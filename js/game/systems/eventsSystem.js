import { CONFIG, getArmorConfig, getWeaponConfig } from "../config.js";
import { clamp, generateId } from "../utils.js";
import { createBattleUnit, createReserveUnit } from "../factories.js";

function chooseWeightedEvent() {
  const events = CONFIG.events.events ?? [];
  const totalWeight = events.reduce((total, event) => total + (event.weight ?? 1), 0);
  if (totalWeight <= 0) {
    return null;
  }
  let roll = Math.random() * totalWeight;
  for (const event of events) {
    roll -= event.weight ?? 1;
    if (roll <= 0) {
      return event;
    }
  }
  return events[0] ?? null;
}

function pushActiveEvent(state, entry) {
  state.activeEvents.push(entry);
  state.eventHistory.unshift({
    id: generateId("event-log"),
    key: entry.key,
    label: entry.label,
    description: entry.description
  });
  state.eventHistory = state.eventHistory.slice(0, 4);
}

function pickCollapseTarget(state) {
  const unlockedMines = state.mines.filter((mine) => mine.isUnlocked);
  if (unlockedMines.length === 0) {
    return null;
  }
  const mine = unlockedMines[Math.floor(Math.random() * unlockedMines.length)];
  const workerSlots = mine.workerIds
    .map((worker, index) => (worker ? index : -1))
    .filter((index) => index >= 0);
  const slotIndex = workerSlots.length > 0
    ? workerSlots[workerSlots.length - 1]
    : mine.workerIds.findIndex((worker) => worker === null);
  return { mineId: mine.id, slotIndex: slotIndex < 0 ? 0 : slotIndex };
}

export function rollBetweenWaveEvent(state, nowSeconds) {
  if (Math.random() > (CONFIG.events.cooldownRollChance ?? 0)) {
    return null;
  }

  const event = chooseWeightedEvent();
  if (!event) {
    return null;
  }

  const type = event.type
    ?? (event.wares ? "merchant"
      : event.offers ? "mercenary"
      : event.resourceGrant ? "grant"
      : (event.durationSeconds ?? 0) > 0 ? "debuff"
      : "grant");

  if (type === "grant") {
    pushActiveEvent(state, {
      id: generateId("event"),
      key: event.key,
      type,
      label: event.label,
      description: event.description,
      icon: event.icon ?? "🎁",
      resourceGrant: { ...(event.resourceGrant ?? {}) },
      persistsUntilNextWave: true,
      expiresAt: Number.POSITIVE_INFINITY
    });
  } else if (type === "merchant") {
    pushActiveEvent(state, {
      id: generateId("event"),
      key: event.key,
      type,
      label: event.label,
      description: event.description,
      icon: event.icon ?? "🛒",
      wares: (event.wares ?? []).map((ware, index) => ({
        ...ware,
        index,
        purchased: false
      })),
      persistsUntilNextWave: true,
      expiresAt: Number.POSITIVE_INFINITY
    });
  } else if (type === "mercenary") {
    pushActiveEvent(state, {
      id: generateId("event"),
      key: event.key,
      type,
      label: event.label,
      description: event.description,
      icon: event.icon ?? "🗡️",
      offers: (event.offers ?? []).map((offer, index) => ({
        ...offer,
        index,
        purchased: false
      })),
      persistsUntilNextWave: true,
      expiresAt: Number.POSITIVE_INFINITY
    });
  } else if (type === "collapse") {
    const target = pickCollapseTarget(state);
    if (!target) {
      // Nowhere to collapse — roll into log-only entry.
      state.eventHistory.unshift({
        id: generateId("event-log"),
        key: event.key,
        label: event.label,
        description: `${event.description} (skipped — no active mine)`
      });
      state.eventHistory = state.eventHistory.slice(0, 4);
      state.battle.log = `Event: ${event.label}. No open mine to collapse.`;
      return event;
    }
    pushActiveEvent(state, {
      id: generateId("event"),
      key: event.key,
      type,
      label: event.label,
      description: event.description,
      icon: event.icon ?? "🪨",
      mineProductionMultiplier: event.mineProductionMultiplier ?? 0.75,
      targetMineId: target.mineId,
      disabledSlotIndex: target.slotIndex,
      expiresAt: nowSeconds + (event.durationSeconds ?? 60)
    });
  } else if (type === "festival") {
    pushActiveEvent(state, {
      id: generateId("event"),
      key: event.key,
      type,
      label: event.label,
      description: event.description,
      icon: event.icon ?? "🎆",
      mineProductionMultiplier: event.mineProductionMultiplier ?? 1.5,
      persistsUntilNextWave: true,
      expiresAt: Number.POSITIVE_INFINITY
    });
  } else if ((event.durationSeconds ?? 0) > 0) {
    pushActiveEvent(state, {
      id: generateId("event"),
      key: event.key,
      type,
      label: event.label,
      description: event.description,
      icon: event.icon,
      mineProductionMultiplier: event.mineProductionMultiplier ?? 1,
      expiresAt: nowSeconds + event.durationSeconds
    });
  } else {
    state.eventHistory.unshift({
      id: generateId("event-log"),
      key: event.key,
      label: event.label,
      description: event.description
    });
    state.eventHistory = state.eventHistory.slice(0, 4);
  }

  state.battle.log = `Event: ${event.label}. ${event.description}`;
  state.ui = state.ui ?? {};
  state.ui.pendingNotification = {
    id: generateId("notif"),
    key: event.key,
    label: event.label,
    description: event.description,
    icon: event.icon ?? "📣",
    tone: type === "collapse" || type === "debuff" ? "bad" : "good"
  };
  return event;
}

