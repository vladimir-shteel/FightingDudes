import { CONFIG } from "../config.js";
import { createEnemy } from "../factories.js";
import { clamp, generateId, sum } from "../utils.js";
import { initBattlePhysics, stepBattlePhysics } from "../physics/battlePhysics.js";

function getAttackInterval(actor) {
  return 1 / actor.attackSpeed;
}

function getDistance(left, right) {
  return Math.hypot((left.x ?? 0) - (right.x ?? 0), (left.y ?? 0) - (right.y ?? 0));
}

function getBodyGap(left, right) {
  const leftRadius = left.physicsRadius ?? CONFIG.battle.physicsRadius ?? 0;
  const rightRadius = right.physicsRadius ?? CONFIG.battle.physicsRadius ?? 0;
  return Math.max(0, getDistance(left, right) - leftRadius - rightRadius);
}

function getAttackRange(actor) {
  return (actor.attackRange ?? ((CONFIG.battle.baseAttackReach ?? 0) + (actor.attackRangeBonus ?? 0))) +
    (CONFIG.battle.attackRangeTolerance ?? 0);
}

function getCastleDistance(actor) {
  return Math.max(
    0,
    Math.hypot((actor.x ?? 0) - CONFIG.battle.castleX, (actor.y ?? 0) - CONFIG.battle.castleY) -
      CONFIG.battle.castleRadius -
      (actor.physicsRadius ?? CONFIG.battle.physicsRadius ?? 0)
  );
}

function chooseClosestTarget(actor, targets) {
  if (targets.length === 0) {
    return null;
  }

  let bestTarget = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const distance = getDistance(actor, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTarget = target;
    }
  }

  return bestTarget;
}

function keepCurrentTarget(actor, targets) {
  const currentTarget = targets.find((target) => target.id === actor.targetId) ?? null;
  if (!currentTarget) {
    return null;
  }

  const currentDistance = getDistance(actor, currentTarget);
  const leashDistance = getAttackRange(actor) + (CONFIG.battle.targetLeashDistance ?? 8);
  return currentDistance <= leashDistance ? currentTarget : null;
}

function chooseTarget(actor, targets) {
  return keepCurrentTarget(actor, targets) ?? chooseClosestTarget(actor, targets);
}

function markHit(target, nowSeconds) {
  target.hitUntil = nowSeconds + 0.16;
}

function pushRangedAttackEffect(state, attacker, target, nowSeconds) {
  if (attacker.attackType !== "ranged") {
    return;
  }

  state.battleEffects.push({
    id: generateId("shot"),
    type: "ranged-line",
    createdAt: nowSeconds,
    fromX: attacker.x ?? 0,
    fromY: attacker.y ?? CONFIG.battle.fieldHeight / 2,
    toX: target.x ?? CONFIG.battle.castleX,
    toY: target.y ?? CONFIG.battle.castleY
  });

  if (state.battleEffects.length > 80) {
    state.battleEffects = state.battleEffects.slice(-80);
  }
}

function getSpawnY(index, total) {
  const padding = 3.5;
  const usableHeight = Math.max(1, CONFIG.battle.fieldHeight - padding * 2);
  const ratio = total <= 1 ? 0.5 : index / (total - 1);
  return padding + usableHeight * ratio;
}

function getDefeatedEnemyIndexes(state, waveIndex) {
  const defeated = state.battle.waveProgress.defeatedEnemyIndexesByWave[waveIndex] ?? [];
  return new Set(defeated);
}

function markWaveEnemyDefeated(state, enemy) {
  if (enemy.waveIndex === undefined || enemy.waveEnemyIndex === undefined) {
    return;
  }

  const progress = state.battle.waveProgress.defeatedEnemyIndexesByWave;
  const defeated = new Set(progress[enemy.waveIndex] ?? []);
  defeated.add(enemy.waveEnemyIndex);
  progress[enemy.waveIndex] = [...defeated].sort((left, right) => left - right);
}

function clearWaveProgress(state, waveIndex) {
  delete state.battle.waveProgress.defeatedEnemyIndexesByWave[waveIndex];
}

function createWaveEnemies(state, waveIndex) {
  const waveDefinition = CONFIG.waves[waveIndex];
  if (!waveDefinition) {
    return [];
  }

  const defeatedIndexes = getDefeatedEnemyIndexes(state, waveIndex);
  const survivors = waveDefinition
    .map((definition, index) => ({ definition, index }))
    .filter((item) => !defeatedIndexes.has(item.index));

  return survivors.map((item, spawnIndex) => {
    const enemy = createEnemy(item.definition);
    enemy.waveIndex = waveIndex;
    enemy.waveEnemyIndex = item.index;
    enemy.x = CONFIG.battle.enemySpawnX + Math.floor(spawnIndex / 2) * 1.8;
    enemy.y = getSpawnY(spawnIndex, survivors.length);
    return enemy;
  });
}

