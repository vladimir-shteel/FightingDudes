import { CONFIG, getMineMaxLevel, getUnitLevelData } from "../config.js";
import { getMaxWorkerLevel } from "./workerTraitSystem.js";
import { applyFortressBaseHealthBonus, canAffordResources, spendResources } from "./fortressSystem.js";
import { getCapstoneBattleDamageBonus } from "./workerTraitSystem.js";

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)] ?? null;
}

function findMine(state, resourceKey) {
  return state.mines.find((mine) => mine.resourceKey === resourceKey) ?? null;
}

function getLockedBuildingTypes(state) {
  return Object.entries(CONFIG.fortressBuildings)
    .filter(([type]) => type !== "hq" && !state.fortress.unlockedBuildingTypes.includes(type))
    .map(([type]) => type);
}

function raiseUnitToLevel(unit, targetLevel) {
  if (!unit || unit.level >= targetLevel) {
    return false;
  }

  const levelData = getUnitLevelData(targetLevel);
  if (!levelData) {
    return false;
  }

  unit.name = levelData.name;
  unit.level = targetLevel;
  unit.icon = levelData.icon ?? unit.icon;
  unit.baseHealth = levelData.baseHealth;
  unit.baseAttack = levelData.baseAttack;
  unit.baseAttackSpeed = levelData.baseAttackSpeed;
  return true;
}

function raiseExistingWorkersToLevel(state, targetLevel) {
  let raisedCount = 0;

  for (const unit of state.reserveUnits) {
    if (raiseUnitToLevel(unit, targetLevel)) {
      raisedCount += 1;
    }
  }

  for (const mine of state.mines) {
    for (const unit of mine.workerIds) {
      if (raiseUnitToLevel(unit, targetLevel)) {
        raisedCount += 1;
      }
    }
  }

  return raisedCount;
}

function getRewardDraftConfig() {
  return CONFIG.rewardDraft ?? {};
}

function formatPercent(multiplier) {
  return `${Math.round((multiplier - 1) * 100)}%`;
}

function createCard({
  id,
  category,
  title,
  description,
  effectText,
  durationText,
  apply
}) {
  return {
    id,
    category,
    title,
    description,
    effectText,
    durationText,
    apply
  };
}

function getRewardCategoryLabel(category) {
  if (category === "oneShot") return "One Shot";
  return category.charAt(0).toUpperCase() + category.slice(1);
}

// === HQ upgrade shop =======================================================================
// The former permanent reward CARDS are now purchasable HQ upgrades with an escalating cost curve —
// a bottomless, wave-scaling resource+gold SINK that soaks the late-game surplus. The player either
// BUYS the buff here or takes an equivalent (temporary/one-shot) reward after a wave.
function hqPermConfig() {
  return CONFIG.hqUpgrades?.permanent ?? {};
}

export function getHqUpgradeLevel(state, key) {
  return state.economy.hqUpgradeLevels?.[key] ?? 0;
}

export function getHqUpgradeCost(state, key) {
  const cfg = hqPermConfig()[key];
  if (!cfg) return {};
  const level = getHqUpgradeLevel(state, key);
  const growth = cfg.costGrowth ?? 1.6;
  return Object.fromEntries(
    Object.entries(cfg.baseCost ?? {}).map(([resourceKey, amount]) => [
      resourceKey,
      Math.max(1, Math.round(amount * growth ** level))
    ])
  );
}

export function buyHqUpgrade(state, key) {
  const cfg = hqPermConfig()[key];
  if (!cfg) return { ok: false, reason: "Unknown HQ upgrade." };
  if (state.fortress.battle.active) return { ok: false, reason: "Cannot upgrade the HQ during battle." };
  state.economy.hqUpgradeLevels ??= { gold: 0, resource: 0, health: 0 };
  const cost = getHqUpgradeCost(state, key);
  if (!spendResources(state.resources, cost)) return { ok: false, reason: "Not enough resources for this HQ upgrade." };
  state.economy.hqUpgradeLevels[key] = getHqUpgradeLevel(state, key) + 1;
  if (key === "health") {
    const bonus = cfg.baseHealthBonus ?? 0;
    state.economy.baseHealthBonus = (state.economy.baseHealthBonus ?? 0) + bonus;
    applyFortressBaseHealthBonus(state, bonus);
  }
  return { ok: true, reason: `${cfg.label} raised to level ${state.economy.hqUpgradeLevels[key]}.` };
}

function hqTempConfig() {
  return CONFIG.hqUpgrades?.temporary ?? {};
}

export function getHqTemporaryCost(kind) {
  return hqTempConfig()[kind]?.cost ?? {};
}

