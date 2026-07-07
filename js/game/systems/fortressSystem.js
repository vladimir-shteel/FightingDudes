import { CONFIG, getFortressBuildingUnlockWave } from "../config.js";
import { clamp, generateId } from "../utils.js";

export const FORTRESS_WIDTH = 5;
export const FORTRESS_HEIGHT = 7;

function costEntries(costs = {}) {
  return Object.entries(costs).filter(([, amount]) => amount > 0);
}

function normalizeFootprint(type) {
  return (CONFIG.fortressBuildings[type]?.footprint ?? [[0, 0]]).map(([x, y]) => ({ x, y }));
}

export function getUnlockedFortressBuildingTypes(waveNumber = 1) {
  return Object.entries(CONFIG.fortressBuildings)
    .filter(([type, building]) => building.unlockedByDefault || waveNumber >= getFortressBuildingUnlockWave(type))
    .map(([type]) => type);
}

export function syncFortressBuildingUnlocks(state) {
  state.fortress.unlockedBuildingTypes = getUnlockedFortressBuildingTypes(state.fortress.waveNumber ?? 1);
}

export function createFortressState() {
  const field = [];
  for (let y = 0; y < FORTRESS_HEIGHT; y += 1) {
    for (let x = 0; x < FORTRESS_WIDTH; x += 1) {
      field.push({ x, y, occupant: null });
    }
  }

  const hq = createFortressBuilding("hq", { x: 1, y: 5 });
  for (const tile of hq.tiles) {
    getTile({ fortress: { field } }, tile.x, tile.y).occupant = { buildingId: hq.id };
  }

  const reserved = new Set(hq.tiles.map((tile) => `${tile.x}:${tile.y}`));
  const candidates = field.filter((tile) => !reserved.has(`${tile.x}:${tile.y}`));
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  for (const tile of candidates.slice(0, 10)) {
    tile.occupant = "obstacle";
  }

  return {
    screen: "bottom",
    field,
    buildings: [hq],
    obstacleRemovalCost: 3,
    movingBuildingId: null,
    waveNumber: 1,
    message: "Fortress field initialized. Production continues below.",
    battle: {
      active: false,
      enemies: [],
      allies: [],
      projectiles: [],
      spawnTimer: 0,
      enemiesToSpawn: 0,
      result: null
    },
    pendingRewardDraft: null,
    buildingBuyDiscount: 1,
    unlockedBuildingTypes: getUnlockedFortressBuildingTypes(1)
  };
}

export function createFortressBuilding(type, origin) {
  const definition = CONFIG.fortressBuildings[type];
  const level = definition.levels[0];
  const footprint = normalizeFootprint(type);
  const baseHealthBonus = 0;
  return {
    id: generateId("building"),
    type,
    level: 1,
    tiles: footprint.map((tile) => ({ x: origin.x + tile.x, y: origin.y + tile.y })),
    hp: level.hp + baseHealthBonus,
    maxHp: level.hp + baseHealthBonus,
    cooldownTimer: 0
  };
}

function getBaseHealthBonus(state) {
  return Math.max(0, state?.economy?.baseHealthBonus ?? 0);
}

export function getTile(state, x, y) {
  return state.fortress.field.find((tile) => tile.x === x && tile.y === y) ?? null;
}

export function canAffordResources(resources, costs = {}) {
  return costEntries(costs).every(([resourceKey, amount]) => (resources[resourceKey] ?? 0) >= amount);
}

export function spendResources(resources, costs = {}) {
  if (!canAffordResources(resources, costs)) {
    return false;
  }

  for (const [resourceKey, amount] of costEntries(costs)) {
    resources[resourceKey] = clamp((resources[resourceKey] ?? 0) - amount, 0, Number.MAX_SAFE_INTEGER);
  }
  return true;
}

export function getFortressBuildingBuyCost(state, type) {
  const definition = CONFIG.fortressBuildings[type];
  const discount = state.fortress.buildingBuyDiscount ?? 1;
  return Object.fromEntries(
    costEntries(definition?.buyCost ?? {}).map(([resourceKey, amount]) => [
      resourceKey,
      Math.max(1, Math.floor(amount * discount))
    ])
  );
}

