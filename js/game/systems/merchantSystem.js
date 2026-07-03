import { CONFIG, getResourceLabel } from "../config.js";
import { clamp } from "../utils.js";

function rollJitter(jitter) {
  return 1 + (Math.random() * 2 - 1) * jitter;
}

function rollPrices() {
  const spread = CONFIG.merchant.spread ?? 0.4;
  const jitter = CONFIG.merchant.jitter ?? 0.2;
  const prices = {};
  for (const entry of CONFIG.merchant.resources ?? []) {
    const jittered = entry.basePriceGold * rollJitter(jitter);
    const sellUnit = jittered * (1 - spread / 2);
    const buyUnit = jittered * (1 + spread / 2);
    prices[entry.resourceKey] = {
      chunk: entry.chunkSize,
      sellPrice: Math.max(1, Math.round(sellUnit * entry.chunkSize)),
      buyPrice: Math.max(1, Math.round(buyUnit * entry.chunkSize))
    };
  }
  return prices;
}

export function maybeOpenMerchant(state, clearedWaveNumber) {
  const interval = CONFIG.merchant.arrivalEveryWaves ?? 0;
  if (interval <= 0 || clearedWaveNumber <= 0 || clearedWaveNumber % interval !== 0) {
    return;
  }

  state.merchant.isActive = true;
  state.merchant.lastArrivalWave = clearedWaveNumber;
  state.merchant.prices = rollPrices();
  state.battle.log = "The caravan merchant has arrived. New rates on the table.";
  state.ui = state.ui ?? {};
  state.ui.pendingMerchantNotification = {
    id: `merchant-arrival-${clearedWaveNumber}`,
    icon: "🐫",
    title: "Caravan arrived",
    description: "The merchant is ready to trade until the next wave."
  };
}

export function dismissMerchant(state) {
  state.merchant.isActive = false;
  state.merchant.prices = {};
}

function ensurePrice(state, resourceKey) {
  if (!state.merchant.isActive) {
    return null;
  }
  return state.merchant.prices[resourceKey] ?? null;
}

export function buyFromMerchant(state, resourceKey) {
  const price = ensurePrice(state, resourceKey);
  if (!price) {
    return { ok: false, reason: "Caravan has no such stock." };
  }
  const gold = state.resources.gold ?? 0;
  if (gold < price.buyPrice) {
    return { ok: false, reason: `Need ${price.buyPrice} gold to buy ${price.chunk} ${getResourceLabel(resourceKey)}.` };
  }
  state.resources.gold = clamp(gold - price.buyPrice, 0, Number.MAX_SAFE_INTEGER);
  state.resources[resourceKey] = clamp(
    (state.resources[resourceKey] ?? 0) + price.chunk,
    0,
    Number.MAX_SAFE_INTEGER
  );
  state.battle.log = `Bought ${price.chunk} ${getResourceLabel(resourceKey)} for ${price.buyPrice} gold.`;
  return { ok: true, reason: state.battle.log };
}

export function sellToMerchant(state, resourceKey) {
  const price = ensurePrice(state, resourceKey);
  if (!price) {
    return { ok: false, reason: "Caravan is not buying that." };
  }
  const current = state.resources[resourceKey] ?? 0;
  if (current < price.chunk) {
    return { ok: false, reason: `Need ${price.chunk} ${getResourceLabel(resourceKey)} to sell.` };
  }
  state.resources[resourceKey] = clamp(current - price.chunk, 0, Number.MAX_SAFE_INTEGER);
  state.resources.gold = clamp(
    (state.resources.gold ?? 0) + price.sellPrice,
    0,
    Number.MAX_SAFE_INTEGER
  );
  state.battle.log = `Sold ${price.chunk} ${getResourceLabel(resourceKey)} for ${price.sellPrice} gold.`;
  return { ok: true, reason: state.battle.log };
}
