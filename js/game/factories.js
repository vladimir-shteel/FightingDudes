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

  return {
    id: generateId("mine"),
    name: resourceType.mineName,
    resourceKey: resourceType.key,
    resourceLabel: resourceType.label,
    isUnlocked: resourceType.unlockedByDefault ?? ((resourceType.unlockCost ?? 0) === 0),
    level: 1,
    workerIds: Array.from({ length: maxSlots }, () => null),
    workerProgress: Array.from({ length: maxSlots }, () => 0),
    passiveProgress: 0
  };
}
