import { CONFIG } from "../config.js";
import { createEnemy } from "../factories.js";
import { clamp, generateId, sum } from "../utils.js";
import { initBattlePhysics, stepBattlePhysics, resetBattleBodies } from "../physics/battlePhysics.js";

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
  // Non-flying-capable actors can't even see flyers as candidates.
  const valid = actor.canHitFlying
    ? targets
    : targets.filter((target) => (target.movementType ?? "ground") !== "flying");

  // Kamikaze ignores the front line and makes for the backline directly.
  if (actor.movementType === "kamikaze") {
    const backline = valid.filter((target) => target.formationRow === "back");
    return chooseClosestTarget(actor, backline.length > 0 ? backline : valid);
  }

  return keepCurrentTarget(actor, valid) ?? chooseClosestTarget(actor, valid);
}

function markHit(target, nowSeconds) {
  target.hitUntil = nowSeconds + 0.16;
}

function pushSplashEffect(state, target, radius, nowSeconds) {
  state.battleEffects.push({
    id: generateId("splash"),
    type: "splash-ring",
    createdAt: nowSeconds,
    x: target.x ?? 0,
    y: target.y ?? 0,
    radius
  });

  if (state.battleEffects.length > 80) {
    state.battleEffects = state.battleEffects.slice(-80);
  }
}

function getSplashRadius(attacker) {
  return (attacker.splashRadius ?? 0) * (CONFIG.battle.splashRadiusMultiplier ?? 1);
}

// Unified damage for both sides: single-target, or splash over the effective
// `splashRadius` around the primary target (Громила, Маг, Камнемёт). The global
// `battle.splashRadiusMultiplier` knob lets us tune AoE reach live vs the
// combat spacing without touching per-class GDD numbers.
function applyDamage(state, attacker, target, defenders, nowSeconds) {
  const splashRadius = getSplashRadius(attacker);
  if (splashRadius > 0) {
    for (const entity of defenders) {
      if (getDistance(target, entity) <= splashRadius) {
        entity.health -= attacker.attack;
        markHit(entity, nowSeconds);
      }
    }
    pushSplashEffect(state, target, splashRadius, nowSeconds);
  } else {
    target.health -= attacker.attack;
    markHit(target, nowSeconds);
  }
}

function pushRangedAttackEffect(state, attacker, target, nowSeconds) {
  if (attacker.attackType !== "ranged" && attacker.attackType !== "ranged_aoe") {
    return;
  }

  state.battleEffects.push({
    id: generateId("shot"),
    type: "ranged-line",
    createdAt: nowSeconds,
    fromX: attacker.x ?? 0,
    fromY: attacker.y ?? CONFIG.battle.fieldHeight / 2,
    toX: target.x ?? 0,
    toY: target.y ?? 0
  });

  if (state.battleEffects.length > 80) {
    state.battleEffects = state.battleEffects.slice(-80);
  }
}

function getSpawnY(index, total) {
  const padding = CONFIG.battle.spawnSpreadPadding ?? 3.5;
  const usableHeight = Math.max(1, CONFIG.battle.fieldHeight - padding * 2);
  const ratio = total <= 1 ? 0.5 : index / (total - 1);
  return padding + usableHeight * ratio;
}

