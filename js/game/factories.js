import { CONFIG, getClassConfig, getUnitLevelData } from "./config.js";
import { generateId } from "./utils.js";

function getMeleeReach() {
  return (CONFIG.battle.baseAttackReach ?? 0) + (CONFIG.battle.meleeAttackRangeBonus ?? 0);
}

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

  return {
    id: generateId("mine"),
    name: resourceType.mineName,
    resourceKey: resourceType.key,
    resourceLabel: resourceType.label,
    unlockCost: resourceType.unlockCost ?? 0,
    unlockCurrency: resourceType.unlockCurrency ?? "gold",
    isUnlocked: index === 0,
    level: 1,
    workerIds: [null, null, null, null],
    workerProgress: [0, 0, 0, 0],
    passiveProgress: 0
  };
}

export function createBattleUnit(unit, classId, formationRow = "front") {
  const classData = getClassConfig(classId);
  if (!classData) {
    throw new Error(`Missing class config for ${classId}`);
  }

  const maxHealth = Math.round(unit.baseHealth * classData.healthMult);
  const attackType = classData.attackType ?? "melee";
  // Kamikaze drives all the way to contact (no attack-range standoff).
  const attackRange = classData.movementType === "kamikaze"
    ? 0
    : (classData.attackRange ?? getMeleeReach());

  return {
    id: generateId("battle"),
    sourceUnitId: unit.id,
    name: classData.name,
    class: classId,
    level: unit.level,
    icon: unit.icon,
    classIcon: classData.icon,
    formationRow,

    attackType,
    attack: Math.round(unit.baseAttack * classData.attackMult),
    attackSpeed: unit.baseAttackSpeed,
    moveSpeed: (CONFIG.battle.allyMoveSpeed ?? 24) * (classData.moveSpeedMult ?? 1),
    attackRange,
    splashRadius: classData.splashRadius ?? 0,
    canHitFlying: classData.canHitFlying ?? false,

    movementType: classData.movementType ?? "ground",
    targetMode: classData.targetMode ?? "closest",
    explosionDamage: classData.explosionDamage ?? 0,
    explosionRadius: classData.explosionRadius ?? 0,

    poisonDps: classData.poisonDps ?? 0,
    poisonDuration: classData.poisonDuration ?? 0,
    healAmount: classData.healAmount ?? 0,
    healInterval: classData.healInterval ?? 0,
    healRadius: classData.healRadius ?? 0,
    berserkerScaling: classData.berserkerScaling ?? false,

    maxHealth,
    health: maxHealth,
    x: CONFIG.battle.allySpawnX,
    y: CONFIG.battle.fieldHeight / 2,
    radius: CONFIG.battle.unitRadius,
    physicsRadius: CONFIG.battle.physicsRadius,
    side: "ally",
    state: "marching",
    lastAttackAt: 0,
    lastHealTime: 0,
    poisonStacks: [],
    targetHint: "advance",
    hitUntil: 0
  };
}

export function createEnemy(definition, formationRow = "front") {
  const hasExplicitRange = definition.attackRange !== undefined;
  const attackRangeBonus = definition.attackRangeBonus ?? CONFIG.battle.enemyAttackRangeBonus ?? 0;
  const attackRange = definition.movementType === "kamikaze"
    ? 0
    : hasExplicitRange
      ? definition.attackRange
      : (CONFIG.battle.baseAttackReach ?? 0) + attackRangeBonus;

  return {
    id: generateId("enemy"),
    name: definition.name,
    icon: definition.icon ?? "🚧",
    class: definition.class ?? null,
    level: definition.level ?? 1,
    formationRow,

    attackType: definition.attackType ?? (hasExplicitRange ? "ranged" : "melee"),
    attack: definition.attack,
    attackSpeed: definition.attackSpeed,
    moveSpeed: definition.moveSpeed ?? CONFIG.battle.enemyMoveSpeed,
    attackRange,
    attackRangeBonus,
    splashRadius: definition.splashRadius ?? 0,
    canHitFlying: definition.canHitFlying ?? false,

    movementType: definition.movementType ?? "ground",
    targetMode: definition.targetMode ?? "closest",
    explosionDamage: definition.explosionDamage ?? 0,
    explosionRadius: definition.explosionRadius ?? 0,
    poisonDps: definition.poisonDps ?? 0,
    poisonDuration: definition.poisonDuration ?? 0,
    // Location 3 enemy specials: self/ally healing (Жрец) and rage scaling (Берсерк).
    healAmount: definition.healAmount ?? 0,
    healInterval: definition.healInterval ?? 0,
    healRadius: definition.healRadius ?? 0,
    berserkerScaling: definition.berserkerScaling ?? false,

    goldReward: definition.goldReward ?? 0,
    isBoss: definition.isBoss ?? false,
    maxHealth: definition.health,
    health: definition.health,
    x: CONFIG.battle.enemySpawnX,
    y: CONFIG.battle.fieldHeight / 2,
    radius: CONFIG.battle.unitRadius,
    physicsRadius: CONFIG.battle.physicsRadius,
    side: "enemy",
    state: "marching",
    lastAttackAt: 0,
    lastHealTime: 0,
    poisonStacks: [],
    hitUntil: 0
  };
}
