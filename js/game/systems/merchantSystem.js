import { CONFIG, getResourceLabel } from "../config.js";
import { clamp } from "../utils.js";

function scaleAmount(amount, factor) {
  return Math.max(1, Math.round(amount * factor));
}

function scaleCosts(costs, factor) {
  return Object.fromEntries(Object.entries(costs ?? {}).map(([resourceKey, amount]) => [
    resourceKey,
    scaleAmount(amount, factor)
  ]));
}

function seededRatio(seed) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }
  return (Math.abs(hash) % 1000) / 1000;
}

function formatResourceSet(resources) {
  return Object.entries(resources ?? {})
    .map(([resourceKey, amount]) => `${amount} ${getResourceLabel(resourceKey)}`)
    .join(", ");
}

export function maybeOpenMerchant(state, clearedWaveNumber) {
  const interval = CONFIG.merchant.arrivalEveryWaves ?? 0;
  if (interval <= 0 || clearedWaveNumber <= 0 || clearedWaveNumber % interval !== 0) {
    return;
  }

  const offers = CONFIG.merchant.offers ?? [];
  const offerCount = Math.min(CONFIG.merchant.offerCount ?? 3, offers.length);
  const jitter = CONFIG.merchant.rateJitter ?? 0;
  const rotated = offers.map((offer, index) => ({ offer, score: seededRatio(`${clearedWaveNumber}:${index}:${offer.key}`) }))
    .sort((left, right) => left.score - right.score)
    .slice(0, offerCount)
    .map(({ offer }, index) => {
      const factor = 1 + (seededRatio(`rate:${clearedWaveNumber}:${offer.key}`) * 2 - 1) * jitter;
      return {
        key: `${offer.key}-${clearedWaveNumber}-${index}`,
        pay: scaleCosts(offer.pay, factor),
        receive: scaleCosts(offer.receive, 1 / factor)
      };
    });

  state.merchant.isActive = true;
  state.merchant.lastArrivalWave = clearedWaveNumber;
  state.merchant.offers = rotated;
  state.battle.log = "The caravan merchant has arrived with fresh exchange rates.";
}

export function acceptMerchantOffer(state, offerKey) {
  const offer = state.merchant.offers.find((item) => item.key === offerKey);
  if (!state.merchant.isActive || !offer) {
    return { ok: false, reason: "The caravan is not offering that trade." };
  }

  const missing = Object.entries(offer.pay ?? {}).filter(([resourceKey, amount]) => (state.resources[resourceKey] ?? 0) < amount);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Not enough resources: ${missing.map(([resourceKey, amount]) => `${getResourceLabel(resourceKey)} ${Math.floor(state.resources[resourceKey] ?? 0)}/${amount}`).join(", ")}.`
    };
  }

  for (const [resourceKey, amount] of Object.entries(offer.pay ?? {})) {
    state.resources[resourceKey] -= amount;
  }
  for (const [resourceKey, amount] of Object.entries(offer.receive ?? {})) {
    state.resources[resourceKey] = clamp((state.resources[resourceKey] ?? 0) + amount, 0, Number.MAX_SAFE_INTEGER);
  }

  state.merchant.offers = state.merchant.offers.filter((item) => item.key !== offerKey);
  state.merchant.isActive = state.merchant.offers.length > 0;
  state.battle.log = `Trade complete: ${formatResourceSet(offer.pay)} -> ${formatResourceSet(offer.receive)}.`;
  return { ok: true, reason: state.battle.log };
}
