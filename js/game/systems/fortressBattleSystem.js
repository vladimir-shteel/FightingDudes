import { CONFIG } from "../config.js";
import { clamp, generateId } from "../utils.js";
import {
  applyBuildingAttrition,
  FORTRESS_HEIGHT,
  FORTRESS_WIDTH,
  syncFortressBuildingUnlocks
} from "./fortressSystem.js";
import { accrueWorkerRest, autoCommitBattleShifts, clearWorkerBattleShifts, consumeShiftRestFlags } from "./mineSystem.js";
import { applyOperatorPrepAtBattleStart, resolveOperatorAttrition } from "./operatorSystem.js";
import { findTilePath } from "./pathfinding.js";
import {
  beginFortressWave,
  endFortressWave,
  getFortressDamageMultiplier,
  getFortressDefenseMultiplier,
  getFortressGoldMultiplier,
  rollUpgradeChoices
} from "./upgradeSystem.js";

const REPATH_INTERVAL_SECONDS = 0.4;
const WAYPOINT_ARRIVAL_DISTANCE = 0.18;
// Collision radius must be small enough that opposing melee units still overlap into each other's
// attack range (warrior range 0.5, enemy range 0.42). 0.18 → minDistance 0.36, comfortably inside melee.
const UNIT_COLLISION_RADIUS = 0.18;
const UNIT_PUSH_STRENGTH = 1.0;
const HIT_FLASH_SECONDS = 0.09;

function getNowSeconds() {
  return typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
}

function markHit(target) {
  target.hitUntil = getNowSeconds() + HIT_FLASH_SECONDS;
}

function getBuildingCenter(building) {
  const minX = Math.min(...building.tiles.map((tile) => tile.x));
  const maxX = Math.max(...building.tiles.map((tile) => tile.x));
  const minY = Math.min(...building.tiles.map((tile) => tile.y));
  const maxY = Math.max(...building.tiles.map((tile) => tile.y));
  return { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2 };
}

function getDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function chooseNearest(source, items) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const distance = getDistance(source, item);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best ? { item: best, distance: bestDistance } : null;
}

function moveToward(actor, target, deltaSeconds) {
  const dx = target.x - actor.x;
  const dy = target.y - actor.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0.001) {
    return;
  }
  const step = Math.min(distance, actor.speed * deltaSeconds);
  actor.x += (dx / distance) * step;
  actor.y += (dy / distance) * step;
}

function getBlockedTileSetForActor(state, ignoreBuildingId) {
  // Trees (`tile.occupant === "obstacle"`) are walkable for units — only live buildings block.
  // That way clearing trees stays purely a gold sink for placement, not a defensive perk.
  const obstacles = new Set();
  for (const building of state.fortress.buildings) {
    if (building.hp <= 0) {
      continue;
    }
    if (building.type === "mine") {
      // Trap mines are transparent to pathfinding — enemies walk into them and trigger damage.
      continue;
    }
    if (building.id === ignoreBuildingId) {
      continue;
    }
    for (const tile of building.tiles) {
      obstacles.add(`${tile.x}:${tile.y}`);
    }
  }
  return obstacles;
}

function getBuildingAtTile(state, tile) {
  return state.fortress.buildings.find((building) => (
    building.hp > 0
    && building.tiles.some((buildingTile) => buildingTile.x === tile.x && buildingTile.y === tile.y)
  )) ?? null;
}

function getActorTile(actor) {
  return {
    x: clamp(Math.floor(actor.x), 0, FORTRESS_WIDTH - 1),
    y: clamp(Math.floor(actor.y), 0, FORTRESS_HEIGHT - 1)
  };
}

function chooseGoalTileForBuilding(building) {
  // For rectangular / multi-tile buildings pick the tile closest to the right (enemy spawn side) so the
  // enemy ends up in contact with the outer edge and can attack.
  let best = null;
  for (const tile of building.tiles) {
    if (!best || tile.x > best.x || (tile.x === best.x && tile.y < best.y)) {
      best = tile;
    }
  }
  return best;
}

