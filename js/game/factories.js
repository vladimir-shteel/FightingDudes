import { CONFIG, getUnitLevelData } from "./config.js";
import { generateId } from "./utils.js";

export function createReserveUnit(level = 1) {
  const levelData = getUnitLevelData(level);
  if (!levelData) {
    throw new Error(`Missing unit level data for level ${level}`);
  }

  return {
    id: generateId("unit"),
    name: levelData.name,
    level,
    icon: levelData.icon ?? "W",
    baseHealth: levelData.baseHealth,
    baseAttack: levelData.baseAttack,
    baseAttackSpeed: levelData.baseAttackSpeed
  };
}

export function createMine(index) {
  const resourceType = CONFIG.mine.resourceTypes[index % CONFIG.mine.resourceTypes.length];
  const maxSlots = CONFIG.mine.levels.length;
  const unlockedByDefault = resourceType.unlockedByDefault ?? false;
  const purchasedSlotIndices = Array.from({ length: maxSlots }, (_, slotIndex) => unlockedByDefault && slotIndex === 0);

  return {
    id: generateId("mine"),
    name: resourceType.mineName,
    resourceKey: resourceType.key,
    resourceLabel: resourceType.label,
    unlockWave: resourceType.unlockWave ?? (unlockedByDefault ? 1 : 999),
    buyCost: resourceType.buyCost ?? { gold: 0 },
    slotUnlockWaves: Array.from({ length: maxSlots }, (_, slotIndex) => resourceType.slotUnlockWaves?.[slotIndex] ?? Number.POSITIVE_INFINITY),
    slotBuyCosts: Array.from({ length: maxSlots }, (_, slotIndex) => resourceType.slotBuyCosts?.[slotIndex] ?? null),
    isUnlocked: unlockedByDefault,
    level: 1,
    workerIds: Array.from({ length: maxSlots }, () => null),
    workerProgress: Array.from({ length: maxSlots }, () => 0),
    purchasedSlotIndices,
    passiveProgress: 0
  };
}
