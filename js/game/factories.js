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
    baseHealth: levelData.baseHealth,
    baseAttack: levelData.baseAttack,
    baseAttackSpeed: levelData.baseAttackSpeed,
    gearKey: null
  };
}

export function createMine(index) {
  return {
    id: generateId("mine"),
    name: `Mine ${index + 1}`,
    level: 1,
    workerIds: [null, null, null, null]
  };
}

export function createBattleUnit(unit, gearKey) {
  const gear = CONFIG.equipment[gearKey];
  const maxHealth = unit.baseHealth + gear.healthBonus;

  return {
    id: generateId("battle"),
    sourceUnitId: unit.id,
    name: unit.name,
    level: unit.level,
    gearKey,
    attackType: gear.attackType,
    attack: unit.baseAttack * gear.attackMultiplier,
    attackSpeed: unit.baseAttackSpeed * gear.attackSpeedMultiplier,
    moveSpeed: CONFIG.battle.allyMoveSpeed,
    attackRange: gear.attackType === "ranged" ? CONFIG.battle.contactRange + 4 : CONFIG.battle.contactRange,
    maxHealth,
    health: maxHealth,
    x: CONFIG.battle.allySpawnX,
    lane: 0,
    radius: CONFIG.battle.unitRadius,
    state: "marching",
    lastAttackAt: 0,
    targetHint: "castle"
  };
}

export function createEnemy(definition) {
  return {
    id: generateId("enemy"),
    name: definition.name,
    level: definition.level ?? 1,
    maxHealth: definition.health,
    health: definition.health,
    attack: definition.attack,
    attackSpeed: definition.attackSpeed,
    moveSpeed: definition.moveSpeed ?? CONFIG.battle.enemyMoveSpeed,
    attackRange: definition.attackRange ?? CONFIG.battle.contactRange,
    x: CONFIG.battle.enemySpawnX,
    lane: 0,
    radius: CONFIG.battle.unitRadius,
    state: "marching",
    lastAttackAt: 0
  };
}