export function triggerEventByKey(state, key, nowSeconds) {
  const definition = (CONFIG.events.events ?? []).find((event) => event.key === key);
  if (!definition) {
    return null;
  }
  const previousChance = CONFIG.events.cooldownRollChance;
  const originalEvents = CONFIG.events.events;
  CONFIG.events.cooldownRollChance = 1;
  CONFIG.events.events = [definition];
  try {
    return rollBetweenWaveEvent(state, nowSeconds);
  } finally {
    CONFIG.events.events = originalEvents;
    CONFIG.events.cooldownRollChance = previousChance;
  }
}

export function claimGrantEvent(state, eventId) {
  const grant = state.activeEvents.find(
    (event) => event.id === eventId && event.type === "grant"
  );
  if (!grant) {
    return { ok: false, reason: "Grant already claimed." };
  }
  for (const [resourceKey, amount] of Object.entries(grant.resourceGrant ?? {})) {
    state.resources[resourceKey] = clamp(
      (state.resources[resourceKey] ?? 0) + amount,
      0,
      Number.MAX_SAFE_INTEGER
    );
  }
  state.activeEvents = state.activeEvents.filter((event) => event.id !== eventId);
  const summary = Object.entries(grant.resourceGrant ?? {})
    .map(([key, amount]) => `${amount} ${key}`)
    .join(", ");
  state.battle.log = `Collected: ${summary}.`;
  return { ok: true, reason: state.battle.log };
}

export function getActiveGrants(state) {
  return state.activeEvents.filter((event) => event.type === "grant");
}

export function tickEvents(state, nowSeconds) {
  state.activeEvents = state.activeEvents.filter(
    (event) => (event.expiresAt ?? 0) > nowSeconds
  );
}

export function clearWaveScopedEvents(state) {
  state.activeEvents = state.activeEvents.filter(
    (event) => !event.persistsUntilNextWave
  );
}

// Backwards alias — battleSystem imports this name.
export const clearOfferEvents = clearWaveScopedEvents;

