import { CONFIG } from "../config.js";
import { createEnemy } from "../factories.js";
import { clamp, sum } from "../utils.js";

function getAttackInterval(actor) {
  return 1 / actor.attackSpeed;
}

function removeDefeated(list) {
  return list.filter((item) => item.health > 0);
}

function getLaneActors(list, lane) {
  return list.filter((actor) => actor.lane === lane && actor.health > 0);
}

function findNearestEnemyAhead(unit, enemies) {
  return enemies
    .filter((enemy) => enemy.x >= unit.x)
    .sort((left, right) => left.x - right.x)[0] ?? null;
}

function findNearestAllyAhead(enemy, allies) {
  return allies
    .filter((ally) => ally.x <= enemy.x)
    .sort((left, right) => right.x - left.x)[0] ?? null;
}

function resolveFriendlyMovement(state, deltaSeconds) {
  for (let lane = 0; lane < CONFIG.battle.laneCount; lane += 1) {
    const allies = getLaneActors(state.battleUnits, lane).sort((left, right) => right.x - left.x);
    const enemies = getLaneActors(state.enemies, lane);

    for (const ally of allies) {
      const spacing = ally.radius * 2 + 1.2;
      const enemyAhead = findNearestEnemyAhead(ally, enemies);
      const allyAhead = allies.find((other) => other.id !== ally.id && other.x > ally.x) ?? null;
      const desiredX = ally.x + ally.moveSpeed * deltaSeconds;
      let maxX = CONFIG.battle.castleX - CONFIG.battle.castleAttackRange;

      if (enemyAhead) {
        maxX = Math.min(maxX, enemyAhead.x - CONFIG.battle.contactRange);
      }

      if (allyAhead) {
        maxX = Math.min(maxX, allyAhead.x - spacing);
      }

      ally.x = clamp(Math.min(desiredX, maxX), CONFIG.battle.allySpawnX, CONFIG.battle.castleX);
      ally.state = enemyAhead && enemyAhead.x - ally.x <= ally.attackRange ? "engaged" : "marching";
      ally.targetHint = enemyAhead ? enemyAhead.name : "castle";
    }
  }
}

function resolveEnemyMovement(state, deltaSeconds) {
  for (let lane = 0; lane < CONFIG.battle.laneCount; lane += 1) {
    const enemies = getLaneActors(state.enemies, lane).sort((left, right) => left.x - right.x);
    const allies = getLaneActors(state.battleUnits, lane);

    for (const enemy of enemies) {
      const spacing = enemy.radius * 2 + 1.2;
      const allyAhead = findNearestAllyAhead(enemy, allies);
      const enemyAhead = enemies.find((other) => other.id !== enemy.id && other.x < enemy.x) ?? null;
      const desiredX = enemy.x - enemy.moveSpeed * deltaSeconds;
      let minX = CONFIG.battle.allySpawnX;

      if (allyAhead) {
        minX = Math.max(minX, allyAhead.x + CONFIG.battle.contactRange);
      }

      if (enemyAhead) {
        minX = Math.max(minX, enemyAhead.x + spacing);
      }

      enemy.x = clamp(Math.max(desiredX, minX), CONFIG.battle.allySpawnX, CONFIG.battle.enemySpawnX + 12);
      enemy.state = allyAhead && enemy.x - allyAhead.x <= enemy.attackRange ? "engaged" : "marching";
    }
  }
}

function applyFriendlyAttacks(state, nowSeconds) {
  for (const unit of state.battleUnits) {
    const targetEnemy = findNearestEnemyAhead(unit, getLaneActors(state.enemies, unit.lane));
    const attackInterval = getAttackInterval(unit);

    if (nowSeconds - unit.lastAttackAt < attackInterval) {
      continue;
    }

    if (targetEnemy && targetEnemy.x - unit.x <= unit.attackRange) {
      unit.targetHint = targetEnemy.name;
      targetEnemy.health -= unit.attack;
      unit.state = "engaged";
      unit.lastAttackAt = nowSeconds;
      continue;
    }

    if (
      state.enemies.length === 0 &&
      state.castle.health > 0 &&
      CONFIG.battle.castleX - unit.x <= CONFIG.battle.castleAttackRange
    ) {
      unit.targetHint = "castle";
      state.castle.health -= unit.attack;
      unit.state = "engaged";
      unit.lastAttackAt = nowSeconds;
    }
  }
}

