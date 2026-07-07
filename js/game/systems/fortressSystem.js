import { CONFIG, getFortressBuildingUnlockWave } from "../config.js";
import { clamp, generateId } from "../utils.js";
import { spawnAllyForBuilding, volleyFromBuilding } from "./fortressBattleSystem.js";

export const FORTRESS_WIDTH = 5;
export const FORTRESS_HEIGHT = 7;

function costEntries(costs = {}) {
  return Object.entries(costs).filter(([, amount]) => amount > 0);
}

function normalizeFootprint(type) {
  return (CONFIG.fortressBuildings[type]?.footprint ?? [[0, 0]]).map(([x, y]) => ({ x, y }));
}

export function getUnlockedFortressBuildingTypes(waveNumber = 1) {
  return Object.entries(CONFIG.fortressBuildings)
    .filter(([type, building]) => building.unlockedByDefault || waveNumber >= getFortressBuildingUnlockWave(type))
    .map(([type]) => type);
}

export function syncFortressBuildingUnlocks(state) {
  state.fortress.unlockedBuildingTypes = getUnlockedFortressBuildingTypes(state.fortress.waveNumber ?? 1);
}

export function createFortressState() {
  const field = [];
  for (let y = 0; y < FORTRESS_HEIGHT; y += 1) {
    for (let x = 0; x < FORTRESS_WIDTH; x += 1) {
      field.push({ x, y, occupant: null });
    }
  }

  const hq = createFortressBuilding("hq", { x: 1, y: 5 });
  for (const tile of hq.tiles) {
    getTile({ fortress: { field } }, tile.x, tile.y).occupant = { buildingId: hq.id };
  }

  const reserved = new Set(hq.tiles.map((tile) => `${tile.x}:${tile.y}`));
  const candidates = field.filter((tile) => !reserved.has(`${tile.x}:${tile.y}`));
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  for (const tile of candidates.slice(0, 10)) {
    tile.occupant = "obstacle";
  }

  return {
    screen: "bottom",
    field,
    buildings: [hq],
    obstacleRemovalCost: 3,
    movingBuildingId: null,
    waveNumber: 1,
    message: "Fortress field initialized. Production continues below.",
    battle: {
      active: false,
      enemies: [],
      allies: [],
      projectiles: [],
      spawnTimer: 0,
      enemiesToSpawn: 0,
      result: null
    },
    pendingRewardDraft: null,
    buildingBuyDiscount: 1,
    earlyStart: null,
    unlockedBuildingTypes: getUnlockedFortressBuildingTypes(1)
  };
}

export function createFortressBuilding(type, origin) {
  const definition = CONFIG.fortressBuildings[type];
  const level = definition.levels[0];
  const footprint = normalizeFootprint(type);
  const baseHealthBonus = 0;
  return {
    id: generateId("building"),
    type,
    level: 1,
    tiles: footprint.map((tile) => ({ x: origin.x + tile.x, y: origin.y + tile.y })),
    hp: level.hp + baseHealthBonus,
    maxHp: level.hp + baseHealthBonus,
    damageFloor: 0,
    cooldownTimer: 0,
    activeCooldown: 0,
    activeBoostRemaining: 0,
    activeBoost: null,
    shieldRemaining: 0,
    shieldReduction: 0
  };
}

export function getBuildingActiveDefinition(building) {
  const definition = CONFIG.fortressBuildings[building.type];
  if (!definition || building.level !== definition.levels.length) {
    return null;
  }
  const maxLevel = definition.levels[definition.levels.length - 1];
  return maxLevel?.active ?? null;
}

export function getBuildingActiveCost(building) {
  const active = getBuildingActiveDefinition(building);
  return active?.cost ?? {};
}