export function canPlaceFortressBuilding(state, type, origin, ignoredBuildingId = null) {
  return normalizeFootprint(type).every((offset) => {
    const tile = getTile(state, origin.x + offset.x, origin.y + offset.y);
    if (!tile) {
      return false;
    }
    if (!tile.occupant) {
      return true;
    }
    return typeof tile.occupant === "object" && tile.occupant.buildingId === ignoredBuildingId;
  });
}

export function findFortressPlacement(state, type) {
  const origins = [];
  for (let y = 0; y < FORTRESS_HEIGHT; y += 1) {
    for (let x = 0; x < FORTRESS_WIDTH; x += 1) {
      const origin = { x, y };
      if (canPlaceFortressBuilding(state, type, origin)) {
        origins.push(origin);
      }
    }
  }
  return origins[Math.floor(Math.random() * origins.length)] ?? null;
}

function occupyBuilding(state, building) {
  for (const tile of building.tiles) {
    getTile(state, tile.x, tile.y).occupant = { buildingId: building.id };
  }
}

function clearBuilding(state, building) {
  for (const tile of building.tiles) {
    const fieldTile = getTile(state, tile.x, tile.y);
    if (fieldTile?.occupant?.buildingId === building.id) {
      fieldTile.occupant = null;
    }
  }
}

export function removeFortressObstacle(state, x, y) {
  const tile = getTile(state, x, y);
  if (!tile || tile.occupant !== "obstacle") {
    return { ok: false, reason: "Obstacle not found." };
  }
  if ((state.resources.gold ?? 0) < state.fortress.obstacleRemovalCost) {
    return { ok: false, reason: "Not enough gold to clear this tile." };
  }
  state.resources.gold -= state.fortress.obstacleRemovalCost;
  state.fortress.obstacleRemovalCost += 1;
  tile.occupant = null;
  return { ok: true, reason: "Obstacle cleared." };
}

export function buyFortressBuilding(state, type) {
  if (type === "hq") {
    return { ok: false, reason: "Building is locked." };
  }
  if (!state.fortress.unlockedBuildingTypes.includes(type)) {
    return { ok: false, reason: "Building is locked." };
  }
  const definition = CONFIG.fortressBuildings[type];
  const buyCost = getFortressBuildingBuyCost(state, type);
  const origin = findFortressPlacement(state, type);
  if (!origin) {
    return { ok: false, reason: "No valid space on the fortress grid." };
  }
  if (!spendResources(state.resources, buyCost)) {
    return { ok: false, reason: "Not enough resources for this building." };
  }
  const building = createFortressBuilding(type, origin);
  const bonusHp = getBaseHealthBonus(state);
  if (bonusHp > 0) {
    building.hp += bonusHp;
    building.maxHp += bonusHp;
  }
  state.fortress.buildings.push(building);
  occupyBuilding(state, building);
  return { ok: true, reason: `${definition.name} placed.` };
}

export function upgradeFortressBuilding(state, buildingId) {
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building || building.type === "hq") {
    return { ok: false, reason: "This building cannot be upgraded." };
  }
  const definition = CONFIG.fortressBuildings[building.type];
  const currentLevel = definition.levels[building.level - 1];
  const nextLevel = definition.levels[building.level];
  if (!nextLevel) {
    return { ok: false, reason: "Building is already max level." };
  }
  if (!spendResources(state.resources, currentLevel.upgradeCost)) {
    return { ok: false, reason: "Not enough resources for upgrade." };
  }
  building.level += 1;
  const bonusHp = getBaseHealthBonus(state);
  building.maxHp = nextLevel.hp + bonusHp;
  building.hp = nextLevel.hp + bonusHp;
  return { ok: true, reason: `${definition.name} upgraded to level ${building.level}.` };
}

export function moveFortressBuilding(state, buildingId, origin) {
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building || building.type === "hq") {
    return { ok: false, reason: "HQ stays anchored." };
  }
  if (!canPlaceFortressBuilding(state, building.type, origin, building.id)) {
    return { ok: false, reason: "That footprint does not fit there." };
  }
  clearBuilding(state, building);
  building.tiles = normalizeFootprint(building.type).map((tile) => ({ x: origin.x + tile.x, y: origin.y + tile.y }));
  occupyBuilding(state, building);
  return { ok: true, reason: "Building moved." };
}

export function applyFortressBaseHealthBonus(state, bonusAmount) {
  if (!bonusAmount) {
    return;
  }

  for (const building of state.fortress.buildings) {
    building.maxHp += bonusAmount;
    building.hp += bonusAmount;
  }
}
