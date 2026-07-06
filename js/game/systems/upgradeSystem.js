import { CONFIG, getMineMaxLevel } from "../config.js";

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function findMine(state, resourceKey) {
  return state.mines.find((mine) => mine.resourceKey === resourceKey) ?? null;
}

function getLockedBuildingTypes(state) {
  return Object.entries(CONFIG.fortressBuildings)
    .filter(([type]) => type !== "hq" && !state.fortress.unlockedBuildingTypes.includes(type))
    .map(([type]) => type);
}

export function rollUpgradeChoices(state) {
  const candidates = [];
  const mineMaxLevel = getMineMaxLevel();

  for (const resourceKey of ["wood", "ore", "iron", "crystal"]) {
    const mine = findMine(state, resourceKey);
    if (!mine) {
      continue;
    }

    const label = resourceKey === "ore" ? "Stone" : CONFIG.mine.resourceTypes.find((item) => item.key === resourceKey)?.label ?? resourceKey;
    if (!mine.isUnlocked) {
      candidates.push({
        id: `unlock-mine-${resourceKey}`,
        type: "unlockMine",
        resourceKey,
        title: `Unlock ${label}`,
        description: `${label} mine becomes available for workers.`
      });
    } else if (mine.level < mineMaxLevel) {
      candidates.push({
        id: `mine-slot-${resourceKey}`,
        type: "mineSlot",
        resourceKey,
        title: `+1 ${label} Slot`,
        description: `${label} mine gains another worker slot.`
      });
    }
  }

  if (CONFIG.merge.maxLevel < 7) {
    candidates.push({
      id: "raise-merge-cap",
      type: "raiseMergeCap",
      title: "Raise Merge Cap",
      description: `Workers can merge up to level ${CONFIG.merge.maxLevel + 1}.`
    });
  }

  if ((state.economy.workerStartLevel ?? 1) < 3) {
    candidates.push({
      id: "raise-worker-start",
      type: "raiseWorkerStart",
      title: "Better New Workers",
      description: `Bought workers start at level ${(state.economy.workerStartLevel ?? 1) + 1}.`
    });
  }

  candidates.push({
    id: "worker-discount",
    type: "workerDiscount",
    title: "Worker Discount",
    description: "Worker purchase prices are reduced by 10%."
  });

  if (getLockedBuildingTypes(state).length > 0) {
    candidates.push({
      id: "unlock-building",
      type: "unlockBuilding",
      title: "Unlock Building",
      description: "A new building type appears in the workshop."
    });
  }

  candidates.push({
    id: "building-discount",
    type: "buildingDiscount",
    title: "Building Discount",
    description: "Building purchase prices are reduced by 10%."
  });

  state.fortress.pendingUpgradeChoices = shuffle(candidates).slice(0, 3);
  return state.fortress.pendingUpgradeChoices;
}

export function applyUpgradeChoice(state, choiceId) {
  const choice = state.fortress.pendingUpgradeChoices?.find((item) => item.id === choiceId);
  if (!choice) {
    return { ok: false, reason: "Upgrade choice is no longer available." };
  }

  if (choice.type === "unlockMine") {
    const mine = findMine(state, choice.resourceKey);
    if (!mine) {
      return { ok: false, reason: "Mine not found." };
    }
    mine.isUnlocked = true;
  } else if (choice.type === "mineSlot") {
    const mine = findMine(state, choice.resourceKey);
    if (!mine || mine.level >= getMineMaxLevel()) {
      return { ok: false, reason: "Mine already has maximum slots." };
    }
    mine.level += 1;
  } else if (choice.type === "raiseMergeCap") {
    CONFIG.merge.maxLevel = Math.min(7, CONFIG.merge.maxLevel + 1);
  } else if (choice.type === "raiseWorkerStart") {
    state.economy.workerStartLevel = Math.min(3, (state.economy.workerStartLevel ?? 1) + 1);
  } else if (choice.type === "workerDiscount") {
    state.economy.workerBuyDiscount = Math.max(0.35, (state.economy.workerBuyDiscount ?? 1) * 0.9);
  } else if (choice.type === "unlockBuilding") {
    const [nextType] = getLockedBuildingTypes(state);
    if (!nextType) {
      return { ok: false, reason: "All buildings are already unlocked." };
    }
    state.fortress.unlockedBuildingTypes.push(nextType);
  } else if (choice.type === "buildingDiscount") {
    state.fortress.buildingBuyDiscount = Math.max(0.35, (state.fortress.buildingBuyDiscount ?? 1) * 0.9);
  }

  state.fortress.pendingUpgradeChoices = null;
  state.fortress.message = `${choice.title} applied.`;
  return { ok: true, reason: state.fortress.message };
}
