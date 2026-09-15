import { CONFIG } from "../config.js";
import { clamp, generateId } from "../utils.js";
import {
  applyBuildingAttrition,
  FORTRESS_HEIGHT,
  FORTRESS_WIDTH,
  syncFortressBuildingUnlocks
} from "./fortressSystem.js";
import { syncMineUnlocks } from "./mineSystem.js";
import { findTilePath } from "./pathfinding.js";
import {
  beginFortressWave,
  endFortressWave,
  getFortressDamageMultiplier,
  getFortressDefenseMultiplier,
  getFortressGoldMultiplier,
  rollUpgradeChoices
} from "./upgradeSystem.js";

// Collision radius must be small enough that opposing melee units still overlap into each other's
// attack range (warrior range 0.5, enemy range 0.42). Default 0.18 → minDistance 0.36, comfortably
// inside melee. All tunable engine thresholds below live in balance.json → combatEngine.
function getCombatEngineConfig() {
  return CONFIG.combatEngine ?? {};
}

function getNowSeconds() {
  return typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
}

function markHit(target) {
  target.hitUntil = getNowSeconds() + (getCombatEngineConfig().hitFlashSeconds ?? 0.09);
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
  enemy.pathTimer = getCombatEngineConfig().repathIntervalSeconds ?? 0.4;
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
  ally.pathTimer = getCombatEngineConfig().repathIntervalSeconds ?? 0.4;
}