export function triggerBuildingActive(state, buildingId) {
  if (!state.fortress.battle.active) {
    return { ok: false, reason: "Actives can only be used during battle." };
  }
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building || building.hp <= 0) {
    return { ok: false, reason: "Building not found." };
  }
  const active = getBuildingActiveDefinition(building);
  if (!active) {
    return { ok: false, reason: "This building has no active ability." };
  }
  if ((building.activeCooldown ?? 0) > 0) {
    return { ok: false, reason: "Active is on cooldown." };
  }
  const cost = active.cost ?? {};
  if (!canAffordResources(state.resources, cost)) {
    return { ok: false, reason: "Not enough resources for this active." };
  }
  if (!spendResources(state.resources, cost)) {
    return { ok: false, reason: "Not enough resources for this active." };
  }

  building.activeCooldown = active.cooldownSeconds;

  const effect = active.effect ?? {};
  if (effect.kind === "buildingDamageBoost") {
    building.activeBoost = { multiplier: effect.multiplier };
    building.activeBoostRemaining = effect.durationSeconds;
  } else if (effect.kind === "spawnSquad") {
    spawnAllyForBuilding(state, building, effect.unit, effect.count);
  } else if (effect.kind === "volley") {
    volleyFromBuilding(state, building, effect.count, effect.damage);
  } else if (effect.kind === "frost") {
    for (const enemy of state.fortress.battle.enemies) {
      if (enemy.hp <= 0) {
        continue;
      }
      enemy.frostRemaining = effect.durationSeconds;
      enemy.frostMultiplier = effect.slowMultiplier;
    }
  } else if (effect.kind === "shield") {
    const center = {
      x: building.tiles.reduce((sum, tile) => sum + tile.x, 0) / building.tiles.length,
      y: building.tiles.reduce((sum, tile) => sum + tile.y, 0) / building.tiles.length
    };
    for (const other of state.fortress.buildings) {
      if (other.hp <= 0) {
        continue;
      }
      const otherCenter = {
        x: other.tiles.reduce((sum, tile) => sum + tile.x, 0) / other.tiles.length,
        y: other.tiles.reduce((sum, tile) => sum + tile.y, 0) / other.tiles.length
      };
      const distance = Math.hypot(center.x - otherCenter.x, center.y - otherCenter.y);
      if (distance <= effect.radius) {
        other.shieldRemaining = effect.durationSeconds;
        other.shieldReduction = effect.damageReduction;
      }
    }
  }

  const definition = CONFIG.fortressBuildings[building.type];
  return { ok: true, reason: `${definition.name} used ${active.label}.` };
}

function getBaseHealthBonus(state) {
  return Math.max(0, state?.economy?.baseHealthBonus ?? 0);
}

export function getBuildingBaseHp(building) {
  const definition = CONFIG.fortressBuildings[building.type];
  return definition.levels[building.level - 1].hp;
}

export function getBuildingMaxHpCap(state, building) {
  // Attrition never reduces maxHp — only current HP. See finishBattle: defeats leave hp low,
  // maxHp stays as (baseHp + baseHealthBonus). Repair fills to full maxHp.
  const baseHp = getBuildingBaseHp(building);
  const bonusHp = getBaseHealthBonus(state);
  return Math.max(1, baseHp + bonusHp);
}

export function applyBuildingAttrition(building, state) {
  building.maxHp = getBuildingMaxHpCap(state, building);
  building.hp = Math.min(building.hp, building.maxHp);
}

export function getTile(state, x, y) {
  return state.fortress.field.find((tile) => tile.x === x && tile.y === y) ?? null;
}

export function canAffordResources(resources, costs = {}) {
  return costEntries(costs).every(([resourceKey, amount]) => (resources[resourceKey] ?? 0) >= amount);
}

export function spendResources(resources, costs = {}) {
  if (!canAffordResources(resources, costs)) {
    return false;
  }

  for (const [resourceKey, amount] of costEntries(costs)) {
    resources[resourceKey] = clamp((resources[resourceKey] ?? 0) - amount, 0, Number.MAX_SAFE_INTEGER);
  }
  return true;
}

