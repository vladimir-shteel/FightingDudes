import { CONFIG } from "../config.js";

export const WORKER_TRAIT_KEYS = ["yield", "golden", "rush"];

function getTraitConfig() {
  return CONFIG.workerTraits ?? {};
}

function getLineConfig(key) {
  return getTraitConfig().lines?.[key] ?? {};
}

export function normalizeTraitVector(traits = {}) {
  return Object.fromEntries(
    WORKER_TRAIT_KEYS.map((key) => [key, Math.max(0, Math.floor(traits[key] ?? 0))])
  );
}

export function getTraitTotal(traits = {}) {
  return WORKER_TRAIT_KEYS.reduce((sum, key) => sum + (traits[key] ?? 0), 0);
}

export function getDominantTraitKey(traits = {}) {
  return WORKER_TRAIT_KEYS
    .map((key) => ({ key, value: traits[key] ?? 0 }))
    .sort((left, right) => right.value - left.value || WORKER_TRAIT_KEYS.indexOf(left.key) - WORKER_TRAIT_KEYS.indexOf(right.key))[0]?.key ?? "yield";
}

export function getTraitLabel(key) {
  return getLineConfig(key).label ?? key;
}

export function getTraitIcon(key) {
  return getLineConfig(key).icon ?? key.charAt(0).toUpperCase();
}

export function rollWorkerTraitVector() {
  const weights = WORKER_TRAIT_KEYS.map((key) => ({
    key,
    weight: Math.max(0, getLineConfig(key).rollWeight ?? 1)
  }));
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * Math.max(0.001, totalWeight);

  for (const item of weights) {
    roll -= item.weight;
    if (roll <= 0) {
      return normalizeTraitVector({ [item.key]: 1 });
    }
  }

  return normalizeTraitVector({ yield: 1 });
}

export function mergeWorkerTraitVectors(firstTraits = {}, secondTraits = {}) {
  const mergeBonus = getTraitConfig().mergeBonusPoints ?? 1;
  const merged = normalizeTraitVector();
  for (const key of WORKER_TRAIT_KEYS) {
    merged[key] = (firstTraits[key] ?? 0) + (secondTraits[key] ?? 0);
  }
  merged[getDominantTraitKey(merged)] += mergeBonus;
  return normalizeTraitVector(merged);
}

export function ensureWorkerTraits(unit) {
  if (!unit) {
    return normalizeTraitVector();
  }
  unit.traits = normalizeTraitVector(unit.traits);
  return unit.traits;
}

export function getWorkerYieldMultiplier(unit) {
  const traits = ensureWorkerTraits(unit);
  const perPoint = getLineConfig("yield").resourceMultiplierPerPoint ?? 0;
  return 1 + traits.yield * perPoint;
}

export function getWorkerGoldenConversion(unit) {
  const traits = ensureWorkerTraits(unit);
  const perPoint = getLineConfig("golden").goldPerResourcePerPoint ?? 0;
  return traits.golden * perPoint;
}

export function getWorkerRushMultiplier(unit) {
  const traits = ensureWorkerTraits(unit);
  const shift = getTraitConfig().battleShift ?? {};
  const base = shift.baseMultiplier ?? 1;
  const perPoint = getLineConfig("rush").battleMultiplierPerPoint ?? 0;
  return base + traits.rush * perPoint;
}

export function isWorkerBattleShiftLocked(state, unit) {
  return Boolean(state.fortress.battle.active && unit?.battleShiftCommitted);
}
