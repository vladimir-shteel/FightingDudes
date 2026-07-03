import { CONFIG } from "../config.js";
import { clamp, generateId } from "../utils.js";

function chooseWeightedEvent() {
  const events = CONFIG.events.events ?? [];
  const totalWeight = events.reduce((total, event) => total + (event.weight ?? 1), 0);
  let roll = Math.random() * totalWeight;
  for (const event of events) {
    roll -= event.weight ?? 1;
    if (roll <= 0) {
      return event;
    }
  }
  return events[0] ?? null;
}

export function rollBetweenWaveEvent(state, nowSeconds) {
  if (Math.random() > (CONFIG.events.cooldownRollChance ?? 0)) {
    return null;
  }

  const event = chooseWeightedEvent();
  if (!event) {
    return null;
  }

  for (const [resourceKey, amount] of Object.entries(event.resourceGrant ?? {})) {
    state.resources[resourceKey] = clamp((state.resources[resourceKey] ?? 0) + amount, 0, Number.MAX_SAFE_INTEGER);
  }

  if ((event.durationSeconds ?? 0) > 0) {
    state.activeEvents.push({
      id: generateId("event"),
      key: event.key,
      label: event.label,
      description: event.description,
      mineProductionMultiplier: event.mineProductionMultiplier ?? 1,
      expiresAt: nowSeconds + event.durationSeconds
    });
  }

  state.eventHistory.unshift({
    id: generateId("event-log"),
    key: event.key,
    label: event.label,
    description: event.description
  });
  state.eventHistory = state.eventHistory.slice(0, 4);
  state.battle.log = `Event: ${event.label}. ${event.description}`;
  return event;
}

export function tickEvents(state, nowSeconds) {
  state.activeEvents = state.activeEvents.filter((event) => event.expiresAt > nowSeconds);
}

export function getMineProductionMultiplier(state) {
  return state.activeEvents.reduce(
    (multiplier, event) => multiplier * (event.mineProductionMultiplier ?? 1),
    1
  );
}
