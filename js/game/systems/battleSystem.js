import { CONFIG } from "../config.js";
import { createEnemy } from "../factories.js";
import { clamp, sum } from "../utils.js";

function getAttackInterval(actor) {
  return 1 / actor.attackSpeed;
}

function getFirstAliveEnemy(state) {
  return state.enemies.find((enemy) => enemy.health > 0) ?? null;
}

function getFirstAliveBattleUnit(state) {
  return state.battleUnits.find((unit) => unit.health > 0) ?? null;
}

function removeDefeated(list) {
  return list.filter((item) => item.health > 0);
}

export function tickPassiveGold(state, deltaSeconds) {
  state.resources.gold += CONFIG.passiveGoldPerSecond * deltaSeconds;
}

export function spawnNextWave(state) {
  const waveDefinition = CONFIG.waves[state.battle.nextWaveIndex];
  if (!waveDefinition) {
    return false;
  }

  state.enemies = waveDefinition.map((definition) => createEnemy(definition));
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

  for (const unit of state.battleUnits) {
    const targetEnemy = getFirstAliveEnemy(state);
    const attackInterval = getAttackInterval(unit);

    if (nowSeconds - unit.lastAttackAt < attackInterval) {
      continue;
    }

    if (targetEnemy) {
      unit.targetHint = targetEnemy.name;
      targetEnemy.health -= unit.attack;
    } else if (state.castle.health > 0) {
      unit.targetHint = "castle";
      state.castle.health -= unit.attack;
    }

    unit.lastAttackAt = nowSeconds;
  }

  for (const enemy of state.enemies) {
    const targetUnit = getFirstAliveBattleUnit(state);
    const attackInterval = getAttackInterval(enemy);

    if (!targetUnit || nowSeconds - enemy.lastAttackAt < attackInterval) {
      continue;
    }

    targetUnit.health -= enemy.attack;
    enemy.lastAttackAt = nowSeconds;
  }

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
