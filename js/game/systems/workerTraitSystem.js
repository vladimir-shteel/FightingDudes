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
  return base + traits.rush * perPoint + getCapstoneRushBonus(unit);
}

export function isWorkerBattleShiftLocked(state, unit) {
  return Boolean(state.fortress.battle.active && unit?.battleShiftCommitted);
}

function getCapstoneConfig() {
  return getTraitConfig().capstones ?? {};
}

const HYBRID_ORDER = ["foreman", "warlord"];

export function pickCapstoneCandidates(traits = {}) {
  const normalized = normalizeTraitVector(traits);
  const dominantKey = getDominantTraitKey(normalized);
  const dominantValue = normalized[dominantKey] ?? 0;
  const dominantChoices = (getCapstoneConfig()[dominantKey] ?? []).map((entry) => entry.id);

  const candidates = [...dominantChoices];

  const secondKey = WORKER_TRAIT_KEYS
    .filter((key) => key !== dominantKey)
    .sort((left, right) => (normalized[right] ?? 0) - (normalized[left] ?? 0))[0];
  const secondValue = normalized[secondKey] ?? 0;

  if (dominantValue > 0 && secondValue >= dominantValue * 0.6) {
    const pairKey = [dominantKey, secondKey].sort().join("+");
    const hybridId = pairKey === "golden+yield" ? "foreman" : pairKey === "rush+yield" ? "warlord" : null;
    if (hybridId) {
      candidates.push(hybridId);
    }
  }

  return candidates;
}

export function getWorkerCapstoneEffect(unit) {
  if (!unit?.capstone) {
    return null;
  }
  const capstones = getCapstoneConfig();
  for (const key of Object.keys(capstones)) {
    const found = (capstones[key] ?? []).find((entry) => entry.id === unit.capstone);
    if (found) {
      return found;
    }
  }
  return null;
}

export function getCapstoneYieldMultiplier(unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  if (!capstone) {
    return 1;
  }
  if (capstone.effect.kind === "yieldMul") {
    return capstone.effect.value ?? 1;
  }
  if (capstone.effect.kind === "foreman") {
    return 1 + 0.4;
  }
  return 1;
}

export function getCapstoneGoldenBonus(unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  if (!capstone) {
    return 0;
  }
  if (capstone.effect.kind === "goldenConversion") {
    return capstone.effect.value ?? 0;
  }
  if (capstone.effect.kind === "foreman") {
    return 0.08;
  }
  return 0;
}

export function getCapstonePassiveGoldPerSecond(unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  if (!capstone || capstone.effect.kind !== "passiveGold") {
    return 0;
  }
  return capstone.effect.value ?? 0;
}

export function getCapstoneRushBonus(unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  if (!capstone) {
    return 0;
  }
  if (capstone.effect.kind === "rushBonus") {
    return capstone.effect.value ?? 0;
  }
  return 0;
}

export function getCapstoneDemandMultiplierBonus(unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  if (!capstone || capstone.effect.kind !== "demandMul") {
    return 1;
  }
  return capstone.effect.value ?? 1;
}

export function getCapstoneBattleDamageBonus(unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  if (!capstone || capstone.effect.kind !== "battleDamageBonus") {
    return 0;
  }
  return capstone.effect.value ?? 0;
}

export function getCapstoneWarlordProductionMultiplier(state, unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  if (!capstone || capstone.effect.kind !== "warlord") {
    return 1;
  }
  const active = Boolean(unit?.battleShiftCommitted && state?.fortress?.battle?.active);
  return active ? 1 + 0.5 : 1;
}

export function applyWorkerCapstone(state, unitId, capstoneId) {
  const unit = state.reserveUnits.find((item) => item.id === unitId)
    ?? state.mines.flatMap((mine) => mine.workerIds).find((item) => item?.id === unitId);

  if (!unit) {
    return { ok: false, reason: "Worker not found." };
  }
  if (!unit.pendingCapstone?.includes(capstoneId)) {
    return { ok: false, reason: "That capstone is not available for this worker." };
  }

  unit.capstone = capstoneId;
  unit.pendingCapstone = null;
  return { ok: true, reason: `${unit.name} gained the ${capstoneId} capstone.` };
}
