import { CONFIG, getResourceLabel, getTerrainZoneConfig } from "../config.js";
import { clamp, generateId } from "../utils.js";

export function isInsideZone(actor, zone) {
  return Math.hypot((actor.x ?? 0) - zone.x, (actor.y ?? 0) - zone.y) <= zone.radius;
}

function getMissingCosts(state, costs) {
  return Object.entries(costs ?? {})
    .filter(([resourceKey, amount]) => (state.resources[resourceKey] ?? 0) < amount)
    .map(([resourceKey, amount]) => `${getResourceLabel(resourceKey)} ${Math.floor(state.resources[resourceKey] ?? 0)}/${amount}`);
}

export function placeTerrainZone(state, type, x, y, nowSeconds) {
  const config = getTerrainZoneConfig(type);
  if (!config) {
    return { ok: false, reason: "Unknown terrain zone." };
  }

  if ((state.terrainZoneCooldowns[type] ?? 0) > 0) {
    return { ok: false, reason: `${config.label} is still cooling down.` };
  }

  if (state.battle.status !== "cooldown" && state.battle.status !== "idle") {
    return { ok: false, reason: "Terrain can only be prepared between waves." };
  }

  const missing = getMissingCosts(state, config.costs);
  if (missing.length > 0) {
    return { ok: false, reason: `Not enough resources: ${missing.join(", ")}.` };
  }

  for (const [resourceKey, amount] of Object.entries(config.costs ?? {})) {
    state.resources[resourceKey] -= amount;
  }

  state.terrainZones.push({
    id: generateId("terrain"),
    type,
    label: config.label,
    icon: config.icon ?? config.label[0],
    x: clamp(x, config.radius, CONFIG.battle.fieldWidth - config.radius),
    y: clamp(y, config.radius, CONFIG.battle.fieldHeight - config.radius),
    radius: config.radius,
    expiresAt: nowSeconds + (config.durationSeconds ?? CONFIG.terrainZones.durationSeconds ?? 45)
  });
  state.terrainZoneCooldowns[type] = config.cooldownSeconds ?? 0;
  state.battle.log = `${config.label} prepared on the battlefield.`;
  return { ok: true, reason: state.battle.log };
}

export function tickTerrainZones(state, deltaSeconds, nowSeconds) {
  state.terrainZones = state.terrainZones.filter((zone) => zone.expiresAt > nowSeconds);

  for (const type of Object.keys(state.terrainZoneCooldowns)) {
    state.terrainZoneCooldowns[type] = Math.max(0, state.terrainZoneCooldowns[type] - deltaSeconds);
  }
}

export function getTerrainAttackMultiplier(state, actor, side) {
  return state.terrainZones.reduce((multiplier, zone) => {
    if (!isInsideZone(actor, zone)) {
      return multiplier;
    }
    const config = getTerrainZoneConfig(zone.type);
    if (side === "ally") {
      return multiplier * (config?.allyAttackMultiplier ?? 1);
    }
    return multiplier * (config?.enemyAttackMultiplier ?? 1);
  }, 1);
}

export function applyTerrainDamage(state, deltaSeconds, nowSeconds) {
  for (const zone of state.terrainZones) {
    const config = getTerrainZoneConfig(zone.type);
    const damagePerSecond = config?.damagePerSecond ?? 0;
    if (damagePerSecond <= 0) {
      continue;
    }

    for (const actor of [...state.battleUnits, ...state.enemies]) {
      if (isInsideZone(actor, zone)) {
        actor.health -= damagePerSecond * deltaSeconds;
        actor.hitUntil = nowSeconds + 0.12;
      }
    }
  }
}
