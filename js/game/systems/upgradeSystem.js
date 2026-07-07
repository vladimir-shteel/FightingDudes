import { CONFIG, getMineMaxLevel, getUnitLevelData } from "../config.js";
import { applyFortressBaseHealthBonus } from "./fortressSystem.js";

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

function buildPermanentCards() {
  const config = getRewardDraftConfig().permanent ?? {};
  return [
    createCard({
      id: "perm-gold",
      category: "permanent",
      title: "Gold Dividend",
      description: "All gold income is permanently increased.",
      effectText: `Gold gain x${config.goldGainMultiplier ?? 1.15}`,
      durationText: "Permanent",
      apply(state) {
        state.economy.goldMultiplier = (state.economy.goldMultiplier ?? 1) * (config.goldGainMultiplier ?? 1.15);
      }
    }),
    createCard({
      id: "perm-resource",
      category: "permanent",
      title: "Supply Line",
      description: "Mine production is permanently increased.",
      effectText: `Resource gain x${config.resourceGainMultiplier ?? 1.15}`,
      durationText: "Permanent",
      apply(state) {
        state.economy.productionMultiplier = (state.economy.productionMultiplier ?? 1) * (config.resourceGainMultiplier ?? 1.15);
      }
    }),
    createCard({
      id: "perm-health",
      category: "permanent",
      title: "Fortified Core",
      description: "Fortress buildings get a flat base health boost.",
      effectText: `+${config.baseHealthBonus ?? 12} base HP`,
      durationText: "Permanent",
      apply(state) {
        const bonus = config.baseHealthBonus ?? 12;
        state.economy.baseHealthBonus = (state.economy.baseHealthBonus ?? 0) + bonus;
        applyFortressBaseHealthBonus(state, bonus);
      }
    })
  ];
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

  const candidate = workers.find(({ unit }) => unit.level < CONFIG.merge.maxLevel) ?? null;
  if (!candidate) {
    return { ok: false, reason: "No worker can be upgraded." };
  }

  const nextLevel = candidate.unit.level + 1;
  return raiseUnitToLevel(candidate.unit, nextLevel)
    ? { ok: true, reason: `${candidate.unit.name} promoted to level ${candidate.unit.level}.` }
    : { ok: false, reason: "Worker upgrade failed." };
}

function upgradeFirstBuilding(state) {
  const building = state.fortress.buildings.find((item) => item.type !== "hq" && item.level < (CONFIG.fortressBuildings[item.type]?.levels.length ?? 0));
  if (!building) {
    return { ok: false, reason: "No building can be upgraded." };
  }

  const definition = CONFIG.fortressBuildings[building.type];
  const nextLevel = definition.levels[building.level];
  if (!nextLevel) {
    return { ok: false, reason: "No building can be upgraded." };
  }

  building.level += 1;
  building.maxHp = nextLevel.hp + (state.economy.baseHealthBonus ?? 0);
  building.hp = building.maxHp;
  return { ok: true, reason: `${definition.name} upgraded to level ${building.level}.` };
}

function unlockOrExpandMine(state) {
  const mine = state.mines.find((item) => !item.isUnlocked || (item.purchasedSlotIndices ?? []).some((isPurchased) => !isPurchased)) ?? null;
  if (!mine) {
    return { ok: false, reason: "No mine can be expanded." };
  }

  if (!mine.isUnlocked) {
    mine.isUnlocked = true;
    mine.purchasedSlotIndices[0] = true;
    mine.level = Math.max(1, mine.level);
    return { ok: true, reason: `${mine.name} unlocked.` };
  }

  const nextSlotIndex = (mine.purchasedSlotIndices ?? []).findIndex((isPurchased) => !isPurchased);
  if (nextSlotIndex < 0) {
    return { ok: false, reason: "No mine can be expanded." };
  }

  mine.purchasedSlotIndices[nextSlotIndex] = true;
  mine.level = Math.min(getMineMaxLevel(), Math.max(mine.level, nextSlotIndex + 1));
  return { ok: true, reason: `${mine.name} gained slot ${nextSlotIndex + 1}.` };
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
  const baseBattleProductionMultiplier = CONFIG.productionMultipliers?.battle ?? 1;
  state.economy.battleProductionMultiplier = baseBattleProductionMultiplier * temporaryBonuses
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
  const draft = shuffle([
    randomItem(buildPermanentCards()),
    randomItem(buildTemporaryCards()),
    randomItem(buildOneShotCards())
  ].filter(Boolean));

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
  return Math.max(1, state.economy.goldMultiplier ?? 1);
}

export function getFortressResourceMultiplier(state) {
  return Math.max(1, state.economy.productionMultiplier ?? 1);
}

export function getFortressBaseHealthBonus(state) {
  return Math.max(0, state.economy.baseHealthBonus ?? 0);
}

export function getFortressBattleProductionMultiplier(state) {
  return Math.max(1, state.economy.battleProductionMultiplier ?? 1);
}

export function getFortressDamageMultiplier(state) {
  return Math.max(1, state.economy.damageMultiplier ?? 1);
}

export function getFortressDefenseMultiplier(state) {
  return Math.max(1, state.economy.defenseMultiplier ?? 1);
}
