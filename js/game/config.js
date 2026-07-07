export const CONFIG = {
  tickRateMs: 100,
  passiveGoldPerSecond: 0,
  startingGold: 0,
  startingResources: {},
  startingOre: 0,
  unitBuyBaseCost: 0,
  unitBuyExponent: 1,
  productionMultipliers: {
    rest: 1,
    battle: 1
  },
  merge: {
    maxLevel: 1
  },
  fortressBuildings: {},
  fortressUnits: {},
  fortressEnemies: {},
  fortressWaves: [],
  unitLevels: [],
  mine: {
    baseProductionPerSecond: 0,
    levels: []
  }
};

function getBasePath() {
  const currentUrl = new URL(import.meta.url);
  return new URL("../../data/", currentUrl);
}

async function fetchJson(fileName) {
  const response = await fetch(new URL(fileName, getBasePath()), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${fileName}: ${response.status}`);
  }
  return response.json();
}

export async function initConfig() {
  const [balance, unitLevels, mineLevels, fortressBuildings, fortressUnits, fortressEnemies, fortressWaves] = await Promise.all([
    fetchJson("balance.json"),
    fetchJson("unit-levels.json"),
    fetchJson("mine-levels.json"),
    fetchJson("fortress-buildings.json"),
    fetchJson("fortress-units.json"),
    fetchJson("fortress-enemies.json"),
    fetchJson("fortress-waves.json")
  ]);

  Object.assign(CONFIG, balance, {
    fortressBuildings,
    fortressUnits,
    fortressEnemies,
    fortressWaves,
    unitLevels: unitLevels.levels,
    mine: mineLevels
  });
}

export function getUnitLevelData(level) {
  return CONFIG.unitLevels.find((item) => item.level === level) ?? null;
}

export function getMineLevelData(level) {
  return CONFIG.mine.levels.find((item) => item.level === level) ?? null;
}

export function getMineMaxLevel() {
  return CONFIG.mine.levels.length;
}

export function getMineResourceType(index) {
  return CONFIG.mine.resourceTypes[index] ?? null;
}

export function getMineResourceTypeByKey(resourceKey) {
  return CONFIG.mine.resourceTypes.find((item) => item.key === resourceKey) ?? null;
}

export function getMineUnlockWave(resourceKey) {
  return getMineResourceTypeByKey(resourceKey)?.unlockWave ?? 1;
}

export function getMineBuyCost(resourceKey) {
  return getMineResourceTypeByKey(resourceKey)?.buyCost ?? {};
}

export function getMineSlotUnlockWave(resourceKey, slotIndex) {
  return getMineResourceTypeByKey(resourceKey)?.slotUnlockWaves?.[slotIndex] ?? Number.POSITIVE_INFINITY;
}

export function getMineSlotBuyCost(resourceKey, slotIndex) {
  return getMineResourceTypeByKey(resourceKey)?.slotBuyCosts?.[slotIndex] ?? null;
}

export function getFortressBuildingUnlockWave(type) {
  return CONFIG.fortressBuildings[type]?.unlockWave ?? 1;
}

export function getFortressEnemy(archetypeKey) {
  return CONFIG.fortressEnemies[archetypeKey] ?? null;
}

export function getResourceLabel(resourceKey) {
  if (resourceKey === "gold") {
    return "Gold";
  }

  return getMineResourceTypeByKey(resourceKey)?.label ?? resourceKey;
}

export function getResourceIcon(resourceKey) {
  if (resourceKey === "gold") {
    return CONFIG.goldIcon ?? null;
  }

  return getMineResourceTypeByKey(resourceKey)?.icon ?? null;
}
