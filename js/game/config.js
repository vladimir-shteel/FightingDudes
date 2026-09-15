export const CONFIG = {
  version: 0,
  tickRateMs: 100,
  passiveGoldPerSecond: 0,
  startingGold: 0,
  startingResources: {},
  startingOre: 0,
  unitBuyBaseCost: 0,
  unitBuyExponent: 1,
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

// Config editor overrides live here, separate from the data/*.json files on disk: the editor mutates
// CONFIG live for immediate playtesting, and can persist that session's tweaks into localStorage so a
// reload doesn't lose them. Deep-merge (not replace) on load so a saved override survives new keys
// being added to the JSON files later — only the values the designer actually touched get overridden.
const CONFIG_OVERRIDE_KEY = "fd_config_override_v1";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeInPlace(target, source) {
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    if (isPlainObject(sourceValue) && isPlainObject(target[key])) {
      deepMergeInPlace(target[key], sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
  return target;
}

// The shipped `data/config.json`'s own `version` field, captured once at boot before any local
// override is applied. This is the number a saved override is judged against on every later boot —
// NOT the live CONFIG.version, which changes as soon as an override is applied — so that judgment
// stays correct even after this session itself just applied (or stamped) an override.
let defaultConfigVersion = 0;

export function getDefaultConfigVersion() {
  return defaultConfigVersion;
}

// Called by the config editor's Save/Export actions: anything a designer chooses to persist or hand
// off is by definition "one release ahead of" the shipped baseline. Stamping it here (rather than
// letting each click add +1 on top of whatever's already in memory) keeps repeated Save/Export clicks
// in one session idempotent — it always lands on defaultConfigVersion + 1, not +2, +3, ...
export function stampNextConfigVersion() {
  CONFIG.version = defaultConfigVersion + 1;
  return CONFIG.version;
}

export function saveConfigOverride() {
  localStorage.setItem(CONFIG_OVERRIDE_KEY, JSON.stringify(CONFIG));
}

export function clearConfigOverride() {
  localStorage.removeItem(CONFIG_OVERRIDE_KEY);
}

export function hasConfigOverride() {
  return localStorage.getItem(CONFIG_OVERRIDE_KEY) != null;
}

// Applies a designer-supplied JSON blob (e.g. imported in the config editor) on top of the live
// CONFIG and persists it, mirroring what happens automatically on boot when a saved override exists.
// Deliberately does NOT touch the version — an imported file's own version travels with it, so an
// outdated import stays subject to the same staleness check as anything else on the next boot.
export function applyConfigOverride(overrideData) {
  deepMergeInPlace(CONFIG, overrideData);
  saveConfigOverride();
}

// The whole game reads from ONE data file, in exactly the shape the config editor's Export button
// produces: a designer can tune values in-app, hit Export, and that file can be dropped straight in
// here as `data/config.json` to become the new baseline for everyone — no reassembly step, because
// there is nothing left to reassemble.
//
// Versioning: a saved local override only applies if its `version` is STRICTLY GREATER than the
// freshly-fetched default's `version`. This is what makes shipping an updated `data/config.json`
// automatically retire everyone's stale local overrides instead of a local override silently winning
// forever until someone remembers to click Reset — once the shipped file's version catches up to (or
// passes) what a browser has saved locally, that saved copy is now redundant (the shipped file already
// carries at least those values) and gets dropped.
export async function initConfig() {
  const configData = await fetchJson("config.json");
  Object.assign(CONFIG, configData);
  defaultConfigVersion = typeof CONFIG.version === "number" ? CONFIG.version : 0;

  const savedOverride = localStorage.getItem(CONFIG_OVERRIDE_KEY);
  if (savedOverride) {
    try {
      const overrideData = JSON.parse(savedOverride);
      const overrideVersion = typeof overrideData.version === "number" ? overrideData.version : 0;
      if (overrideVersion > defaultConfigVersion) {
        deepMergeInPlace(CONFIG, overrideData);
      } else {
        clearConfigOverride();
      }
    } catch (error) {
      console.warn("Ignoring corrupt saved config override:", error);
      clearConfigOverride();
    }
  }
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