export function buyHqTemporaryBuff(state, kind) {
  const cfg = hqTempConfig()[kind];
  if (!cfg) return { ok: false, reason: "Unknown buff." };
  const cost = cfg.cost ?? {};
  if (!spendResources(state.resources, cost)) return { ok: false, reason: "Not enough resources for this buff." };
  const duration = Math.max(1, hqTempConfig().durationWaves ?? 2);
  state.economy.queuedTemporaryBonuses.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    multiplier: cfg.multiplier ?? 1,
    remainingWaves: duration
  });
  return { ok: true, reason: `${cfg.label} queued — begins next wave for ${duration} wave${duration === 1 ? "" : "s"}.` };
}

export function canAffordHqUpgrade(state, cost) {
  return canAffordResources(state.resources, cost);
}

function buildTemporaryCards() {
  const config = getRewardDraftConfig().temporary ?? {};
  const duration = Math.max(1, config.durationWaves ?? 2);
  return [
    createCard({
      id: "temp-production",
      category: "temporary",
      title: "Harvest Surge",
      description: "Resource production spikes for a few waves.",
      effectText: `Production x${config.productionMultiplier ?? 1.25}`,
      durationText: `${duration} wave${duration === 1 ? "" : "s"}`,
      apply(state) {
        state.economy.queuedTemporaryBonuses.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: "production",
          multiplier: config.productionMultiplier ?? 1.25,
          remainingWaves: duration
        });
      }
    }),
    createCard({
      id: "temp-damage",
      category: "temporary",
      title: "War Drums",
      description: "Your fortress units hit harder for a few waves.",
      effectText: `Damage x${config.damageMultiplier ?? 1.2}`,
      durationText: `${duration} wave${duration === 1 ? "" : "s"}`,
      apply(state) {
        state.economy.queuedTemporaryBonuses.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: "damage",
          multiplier: config.damageMultiplier ?? 1.2,
          remainingWaves: duration
        });
      }
    }),
    createCard({
      id: "temp-defense",
      category: "temporary",
      title: "Shield Wall",
      description: "Incoming damage to the fortress is reduced for a few waves.",
      effectText: `Defense x${config.defenseMultiplier ?? 1.15}`,
      durationText: `${duration} wave${duration === 1 ? "" : "s"}`,
      apply(state) {
        state.economy.queuedTemporaryBonuses.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: "defense",
          multiplier: config.defenseMultiplier ?? 1.15,
          remainingWaves: duration
        });
      }
    })
  ];
}

function upgradeFirstWorker(state) {
  const workers = [];
  for (const unit of state.reserveUnits) {
    workers.push({ unit, source: "reserve" });
  }
  for (const mine of state.mines) {
    for (const unit of mine.workerIds) {
      if (unit) {
        workers.push({ unit, source: mine.id });
      }
    }
  }

  // Respect the wave level cap — a free promotion must not vault a worker past the tier the wave
  // gate allows (that cap is what keeps the roster wide and paces capstones).
  const levelCap = getMaxWorkerLevel(state);
  const candidate = workers.find(({ unit }) => unit.level < levelCap) ?? null;
  if (!candidate) {
    return { ok: false, reason: "No worker can be promoted yet (level cap rises each wave)." };
  }

  const nextLevel = candidate.unit.level + 1;
  return raiseUnitToLevel(candidate.unit, nextLevel)
    ? { ok: true, reason: `${candidate.unit.name} promoted to level ${candidate.unit.level}.` }
    : { ok: false, reason: "Worker upgrade failed." };
}

function upgradeFirstBuilding(state) {
  // A free upgrade must not vault a building past the crystal gate (L4+). Otherwise this reward
  // skips the crystal economy entirely and breaks tier pacing.
  const crystalLevels = Object.keys(CONFIG.merge?.crystalCostByLevel ?? {}).map(Number).filter((n) => !Number.isNaN(n));
  const crystalGateLevel = crystalLevels.length ? Math.min(...crystalLevels) : Infinity;
  const building = state.fortress.buildings.find((item) =>
    item.type !== "hq"
    && item.level < (CONFIG.fortressBuildings[item.type]?.levels.length ?? 0)
    && item.level + 1 < crystalGateLevel
  );
  if (!building) {
    return { ok: false, reason: "No building can be upgraded for free (top tiers need 💎 crystal)." };
  }

  const definition = CONFIG.fortressBuildings[building.type];
  const nextLevel = definition.levels[building.level];
  if (!nextLevel) {
    return { ok: false, reason: "No building can be upgraded." };
  }

  building.level += 1;
  building.damageFloor = 0;
  building.maxHp = nextLevel.hp + (state.economy.baseHealthBonus ?? 0);
  building.hp = building.maxHp;
  return { ok: true, reason: `${definition.name} upgraded to level ${building.level}.` };
}

