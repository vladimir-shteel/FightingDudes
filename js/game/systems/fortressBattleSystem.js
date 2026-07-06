import { CONFIG } from "../config.js";
import { clamp, generateId } from "../utils.js";
import { FORTRESS_HEIGHT, FORTRESS_WIDTH } from "./fortressSystem.js";
import { findTilePath } from "./pathfinding.js";
import { rollUpgradeChoices } from "./upgradeSystem.js";

const REPATH_INTERVAL_SECONDS = 0.4;
const WAYPOINT_ARRIVAL_DISTANCE = 0.18;
// Collision radius must be small enough that opposing melee units still overlap into each other's
// attack range (warrior range 0.5, enemy range 0.42). 0.18 → minDistance 0.36, comfortably inside melee.
const UNIT_COLLISION_RADIUS = 0.18;
const UNIT_PUSH_STRENGTH = 1.0;

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
  // For rectangular / multi-tile buildings pick the tile closest to top (enemy spawn side) so the enemy
  // ends up in contact with the outer edge and can attack.
  let best = null;
  for (const tile of building.tiles) {
    if (!best || tile.y < best.y || (tile.y === best.y && tile.x < best.x)) {
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
  // Keep everyone inside the horizontal grid.
  for (const actor of actors) {
    actor.x = clamp(actor.x, -0.4, FORTRESS_WIDTH - 0.6);
  }
}

function createFortressEnemy(state) {
  const base = CONFIG.fortressUnits.enemy;
  const waveBonus = Math.max(0, state.fortress.waveNumber - 1);
  const hp = base.hp + waveBonus * 3;
  return {
    id: generateId("fortress-enemy"),
    icon: base.icon,
    hp,
    maxHp: hp,
    attack: base.attack + Math.floor(waveBonus / 3),
    cooldownSeconds: base.cooldownSeconds,
    attackTimer: 0,
    range: base.rangeTiles,
    speed: base.speedTilesPerSecond,
    x: Math.random() * (FORTRESS_WIDTH - 0.5) + 0.25,
    y: -0.45
  };
}

function createFortressAlly(type, origin) {
  const base = CONFIG.fortressUnits[type];
  return {
    id: generateId("fortress-ally"),
    type,
    icon: base.icon,
    hp: base.hp,
    maxHp: base.hp,
    attack: base.attack,
    cooldownSeconds: base.cooldownSeconds,
    attackTimer: 0,
    range: base.rangeTiles,
    speed: base.speedTilesPerSecond,
    x: origin.x,
    y: origin.y,
    path: null,
    pathTimer: 0,
    pathTargetId: null
  };
}

function createProjectile(source, target, damage, type) {
  return {
    id: generateId("fortress-shot"),
    type,
    targetId: target.id,
    damage,
    x: source.x,
    y: source.y,
    speed: 5.5
  };
}

export function startFortressBattle(state) {
  if (state.fortress.battle.active || state.game.isOver) {
    return { ok: false, reason: "Battle is already running." };
  }

  const wave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
  if (!wave) {
    return { ok: false, reason: "All fortress waves are complete." };
  }

  state.fortress.movingBuildingId = null;
  state.fortress.battle = {
    active: true,
    enemies: [],
    allies: [],
    projectiles: [],
    spawnTimer: 0,
    enemiesToSpawn: wave.enemyCount,
    enemiesSpawned: 0,
    enemiesDefeated: 0,
    goldEarned: 0,
    result: null
  };
  for (const building of state.fortress.buildings) {
    building.hp = building.maxHp;
    building.cooldownTimer = 0.5;
  }
  return { ok: true, reason: `Fortress wave ${state.fortress.waveNumber} started.` };
}

function tickSpawns(state, deltaSeconds) {
  const battle = state.fortress.battle;
  const wave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
  if (battle.enemiesToSpawn <= 0) {
    return;
  }
  battle.spawnTimer -= deltaSeconds;
  if (battle.spawnTimer <= 0) {
    battle.enemies.push(createFortressEnemy(state));
    battle.enemiesToSpawn -= 1;
    battle.enemiesSpawned += 1;
    battle.spawnTimer = wave.spawnIntervalSeconds;
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
        battle.allies.push(createFortressAlly(level.unit, { x: center.x, y: Math.max(0, center.y - 0.65) }));
        building.cooldownTimer = level.cooldownSeconds;
      }
    }

    if (level.damage && building.type === "turret") {
      building.cooldownTimer -= deltaSeconds;
      if (building.cooldownTimer <= 0) {
        const target = chooseNearest(center, battle.enemies.filter((enemy) => enemy.hp > 0));
        if (target && target.distance <= 3.2) {
          battle.projectiles.push(createProjectile(center, target.item, level.damage, "turret"));
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
  for (const enemy of battle.enemies) {
    if (enemy.hp <= 0) {
      enemy.path = null;
      continue;
    }

    const allyTarget = chooseNearest(enemy, battle.allies.filter((ally) => ally.hp > 0));
    if (allyTarget && allyTarget.distance <= enemy.range + 0.12) {
      enemy.attackTimer -= deltaSeconds;
      if (enemy.attackTimer <= 0) {
        allyTarget.item.hp = clamp(allyTarget.item.hp - enemy.attack, 0, allyTarget.item.maxHp);
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
        enemy.hp -= level.damage;
        building.hp = 0;
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
        bestBuilding.hp = clamp(bestBuilding.hp - enemy.attack, 0, bestBuilding.maxHp);
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
        battle.projectiles.push(createProjectile(ally, target.item, ally.attack, ally.type));
      } else {
        target.item.hp -= ally.attack;
      }
      ally.attackTimer = ally.cooldownSeconds;
    }
  }
}

function tickProjectiles(state, deltaSeconds) {
  const battle = state.fortress.battle;
  for (const projectile of battle.projectiles) {
    const target = battle.enemies.find((enemy) => enemy.id === projectile.targetId && enemy.hp > 0);
    if (!target) {
      projectile.done = true;
      continue;
    }
    if (getDistance(projectile, target) <= 0.14) {
      target.hp -= projectile.damage;
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

  state.resources.gold += amount;
  state.fortress.battle.goldEarned = (state.fortress.battle.goldEarned ?? 0) + amount;
  state.resourceBursts.push({
    id: `${enemy.id}-gold-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    battlefield: { x: enemy.x, y: enemy.y },
    payouts: [{ resourceKey: "gold", amount }]
  });
}

function finishBattle(state, result) {
  const wave = CONFIG.fortressWaves[state.fortress.waveNumber - 1];
  state.fortress.battle.active = false;
  state.fortress.battle.result = result;
  state.fortress.battle.enemies = [];
  state.fortress.battle.allies = [];
  state.fortress.battle.projectiles = [];

  for (const building of state.fortress.buildings) {
    building.hp = building.maxHp;
    building.cooldownTimer = 0;
  }

  if (result === "victory") {
    state.resources.gold += wave.victoryGold;
    state.fortress.battle.goldEarned = (state.fortress.battle.goldEarned ?? 0) + wave.victoryGold;
    if (state.fortress.waveNumber >= CONFIG.fortressWaves.length) {
      state.game.isOver = true;
      state.game.result = "win";
      state.fortress.message = "Prototype complete. The fortress survived every wave.";
    } else {
      state.fortress.waveNumber += 1;
      state.fortress.message = `Victory. +${wave.victoryGold} gold bonus.`;
      rollUpgradeChoices(state);
    }
  } else {
    const earnedGold = state.fortress.battle.goldEarned ?? 0;
    state.fortress.message = `HQ destroyed. Kept ${earnedGold} gold from kills.`;
  }
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
    return;
  }

  tickSpawns(state, deltaSeconds);
  tickBuildingActions(state, deltaSeconds);
  tickEnemies(state, deltaSeconds);
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