function followPath(enemy, deltaSeconds) {
  if (!enemy.path || enemy.path.length === 0) {
    return false;
  }
  const nextWaypoint = enemy.path[0];
  moveToward(enemy, nextWaypoint, deltaSeconds);
  const arrivalDistance = getCombatEngineConfig().waypointArrivalDistance ?? 0.18;
  if (Math.hypot(enemy.x - nextWaypoint.x, enemy.y - nextWaypoint.y) <= arrivalDistance) {
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
  const engineCfg = getCombatEngineConfig();
  const minDistance = (engineCfg.unitCollisionRadius ?? 0.18) * 2;
  const pushStrength = engineCfg.unitPushStrength ?? 1.0;
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
      const push = (overlap / 2) * pushStrength;
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
  const margin = engineCfg.fieldVerticalMargin ?? {};
  for (const actor of actors) {
    actor.y = clamp(actor.y, -(margin.top ?? 0.4), FORTRESS_HEIGHT - (margin.bottom ?? 0.6));
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
    x: FORTRESS_WIDTH + (CONFIG.combatEngine?.enemySpawnOffset?.x ?? 0.45),
    y: Math.random() * (FORTRESS_HEIGHT - (CONFIG.combatEngine?.enemySpawnOffset?.yMargin ?? 0.5))
      + (CONFIG.combatEngine?.enemySpawnOffset?.yPadding ?? 0.25)
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
  const engineCfg = getCombatEngineConfig();
  const spawnDistance = engineCfg.spawnDistanceFromBuilding ?? 0.65;
  const spacing = engineCfg.squadSpawnSpacing ?? 0.4;
  for (let index = 0; index < count; index += 1) {
    const offset = (index - (count - 1) / 2) * spacing;
    battle.allies.push(createFortressAlly(
      unitKey,
      { x: Math.min(FORTRESS_WIDTH, center.x + spawnDistance), y: center.y + offset },
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
    speed: getCombatEngineConfig().projectileSpeed ?? 5.5
  };
}

export function startFortressBattle(state) {
  // Stage 1 rework: this is now startFortressMatch — a one-shot entry that kicks off the
  // continuous wave stream. Subsequent waves are spawned automatically inside tickFortressBattle
  // via advanceToNextWave(). finishBattle() is intentionally never called by the stream.
  if (state.fortress.stream?.active || state.fortress.battle.active || state.game.isOver) {
    return { ok: false, reason: "Match already running." };
  }
  if (!CONFIG.fortressWaves || CONFIG.fortressWaves.length === 0) {
    return { ok: false, reason: "No waves configured." };
  }

  state.fortress.earlyStart = null;
  state.fortress.movingBuildingId = null;
  state.fortress.waveNumber = 1;

  const firstWave = CONFIG.fortressWaves[0];
  const spawnQueue = expandComposition(firstWave);

  state.fortress.battle = {
    active: true,
    enemies: [],
    allies: [],
    projectiles: [],
    bursts: [],
    spawnTimer: 0,
    spawnQueue,
    enemiesToSpawn: spawnQueue.length,
    enemiesSpawned: 0,
    enemiesDefeated: 0,
    goldEarned: 0,
    activeCasts: 0,
    result: null
  };
  state.fortress.stream = {
    active: true,
    phase: "spawning",
    currentWaveIndex: 0,
    gapTimer: 0
  };
  for (const building of state.fortress.buildings) {
    building.cooldownTimer = 0.5;
  }
  beginFortressWave(state);
  return { ok: true, reason: "Match started. Waves incoming!" };
}

function advanceToNextWave(state) {
  const stream = state.fortress.stream;
  const nextIndex = stream.currentWaveIndex + 1;
  const nextWave = CONFIG.fortressWaves[nextIndex];
  if (!nextWave) {
    stream.phase = "done";
    stream.gapTimer = 0;
    return;
  }
  stream.currentWaveIndex = nextIndex;
  stream.phase = "spawning";
  stream.gapTimer = 0;
  state.fortress.waveNumber = nextIndex + 1;
  const spawnQueue = expandComposition(nextWave);
  state.fortress.battle.spawnQueue = spawnQueue;
  state.fortress.battle.enemiesToSpawn = spawnQueue.length;
  state.fortress.battle.spawnTimer = 0;
  syncFortressBuildingUnlocks(state);
  syncMineUnlocks(state);
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

    if (level.unit) {
      building.cooldownTimer -= deltaSeconds;
      if (building.cooldownTimer <= 0) {
        const spawnDistance = getCombatEngineConfig().spawnDistanceFromBuilding ?? 0.65;
        battle.allies.push(createFortressAlly(level.unit, { x: Math.min(FORTRESS_WIDTH, center.x + spawnDistance), y: center.y }, building.level));
        building.cooldownTimer = level.cooldownSeconds;
      }
    }

    if (level.damage && building.type === "turret") {
      building.cooldownTimer -= deltaSeconds;
      if (building.cooldownTimer <= 0) {
        const target = chooseNearest(center, battle.enemies.filter((enemy) => enemy.hp > 0));
        const defaultRange = getCombatEngineConfig().turretDefaultRange ?? 3.2;
        if (target && target.distance <= (level.range ?? defaultRange)) {
          const boostMultiplier = building.activeBoostRemaining > 0 ? (building.activeBoost?.multiplier ?? 1) : 1;
          battle.projectiles.push(createProjectile(center, target.item, level.damage * boostMultiplier, "turret"));
          building.cooldownTimer = level.cooldownSeconds;
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
    const meleeEngageBuffer = getCombatEngineConfig().meleeEngageBuffer ?? 0.12;
    if (allyTarget && allyTarget.distance <= enemy.range + meleeEngageBuffer) {
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
      const trapTriggerRadius = getCombatEngineConfig().trapMineTriggerRadius ?? 0.55;
      if (distanceToBuildingEdge(enemy, building) <= trapTriggerRadius) {
        const mineTile = building.tiles[0];
        const mineCenter = { x: mineTile.x + 0.5, y: mineTile.y + 0.5 };
        const splashRadius = CONFIG.fortressBuildings.mine.splashRadius ?? 0;
        for (const other of battle.enemies) {
          if (other.hp <= 0) {
            continue;
          }
          if (Math.hypot(other.x - mineCenter.x, other.y - mineCenter.y) <= splashRadius) {
            applyDamageToEnemy(other, level.damage * damageMultiplier);
            markHit(other);
          }
        }
        battle.bursts.push({ id: generateId("burst"), x: mineCenter.x, y: mineCenter.y, radius: splashRadius, remaining: 0.35, duration: 0.35 });
        building.hp = 0;
        markHit(building);
        break;
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
    const buildingContactRadius = getCombatEngineConfig().buildingContactRadius ?? 0.7;
    if (bestEdgeDistance <= buildingContactRadius) {
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
    const tickSeconds = getCombatEngineConfig().bossAuraTickSeconds ?? 1;
    enemy.auraTimer = (enemy.auraTimer ?? 0) + deltaSeconds;
    if (enemy.auraTimer < tickSeconds) {
      return;
    }
    enemy.auraTimer -= tickSeconds;
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
      if (building.hp <= 0 || building.type === "mine") {
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
      const rangedThreshold = getCombatEngineConfig().rangedAttackThreshold ?? 0.8;
      if (ally.range > rangedThreshold) {
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
    const hitRadius = getCombatEngineConfig().projectileHitRadius ?? 0.14;
    if (getDistance(projectile, target) <= hitRadius) {
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
        battle.bursts.push({ id: generateId("burst"), x: target.x, y: target.y, radius: splash, remaining: 0.35, duration: 0.35 });
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

function tickBursts(state, deltaSeconds) {
  const battle = state.fortress.battle;
  for (const burst of battle.bursts) {
    burst.remaining -= deltaSeconds;
  }
  battle.bursts = battle.bursts.filter((burst) => burst.remaining > 0);
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
  state.fortress.battle.bursts = [];

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
      syncMineUnlocks(state);
      state.fortress.message = `Victory. +${victoryGold} gold bonus.`;
      if (CONFIG.rewardDraftEnabled !== false) {
        rollUpgradeChoices(state);
      }
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
  const stream = state.fortress.stream;
  const total = CONFIG.fortressWaves.length;
  const aliveEnemies = battle.enemies.filter((enemy) => enemy.hp > 0).length;
  const aliveAllies = battle.allies.filter((ally) => ally.hp > 0).length;

  if (stream && stream.phase === "gap") {
    const secs = Math.max(0, stream.gapTimer).toFixed(1);
    state.fortress.message = `Wave ${state.fortress.waveNumber}/${total} cleared. Next wave in ${secs}s.`;
    return;
  }
  if (stream && stream.phase === "waitClear") {
    state.fortress.message = `Wave ${state.fortress.waveNumber}/${total}: clear the field before the next wave!`;
    return;
  }
  if (stream && stream.phase === "done") {
    state.fortress.message = `Final wave underway. ${aliveEnemies} enemies remain.`;
    return;
  }
  state.fortress.message =
    `Wave ${state.fortress.waveNumber}/${total}: ${aliveEnemies} enemies, ${aliveAllies} allies defending.`;
}

export function tickFortressBattle(state, deltaSeconds) {
  const battle = state.fortress.battle;
  if (!battle.active) {
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
  tickBursts(state, deltaSeconds);
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
    // HQ down: stream-mode match is a permanent loss (no retries).
    battle.active = false;
    state.fortress.stream.active = false;
    state.fortress.stream.phase = "done";
    state.game.isOver = true;
    state.game.result = "loss";
    state.fortress.message = "HQ destroyed. The fortress has fallen.";
    return;
  }

  // Stream state machine — advance waves automatically.
  const stream = state.fortress.stream;
  if (stream && stream.active) {
    const waveGap = CONFIG.waveGapSeconds ?? 8;
    const currentWave = CONFIG.fortressWaves[stream.currentWaveIndex];
    const spawnQueueEmpty = !battle.spawnQueue || battle.spawnQueue.length === 0;

    if (stream.phase === "spawning" && spawnQueueEmpty) {
      if (currentWave?.waitForClear) {
        stream.phase = "waitClear";
      } else {
        stream.phase = "gap";
        stream.gapTimer = waveGap;
      }
    }

    if (stream.phase === "waitClear" && battle.enemies.length === 0) {
      stream.phase = "gap";
      stream.gapTimer = waveGap;
    }

    if (stream.phase === "gap") {
      stream.gapTimer -= deltaSeconds;
      if (stream.gapTimer <= 0) {
        advanceToNextWave(state);
      }
    }

    if (stream.phase === "done" && battle.enemies.length === 0) {
      // Victory: last wave fully spawned and field cleared.
      battle.active = false;
      stream.active = false;
      state.game.isOver = true;
      state.game.result = "win";
      state.fortress.message = "Prototype complete. The fortress survived every wave.";
      return;
    }
  }

  updateBattleMessage(state);
}
