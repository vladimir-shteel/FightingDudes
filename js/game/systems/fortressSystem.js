import { CONFIG, getFortressBuildingUnlockWave } from "../config.js";
import { clamp, generateId } from "../utils.js";
import { spawnAllyForBuilding, volleyFromBuilding } from "./fortressBattleSystem.js";

// Field is played horizontally: base on the LEFT, enemies march in from the RIGHT.
export const FORTRESS_WIDTH = 9;
export const FORTRESS_HEIGHT = 7;

function costEntries(costs = {}) {
  return Object.entries(costs).filter(([, amount]) => amount > 0);
}

// Exported for the UI's drag-and-drop footprint highlighting.
export function normalizeFootprint(type) {
  return (CONFIG.fortressBuildings[type]?.footprint ?? [[0, 0]]).map(([x, y]) => ({ x, y }));
}

function getFortressLayoutConfig() {
  return CONFIG.fortress ?? {};
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

  // Base hugs the left edge, vertically centred on the 7-row field (rows 2-4).
  const draftState = { fortress: { field, buildings: [] } };
  const hq = createFortressBuilding("hq", { x: 0, y: 2 });
  occupyBuilding(draftState, hq);
  draftState.fortress.buildings.push(hq);

  // Starting loadout: HQ + barracks (support, right next to HQ) + wall (forward blocker, ahead of
  // the base since enemies march in from the right). Placement uses normalizeFootprint/
  // canPlaceFortressBuilding so it stays correct if footprints change in config.
  const startingBuildings = [hq];
  const barracksOrigin = { x: 2, y: 2 };
  if (canPlaceFortressBuilding(draftState, "barracks", barracksOrigin)) {
    const barracks = createFortressBuilding("barracks", barracksOrigin);
    occupyBuilding(draftState, barracks);
    draftState.fortress.buildings.push(barracks);
    startingBuildings.push(barracks);
  }
  const wallOrigin = { x: 4, y: 3 };
  if (canPlaceFortressBuilding(draftState, "wall", wallOrigin)) {
    const wall = createFortressBuilding("wall", wallOrigin);
    occupyBuilding(draftState, wall);
    draftState.fortress.buildings.push(wall);
    startingBuildings.push(wall);
  }

  const reserved = new Set(
    startingBuildings.flatMap((building) => building.tiles.map((tile) => `${tile.x}:${tile.y}`))
  );
  const candidates = field.filter((tile) => !reserved.has(`${tile.x}:${tile.y}`));
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  const obstacleCount = getFortressLayoutConfig().obstacleCount ?? 10;
  for (const tile of candidates.slice(0, obstacleCount)) {
    tile.occupant = "obstacle";
  }

  return {
    screen: "bottom",
    field,
    buildings: startingBuildings,
    // Bought-but-not-yet-placed buildings live here until the player drops them on the field
    // (or drops one onto a matching building to merge immediately).
    unplacedBuildings: [],
    obstacleRemovalCost: getFortressLayoutConfig().obstacleRemovalBaseCost ?? 3,
    movingBuildingId: null,
    waveNumber: 1,
    message: "Fortress field initialized. Place buildings, then hit Start.",
    battle: {
      active: false,
      enemies: [],
      allies: [],
      projectiles: [],
      bursts: [],
      spawnTimer: 0,
      enemiesToSpawn: 0,
      result: null
    },
    pendingRewardDrafts: [],
    activeUpgradeEffects: [],
    buildingBuyDiscount: 1,
    stream: {
      active: false,
      phase: "idle",
      currentWaveIndex: -1,
      gapTimer: 0
    },
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

export function getBuildingActiveCost(state, building) {
  const active = getBuildingActiveDefinition(building);
  const base = active?.cost ?? {};
  // Cost accumulation is currently disabled (`abilityCostAccumulation: 1`): the stream model runs one
  // continuous battle for the whole match, so a per-cast multiplier that only resets on battle start
  // would compound unboundedly over 24 waves. `activeCasts` still increments below in case a future
  // balance pass reintroduces escalation with a real reset point (e.g. per-wave).
  const casts = state?.fortress?.battle?.activeCasts ?? 0;
  const mult = Math.pow(CONFIG.abilityCostAccumulation ?? 1, casts);
  return Object.fromEntries(
    Object.entries(base).map(([resourceKey, amount]) => [resourceKey, Math.max(1, Math.floor(amount * mult))])
  );
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
  const cost = getBuildingActiveCost(state, building);
  if (!canAffordResources(state.resources, cost)) {
    return { ok: false, reason: "Not enough resources for this active." };
  }
  if (!spendResources(state.resources, cost)) {
    return { ok: false, reason: "Not enough resources for this active." };
  }

  // Each cast raises the cost of the NEXT active this battle (accumulating Sink).
  state.fortress.battle.activeCasts = (state.fortress.battle.activeCasts ?? 0) + 1;
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
  // maxHp = baseHp + baseHealthBonus. Combat only ever reduces current hp; repair refills to maxHp.
  const baseHp = getBuildingBaseHp(building);
  const bonusHp = getBaseHealthBonus(state);
  return Math.max(1, baseHp + bonusHp);
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
  // Over-build escalation now scales with the total INVESTED POWER in this TYPE — Σ 2^(level-1) over
  // its buildings, exactly like the worker buy curve (E = Σ 2^(level-1)). Both going wide (more
  // buildings) AND going tall (higher tiers) raise the next cost, and MERGING is power-neutral
  // (two L1 = 1+1 = 2 = one L2), so you can no longer dodge the escalation by tiering up. This turns
  // the whole fortress into a capital sink: on a finite grid the cost to keep arming it outruns your
  // income, so you're always building toward the next piece instead of maxing out and drowning.
  // DIVERSIFYING (a fresh type) still starts at base cost; walls escalate gently (chaff layer).
  const esc = CONFIG.buildingCostEscalation ?? {};
  const factorBase = esc[type] ?? esc.default ?? 1;
  const typePower = state.fortress.buildings
    .filter((building) => building.type === type)
    .reduce((sum, building) => sum + 2 ** ((building.level ?? 1) - 1), 0);
  const escalation = Math.pow(factorBase, typePower);
  return Object.fromEntries(
    costEntries(definition?.buyCost ?? {}).map(([resourceKey, amount]) => [
      resourceKey,
      Math.max(1, Math.floor(amount * discount * escalation))
    ])
  );
}

export function canPlaceFortressBuilding(state, type, origin, ignoredBuildingId = null) {
  return normalizeFootprint(type).every((offset) => {
    const tx = origin.x + offset.x;
    const ty = origin.y + offset.y;
    const tile = getTile(state, tx, ty);
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
  state.fortress.obstacleRemovalCost += getFortressLayoutConfig().obstacleRemovalCostStep ?? 1;
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
  if (!spendResources(state.resources, buyCost)) {
    return { ok: false, reason: "Not enough resources for this building." };
  }
  // No auto-placement: the building is created "in hand" (empty tiles, unplacedBuildings) and the
  // player decides where it goes — drop it on a free tile, or straight onto a matching building
  // to merge. createFortressBuilding needs a dummy origin; tiles are re-derived on placement.
  const building = createFortressBuilding(type, { x: 0, y: 0 });
  building.tiles = [];
  const bonusHp = getBaseHealthBonus(state);
  if (bonusHp > 0) {
    building.hp += bonusHp;
    building.maxHp += bonusHp;
  }
  state.fortress.unplacedBuildings.push(building);
  return { ok: true, reason: `${definition.name} bought — drag it onto the field, or onto a matching building to merge.` };
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
  // Repair scales with the MISSING HP FRACTION (0..1), not absolute HP — otherwise high-HP
  // buildings (e.g. L5 walls) would cost absurd amounts to repair. Cheap & incremental by design
  // (§5): a fully-destroyed building costs `rate` × its buyCost to restore. rate ≈ 0.5.
  const missingFraction = Math.min(1, missing / Math.max(1, building.maxHp));
  const definition = CONFIG.fortressBuildings[building.type];
  const buyCost = costEntries(definition?.buyCost ?? {});
  const rate = CONFIG.attrition?.repairCostPerHpFractionOfBuyCost ?? 0;
  // Basis scales LINEARLY with tier (buyCost × level): a maxed building represents a bigger
  // investment, so repairing it costs proportionally more — this is what makes attrition a real
  // per-wave sink. Linear (not the merge 2^level) keeps late repair affordable (no death-spiral).
  const levelMult = building.level ?? 1;
  if (buyCost.length === 0) {
    const fallbackWoodPerLevel = getFortressLayoutConfig().repairFallbackWoodPerLevel ?? 20;
    return { wood: Math.max(1, Math.ceil(missingFraction * fallbackWoodPerLevel * levelMult)) };
  }
  return Object.fromEntries(
    buyCost.map(([resourceKey, amount]) => [resourceKey, Math.max(1, Math.ceil(missingFraction * rate * amount * levelMult))])
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
  if (building.hp >= building.maxHp) {
    return { ok: false, reason: "Building is already at full health." };
  }
  const cost = getFortressRepairCost(state, building);
  if (!spendResources(state.resources, cost)) {
    return { ok: false, reason: "Not enough resources to repair." };
  }
  building.hp = building.maxHp;
  const definition = CONFIG.fortressBuildings[building.type];
  return { ok: true, reason: `${definition.name} repaired.` };
}

// Crystal is the "late power" currency: merging a combat building into a high tier costs crystal
// (top-tier merges only — walls/traps stay wood/iron). This is what makes crystal a NON-optional
// sink; the cheapest maxed defense cannot route around it. Which buildings are gated is declared per
// building via `crystalMergeGated` in fortress-buildings.json. Tuned via balance.merge.crystalCostByLevel.
export function getMergeCrystalCost(type, targetLevel) {
  if (!CONFIG.fortressBuildings[type]?.crystalMergeGated) {
    return 0;
  }
  const table = CONFIG.merge?.crystalCostByLevel ?? {};
  return table[String(targetLevel)] ?? 0;
}

// Shared validity rule for a merge attempt, used by the click path AND by drag-and-drop
// hit-testing/highlighting (must stay in sync with what mergeFortressBuildings actually accepts).
export function canMergeFortressBuildings(state, source, target) {
  return Boolean(
    source &&
    target &&
    source.id !== target.id &&
    source.type !== "hq" &&
    source.hp > 0 &&
    target.hp > 0 &&
    source.type === target.type &&
    source.level === target.level &&
    Boolean(CONFIG.fortressBuildings[target.type]?.levels[target.level])
  );
}

export function mergeFortressBuildings(state, sourceId, targetId) {
  const source = findAnyFortressBuilding(state, sourceId);
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
  if (source.hp <= 0 || target.hp <= 0) {
    return { ok: false, reason: "Destroyed buildings cannot be merged." };
  }
  if (source.level !== target.level) {
    return { ok: false, reason: "Buildings must be the same level to merge." };
  }
  const definition = CONFIG.fortressBuildings[target.type];
  const nextLevel = definition.levels[target.level];
  if (!nextLevel) {
    return { ok: false, reason: "Building is already max level." };
  }
  const crystalCost = getMergeCrystalCost(target.type, target.level + 1);
  if (crystalCost > 0 && !spendResources(state.resources, { crystal: crystalCost })) {
    return { ok: false, reason: `Need ${crystalCost} 💎 to merge to level ${target.level + 1}.` };
  }

  // Remap source's alive units to target so the cap tracks correctly after merge.
  if (state.fortress.battle?.allies) {
    for (const ally of state.fortress.battle.allies) {
      if (ally.hp > 0 && ally.sourceBuildingId === source.id) {
        ally.sourceBuildingId = target.id;
      }
    }
  }

  clearBuilding(state, source);
  state.fortress.buildings = state.fortress.buildings.filter((item) => item.id !== source.id);
  // The source may have been a bought-but-unplaced building (merge right after purchase).
  if (state.fortress.unplacedBuildings?.length) {
    state.fortress.unplacedBuildings = state.fortress.unplacedBuildings.filter((item) => item.id !== source.id);
  }

  target.level += 1;
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

// Mass merge (mirrors reserveSystem.massMergeReserve): repeatedly merge any same-type + same-level pair
// until none remain. Merging is adjacency-free (mergeFortressBuildings takes two ids and frees the
// source tiles), so this collapses the whole field's mergeable pairs in one click. Pairs whose next
// tier needs crystal you can't afford are skipped (not fatal) — everything else still merges.
export function massMergeFortressBuildings(state) {
  let mergedCount = 0;
  let blockedByCrystal = false;
  while (true) {
    const groups = new Map();
    for (const building of state.fortress.buildings) {
      if (building.type === "hq") continue;
      const definition = CONFIG.fortressBuildings[building.type];
      if (!definition || !definition.levels[building.level]) continue; // already max tier
      const key = `${building.type}:${building.level}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(building.id);
    }

    let mergedThisPass = false;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const result = mergeFortressBuildings(state, ids[0], ids[1]);
      if (result.ok) {
        mergedCount += 1;
        mergedThisPass = true;
        break; // rebuild groups (levels changed) before continuing
      }
      // Failed pair (e.g. not enough crystal for a top-tier merge): skip this group, try others.
      blockedByCrystal = true;
    }
    if (!mergedThisPass) break;
  }

  if (mergedCount > 0) {
    return { ok: true, reason: `Mass merge completed: ${mergedCount} merge(s).` };
  }
  return {
    ok: false,
    reason: blockedByCrystal
      ? "No affordable merges — top-tier merges need 💎 crystal."
      : "No matching building pairs to merge."
  };
}

// Looks in placed buildings first, then in the unplaced (bought, not yet dropped) tray.
export function findAnyFortressBuilding(state, buildingId) {
  return (
    state.fortress.buildings.find((item) => item.id === buildingId) ??
    state.fortress.unplacedBuildings?.find((item) => item.id === buildingId) ??
    null
  );
}

export function moveFortressBuilding(state, buildingId, origin) {
  const building = findAnyFortressBuilding(state, buildingId);
  if (!building) {
    return { ok: false, reason: "Building not found." };
  }
  if (!canPlaceFortressBuilding(state, building.type, origin, building.id)) {
    return { ok: false, reason: "That footprint does not fit there." };
  }
  const wasUnplaced = state.fortress.unplacedBuildings?.some((item) => item.id === buildingId) ?? false;
  clearBuilding(state, building);
  building.tiles = normalizeFootprint(building.type).map((t) => ({ x: origin.x + t.x, y: origin.y + t.y }));
  occupyBuilding(state, building);
  if (wasUnplaced) {
    state.fortress.unplacedBuildings = state.fortress.unplacedBuildings.filter((item) => item.id !== buildingId);
    state.fortress.buildings.push(building);
    return { ok: true, reason: "Building placed." };
  }
  return { ok: true, reason: "Building moved." };
}

// A purchase is only useful if the new copy can go somewhere: a free placement exists,
// or there is already a same-type + same-level pair on the field/tray to merge it with.
export function hasFortressMergePair(state, type) {
  const levelCounts = new Map();
  const pool = [...state.fortress.buildings, ...(state.fortress.unplacedBuildings ?? [])];
  for (const building of pool) {
    if (building.type !== type || building.type === "hq") {
      continue;
    }
    if (!CONFIG.fortressBuildings[type]?.levels[building.level]) {
      continue; // already max tier
    }
    const count = (levelCounts.get(building.level) ?? 0) + 1;
    if (count >= 2) {
      return true;
    }
    levelCounts.set(building.level, count);
  }
  return false;
}

export function hasFortressPlacementOrMerge(state, type) {
  return Boolean(findFortressPlacement(state, type)) || hasFortressMergePair(state, type);
}

// Book value of a building = what it cost to FIELD at its current tier via the (only) upgrade path,
// merging: buyCost × 2^(level-1) base copies + crystal spent on each top-tier merge step (mirrors the
// ladder in mergeFortressBuildings). Demolish hands back `refundFraction` of that, floored per resource.
export function getFortressBuildingRefund(state, building) {
  const definition = CONFIG.fortressBuildings[building.type];
  if (!definition || building.type === "hq") {
    return {};
  }
  const fraction = CONFIG.demolish?.refundFraction ?? 0.4;
  const level = building.level ?? 1;
  const copies = 2 ** (level - 1);
  const refund = {};
  for (const [resourceKey, amount] of costEntries(definition.buyCost ?? {})) {
    const value = Math.floor(amount * copies * fraction);
    if (value > 0) {
      refund[resourceKey] = (refund[resourceKey] ?? 0) + value;
    }
  }
  // Crystal sunk into top-tier merges (L4/L5): 2^(level-j) merges produce a level-j building.
  let crystal = 0;
  for (let j = 2; j <= level; j += 1) {
    crystal += (2 ** (level - j)) * getMergeCrystalCost(building.type, j);
  }
  const crystalRefund = Math.floor(crystal * fraction);
  if (crystalRefund > 0) {
    refund.crystal = (refund.crystal ?? 0) + crystalRefund;
  }
  return refund;
}

// Demolishing charges GOLD (a sink for the one currency mining never produces) and hands back a
// fraction of the spent resources. Cost scales with invested power (2^(level-1) copies) like the
// refund, so churning a maxed building is a real gold decision, not free reorganising.
export function getFortressBuildingDemolishGoldCost(state, building) {
  if (!building || building.type === "hq") {
    return 0;
  }
  const perCopy = CONFIG.demolish?.goldCostPerCopy ?? 0;
  if (perCopy <= 0) {
    return 0;
  }
  const copies = 2 ** ((building.level ?? 1) - 1);
  return Math.max(1, Math.round(perCopy * copies));
}

export function demolishFortressBuilding(state, buildingId) {
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building) {
    return { ok: false, reason: "Building not found." };
  }
  if (building.type === "hq") {
    return { ok: false, reason: "The HQ cannot be demolished." };
  }
  const definition = CONFIG.fortressBuildings[building.type];
  const goldCost = getFortressBuildingDemolishGoldCost(state, building);
  if ((state.resources.gold ?? 0) < goldCost) {
    return { ok: false, reason: `Need ${goldCost} gold to demolish.` };
  }
  state.resources.gold -= goldCost;
  const refund = getFortressBuildingRefund(state, building);
  for (const [resourceKey, amount] of costEntries(refund)) {
    state.resources[resourceKey] = (state.resources[resourceKey] ?? 0) + amount;
  }
  clearBuilding(state, building);
  state.fortress.buildings = state.fortress.buildings.filter((item) => item.id !== building.id);
  if (state.ui?.fortressPopup?.kind === "building" && state.ui.fortressPopup.buildingId === building.id) {
    state.ui.fortressPopup = null;
  }
  const refundText = costEntries(refund).map(([key, amount]) => `${amount} ${key}`).join(", ");
  return {
    ok: true,
    reason: `${definition?.name ?? "Building"} demolished (−${goldCost} gold).${refundText ? ` Refunded ${refundText}.` : ""}`
  };
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