export function getMineProductionMultiplier(state, mineId = null) {
  return state.activeEvents.reduce((multiplier, event) => {
    if (event.mineProductionMultiplier === undefined) {
      return multiplier;
    }
    if (event.targetMineId && event.targetMineId !== mineId) {
      return multiplier;
    }
    return multiplier * event.mineProductionMultiplier;
  }, 1);
}

export function isMineSlotDisabledByEvent(state, mineId, slotIndex) {
  return state.activeEvents.some(
    (event) =>
      event.type === "collapse" &&
      event.targetMineId === mineId &&
      event.disabledSlotIndex === slotIndex
  );
}

export function getMineVisualEffects(state, mineId) {
  const effects = [];
  for (const event of state.activeEvents) {
    if (event.type === "festival") {
      effects.push({ kind: "festival", eventId: event.id });
    } else if (event.type === "collapse" && event.targetMineId === mineId) {
      effects.push({
        kind: "collapse",
        eventId: event.id,
        disabledSlotIndex: event.disabledSlotIndex
      });
    } else if (event.key === "bad_weather") {
      effects.push({ kind: "storm", eventId: event.id });
    }
  }
  return effects;
}

export function getActiveMerchant(state) {
  return state.activeEvents.find((event) => event.type === "merchant") ?? null;
}

export function getActiveMercenary(state) {
  return state.activeEvents.find((event) => event.type === "mercenary") ?? null;
}

export function purchaseMerchantWare(state, eventId, wareIndex) {
  const merchant = state.activeEvents.find(
    (event) => event.id === eventId && event.type === "merchant"
  );
  if (!merchant) {
    return { ok: false, reason: "Merchant is gone." };
  }

  const ware = merchant.wares[wareIndex];
  if (!ware || ware.purchased) {
    return { ok: false, reason: "That item is unavailable." };
  }

  const gold = state.resources.gold ?? 0;
  if (gold < ware.goldCost) {
    return { ok: false, reason: `Need ${ware.goldCost} gold.` };
  }

  state.resources.gold = gold - ware.goldCost;
  state.resources[ware.resourceKey] =
    (state.resources[ware.resourceKey] ?? 0) + ware.amount;
  ware.purchased = true;
  state.battle.log = `Bought ${ware.amount} ${ware.resourceKey} for ${ware.goldCost} gold.`;
  return { ok: true, reason: state.battle.log };
}

export function hireMercenaryOffer(state, eventId, offerIndex) {
  const mercenary = state.activeEvents.find(
    (event) => event.id === eventId && event.type === "mercenary"
  );
  if (!mercenary) {
    return { ok: false, reason: "Mercenary already left." };
  }

  const offer = mercenary.offers[offerIndex];
  if (!offer || offer.purchased) {
    return { ok: false, reason: "That contract is unavailable." };
  }

  const maxSlots = CONFIG.bridgehead?.maxSlots ?? 8;
  if (state.bridgeheadUnits.length >= maxSlots) {
    return { ok: false, reason: "Bridgehead is full — clear a slot first." };
  }

  const gold = state.resources.gold ?? 0;
  if (gold < offer.goldCost) {
    return { ok: false, reason: `Need ${offer.goldCost} gold.` };
  }

  const weapon = getWeaponConfig(offer.weaponKey);
  const armor = getArmorConfig(offer.armorKey);
  if (!weapon || !armor) {
    return { ok: false, reason: "Mercenary gear misconfigured." };
  }

  state.resources.gold = gold - offer.goldCost;
  const sourceUnit = createReserveUnit(offer.level);
  const battleUnit = createBattleUnit(sourceUnit, offer.weaponKey, offer.armorKey);
  battleUnit.state = "ready";
  battleUnit.targetHint = "bridgehead";
  state.bridgeheadUnits.push(battleUnit);
  offer.purchased = true;
  state.battle.log =
    `Hired ${sourceUnit.name} Lv${offer.level} with ${weapon.label} + ${armor.label}.`;
  return { ok: true, reason: state.battle.log };
}