function getEnemyRowSpawnX(formationRow) {
  const rows = CONFIG.battle.enemyRowSpawnX ?? {};
  if (rows[formationRow] !== undefined) {
    return rows[formationRow];
  }
  const front = rows.front ?? CONFIG.battle.enemySpawnX;
  return formationRow === "back" ? front + 8 : front;
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

function getWaveGroups(wave) {
  if (Array.isArray(wave)) {
    // Legacy flat format: treat the whole wave as one front group.
    return [{ formationRow: "front", enemies: wave }];
  }
  return wave.groups ?? [];
}

function createWaveEnemies(state, waveIndex) {
  const wave = CONFIG.waves[waveIndex];
  if (!wave) {
    return [];
  }

  const groups = getWaveGroups(wave);
  const flat = [];
  let globalIndex = 0;
  for (const group of groups) {
    const row = group.formationRow ?? "front";
    const enemies = group.enemies ?? [];
    enemies.forEach((definition, indexInGroup) => {
      flat.push({ definition, row, globalIndex, indexInGroup, groupSize: enemies.length });
      globalIndex += 1;
    });
  }

  const defeatedIndexes = getDefeatedEnemyIndexes(state, waveIndex);
  const survivors = flat.filter((item) => !defeatedIndexes.has(item.globalIndex));

  return survivors.map((item) => {
    const enemy = createEnemy(item.definition, item.row);
    enemy.waveIndex = waveIndex;
    enemy.waveEnemyIndex = item.globalIndex;
    enemy.x = getEnemyRowSpawnX(item.row);
    enemy.y = getSpawnY(item.indexInGroup, item.groupSize);
    return enemy;
  });
}

function assignTargets(state) {
  for (const unit of state.battleUnits) {
    const targetEnemy = chooseTarget(unit, state.enemies);
    if (targetEnemy) {
      unit.targetId = targetEnemy.id;
      unit.targetHint = targetEnemy.name;
    } else {
      unit.targetId = null;
      unit.targetHint = "advance";
    }
  }

  for (const enemy of state.enemies) {
    const targetUnit = chooseTarget(enemy, state.battleUnits);
    enemy.targetId = targetUnit?.id ?? null;
    enemy.targetHint = targetUnit?.name ?? "advance";
  }
}

// Kamikaze: no ranged/melee attack — it detonates on contact and dies.
function updateKamikazes(state, attackers, defenders, nowSeconds) {
  const contactGap = CONFIG.battle.kamikazeContactGap ?? 0.5;

  for (const actor of attackers) {
    if (actor.movementType !== "kamikaze" || actor.health <= 0) {
      continue;
    }

    const target = defenders.find((entity) => entity.id === actor.targetId) ?? null;
    if (!target || getBodyGap(actor, target) >= contactGap) {
      continue;
    }

    const radius = actor.explosionRadius ?? 0;
    const damage = actor.explosionDamage ?? 0;
    for (const entity of defenders) {
      if (getDistance(actor, entity) <= radius) {
        entity.health -= damage;
        markHit(entity, nowSeconds);
      }
    }
    pushSplashEffect(state, actor, radius, nowSeconds);
    actor.health = 0;
    actor.state = "exploded";
  }
}

function applySideAttacks(state, attackers, defenders, nowSeconds) {
  for (const actor of attackers) {
    if (actor.movementType === "kamikaze") {
      continue; // handled by updateKamikazes
    }

    const attackInterval = getAttackInterval(actor);
    const target = defenders.find((entity) => entity.id === actor.targetId) ?? null;

    if (!target) {
      actor.state = "marching";
      continue;
    }

    const gap = getBodyGap(actor, target);
    const range = getAttackRange(actor);
    if (gap <= range && nowSeconds - actor.lastAttackAt >= attackInterval) {
      applyDamage(state, actor, target, defenders, nowSeconds);
      actor.state = "engaged";
      actor.lastAttackAt = nowSeconds;
      pushRangedAttackEffect(state, actor, target, nowSeconds);
    } else {
      actor.state = gap <= range ? "ready" : "marching";
    }
  }
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
}

function returnSurvivorsToBridgehead(state) {
  for (const unit of state.battleUnits) {
    unit.health = unit.maxHealth;
    unit.state = "ready";
    unit.targetId = null;
    unit.targetHint = "bridgehead";
    unit.lastAttackAt = 0;
    unit.lastHealTime = 0;
    unit.poisonStacks = [];
    unit.x = CONFIG.battle.allySpawnX;
    unit.y = CONFIG.battle.fieldHeight / 2;
    state.bridgeheadUnits.push(unit);
  }
  state.battleUnits = [];
}

function handleVictory(state) {
  const clearedWaveIndex = state.battle.currentWaveIndex;
  clearWaveProgress(state, clearedWaveIndex);
  returnSurvivorsToBridgehead(state);

  const nextWaveIndex = clearedWaveIndex + 1;
  if (nextWaveIndex >= CONFIG.waves.length) {
    state.battle.status = "won";
    state.battle.log = "Все волны отбиты. Победа!";
    state.game.isOver = true;
    state.game.result = "win";
  } else {
    state.battle.currentWaveIndex = nextWaveIndex;
    state.battle.status = "idle";
    state.battle.log = `Волна ${clearedWaveIndex + 1} зачищена. Готовьте отряд к волне ${nextWaveIndex + 1}.`;
  }
}

function handleDefeat(state) {
  const waveIndex = state.battle.currentWaveIndex;
  // Gold for enemies killed this attempt was already awarded on death.
  // Reset the wave so the survivors reappear at full HP on the next attempt.
  clearWaveProgress(state, waveIndex);
  state.enemies = [];
  state.battle.status = "lost";
  state.battle.log = "Отряд пал. Волна восстановлена. Соберите новый состав и попробуйте снова.";
}

export function isBattleActive(state) {
  return state.battle.status === "fighting";
}

export function startBattle(state) {
  if (state.enemies.length === 0) {
    state.enemies = createWaveEnemies(state, state.battle.currentWaveIndex);
  }
  // Clear stale bodies so allies and enemies respawn at their spawn coords
  // instead of wherever they were parked when the previous battle ended.
  resetBattleBodies();
  state.battle.status = "fighting";
}

export function tickBattle(state, deltaSeconds, nowSeconds) {
  initBattlePhysics();

  if (state.game.isOver || state.battle.status !== "fighting") {
    return;
  }

  assignTargets(state);
  stepBattlePhysics(state, deltaSeconds);
  updateKamikazes(state, state.battleUnits, state.enemies, nowSeconds);
  updateKamikazes(state, state.enemies, state.battleUnits, nowSeconds);
  applySideAttacks(state, state.battleUnits, state.enemies, nowSeconds);
  applySideAttacks(state, state.enemies, state.battleUnits, nowSeconds);
  cleanupDefeated(state);

  const alliesAlive = state.battleUnits.length > 0;
  const enemiesAlive = state.enemies.length > 0;

  if (!enemiesAlive) {
    handleVictory(state);
  } else if (!alliesAlive) {
    handleDefeat(state);
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