function ensureEnemyPath(state, enemy, deltaSeconds) {
  enemy.pathTimer = (enemy.pathTimer ?? 0) - deltaSeconds;
  const targetId = enemy.pathTargetId ?? null;
  const needsRepath = !enemy.path || enemy.path.length === 0
    || enemy.pathTimer <= 0
    || enemy.pathTargetId !== enemy.currentTargetId;
  if (!needsRepath) {
    return;
  }
  const targetBuilding = state.fortress.buildings.find((building) => building.id === enemy.currentTargetId);
  if (!targetBuilding || targetBuilding.hp <= 0) {
    enemy.path = null;
    enemy.pathTargetId = null;
    return;
  }
  const blocked = getBlockedTileSetForActor(state, targetBuilding.id);
  const startTile = { x: clamp(Math.round(enemy.x), 0, FORTRESS_WIDTH - 1), y: clamp(Math.round(enemy.y), 0, FORTRESS_HEIGHT - 1) };
  const goalTile = chooseGoalTileForBuilding(targetBuilding);
  const tilePath = findTilePath(
    startTile,
    goalTile,
    (x, y) => blocked.has(`${x}:${y}`)
  );
  if (!tilePath) {
    enemy.path = null;
    enemy.pathTargetId = targetId;
    return;
  }
  // Path returned includes the current tile at index 0; skip it so the first waypoint is one step ahead.
  enemy.path = tilePath.slice(1).map((tile) => ({ x: tile.x + 0.5, y: tile.y + 0.5 }));
  enemy.pathTargetId = enemy.currentTargetId;
  enemy.pathTimer = REPATH_INTERVAL_SECONDS;
}

function ensureAllyPath(state, ally, target, deltaSeconds) {
  ally.pathTimer = (ally.pathTimer ?? 0) - deltaSeconds;
  const needsRepath = !ally.path || ally.path.length === 0
    || ally.pathTimer <= 0
    || ally.pathTargetId !== target.id;
  if (!needsRepath) {
    return;
  }

  const startTile = getActorTile(ally);
  const currentBuilding = getBuildingAtTile(state, startTile);
  const blocked = getBlockedTileSetForActor(state, currentBuilding?.id ?? null);
  const goalTile = getActorTile(target);
  const tilePath = findTilePath(
    startTile,
    goalTile,
    (x, y) => blocked.has(`${x}:${y}`)
  );

  if (!tilePath) {
    ally.path = null;
    ally.pathTargetId = target.id;
    return;
  }

  ally.path = tilePath.slice(1).map((tile) => ({ x: tile.x + 0.5, y: tile.y + 0.5 }));
  ally.pathTargetId = target.id;
  ally.pathTimer = REPATH_INTERVAL_SECONDS;
}

function followPath(enemy, deltaSeconds) {
  if (!enemy.path || enemy.path.length === 0) {
    return false;
  }
  const nextWaypoint = enemy.path[0];
  moveToward(enemy, nextWaypoint, deltaSeconds);
  if (Math.hypot(enemy.x - nextWaypoint.x, enemy.y - nextWaypoint.y) <= WAYPOINT_ARRIVAL_DISTANCE) {
    enemy.path.shift();
  }
  return true;
}

