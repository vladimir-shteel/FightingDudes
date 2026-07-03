export const CONFIG = {
  tickRateMs: 100,
  passiveGoldPerSecond: 0,
  startingGold: 0,
  startingOre: 0,
  unitBuyBaseCost: 0,
  unitBuyExponent: 1,
  battle: {
    waveCooldownSeconds: 0
  },
  bridgehead: {
    maxSlots: 8
  },
  castle: {
    maxHealth: 0
  },
  merge: {
    maxLevel: 1
  },
  equipment: {},
  events: {
    cooldownRollChance: 0,
    events: []
  },
  waves: [],
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
  const response = await fetch(new URL(fileName, getBasePath()));
  if (!response.ok) {
    throw new Error(`Failed to load ${fileName}: ${response.status}`);
  }
  return response.json();
}

export async function initConfig() {
  const [balance, equipment, waves, unitLevels, mineLevels, events] = await Promise.all([
    fetchJson("balance.json"),
    fetchJson("equipment.json"),
    fetchJson("waves.json"),
    fetchJson("unit-levels.json"),
    fetchJson("mine-levels.json"),
    fetchJson("events.json")
  ]);

  Object.assign(CONFIG, balance, {
    equipment,
    events,
    waves,
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

export function getResourceLabel(resourceKey) {
  if (resourceKey === "gold") {
    return "Gold";
  }

  return CONFIG.mine.resourceTypes?.find((item) => item.key === resourceKey)?.label ?? resourceKey;
}

export function getResourceIcon(resourceKey) {
  if (resourceKey === "gold") {
    return CONFIG.goldIcon ?? null;
  }

  return CONFIG.mine.resourceTypes?.find((item) => item.key === resourceKey)?.icon ?? null;
}

export function getWeaponConfig(key) {
  return CONFIG.equipment.weapons?.[key] ?? null;
}

export function getArmorConfig(key) {
  return CONFIG.equipment.armors?.[key] ?? null;
}