function unlockOrExpandMine(state) {
  // Only unlock/expand what is ALREADY wave-eligible: the reward waives the gold cost, it does NOT
  // skip the wave gates. Unlocking a mine (esp. crystal) or a slot early would break the resource /
  // crystal-gate pacing — exactly the "auto mine upgrade" that facerolled the loop.
  const wave = state.fortress.waveNumber ?? 1;

  const lockedMine = state.mines.find((item) => !item.isUnlocked && wave >= (item.unlockWave ?? 1)) ?? null;
  if (lockedMine) {
    lockedMine.isUnlocked = true;
    lockedMine.purchasedSlotIndices[0] = true;
    lockedMine.level = Math.max(1, lockedMine.level);
    return { ok: true, reason: `${lockedMine.name} unlocked.` };
  }

  for (const mine of state.mines) {
    if (!mine.isUnlocked) continue;
    const nextSlotIndex = (mine.purchasedSlotIndices ?? []).findIndex((isPurchased) => !isPurchased);
    if (nextSlotIndex < 0) continue;
    const slotUnlockWave = mine.slotUnlockWaves?.[nextSlotIndex] ?? 1;
    if (wave < slotUnlockWave) continue;
    mine.purchasedSlotIndices[nextSlotIndex] = true;
    mine.level = Math.min(getMineMaxLevel(), Math.max(mine.level, nextSlotIndex + 1));
    return { ok: true, reason: `${mine.name} gained slot ${nextSlotIndex + 1}.` };
  }

  return { ok: false, reason: "No mine slot is available to expand yet." };
}

function repairFortress(state) {
  let repairedCount = 0;
  for (const building of state.fortress.buildings) {
    if (building.hp < building.maxHp) {
      building.hp = building.maxHp;
      repairedCount += 1;
    }
  }

  if (repairedCount === 0) {
    return { ok: false, reason: "No buildings need repairs." };
  }

  return { ok: true, reason: `Mass repair restored ${repairedCount} building(s).` };
}

function injectResources(state) {
  const config = getRewardDraftConfig().oneShot ?? {};
  const gold = Math.max(0, config.goldInjection ?? 180);
  const resource = Math.max(0, config.resourceInjection ?? 70);

  state.resources.gold += gold;
  for (const mineType of CONFIG.mine.resourceTypes) {
    state.resources[mineType.key] = (state.resources[mineType.key] ?? 0) + resource;
  }

  return { ok: true, reason: `Supply drop delivered +${gold} gold and +${resource} of each resource.` };
}

function buildOneShotCards() {
  return [
    createCard({
      id: "shot-worker",
      category: "oneShot",
      title: "Worker Promotion",
      description: "Promote one worker by a level if possible.",
      effectText: "Upgrade one worker now",
      durationText: "Instant",
      apply(state) {
        return upgradeFirstWorker(state);
      }
    }),
    createCard({
      id: "shot-building",
      category: "oneShot",
      title: "Building Upgrade",
      description: "Upgrade one fortress building without paying its cost.",
      effectText: "Upgrade one building now",
      durationText: "Instant",
      apply(state) {
        return upgradeFirstBuilding(state);
      }
    }),
    createCard({
      id: "shot-mine",
      category: "oneShot",
      title: "Free Mine Slot",
      description: "Unlock a mine or add a free slot to one that is already open.",
      effectText: "Unlock or expand one mine",
      durationText: "Instant",
      apply(state) {
        return unlockOrExpandMine(state);
      }
    }),
    createCard({
      id: "shot-drop",
      category: "oneShot",
      title: "Supply Drop",
      description: "Gain a burst of gold and materials right away.",
      effectText: "Gold + resources",
      durationText: "Instant",
      apply(state) {
        return injectResources(state);
      }
    }),
    createCard({
      id: "shot-repair",
      category: "oneShot",
      title: "Mass Repair",
      description: "Restore every damaged fortress building to full health.",
      effectText: "Repair all buildings",
      durationText: "Instant",
      apply(state) {
        return repairFortress(state);
      }
    })
  ];
}