function resolveUnitCollisions(state) {
  const battle = state.fortress.battle;
  const actors = [];
  for (const enemy of battle.enemies) {
    if (enemy.hp > 0) actors.push(enemy);
  }
  for (const ally of battle.allies) {
    if (ally.hp > 0) actors.push(ally);
  }
  const minDistance = UNIT_COLLISION_RADIUS * 2;
  for (let i = 0; i < actors.length; i += 1) {
    for (let j = i + 1; j < actors.length; j += 1) {
      const a = actors[i];
      const b = actors[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let distance = Math.hypot(dx, dy);
      if (distance >= minDistance) {
        continue;
      }
      if (distance < 0.0001) {
        // Perfect overlap — apply a deterministic tiny offset based on ids to break the tie.
        const jitter = (a.id.length + b.id.length) % 7;
        const ax = 0.02 * (jitter - 3);
        const ay = 0.02 * ((jitter * 3) % 7 - 3);
        b.x += ax;
        b.y += ay;
        continue;
      }
      const overlap = minDistance - distance;
      const push = (overlap / 2) * UNIT_PUSH_STRENGTH;
      const nx = dx / distance;
      const ny = dy / distance;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
    }
  }
  // Keep everyone inside the field vertically (the travel axis is now horizontal, so leave X free so
  // enemies can walk in from just off the right edge).
  for (const actor of actors) {
    actor.y = clamp(actor.y, -0.4, FORTRESS_HEIGHT - 0.6);
  }
}

// Armor rule: effective = max(dmg*armorMinFraction, dmg - armor). The fractional floor (not 0, not a
// flat 1) makes armor a real RPS lever — many-small-hits bounce to ~15% vs a heavy target, so burst
// (few big hits: turret/mine) is the efficient answer, yet nothing is fully immune (soft counter, no
// softlock). Splash AoE is the anti-swarm answer. Mirrors tools/balance-sim/battle_sim.hurt_enemy.
function applyDamageToEnemy(enemy, rawDamage) {
  const armor = enemy.armor ?? 0;
  const minFraction = CONFIG.combat?.armorMinFraction ?? 0.15;
  const dealt = Math.max(rawDamage * minFraction, rawDamage - armor);
  enemy.hp -= dealt;
  return dealt;
}

function createFortressEnemy(state, archetypeKey) {
  const base = CONFIG.fortressEnemies[archetypeKey];
  const waveBonus = Math.max(0, state.fortress.waveNumber - 1);
  const c = CONFIG.combat ?? {};
  // Multiplicative wave scaling PRESERVES archetype identity across waves (the old additive
  // +5(w-1)+0.35(w-1)^2 added a flat HP slab to every archetype and erased the swarm/tank
  // distinction late). Armor scales multiplicatively too, so it tracks the tier-growth of the
  // big-hit sources and chip keeps bouncing at every wave.
  const hp = Math.round(base.hp * (1 + (c.hpScalePerWave ?? 0.14) * waveBonus));
  const baseArmor = base.armor ?? 0;
  const armor = baseArmor > 0
    ? Math.round(baseArmor * (1 + (c.armorScalePerWave ?? 0.10) * waveBonus))
    : 0;
  return {
    id: generateId("fortress-enemy"),
    archetype: archetypeKey,
    tag: base.tag,
    icon: base.icon,
    hp,
    maxHp: hp,
    armor,
    attack: Math.round(base.attack * (1 + (c.attackScalePerWave ?? 0.06) * waveBonus)),
    cooldownSeconds: base.cooldownSeconds,
    attackTimer: 0,
    range: base.rangeTiles,
    speed: base.speedTilesPerSecond,
    baseSpeed: base.speedTilesPerSecond,
    frostRemaining: 0,
    frostMultiplier: 1,
    mechanic: base.mechanic ?? null,
    auraTimer: 0,
    summonTimer: base.mechanic?.kind === "summon" ? base.mechanic.intervalSeconds : 0,
    // Enemies pour in from just off the RIGHT edge, spread across the field height.
    x: FORTRESS_WIDTH + 0.45,
    y: Math.random() * (FORTRESS_HEIGHT - 0.5) + 0.25
  };
}

function expandComposition(wave) {
  const composition = wave.composition ?? [{ archetype: "grunt", count: wave.enemyCount }];
  const groups = composition.map((entry) => ({ archetype: entry.archetype, remaining: entry.count }));
  const queue = [];
  let anyRemaining = groups.some((group) => group.remaining > 0);
  while (anyRemaining) {
    anyRemaining = false;
    for (const group of groups) {
      if (group.remaining > 0) {
        queue.push(group.archetype);
        group.remaining -= 1;
        if (group.remaining > 0) {
          anyRemaining = true;
        }
      }
    }
  }
  return queue;
}

export function createFortressAlly(type, origin, level = 1) {
  const base = CONFIG.fortressUnits[type];
  const c = CONFIG.combat ?? {};
  // Spawned-unit power scales with the SPAWNER building's tier (was frozen: only cooldown scaled, so
  // spawner units fell behind turret point-damage late-game). This is the spawner merge payoff and
  // keeps mage splash / warrior bodies relevant vs multiplicatively-scaled enemy HP.
  const atkMult = 1 + (c.unitAttackPerLevel ?? 0.35) * (level - 1);
  const hpMult = 1 + (c.unitHpPerLevel ?? 0.20) * (level - 1);
  const hp = Math.round(base.hp * hpMult);
  return {
    id: generateId("fortress-ally"),
    type,
    icon: base.icon,
    hp,
    maxHp: hp,
    attack: base.attack * atkMult,
    cooldownSeconds: base.cooldownSeconds,
    attackTimer: 0,
    range: base.rangeTiles,
    speed: base.speedTilesPerSecond,
    splashRadius: base.splashRadius ?? 0,
    x: origin.x,
    y: origin.y,
    path: null,
    pathTimer: 0,
    pathTargetId: null
  };
}

export function spawnAllyForBuilding(state, building, unitKey, count) {
  const battle = state.fortress.battle;
  if (!battle.active) {
    return;
  }
  const center = getBuildingCenter(building);
  for (let index = 0; index < count; index += 1) {
    const offset = (index - (count - 1) / 2) * 0.4;
    battle.allies.push(createFortressAlly(
      unitKey,
      { x: Math.min(FORTRESS_WIDTH, center.x + 0.65), y: center.y + offset },
      building.level
    ));
  }
}

export function volleyFromBuilding(state, building, count, damage) {
  const battle = state.fortress.battle;
  if (!battle.active) {
    return;
  }
  const center = getBuildingCenter(building);
  const aliveEnemies = battle.enemies.filter((enemy) => enemy.hp > 0);
  const targets = [...aliveEnemies].sort((a, b) => getDistance(center, a) - getDistance(center, b)).slice(0, count);
  for (const target of targets) {
    battle.projectiles.push(createProjectile(center, target, damage, "volley"));
  }
}

function createProjectile(source, target, damage, type, splashRadius = 0) {
  return {
    id: generateId("fortress-shot"),
    type,
    targetId: target.id,
    damage,
    splashRadius,
    x: source.x,
    y: source.y,
    speed: 5.5
  };
}

export function startFortressBattle(state) {
  if (state.fortress.battle.active || state.game.isOver) {
    return { ok: false, reason: "Battle is already running." };
  }
  if ((state.fortress.pendingRewardDraft?.length ?? 0) > 0) {
    return { ok: false, reason: "Choose a reward before starting the next wave." };
  }

  const wave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
  if (!wave) {
    return { ok: false, reason: "All fortress waves are complete." };
  }

  const spawnQueue = expandComposition(wave);

  const earlyStart = state.fortress.earlyStart;
  if (earlyStart && earlyStart.window > 0) {
    const fraction = Math.max(0, Math.min(1, earlyStart.remaining / earlyStart.window));
    const rawBonus = Math.round(earlyStart.bonus * fraction);
    if (rawBonus > 0) {
      const paidBonus = Math.round(rawBonus * getFortressGoldMultiplier(state));
      state.resources.gold += paidBonus;
      state.fortress.message = `Early start +${paidBonus} gold.`;
    }
  }
  state.fortress.earlyStart = null;

  state.fortress.movingBuildingId = null;
  state.fortress.battle = {
    active: true,
    enemies: [],
    allies: [],
    projectiles: [],
    spawnTimer: 0,
    spawnQueue,
    enemiesToSpawn: spawnQueue.length,
    enemiesSpawned: 0,
    enemiesDefeated: 0,
    goldEarned: 0,
    activeCasts: 0,
    result: null
  };
  for (const building of state.fortress.buildings) {
    building.cooldownTimer = 0.5;
  }
  // Lock in operator buffs (HP bonus + damage/summon multipliers) and spend their Rest prep charge.
  applyOperatorPrepAtBattleStart(state);
  beginFortressWave(state);
  // Rested workers staffing a mine automatically take the battle shift (up to the per-mine cap).
  autoCommitBattleShifts(state);
  // Committed workers spend their rest to power the Shift.
  consumeShiftRestFlags(state);
  return { ok: true, reason: `Fortress wave ${state.fortress.waveNumber} started.` };
}

function tickSpawns(state, deltaSeconds) {
  const battle = state.fortress.battle;
  const wave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
  if (!battle.spawnQueue || battle.spawnQueue.length === 0) {
    return;
  }
  battle.spawnTimer -= deltaSeconds;
  if (battle.spawnTimer <= 0) {
    const archetype = battle.spawnQueue.shift();
    battle.enemies.push(createFortressEnemy(state, archetype));
    battle.enemiesToSpawn = battle.spawnQueue.length;
    battle.enemiesSpawned += 1;
    battle.spawnTimer = wave.spawnIntervalSeconds;
  }
}

function tickBuildingActiveTimers(state, deltaSeconds) {
  for (const building of state.fortress.buildings) {
    building.activeCooldown = Math.max(0, (building.activeCooldown ?? 0) - deltaSeconds);
    building.activeBoostRemaining = Math.max(0, (building.activeBoostRemaining ?? 0) - deltaSeconds);
    building.shieldRemaining = Math.max(0, (building.shieldRemaining ?? 0) - deltaSeconds);
  }
}

function tickBuildingActions(state, deltaSeconds) {
  const battle = state.fortress.battle;
  for (const building of state.fortress.buildings) {
    if (building.hp <= 0) {
      continue;
    }

    const definition = CONFIG.fortressBuildings[building.type];
    const level = definition.levels[building.level - 1];
    const center = getBuildingCenter(building);
    // Operator buffs: faster summon (cooldownMult < 1) and stronger direct damage.
    const opBuff = building.operatorBuff ?? { damageMult: 1, cooldownMult: 1 };

    if (level.unit) {
      building.cooldownTimer -= deltaSeconds;
      if (building.cooldownTimer <= 0) {
        battle.allies.push(createFortressAlly(level.unit, { x: Math.min(FORTRESS_WIDTH, center.x + 0.65), y: center.y }, building.level));
        building.cooldownTimer = level.cooldownSeconds * (opBuff.cooldownMult ?? 1);
      }
    }

    if (level.damage && building.type === "turret") {
      building.cooldownTimer -= deltaSeconds;
      if (building.cooldownTimer <= 0) {
        const target = chooseNearest(center, battle.enemies.filter((enemy) => enemy.hp > 0));
        if (target && target.distance <= (level.range ?? 3.2)) {
          const boostMultiplier = building.activeBoostRemaining > 0 ? (building.activeBoost?.multiplier ?? 1) : 1;
          const damage = level.damage * boostMultiplier * (opBuff.damageMult ?? 1);
          battle.projectiles.push(createProjectile(center, target.item, damage, "turret"));
          building.cooldownTimer = level.cooldownSeconds * (opBuff.cooldownMult ?? 1);
        }
      }
    }
  }
}

function distanceToBuildingEdge(enemy, building) {
  let best = Infinity;
  for (const tile of building.tiles) {
    const centerX = tile.x + 0.5;
    const centerY = tile.y + 0.5;
    const distance = Math.hypot(enemy.x - centerX, enemy.y - centerY);
    if (distance < best) {
      best = distance;
    }
  }
  return best;
}

function tickEnemies(state, deltaSeconds) {
  const battle = state.fortress.battle;
  const defenseMultiplier = getFortressDefenseMultiplier(state);
  const damageMultiplier = getFortressDamageMultiplier(state);
  for (const enemy of battle.enemies) {
    if (enemy.hp <= 0) {
      enemy.path = null;
      continue;
    }

    if (enemy.frostRemaining > 0) {
      enemy.frostRemaining = Math.max(0, enemy.frostRemaining - deltaSeconds);
      enemy.speed = enemy.baseSpeed * enemy.frostMultiplier;
    } else {
      enemy.speed = enemy.baseSpeed;
    }

    const allyTarget = chooseNearest(enemy, battle.allies.filter((ally) => ally.hp > 0));
    if (allyTarget && allyTarget.distance <= enemy.range + 0.12) {
      enemy.attackTimer -= deltaSeconds;
      if (enemy.attackTimer <= 0) {
        allyTarget.item.hp = clamp(
          allyTarget.item.hp - (enemy.attack / defenseMultiplier),
          0,
          allyTarget.item.maxHp
        );
        markHit(allyTarget.item);
        enemy.attackTimer = enemy.cooldownSeconds;
      }
      continue;
    }

    for (const building of state.fortress.buildings) {
      if (building.type !== "mine" || building.hp <= 0) {
        continue;
      }
      const level = CONFIG.fortressBuildings.mine.levels[building.level - 1];
      if (distanceToBuildingEdge(enemy, building) <= 0.55) {
        applyDamageToEnemy(enemy, level.damage * damageMultiplier);
        markHit(enemy);
        building.hp = 0;
        markHit(building);
      }
    }

    // Pick the nearest attackable building (excluding trap mines — those are hazards, not targets).
    const attackable = state.fortress.buildings.filter((building) => building.hp > 0 && building.type !== "mine");
    let bestBuilding = null;
    let bestEdgeDistance = Infinity;
    for (const building of attackable) {
      const edgeDistance = distanceToBuildingEdge(enemy, building);
      if (edgeDistance < bestEdgeDistance) {
        bestEdgeDistance = edgeDistance;
        bestBuilding = building;
      }
    }
    if (!bestBuilding) {
      enemy.path = null;
      enemy.currentTargetId = null;
      continue;
    }
    enemy.currentTargetId = bestBuilding.id;

    // In attack range of building footprint? Stand and hit.
    if (bestEdgeDistance <= 0.7) {
      enemy.path = null;
      enemy.attackTimer -= deltaSeconds;
      if (enemy.attackTimer <= 0) {
        const breachMult = enemy.mechanic?.kind === "breach" ? enemy.mechanic.damageMultVsBuildings : 1;
        const shieldMult = bestBuilding.shieldRemaining > 0 ? (1 - (bestBuilding.shieldReduction ?? 0)) : 1;
        bestBuilding.hp = clamp(
          bestBuilding.hp - (enemy.attack * breachMult * shieldMult / defenseMultiplier),
          0,
          bestBuilding.maxHp
        );
        markHit(bestBuilding);
        enemy.attackTimer = enemy.cooldownSeconds;
      }
      continue;
    }

    ensureEnemyPath(state, enemy, deltaSeconds);
    if (!followPath(enemy, deltaSeconds)) {
      // Path unreachable — fall back to straight line toward the closest footprint tile.
      let closestTile = bestBuilding.tiles[0];
      let closestDistance = Infinity;
      for (const tile of bestBuilding.tiles) {
        const d = Math.hypot(enemy.x - (tile.x + 0.5), enemy.y - (tile.y + 0.5));
        if (d < closestDistance) {
          closestDistance = d;
          closestTile = tile;
        }
      }
      moveToward(enemy, { x: closestTile.x + 0.5, y: closestTile.y + 0.5 }, deltaSeconds);
    }
  }
}

function tickBossMechanic(state, enemy, deltaSeconds) {
  if (!enemy.mechanic || enemy.hp <= 0) {
    return;
  }
  const battle = state.fortress.battle;

  if (enemy.mechanic.kind === "aura") {
    enemy.auraTimer = (enemy.auraTimer ?? 0) + deltaSeconds;
    if (enemy.auraTimer < 1) {
      return;
    }
    enemy.auraTimer -= 1;
    const damage = enemy.mechanic.damagePerSecond;
    for (const ally of battle.allies) {
      if (ally.hp <= 0) {
        continue;
      }
      if (getDistance(enemy, ally) <= enemy.mechanic.radius) {
        ally.hp = clamp(ally.hp - damage, 0, ally.maxHp);
        markHit(ally);
      }
    }
    for (const building of state.fortress.buildings) {
      if (building.hp <= 0) {
        continue;
      }
      if (distanceToBuildingEdge(enemy, building) <= enemy.mechanic.radius) {
        building.hp = clamp(building.hp - damage, 0, building.maxHp);
        markHit(building);
      }
    }
    return;
  }

  if (enemy.mechanic.kind === "summon") {
    enemy.summonTimer = (enemy.summonTimer ?? enemy.mechanic.intervalSeconds) - deltaSeconds;
    if (enemy.summonTimer <= 0) {
      const summon = createFortressEnemy(state, enemy.mechanic.archetype);
      summon.x = enemy.x + 0.4;
      summon.y = enemy.y + 0.2;
      battle.enemies.push(summon);
      enemy.summonTimer = enemy.mechanic.intervalSeconds;
    }
  }
}

function tickAllies(state, deltaSeconds) {
  const battle = state.fortress.battle;
  for (const ally of battle.allies) {
    if (ally.hp <= 0) {
      continue;
    }
    const target = chooseNearest(ally, battle.enemies.filter((enemy) => enemy.hp > 0));
    if (!target) {
      ally.path = null;
      ally.pathTargetId = null;
      continue;
    }
    if (target.distance > ally.range) {
      ensureAllyPath(state, ally, target.item, deltaSeconds);
      if (!followPath(ally, deltaSeconds)) {
        moveToward(ally, target.item, deltaSeconds);
      }
      continue;
    }
    ally.path = null;
    ally.attackTimer -= deltaSeconds;
    if (ally.attackTimer <= 0) {
      if (ally.range > 0.8) {
        battle.projectiles.push(createProjectile(ally, target.item, ally.attack, ally.type, ally.splashRadius ?? 0));
      } else {
        applyDamageToEnemy(target.item, ally.attack * getFortressDamageMultiplier(state));
        markHit(target.item);
      }
      ally.attackTimer = ally.cooldownSeconds;
    }
  }
}

function tickProjectiles(state, deltaSeconds) {
  const battle = state.fortress.battle;
  const damageMultiplier = getFortressDamageMultiplier(state);
  for (const projectile of battle.projectiles) {
    const target = battle.enemies.find((enemy) => enemy.id === projectile.targetId && enemy.hp > 0);
    if (!target) {
      projectile.done = true;
      continue;
    }
    if (getDistance(projectile, target) <= 0.14) {
      const dmg = projectile.damage * damageMultiplier;
      const splash = projectile.splashRadius ?? 0;
      if (splash > 0) {
        // AoE: every live enemy within splash of impact takes the hit (armor applies per enemy).
        for (const enemy of battle.enemies) {
          if (enemy.hp > 0 && Math.hypot(enemy.x - target.x, enemy.y - target.y) <= splash) {
            applyDamageToEnemy(enemy, dmg);
            markHit(enemy);
          }
        }
      } else {
        applyDamageToEnemy(target, dmg);
        markHit(target);
      }
      projectile.done = true;
      continue;
    }
    moveToward(projectile, target, deltaSeconds);
  }
  battle.projectiles = battle.projectiles.filter((projectile) => !projectile.done);
}

function awardEnemyKillGold(state, enemy) {
  const wave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
  const amount = wave?.killGold ?? 0;
  if (amount <= 0) {
    return;
  }

  const payout = amount * getFortressGoldMultiplier(state);
  state.resources.gold += payout;
  state.fortress.battle.goldEarned = (state.fortress.battle.goldEarned ?? 0) + payout;
  state.resourceBursts.push({
    id: `${enemy.id}-gold-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    battlefield: { x: enemy.x, y: enemy.y },
    payouts: [{ resourceKey: "gold", amount: payout }]
  });
}

function finishBattle(state, result) {
  const wave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
  state.fortress.battle.active = false;
  state.fortress.battle.result = result;
  state.fortress.battle.enemies = [];
  state.fortress.battle.allies = [];
  state.fortress.battle.projectiles = [];

  // Operator attrition FIRST: peel the temporary operator HP bonus off maxHp (so the restore below
  // uses the real cap) and drop/lose operators whose building was destroyed this wave.
  const operatorMessages = resolveOperatorAttrition(state);

  if (result === "defeat") {
    const postDefeatHpFraction = CONFIG.attrition?.postDefeatHpFraction ?? 0.4;
    const floorPerDefeat = CONFIG.attrition?.floorPerDefeat ?? 0;
    for (const building of state.fortress.buildings) {
      if (building.hp > 0) {
        building.cooldownTimer = 0;
        continue;
      }
      // Attrition: each defeat adds floorPerDefeat to damageFloor. Restore fraction
      // shrinks as damageFloor grows. maxHp is untouched — repair or victory clears
      // the floor and brings hp back to full.
      building.damageFloor = (building.damageFloor ?? 0) + floorPerDefeat;
      const restoreFraction = Math.max(0, postDefeatHpFraction - building.damageFloor);
      building.hp = Math.max(1, Math.floor(building.maxHp * restoreFraction));
      building.cooldownTimer = 0;
    }
  } else {
    // ATTRITION (steady per-wave sink coupling mining<->combat): victory clears the permanent
    // damageFloor, but buildings KEEP the HP they lost this fight — you repair with resources between
    // waves. Harder fights chew more HP -> more repair -> more mining. Destroyed buildings are pulled
    // back to a repairable fraction so a WIN never outright deletes your defense (no death-spiral).
    const victoryFloor = CONFIG.attrition?.postDefeatHpFraction ?? 0.4;
    for (const building of state.fortress.buildings) {
      building.damageFloor = 0;
      if (building.hp <= 0) {
        building.hp = Math.max(1, Math.floor(building.maxHp * victoryFloor));
      }
      building.cooldownTimer = 0;
    }
  }

  if (result === "victory") {
    const victoryGold = wave.victoryGold * getFortressGoldMultiplier(state);
    state.resources.gold += victoryGold;
    state.fortress.battle.goldEarned = (state.fortress.battle.goldEarned ?? 0) + victoryGold;
    endFortressWave(state);
    if (state.fortress.waveNumber >= CONFIG.fortressWaves.length) {
      state.game.isOver = true;
      state.game.result = "win";
      state.fortress.message = "Prototype complete. The fortress survived every wave.";
    } else {
      state.fortress.waveNumber += 1;
      syncFortressBuildingUnlocks(state);
      state.fortress.message = `Victory. +${victoryGold} gold bonus.`;
      rollUpgradeChoices(state);
      const nextWave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
      const bonus = nextWave?.startBonusGold ?? 0;
      const window = nextWave?.startBonusWindowSeconds ?? 0;
      state.fortress.earlyStart = bonus > 0 && window > 0
        ? { remaining: window, window, bonus }
        : null;
    }
  } else {
    const earnedGold = state.fortress.battle.goldEarned ?? 0;
    state.fortress.message = `HQ destroyed. Kept ${earnedGold} gold from kills.`;
  }

  clearWorkerBattleShifts(state);
  // Every worker NOT on its desired mine (reserve or a wrong mine) builds Rest toward that mine.
  accrueWorkerRest(state);

  if (operatorMessages.length > 0) {
    state.fortress.message = `${state.fortress.message} ${operatorMessages.join(" ")}`.trim();
  }
}

export function giveUpFortressBattle(state) {
  if (!state.fortress.battle.active) {
    return { ok: false, reason: "No battle to give up." };
  }
  // Concede a doomed fight: resolve it as a normal defeat (attrition damage applies, the wave can be
  // retried) so the player doesn't have to watch a lost battle play out.
  finishBattle(state, "defeat");
  state.fortress.message = "Surrendered — the wave is lost. Regroup and try again.";
  return { ok: true, reason: "Battle surrendered." };
}

function updateBattleMessage(state) {
  const battle = state.fortress.battle;
  const wave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
  const aliveEnemies = battle.enemies.filter((enemy) => enemy.hp > 0).length;
  const aliveAllies = battle.allies.filter((ally) => ally.hp > 0).length;
  const damagedBuildings = state.fortress.buildings
    .filter((building) => building.hp > 0 && building.hp < building.maxHp)
    .length;
  const destroyedBuildings = state.fortress.buildings
    .filter((building) => building.hp <= 0)
    .length;
  const spawned = battle.enemiesSpawned ?? (wave.enemyCount - battle.enemiesToSpawn);

  state.fortress.message =
    `Wave ${state.fortress.waveNumber}: ${spawned}/${wave.enemyCount} enemies deployed, ` +
    `${aliveEnemies} alive, ${aliveAllies} allies defending, ` +
    `${damagedBuildings} damaged / ${destroyedBuildings} destroyed buildings.`;
}

export function tickFortressBattle(state, deltaSeconds) {
  const battle = state.fortress.battle;
  if (!battle.active) {
    if (state.fortress.earlyStart) {
      state.fortress.earlyStart.remaining = Math.max(0, state.fortress.earlyStart.remaining - deltaSeconds);
    }
    return;
  }

  tickSpawns(state, deltaSeconds);
  tickBuildingActiveTimers(state, deltaSeconds);
  tickBuildingActions(state, deltaSeconds);
  tickEnemies(state, deltaSeconds);
  for (const enemy of battle.enemies) {
    tickBossMechanic(state, enemy, deltaSeconds);
  }
  tickAllies(state, deltaSeconds);
  tickProjectiles(state, deltaSeconds);
  resolveUnitCollisions(state);

  for (const enemy of battle.enemies) {
    if (enemy.hp <= 0) {
      awardEnemyKillGold(state, enemy);
    }
  }
  const enemiesBeforeCleanup = battle.enemies.length;
  battle.enemies = battle.enemies.filter((enemy) => enemy.hp > 0);
  battle.enemiesDefeated += enemiesBeforeCleanup - battle.enemies.length;
  battle.allies = battle.allies.filter((ally) => ally.hp > 0);

  const hq = state.fortress.buildings.find((building) => building.type === "hq");
  if (!hq || hq.hp <= 0) {
    finishBattle(state, "defeat");
  } else if (battle.enemiesToSpawn <= 0 && battle.enemies.length === 0) {
    finishBattle(state, "victory");
  } else {
    updateBattleMessage(state);
  }
}