export function getFortressBuildingBuyCost(state, type) {
  const definition = CONFIG.fortressBuildings[type];
  const discount = state.fortress.buildingBuyDiscount ?? 1;
  return Object.fromEntries(
    costEntries(definition?.buyCost ?? {}).map(([resourceKey, amount]) => [
      resourceKey,
      Math.max(1, Math.floor(amount * discount))
    ])
  );
}

export function canPlaceFortressBuilding(state, type, origin, ignoredBuildingId = null) {
  return normalizeFootprint(type).every((offset) => {
    const tile = getTile(state, origin.x + offset.x, origin.y + offset.y);
    if (!tile) {
      return false;
    }
    if (!tile.occupant) {
      return true;
    }
    return typeof tile.occupant === "object" && tile.occupant.buildingId === ignoredBuildingId;
  });
}

export function findFortressPlacement(state, type) {
  const origins = [];
  for (let y = 0; y < FORTRESS_HEIGHT; y += 1) {
    for (let x = 0; x < FORTRESS_WIDTH; x += 1) {
      const origin = { x, y };
      if (canPlaceFortressBuilding(state, type, origin)) {
        origins.push(origin);
      }
    }
  }
  return origins[Math.floor(Math.random() * origins.length)] ?? null;
}

function occupyBuilding(state, building) {
  for (const tile of building.tiles) {
    getTile(state, tile.x, tile.y).occupant = { buildingId: building.id };
  }
}

function clearBuilding(state, building) {
  for (const tile of building.tiles) {
    const fieldTile = getTile(state, tile.x, tile.y);
    if (fieldTile?.occupant?.buildingId === building.id) {
      fieldTile.occupant = null;
    }
  }
}

export function removeFortressObstacle(state, x, y) {
  const tile = getTile(state, x, y);
  if (!tile || tile.occupant !== "obstacle") {
    return { ok: false, reason: "Obstacle not found." };
  }
  if ((state.resources.gold ?? 0) < state.fortress.obstacleRemovalCost) {
    return { ok: false, reason: "Not enough gold to clear this tile." };
  }
  state.resources.gold -= state.fortress.obstacleRemovalCost;
  state.fortress.obstacleRemovalCost += 1;
  tile.occupant = null;
  return { ok: true, reason: "Obstacle cleared." };
}

export function buyFortressBuilding(state, type) {
  if (type === "hq") {
    return { ok: false, reason: "Building is locked." };
  }
  if (!state.fortress.unlockedBuildingTypes.includes(type)) {
    return { ok: false, reason: "Building is locked." };
  }
  const definition = CONFIG.fortressBuildings[type];
  const buyCost = getFortressBuildingBuyCost(state, type);
  const origin = findFortressPlacement(state, type);
  if (!origin) {
    return { ok: false, reason: "No valid space on the fortress grid." };
  }
  if (!spendResources(state.resources, buyCost)) {
    return { ok: false, reason: "Not enough resources for this building." };
  }
  const building = createFortressBuilding(type, origin);
  const bonusHp = getBaseHealthBonus(state);
  if (bonusHp > 0) {
    building.hp += bonusHp;
    building.maxHp += bonusHp;
  }
  state.fortress.buildings.push(building);
  occupyBuilding(state, building);
  return { ok: true, reason: `${definition.name} placed.` };
}

export function upgradeFortressBuilding(state, buildingId) {
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building || building.type === "hq") {
    return { ok: false, reason: "This building cannot be upgraded." };
  }
  const definition = CONFIG.fortressBuildings[building.type];
  const currentLevel = definition.levels[building.level - 1];
  const nextLevel = definition.levels[building.level];
  if (!nextLevel) {
    return { ok: false, reason: "Building is already max level." };
  }
  if (!spendResources(state.resources, currentLevel.upgradeCost)) {
    return { ok: false, reason: "Not enough resources for upgrade." };
  }
  building.level += 1;
  building.damageFloor = 0;
  const bonusHp = getBaseHealthBonus(state);
  building.maxHp = nextLevel.hp + bonusHp;
  building.hp = nextLevel.hp + bonusHp;
  return { ok: true, reason: `${definition.name} upgraded to level ${building.level}.` };
}

