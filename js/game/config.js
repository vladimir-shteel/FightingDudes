export const CONFIG = {
  tickRateMs: 100,
  passiveGoldPerSecond: 0,
  startingGold: 0,
  startingOre: 0,
  unitBuyBaseCost: 0,
  unitBuyCostStep: 0,
  battle: {
    waveCooldownSeconds: 0
  },
  castle: {
    maxHealth: 0
  },
  merge: {
    maxLevel: 1
  },
  equipment: {},
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
  const [balance, equipment, waves, unitLevels, mineLevels] = await Promise.all([
    fetchJson("balance.json"),
    fetchJson("equipment.json"),
    fetchJson("waves.json"),
    fetchJson("unit-levels.json"),
    fetchJson("mine-levels.json")
  ]);

  Object.assign(CONFIG, balance, {
    equipment,
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
