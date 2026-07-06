import { CONFIG, getArmorConfig, getUnitLevelData, getWeaponConfig } from "./config.js";
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
    icon: levelData.icon ?? "🚧",
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
    unlockCost: resourceType.unlockCost ?? 0,
    unlockCurrency: resourceType.unlockCurrency ?? "gold",
    isUnlocked: (resourceType.unlockCost ?? 0) === 0,
    level: 1,
    workerIds: Array.from({ length: maxSlots }, () => null),
    workerProgress: Array.from({ length: maxSlots }, () => 0),
    passiveProgress: 0
  };
}

export function createBattleUnit(unit, weaponKey, armorKey) {
  const weapon = getWeaponConfig(weaponKey);
  const armor = getArmorConfig(armorKey);
  const maxHealth = unit.baseHealth + (armor?.healthBonus ?? 0);
  const defaultAttackRangeBonus = weapon.attackType === "ranged"
    ? CONFIG.battle.rangedAttackRangeBonus
    : CONFIG.battle.meleeAttackRangeBonus;
  const attackRangeBonus = weapon.attackRangeBonus ?? weapon.attackRange ?? defaultAttackRangeBonus ?? 0;
  const attackRange = (CONFIG.battle.baseAttackReach ?? 0) + attackRangeBonus;

  return {
    id: generateId("battle"),
    sourceUnitId: unit.id,
    name: unit.name,
    level: unit.level,
    weaponKey,
    armorKey,
    icon: unit.icon,
    weaponIcon: weapon.icon ?? "",
    armorIcon: armor?.icon ?? "",
    attackType: weapon.attackType,
    attack: unit.baseAttack * weapon.attackMultiplier,
    attackSpeed: unit.baseAttackSpeed * weapon.attackSpeedMultiplier,
    moveSpeed: CONFIG.battle.allyMoveSpeed,
    attackRange,
    attackRangeBonus,
    maxHealth,
    health: maxHealth,
    x: CONFIG.battle.allySpawnX,
    y: CONFIG.battle.fieldHeight / 2,
    radius: CONFIG.battle.unitRadius,
    physicsRadius: CONFIG.battle.physicsRadius,
    state: "marching",
    lastAttackAt: 0,
    targetHint: "castle",
    hitUntil: 0
  };
}

export function createEnemy(definition) {
  const attackRangeBonus = definition.attackRangeBonus ?? definition.attackRange ?? CONFIG.battle.enemyAttackRangeBonus ?? 0;

  return {
    id: generateId("enemy"),
    name: definition.name,
    icon: definition.icon ?? "🚧",
    level: definition.level ?? 1,
    maxHealth: definition.health,
    health: definition.health,
    attack: definition.attack,
    attackSpeed: definition.attackSpeed,
    moveSpeed: definition.moveSpeed ?? CONFIG.battle.enemyMoveSpeed,
    attackRange: (CONFIG.battle.baseAttackReach ?? 0) + attackRangeBonus,
    attackRangeBonus,
    goldReward: definition.goldReward ?? 0,
    x: CONFIG.battle.enemySpawnX,
    y: CONFIG.battle.fieldHeight / 2,
    radius: CONFIG.battle.unitRadius,
    physicsRadius: CONFIG.battle.physicsRadius,
    state: "marching",
    lastAttackAt: 0,
    hitUntil: 0,
    isRetreating: false
  };
}