function assignTargets(state) {
  for (const unit of state.battleUnits) {
    const targetEnemy = chooseTarget(unit, state.enemies.filter((enemy) => !enemy.isRetreating));
    if (targetEnemy) {
      unit.targetId = targetEnemy.id;
      unit.targetHint = targetEnemy.name;
    } else {
      unit.targetId = null;
      unit.targetHint = "castle";
    }
  }

  for (const enemy of state.enemies) {
    if (enemy.isRetreating) {
      enemy.targetId = null;
      enemy.targetHint = "castle";
      continue;
    }

    const targetUnit = chooseTarget(enemy, state.battleUnits);
    enemy.targetId = targetUnit?.id ?? null;
    enemy.targetHint = targetUnit?.name ?? "advance";
  }
}

function applyFriendlyAttacks(state, nowSeconds) {
  for (const unit of state.battleUnits) {
    const attackInterval = getAttackInterval(unit);
    const targetEnemy = state.enemies.find((enemy) => enemy.id === unit.targetId && !enemy.isRetreating) ?? null;

    if (targetEnemy) {
      const targetDistance = getBodyGap(unit, targetEnemy);
      const attackRange = getAttackRange(unit);
      if (targetDistance <= attackRange && nowSeconds - unit.lastAttackAt >= attackInterval) {
        unit.state = "engaged";
        targetEnemy.health -= unit.attack;
        unit.lastAttackAt = nowSeconds;
        markHit(targetEnemy, nowSeconds);
        pushRangedAttackEffect(state, unit, targetEnemy, nowSeconds);
      } else {
        unit.state = targetDistance <= attackRange ? "ready" : "marching";
      }
      continue;
    }

    const distanceToCastle = getCastleDistance(unit);
    const castleAttackRange = getAttackRange(unit) + (CONFIG.battle.castleAttackRangeBonus ?? 0);
    if (
      state.enemies.filter((enemy) => !enemy.isRetreating).length === 0 &&
      state.castle.health > 0 &&
      distanceToCastle <= castleAttackRange &&
      nowSeconds - unit.lastAttackAt >= attackInterval
    ) {
      unit.state = "engaged";
      state.castle.health -= unit.attack;
      unit.lastAttackAt = nowSeconds;
      state.castle.hitUntil = nowSeconds + 0.16;
      pushRangedAttackEffect(state, unit, state.castle, nowSeconds);
    } else {
      unit.state = distanceToCastle <= castleAttackRange ? "ready" : "marching";
    }
  }
}

function applyEnemyAttacks(state, nowSeconds) {
  for (const enemy of state.enemies) {
    if (enemy.isRetreating) {
      enemy.state = "retreating";
      continue;
    }

    const attackInterval = getAttackInterval(enemy);
    const targetUnit = state.battleUnits.find((unit) => unit.id === enemy.targetId) ?? null;

    if (!targetUnit) {
      enemy.state = "marching";
      continue;
    }

    const targetDistance = getBodyGap(enemy, targetUnit);
    const attackRange = getAttackRange(enemy);
    if (targetDistance <= attackRange && nowSeconds - enemy.lastAttackAt >= attackInterval) {
      targetUnit.health -= enemy.attack;
      enemy.state = "engaged";
      enemy.lastAttackAt = nowSeconds;
      markHit(targetUnit, nowSeconds);
    } else {
      enemy.state = targetDistance <= attackRange ? "ready" : "marching";
    }
  }
}

function startEnemyRetreat(state) {
  if (state.enemies.length === 0 || state.battle.status === "retreating") {
    return;
  }

  state.battle.retreatWaveIndex = state.battle.activeWaveIndex;
  state.battle.status = "retreating";
  state.battle.log = "Your last ally fell. The wave is retreating back to the castle.";
  for (const enemy of state.enemies) {
    enemy.isRetreating = true;
    enemy.targetId = null;
    enemy.targetHint = "castle";
    enemy.state = "retreating";
  }
}

function removeExitedRetreatingEnemies(state) {
  state.enemies = state.enemies.filter((enemy) => {
    if (!enemy.isRetreating) {
      return true;
    }

    return getCastleDistance(enemy) > Math.max(1.2, CONFIG.battle.castleRadius * 0.35);
  });
}

function awardEnemyGold(state, enemy) {
  const reward = enemy.goldReward ?? 0;
  if (reward <= 0) {
    return;
  }

  state.resources.gold = clamp(state.resources.gold + reward, 0, Number.MAX_SAFE_INTEGER);
  state.resourceBursts.push({
    id: generateId("kill-gold"),
    battlefield: { x: enemy.x ?? 0, y: enemy.y ?? 0 },
    payouts: [{ resourceKey: "gold", amount: reward }]
  });
}

