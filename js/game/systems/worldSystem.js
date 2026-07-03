import { CONFIG, getWorldPhaseConfig } from "../config.js";

export function updateWorldPhase(state) {
  const cycle = CONFIG.worldPhases.cycle ?? ["day"];
  const waveNumber = Math.max(0, state.battle.activeWaveIndex ?? state.battle.nextWaveIndex ?? 0);
  const phaseKey = cycle[waveNumber % cycle.length] ?? cycle[0] ?? "day";
  const phase = getWorldPhaseConfig(phaseKey);
  state.world.phase = phaseKey;
  state.world.label = phase?.label ?? phaseKey;
  state.world.description = phase?.description ?? "";
}

export function getWorldAttackMultiplier(state, side) {
  const phase = getWorldPhaseConfig(state.world.phase);
  return side === "enemy"
    ? phase?.enemyAttackMultiplier ?? 1
    : phase?.allyAttackMultiplier ?? 1;
}

export function getWorldMoveMultiplier(state, side) {
  const phase = getWorldPhaseConfig(state.world.phase);
  return side === "enemy"
    ? phase?.enemyMoveMultiplier ?? 1
    : phase?.allyMoveMultiplier ?? 1;
}

export function getWorldAttackRangeBonus(state, actor, side) {
  const phase = getWorldPhaseConfig(state.world.phase);
  if (side === "ally" && actor.attackType === "ranged") {
    return phase?.allyRangedAttackRangeBonus ?? 0;
  }
  if (side === "enemy") {
    return phase?.enemyAttackRangeBonus ?? 0;
  }
  return phase?.allyAttackRangeBonus ?? 0;
}
