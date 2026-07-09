import { CONFIG, getMergeMaxLevel } from "../config.js";
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

// Берсерк: атака растёт по мере потери HP — ×1 при полном здоровье до ×3 у смерти.
function getEffectiveAttack(attacker) {
  if (!attacker.berserkerScaling || !attacker.maxHealth) {
    return attacker.attack;
  }
  const missing = 1 - Math.max(0, attacker.health) / attacker.maxHealth;
  return attacker.attack * (1 + 2 * Math.min(1, Math.max(0, missing)));
}

// Отравитель: вешает стак яда (DoT, тикает в tickPoison, игнорирует броню).
function applyPoison(attacker, target, nowSeconds) {
  if ((attacker.poisonDps ?? 0) <= 0 || (attacker.poisonDuration ?? 0) <= 0) {
    return;
  }
  if (!Array.isArray(target.poisonStacks)) {
    target.poisonStacks = [];
  }
  target.poisonStacks.push({ dps: attacker.poisonDps, until: nowSeconds + attacker.poisonDuration });
}

// Unified damage for both sides: single-target, or splash over the effective
// `splashRadius` around the primary target (Громила, Маг, Камнемёт). The global
// `battle.splashRadiusMultiplier` knob lets us tune AoE reach live vs the
// combat spacing without touching per-class GDD numbers.
function applyDamage(state, attacker, target, defenders, nowSeconds) {
  const damage = getEffectiveAttack(attacker);
  const splashRadius = getSplashRadius(attacker);
  if (splashRadius > 0) {
    for (const entity of defenders) {
      if (getDistance(target, entity) <= splashRadius) {
        entity.health -= damage;
        applyPoison(attacker, entity, nowSeconds);
        markHit(entity, nowSeconds);
      }
    }
    pushSplashEffect(state, target, splashRadius, nowSeconds);
  } else {
    target.health -= damage;
    applyPoison(attacker, target, nowSeconds);
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

// Яд: суммируем активные стаки, тикаем DoT, отбрасываем истёкшие.
function tickPoison(entities, deltaSeconds, nowSeconds) {
  for (const entity of entities) {
    const stacks = entity.poisonStacks;
    if (!Array.isArray(stacks) || stacks.length === 0) {
      continue;
    }
    let dps = 0;
    const active = [];
    for (const stack of stacks) {
      if (stack.until > nowSeconds) {
        dps += stack.dps;
        active.push(stack);
      }
    }
    entity.poisonStacks = active;
    if (dps > 0) {
      entity.health -= dps * deltaSeconds;
      entity.hitUntil = Math.max(entity.hitUntil ?? 0, nowSeconds + 0.05);
    }
  }
}

// Паладин: раз в healInterval лечит самого раненого союзника в healRadius.
function updateHealers(state, allies, nowSeconds) {
  for (const healer of allies) {
    if ((healer.healAmount ?? 0) <= 0 || healer.health <= 0) {
      continue;
    }
    const interval = healer.healInterval ?? 0;
    if (interval <= 0 || nowSeconds - (healer.lastHealTime ?? 0) < interval) {
      continue;
    }

    const radius = healer.healRadius ?? 0;
    let best = null;
    let bestMissing = 0;
    for (const ally of allies) {
      if (ally === healer || ally.health <= 0 || ally.health >= ally.maxHealth) {
        continue;
      }
      if (getDistance(healer, ally) > radius) {
        continue;
      }
      const missing = ally.maxHealth - ally.health;
      if (missing > bestMissing) {
        bestMissing = missing;
        best = ally;
      }
    }

    if (best) {
      best.health = Math.min(best.maxHealth, best.health + healer.healAmount);
      healer.lastHealTime = nowSeconds;
      pushSplashEffect(state, best, 1.4, nowSeconds);
    }
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

function getWaveLocation(waveIndex) {
  const wave = CONFIG.waves[waveIndex];
  if (!wave || Array.isArray(wave)) {
    return 1;
  }
  return wave.location ?? 1;
}

// A location is complete when the just-cleared wave was its last one (the next
// wave belongs to a different location, or there is no next wave).
function markLocationProgress(state, clearedWaveIndex, nextWaveIndex) {
  if (!state.progress) {
    state.progress = { completedLocations: 0 };
  }
  const clearedLocation = getWaveLocation(clearedWaveIndex);
  const nextLocation = nextWaveIndex < CONFIG.waves.length ? getWaveLocation(nextWaveIndex) : null;
  const locationDone = nextLocation === null || nextLocation !== clearedLocation;

  if (locationDone && state.progress.completedLocations < clearedLocation) {
    state.progress.completedLocations = clearedLocation;
    return { justCleared: clearedLocation, nextLocation };
  }
  return { justCleared: null, nextLocation };
}

function handleVictory(state) {
  const clearedWaveIndex = state.battle.currentWaveIndex;
  clearWaveProgress(state, clearedWaveIndex);
  returnSurvivorsToBridgehead(state);

  const nextWaveIndex = clearedWaveIndex + 1;
  const { justCleared, nextLocation } = markLocationProgress(state, clearedWaveIndex, nextWaveIndex);

  if (nextWaveIndex >= CONFIG.waves.length) {
    state.battle.status = "won";
    state.battle.log = "Все волны отбиты. Победа!";
    state.game.isOver = true;
    state.game.result = "win";
  } else {
    state.battle.currentWaveIndex = nextWaveIndex;
    state.battle.status = "idle";
    if (justCleared) {
      state.battle.log =
        `🏰 Локация ${justCleared} пройдена! Слияние теперь до ур.${getMergeMaxLevel(state)}. ` +
        `Впереди Локация ${nextLocation}.`;
      state.battle.locationToast = {
        seq: (state.battle.locationToast?.seq ?? 0) + 1,
        location: justCleared,
        mergeCap: getMergeMaxLevel(state)
      };
    } else {
      state.battle.log = `Волна ${clearedWaveIndex + 1} зачищена. Готовьте отряд к волне ${nextWaveIndex + 1}.`;
    }
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
  updateHealers(state, state.battleUnits, nowSeconds);
  updateHealers(state, state.enemies, nowSeconds);
  applySideAttacks(state, state.battleUnits, state.enemies, nowSeconds);
  applySideAttacks(state, state.enemies, state.battleUnits, nowSeconds);
  tickPoison(state.battleUnits, deltaSeconds, nowSeconds);
  tickPoison(state.enemies, deltaSeconds, nowSeconds);
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