function cleanupDefeated(state) {
  state.battleUnits = state.battleUnits.filter((unit) => unit.health > 0);
  state.enemies = state.enemies.filter((enemy) => {
    if (enemy.health > 0) {
      return true;
    }

    markWaveEnemyDefeated(state, enemy);
    awardEnemyGold(state, enemy);
    return false;
  });
  removeExitedRetreatingEnemies(state);
}

function spawnWave(state, waveIndex, message) {
  const enemies = createWaveEnemies(state, waveIndex);
  if (enemies.length === 0) {
    return false;
  }

  state.enemies = enemies;
  state.battle.activeWaveIndex = waveIndex;
  state.battle.status = "fighting";
  state.battle.log = message;
  return true;
}

export function tickPassiveGold() {}

export function spawnNextWave(state) {
  const waveDefinition = CONFIG.waves[state.battle.nextWaveIndex];
  if (!waveDefinition) {
    return false;
  }

  const didSpawn = spawnWave(
    state,
    state.battle.nextWaveIndex,
    `Wave ${state.battle.nextWaveIndex + 1} is attacking.`
  );
  if (didSpawn) {
    state.battle.nextWaveIndex += 1;
    state.battle.retreatWaveIndex = null;
  }
  return didSpawn;
}

export function tickBattle(state, deltaSeconds, nowSeconds) {
  initBattlePhysics();

  if (state.game.isOver) {
    return;
  }

  if (state.battle.retreatWaveIndex !== null && state.battleUnits.length > 0 && state.enemies.length === 0) {
    const respawnIndex = state.battle.retreatWaveIndex;
    state.battle.retreatWaveIndex = null;
    const didRespawn = spawnWave(state, respawnIndex, `Wave ${respawnIndex + 1} marches out again.`);
    if (!didRespawn) {
      clearWaveProgress(state, respawnIndex);
      state.battle.activeWaveIndex = null;
      state.battle.status = state.battle.nextWaveIndex >= CONFIG.waves.length ? "siege" : "cooldown";
      state.battle.waveCooldownRemaining = CONFIG.battle.waveCooldownSeconds;
      state.battle.log = "The last survivors of that wave were already defeated.";
    }
  } else if (
    state.battleUnits.length > 0 &&
    state.battle.nextWaveIndex < CONFIG.waves.length &&
    state.enemies.length === 0 &&
    state.battle.retreatWaveIndex === null
  ) {
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

  assignTargets(state);
  stepBattlePhysics(state, deltaSeconds);
  applyFriendlyAttacks(state, nowSeconds);
  applyEnemyAttacks(state, nowSeconds);
  cleanupDefeated(state);

  if (state.battleUnits.length === 0 && state.enemies.some((enemy) => !enemy.isRetreating)) {
    startEnemyRetreat(state);
  }

  state.castle.health = Math.max(0, Math.min(state.castle.maxHealth, state.castle.health));

  if (state.enemies.length === 0 && state.battle.status === "fighting") {
    const clearedWaveIndex = state.battle.activeWaveIndex;
    if (state.battle.nextWaveIndex >= CONFIG.waves.length) {
      state.battle.status = "siege";
      state.battle.log = "Final wave defeated. Finish off the castle.";
    } else {
      state.battle.status = "cooldown";
      state.battle.waveCooldownRemaining = CONFIG.battle.waveCooldownSeconds;
      state.battle.log = "Wave cleared. Next wave is preparing.";
    }
    if (clearedWaveIndex !== null) {
      clearWaveProgress(state, clearedWaveIndex);
    }
    state.battle.activeWaveIndex = null;
  } else if (state.enemies.length === 0 && state.battle.status === "retreating") {
    state.battle.log = "The wave hid in the castle. Deploy a new ally to bring them back out.";
    state.battle.activeWaveIndex = null;
  }

  const canWin = state.battle.nextWaveIndex >= CONFIG.waves.length &&
    state.enemies.length === 0 &&
    state.battle.retreatWaveIndex === null;

  if (state.castle.health <= 0 && canWin) {
    state.castle.health = 0;
    state.game.isOver = true;
    state.game.result = "win";
    state.battle.status = "won";
    state.battle.log = "Castle destroyed. Victory!";
  } else if (state.castle.health <= 0) {
    state.castle.health = 1;
    state.battle.log = "The castle is barely standing. Clear the remaining waves first.";
  } else if (state.battleUnits.length === 0 && state.enemies.length > 0) {
    state.battle.log = "Your battle line fell. The enemies are pulling back to the castle.";
  } else if (state.battleUnits.length === 0 && state.battle.nextWaveIndex === 0 && state.battle.retreatWaveIndex === null) {
    state.battle.log = state.bridgeheadUnits.length > 0
      ? "Units are waiting on the bridgehead. Press To Battle to deploy them."
      : "Prepare units in the garrison, then send them from the bridgehead.";
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
