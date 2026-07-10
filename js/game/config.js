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
  merge: {
    maxLevel: 1
  },
  equipment: {},
  classes: {},
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
  const response = await fetch(new URL(fileName, getBasePath()), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${fileName}: ${response.status}`);
  }
  return response.json();
}

export async function initConfig() {
  const [balance, equipment, classes, waves, unitLevels, mineLevels] = await Promise.all([
    fetchJson("balance.json"),
    fetchJson("equipment.json"),
    fetchJson("classes.json"),
    fetchJson("waves.json"),
    fetchJson("unit-levels.json"),
    fetchJson("mine-levels.json")
  ]);

  Object.assign(CONFIG, balance, {
    equipment,
    classes: classes.classes,
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

export function getClassConfig(classId) {
  return CONFIG.classes?.[classId] ?? null;
}

// Resource cost to stage a class scales with the merge level of the source
// worker: a level-6 unit is 32 base units of investment, so its resource price
// should dwarf a level-1's. Keeps the flat `costs` in classes.json as the
// per-level base and multiplies by the unit level (level 1 = base, unchanged).
export function getClassCosts(classConfig, level = 1) {
  const base = classConfig?.costs ?? {};
  const factor = Math.max(1, Math.floor(level));
  const scaled = {};
  for (const [resourceKey, amount] of Object.entries(base)) {
    scaled[resourceKey] = Math.ceil(amount * factor);
  }
  return scaled;
}

// Merge cap rises with location progress (Д6): starts at 4, becomes 6 once
// Location 1 is cleared (tier-2 Щитоносец/Копейщик, minLevel 5), and 8 once
// Location 2 is cleared (tier-3/4 Отравитель/Паладин/Берсерк/Маг, minLevel 7-8).
export function getMergeMaxLevel(state) {
  const completed = state?.progress?.completedLocations ?? 0;
  const base = CONFIG.merge?.maxLevel ?? 1;
  const afterLocation1 = CONFIG.merge?.maxLevelAfterLocation1 ?? base;
  const afterLocation2 = CONFIG.merge?.maxLevelAfterLocation2 ?? afterLocation1;
  if (completed >= 2) {
    return afterLocation2;
  }
  return completed >= 1 ? afterLocation1 : base;
}

export function getAvailableClasses(level) {
  return Object.entries(CONFIG.classes ?? {})
    .filter(([, config]) => (config.minLevel ?? 1) <= level)
    .map(([id, config]) => ({ id, ...config }));
}
