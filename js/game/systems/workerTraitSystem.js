import { CONFIG } from "../config.js";

export const WORKER_TRAIT_KEYS = ["maintainer", "golden", "rush"];

// Worker merge level is gated by wave: starts at workerLevelCapBase and rises one tier every
// workerLevelCapWavesPerStep waves up to merge.maxLevel. Keeps the early roster WIDE (surplus
// bodies must sit in reserve where they rest → the Shift loop stays alive) and paces capstones
// (they only fire at the true maxLevel). Set wavesPerStep to 0 to disable the gate.
// Rest is a POOL, not a flag: a worker banks up to ceil(level / restChargeDivisor) rest charges.
// Each battle Shift spends one; a wave spent in reserve regains one. Higher-level workers hold more
// charges (longer shift-endurance before they must rotate out to recharge).
export function getMaxRestCharges(level) {
  const perLevel = CONFIG.workerTraits?.battleShift?.restChargePerLevel ?? 2;
  return Math.max(1, Math.floor((level ?? 1) * perLevel));
}

export function getMaxWorkerLevel(state) {
  const merge = CONFIG.merge ?? {};
  const hardMax = merge.maxLevel ?? 5;
  const unlockWaves = merge.workerLevelUnlockWaves;
  if (!Array.isArray(unlockWaves) || unlockWaves.length === 0) return hardMax;
  const wave = state?.fortress?.waveNumber ?? 1;
  // Cap = the highest level whose unlock wave has been reached (array index i = level i+1).
  let cap = 1;
  for (let i = 0; i < unlockWaves.length; i += 1) {
    if (wave >= (unlockWaves[i] ?? 1)) cap = i + 1;
  }
  return Math.min(hardMax, cap);
}

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

// Trait points a worker of this level can hold. A merge sums both parents' points and adds
// mergeBonusPoints, from a level-1 roll of 1 point: T(1)=1, T(n)=2·T(n-1)+b → 2^(n-1)·(1+b) − b.
// Used to CLAMP traits when a worker loses a level (operator attrition) so power can't outrun tier.
export function getMaxTraitTotalForLevel(level) {
  const bonus = getTraitConfig().mergeBonusPoints ?? 1;
  const lvl = Math.max(1, level ?? 1);
  return Math.max(1, Math.round(Math.pow(2, lvl - 1) * (1 + bonus) - bonus));
}

// Scale a worker's trait vector down so its total fits its (reduced) level, preserving the mix.
export function trimWorkerTraitsToLevel(unit) {
  const traits = ensureWorkerTraits(unit);
  const target = getMaxTraitTotalForLevel(unit?.level);
  const total = getTraitTotal(traits);
  if (total <= target) {
    return traits;
  }
  const scale = target / total;
  for (const key of WORKER_TRAIT_KEYS) {
    traits[key] = Math.max(0, Math.floor((traits[key] ?? 0) * scale));
  }
  return traits;
}

export function getDominantTraitKey(traits = {}) {
  return WORKER_TRAIT_KEYS
    .map((key) => ({ key, value: traits[key] ?? 0 }))
    .sort((left, right) => right.value - left.value || WORKER_TRAIT_KEYS.indexOf(left.key) - WORKER_TRAIT_KEYS.indexOf(right.key))[0]?.key ?? "maintainer";
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

  return normalizeTraitVector({ maintainer: 1 });
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
    const hybridId = pairKey === "golden+maintainer" ? "foreman" : pairKey === "maintainer+rush" ? "warlord" : null;
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

export function getCapstoneOperatorBuffMultiplier(unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  if (!capstone) return 1;
  if (capstone.effect.kind === "operatorBuffMul") return capstone.effect.value ?? 1;
  if (capstone.effect.kind === "foreman") return 1.25;
  if (capstone.effect.kind === "warlord") return 1.25;
  return 1;
}

export function getCapstoneOperatorNoDelevel(unit) {
  const capstone = getWorkerCapstoneEffect(unit);
  return capstone?.effect?.kind === "operatorNoDelevel";
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