export function getFortressRepairCost(state, building) {
  const missing = building.maxHp - building.hp;
  if (missing <= 0) {
    return {};
  }
  const definition = CONFIG.fortressBuildings[building.type];
  const buyCost = costEntries(definition?.buyCost ?? {});
  const rate = CONFIG.attrition?.repairCostPerHpFractionOfBuyCost ?? 0;
  if (buyCost.length === 0) {
    return { wood: Math.max(1, Math.ceil(missing * 1)) };
  }
  return Object.fromEntries(
    buyCost.map(([resourceKey, amount]) => [resourceKey, Math.max(1, Math.ceil(missing * rate * amount))])
  );
}

export function repairFortressBuilding(state, buildingId) {
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building) {
    return { ok: false, reason: "Building not found." };
  }
  if (building.type === "mine") {
    return { ok: false, reason: "This building cannot be repaired." };
  }
  if (state.fortress.battle.active) {
    return { ok: false, reason: "Cannot repair during battle." };
  }
  if (building.hp >= building.maxHp) {
    return { ok: false, reason: "Building is already at full health." };
  }
  const cost = getFortressRepairCost(state, building);
  if (!spendResources(state.resources, cost)) {
    return { ok: false, reason: "Not enough resources to repair." };
  }
  building.hp = building.maxHp;
  building.damageFloor = 0;
  const definition = CONFIG.fortressBuildings[building.type];
  return { ok: true, reason: `${definition.name} repaired.` };
}

export function mergeFortressBuildings(state, sourceId, targetId) {
  const source = state.fortress.buildings.find((item) => item.id === sourceId);
  const target = state.fortress.buildings.find((item) => item.id === targetId);
  if (!source || !target) {
    return { ok: false, reason: "Building not found." };
  }
  if (source.type !== target.type) {
    return { ok: false, reason: "Buildings must be the same type to merge." };
  }
  if (source.type === "hq") {
    return { ok: false, reason: "HQ cannot be merged." };
  }
  if (source.level !== target.level) {
    return { ok: false, reason: "Buildings must be the same level to merge." };
  }
  const definition = CONFIG.fortressBuildings[target.type];
  const nextLevel = definition.levels[target.level];
  if (!nextLevel) {
    return { ok: false, reason: "Building is already max level." };
  }
  if (state.fortress.battle.active) {
    return { ok: false, reason: "Cannot merge during battle." };
  }

  clearBuilding(state, source);
  state.fortress.buildings = state.fortress.buildings.filter((item) => item.id !== source.id);

  target.level += 1;
  target.damageFloor = 0;
  const bonusHp = getBaseHealthBonus(state);
  target.maxHp = nextLevel.hp + bonusHp;
  target.hp = target.maxHp;
  target.cooldownTimer = 0;
  target.activeCooldown = 0;
  target.activeBoostRemaining = 0;
  target.activeBoost = null;
  target.shieldRemaining = 0;
  target.shieldReduction = 0;

  return { ok: true, reason: `${definition.name} merged to level ${target.level}.` };
}

export function moveFortressBuilding(state, buildingId, origin) {
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building || building.type === "hq") {
    return { ok: false, reason: "HQ stays anchored." };
  }
  if (!canPlaceFortressBuilding(state, building.type, origin, building.id)) {
    return { ok: false, reason: "That footprint does not fit there." };
  }
  clearBuilding(state, building);
  building.tiles = normalizeFootprint(building.type).map((tile) => ({ x: origin.x + tile.x, y: origin.y + tile.y }));
  occupyBuilding(state, building);
  return { ok: true, reason: "Building moved." };
}

export function applyFortressBaseHealthBonus(state, bonusAmount) {
  if (!bonusAmount) {
    return;
  }

  for (const building of state.fortress.buildings) {
    building.maxHp += bonusAmount;
    building.hp += bonusAmount;
  }
}
