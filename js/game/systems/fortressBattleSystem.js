import { CONFIG } from "../config.js";
import { clamp, generateId } from "../utils.js";
import { FORTRESS_HEIGHT, FORTRESS_WIDTH } from "./fortressSystem.js";
import { rollUpgradeChoices } from "./upgradeSystem.js";

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

function createFortressEnemy(state) {
  const base = CONFIG.fortressUnits.enemy;
  const waveBonus = Math.max(0, state.fortress.waveNumber - 1);
  const hp = base.hp + waveBonus * 6;
  return {
    id: generateId("fortress-enemy"),
    icon: base.icon,
    hp,
    maxHp: hp,
    attack: base.attack + Math.floor(waveBonus / 2),
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
    y: origin.y
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

function tickEnemies(state, deltaSeconds) {
  const battle = state.fortress.battle;
  for (const enemy of battle.enemies) {
    if (enemy.hp <= 0) {
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
      const center = getBuildingCenter(building);
      if (getDistance(enemy, center) <= 0.45) {
        enemy.hp -= level.damage;
        building.hp = 0;
      }
    }

    const targets = state.fortress.buildings
      .filter((building) => building.hp > 0 && building.type !== "mine")
      .map((building) => ({ ...getBuildingCenter(building), building }));
    const target = chooseNearest(enemy, targets);
    if (!target) {
      continue;
    }
    if (target.distance > enemy.range) {
      moveToward(enemy, target.item, deltaSeconds);
      continue;
    }
    enemy.attackTimer -= deltaSeconds;
    if (enemy.attackTimer <= 0) {
      target.item.building.hp = clamp(target.item.building.hp - enemy.attack, 0, target.item.building.maxHp);
      enemy.attackTimer = enemy.cooldownSeconds;
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
      continue;
    }
    if (target.distance > ally.range) {
      moveToward(ally, target.item, deltaSeconds);
      continue;
    }
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
    if (state.fortress.waveNumber >= CONFIG.fortressWaves.length) {
      state.game.isOver = true;
      state.game.result = "win";
      state.fortress.message = "Prototype complete. The fortress survived every wave.";
    } else {
      state.fortress.waveNumber += 1;
      state.fortress.message = `Victory. +${wave.victoryGold} gold.`;
      rollUpgradeChoices(state);
    }
  } else {
    state.resources.gold += wave.defeatGold;
    state.fortress.message = `HQ destroyed. +${wave.defeatGold} consolation gold.`;
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
