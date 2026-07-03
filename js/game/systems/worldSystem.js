import { CONFIG, getWorldPhaseConfig } from "../config.js";

function applyPhase(state, phaseKey) {
  const phase = getWorldPhaseConfig(phaseKey);
  state.world.phase = phaseKey;
  state.world.label = phase?.label ?? phaseKey;
  state.world.icon = phase?.icon ?? "";
  state.world.description = phase?.description ?? "";
}

function pickPhaseForWave(waveNumber) {
  const cycle = CONFIG.worldPhases.cycle ?? ["day"];
  const stormChance = CONFIG.worldPhases.stormChance ?? 0;
  const base = cycle[waveNumber % cycle.length] ?? cycle[0] ?? "day";
  if (stormChance > 0 && Math.random() < stormChance) {
    return "storm";
  }
  return base;
}

export function rollInitialWorldPhase(state) {
  applyPhase(state, pickPhaseForWave(0));
}

export function rollWorldPhaseForWave(state, waveIndex) {
  applyPhase(state, pickPhaseForWave(Math.max(0, waveIndex)));
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