function applyEnemyAttacks(state, nowSeconds) {
  for (const enemy of state.enemies) {
    const targetUnit = findNearestAllyAhead(enemy, getLaneActors(state.battleUnits, enemy.lane));
    const attackInterval = getAttackInterval(enemy);

    if (!targetUnit || nowSeconds - enemy.lastAttackAt < attackInterval) {
      continue;
    }

    if (enemy.x - targetUnit.x <= enemy.attackRange) {
      targetUnit.health -= enemy.attack;
      enemy.state = "engaged";
      enemy.lastAttackAt = nowSeconds;
    }
  }
}

export function tickPassiveGold(state, deltaSeconds) {
  state.resources.gold += CONFIG.passiveGoldPerSecond * deltaSeconds;
}

export function spawnNextWave(state) {
  const waveDefinition = CONFIG.waves[state.battle.nextWaveIndex];
  if (!waveDefinition) {
    return false;
  }

  state.enemies = waveDefinition.map((definition, index) => {
    const enemy = createEnemy(definition);
    enemy.lane = definition.lane ?? index % CONFIG.battle.laneCount;
    enemy.x = CONFIG.battle.enemySpawnX + Math.floor(index / CONFIG.battle.laneCount) * 4;
    return enemy;
  });
  state.battle.status = "fighting";
  state.battle.log = `Wave ${state.battle.nextWaveIndex + 1} is attacking.`;
  state.battle.nextWaveIndex += 1;
  return true;
}

export function tickBattle(state, deltaSeconds, nowSeconds) {
  if (state.game.isOver) {
    return;
  }

  if (state.battleUnits.length > 0 && state.battle.nextWaveIndex < CONFIG.waves.length && state.enemies.length === 0) {
    if (state.battle.status !== "cooldown") {
      state.battle.status = "cooldown";
      state.battle.waveCooldownRemaining = CONFIG.battle.waveCooldownSeconds;
    } else {
      state.battle.waveCooldownRemaining -= deltaSeconds;
      if (state.battle.waveCooldownRemaining <= 0) {
        spawnNextWave(state);
      }
    }
  }

  resolveFriendlyMovement(state, deltaSeconds);
  resolveEnemyMovement(state, deltaSeconds);
  applyFriendlyAttacks(state, nowSeconds);
  applyEnemyAttacks(state, nowSeconds);

  state.enemies = removeDefeated(state.enemies);
  state.battleUnits = removeDefeated(state.battleUnits);
  state.castle.health = clamp(state.castle.health, 0, state.castle.maxHealth);

  if (state.enemies.length === 0 && state.battle.status === "fighting") {
    if (state.battle.nextWaveIndex >= CONFIG.waves.length) {
      state.battle.status = "siege";
      state.battle.log = "Final wave defeated. Finish off the castle.";
    } else {
      state.battle.status = "cooldown";
      state.battle.waveCooldownRemaining = CONFIG.battle.waveCooldownSeconds;
      state.battle.log = "Wave cleared. Next wave is preparing.";
    }
  }

  if (state.castle.health <= 0) {
    state.castle.health = 0;
    state.game.isOver = true;
    state.game.result = "win";
    state.battle.status = "won";
    state.battle.log = "Castle destroyed. Victory!";
  } else if (state.battleUnits.length === 0 && state.enemies.length > 0) {
    state.battle.log = "Your battle line fell. Mine more ore and deploy reinforcements.";
  } else if (state.battleUnits.length === 0 && state.battle.nextWaveIndex === 0) {
    state.battle.log = "Deploy a unit through the garrison.";
  }
}

export function getBattleSummary(state) {
  const squadPower = sum(state.battleUnits, (unit) => unit.attack);
  return {
    friendlyCount: state.battleUnits.length,
    enemyCount: state.enemies.length,
    squadPower
  };
}