function refreshTemporaryMultiplierState(state) {
  const temporaryBonuses = state.economy.temporaryBonuses ?? [];
  // Temporary "Harvest Surge" production boost — an ALWAYS-ON multiplier for its duration, decoupled
  // from battle. There is intentionally NO blanket battle production multiplier: during a battle the
  // ONLY mining boost comes from committed shift workers (their rush multiplier). That is the whole
  // point of the shift mechanic — it is the player's lever for in-battle mining engagement.
  state.economy.temporaryProductionMultiplier = temporaryBonuses
    .filter((bonus) => bonus.kind === "production")
    .reduce((product, bonus) => product * bonus.multiplier, 1);
  state.economy.damageMultiplier = temporaryBonuses
    .filter((bonus) => bonus.kind === "damage")
    .reduce((product, bonus) => product * bonus.multiplier, 1);
  state.economy.defenseMultiplier = temporaryBonuses
    .filter((bonus) => bonus.kind === "defense")
    .reduce((product, bonus) => product * bonus.multiplier, 1);
}

export function rollUpgradeChoices(state) {
  // Permanent buffs moved to the HQ shop, so the draft is only temporary + one-shot now. Draw a
  // varied hand (guarantee ≥1 of each so there's always a spread) from the whole pool.
  const temps = buildTemporaryCards();
  const shots = buildOneShotCards();
  const count = Math.max(1, CONFIG.rewardDraft?.cardsOffered ?? 3);
  const picks = [randomItem(temps), randomItem(shots)].filter(Boolean);
  const rest = shuffle([...temps, ...shots].filter((card) => !picks.some((pick) => pick.id === card.id)));
  while (picks.length < count && rest.length) {
    picks.push(rest.shift());
  }
  const draft = shuffle(picks);
  state.fortress.pendingRewardDraft = draft;
  return draft;
}

export function applyUpgradeChoice(state, choiceId) {
  const choice = state.fortress.pendingRewardDraft?.find((item) => item.id === choiceId);
  if (!choice) {
    return { ok: false, reason: "Reward card is no longer available." };
  }

  const result = choice.apply(state);
  if (result?.ok === false) {
    return result;
  }

  if (choice.category === "temporary") {
    state.fortress.message = `${choice.title} queued. It begins with the next wave.`;
  } else {
    state.fortress.message = `${choice.title} applied.`;
  }

  state.fortress.pendingRewardDraft = null;
  return { ok: true, reason: state.fortress.message };
}

export function beginFortressWave(state) {
  const queued = state.economy.queuedTemporaryBonuses ?? [];
  if (queued.length === 0) {
    return;
  }

  state.economy.temporaryBonuses = [
    ...(state.economy.temporaryBonuses ?? []),
    ...queued
  ];
  state.economy.queuedTemporaryBonuses = [];
  refreshTemporaryMultiplierState(state);
}

export function endFortressWave(state) {
  const active = state.economy.temporaryBonuses ?? [];
  if (active.length === 0) {
    return;
  }

  state.economy.temporaryBonuses = active
    .map((bonus) => ({
      ...bonus,
      remainingWaves: (bonus.remainingWaves ?? 0) - 1
    }))
    .filter((bonus) => bonus.remainingWaves > 0);
  refreshTemporaryMultiplierState(state);
}

export function getFortressGoldMultiplier(state) {
  const perm = CONFIG.hqUpgrades?.permanent?.gold;
  const hqMult = perm ? (perm.multiplier ?? 1) ** getHqUpgradeLevel(state, "gold") : 1;
  return Math.max(1, (state.economy.goldMultiplier ?? 1) * hqMult);
}

export function getFortressResourceMultiplier(state) {
  // NOTE: economy.productionMultiplier is seeded to the rest factor (0.55) and clamped by max(1,…),
  // so it is effectively a no-op base of 1 — the real permanent boost comes from the HQ Supply Line
  // level (1.1^level), computed directly here so early levels aren't swallowed by that 0.55 seed.
  const perm = CONFIG.hqUpgrades?.permanent?.resource;
  const hqMult = perm ? (perm.multiplier ?? 1) ** getHqUpgradeLevel(state, "resource") : 1;
  return Math.max(1, hqMult);
}

export function getFortressBaseHealthBonus(state) {
  return Math.max(0, state.economy.baseHealthBonus ?? 0);
}

export function getTemporaryProductionMultiplier(state) {
  return Math.max(1, state.economy.temporaryProductionMultiplier ?? 1);
}

function getCommittedSkirmisherBonus(state) {
  if (!state.fortress.battle.active) {
    return 0;
  }
  let bonus = 0;
  for (const mine of state.mines) {
    for (const worker of mine.workerIds) {
      if (worker?.battleShiftCommitted) {
        bonus += getCapstoneBattleDamageBonus(worker);
      }
    }
  }
  return bonus;
}

export function getFortressDamageMultiplier(state) {
  const base = Math.max(1, state.economy.damageMultiplier ?? 1);
  return base * (1 + getCommittedSkirmisherBonus(state));
}

export function getFortressDefenseMultiplier(state) {
  return Math.max(1, state.economy.defenseMultiplier ?? 1);
}
