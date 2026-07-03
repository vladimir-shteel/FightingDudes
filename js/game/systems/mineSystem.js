import { CONFIG, getMineLevelData, getMineMaxLevel } from "../config.js";
import { clamp } from "../utils.js";
import { canMergeUnits, createMergedUnit, removeUnitFromReserve, returnUnitToReserve } from "./reserveSystem.js";

export function getMineUpgradeCost(mine) {
  const nextLevelData = getMineLevelData(mine.level + 1);
  return nextLevelData?.upgradeCost ?? null;
}

export function unlockMine(state, mineId) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }

  if (mine.isUnlocked) {
    return { ok: false, reason: "Mine already unlocked." };
  }

  if ((state.resources[mine.unlockCurrency] ?? 0) < mine.unlockCost) {
    return { ok: false, reason: `Not enough ${mine.unlockCurrency} to unlock ${mine.name}.` };
  }

  state.resources[mine.unlockCurrency] -= mine.unlockCost;
  mine.isUnlocked = true;
  return { ok: true, reason: `${mine.name} is now unlocked.` };
}

export function upgradeMine(state, mineId) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }

  if (!mine.isUnlocked) {
    return { ok: false, reason: "Unlock this mine first." };
  }

  if (mine.level >= getMineMaxLevel()) {
    return { ok: false, reason: "Mine already reached max level." };
  }

  const cost = getMineUpgradeCost(mine);
  const nextLevelData = getMineLevelData(mine.level + 1);
  const currencyKey = nextLevelData?.upgradeCurrency ?? "gold";

  if (cost === null || (state.resources[currencyKey] ?? 0) < cost) {
    return { ok: false, reason: `Not enough ${currencyKey} for mine upgrade.` };
  }

  state.resources[currencyKey] -= cost;
  mine.level += 1;
  return { ok: true, reason: `${mine.name} upgraded to level ${mine.level}.` };
}

export function assignReserveUnitToMine(state, unitId, mineId, slotIndex) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }

  if (!mine.isUnlocked) {
    return { ok: false, reason: "Mine is locked." };
  }

  const mineLevelData = getMineLevelData(mine.level);
  if (!mineLevelData || slotIndex >= mineLevelData.slots) {
    return { ok: false, reason: "This mine slot is still locked." };
  }

  if (mine.workerIds[slotIndex]) {
    return { ok: false, reason: "Mine slot is already occupied." };
  }

  const unit = removeUnitFromReserve(state, unitId);
  if (!unit) {
    return { ok: false, reason: "Only reserve units can be assigned to a free mine slot." };
  }

  mine.workerIds[slotIndex] = unit;
  mine.workerProgress[slotIndex] = 0;
  return { ok: true, reason: `${unit.name} started mining in ${mine.name}.` };
}

export function returnMineUnitToReserve(state, mineId, slotIndex) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }

  const unit = mine.workerIds[slotIndex];
  if (!unit) {
    return { ok: false, reason: "That slot is already empty." };
  }

  mine.workerIds[slotIndex] = null;
  mine.workerProgress[slotIndex] = 0;
  returnUnitToReserve(state, unit);
  return { ok: true, reason: `${unit.name} returned to reserve.` };
}

export function moveMineUnitToMineSlot(state, fromMineId, fromSlotIndex, toMineId, toSlotIndex) {
  const fromMine = state.mines.find((item) => item.id === fromMineId);
  const toMine = state.mines.find((item) => item.id === toMineId);
  if (!fromMine || !toMine) {
    return { ok: false, reason: "Mine not found." };
  }

  if (!fromMine.isUnlocked || !toMine.isUnlocked) {
    return { ok: false, reason: "Both mines must be unlocked." };
  }

  const fromMineLevelData = getMineLevelData(fromMine.level);
  const toMineLevelData = getMineLevelData(toMine.level);
  if (!fromMineLevelData || !toMineLevelData) {
    return { ok: false, reason: "Mine level data missing." };
  }

  if (fromSlotIndex >= fromMineLevelData.slots || toSlotIndex >= toMineLevelData.slots) {
    return { ok: false, reason: "This mine slot is still locked." };
  }

  if (fromMineId === toMineId && fromSlotIndex === toSlotIndex) {
    return { ok: false, reason: "Unit is already in that slot." };
  }

  const unit = fromMine.workerIds[fromSlotIndex];
  if (!unit) {
    return { ok: false, reason: "No mine unit in that slot." };
  }

  const targetUnit = toMine.workerIds[toSlotIndex];
  if (!targetUnit) {
    fromMine.workerIds[fromSlotIndex] = null;
    fromMine.workerProgress[fromSlotIndex] = 0;
    toMine.workerIds[toSlotIndex] = unit;
    toMine.workerProgress[toSlotIndex] = 0;
    return { ok: true, reason: `${unit.name} moved to ${toMine.name}.` };
  }

  if (canMergeUnits(unit, targetUnit)) {
    fromMine.workerIds[fromSlotIndex] = null;
    fromMine.workerProgress[fromSlotIndex] = 0;
    toMine.workerIds[toSlotIndex] = createMergedUnit(unit, targetUnit);
    toMine.workerProgress[toSlotIndex] = 0;
    return { ok: true, reason: `Merged into level ${unit.level + 1} worker.` };
  }

  fromMine.workerIds[fromSlotIndex] = targetUnit;
  fromMine.workerProgress[fromSlotIndex] = 0;
  toMine.workerIds[toSlotIndex] = unit;
  toMine.workerProgress[toSlotIndex] = 0;
  return { ok: true, reason: `${unit.name} swapped places with ${targetUnit.name}.` };
}

export function removeUnitFromMine(state, unitId) {
  for (const mine of state.mines) {
    for (let index = 0; index < mine.workerIds.length; index += 1) {
      const worker = mine.workerIds[index];
      if (worker?.id === unitId) {
        mine.workerIds[index] = null;
        mine.workerProgress[index] = 0;
        return { unit: worker, mineId: mine.id, slotIndex: index };
      }
    }
  }

  return null;
}

export function restoreUnitToMine(state, mineId, slotIndex, unit) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return false;
  }

  if (mine.workerIds[slotIndex]) {
    return false;
  }

  mine.workerIds[slotIndex] = unit;
  mine.workerProgress[slotIndex] = 0;
  return true;
}

export function mergeReserveUnitIntoMineUnit(state, reserveUnitId, mineId, slotIndex) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine?.isUnlocked) {
    return { ok: false, reason: "Mine is locked." };
  }

  const mineUnit = mine.workerIds[slotIndex];
  if (!mineUnit) {
    return { ok: false, reason: "No mine unit in that slot." };
  }

  const reserveUnit = state.reserveUnits.find((unit) => unit.id === reserveUnitId);
  if (!reserveUnit) {
    return { ok: false, reason: "Reserve unit not found." };
  }

  if (reserveUnit.level !== mineUnit.level) {
    return { ok: false, reason: "Only equal-level units can merge." };
  }

  if (reserveUnit.level >= CONFIG.merge.maxLevel) {
    return { ok: false, reason: "This unit has reached max merge level." };
  }

  if (!canMergeUnits(reserveUnit, mineUnit)) {
    return { ok: false, reason: "Only units with the same class can merge." };
  }

  removeUnitFromReserve(state, reserveUnitId);
  mine.workerIds[slotIndex] = createMergedUnit(reserveUnit, mineUnit);
  mine.workerProgress[slotIndex] = 0;
  return { ok: true, reason: `Merged into level ${mineUnit.level + 1} worker.` };
}

export function tickMineProduction(state, deltaSeconds) {
  const passivePerMine = CONFIG.passiveGoldPerSecondPerUnlockedMine ?? 0;
  const passiveInterval = Math.max(0.001, CONFIG.passiveGoldPayoutIntervalSeconds ?? 1);

  for (const mine of state.mines) {
    if (!mine.isUnlocked) {
      mine.passiveProgress = 0;
      continue;
    }

    if (passivePerMine > 0) {
      mine.passiveProgress = (mine.passiveProgress ?? 0) + deltaSeconds;
      if (mine.passiveProgress >= passiveInterval) {
        const payoutSeconds = mine.passiveProgress;
        mine.passiveProgress = 0;
        const goldAmount = passivePerMine * payoutSeconds;
        state.resources.gold = clamp(
          state.resources.gold + goldAmount,
          0,
          Number.MAX_SAFE_INTEGER
        );
        state.resourceBursts.push({
          id: `${mine.id}-passive-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          mineId: mine.id,
          slotIndex: -1,
          payouts: [{ resourceKey: "gold", amount: goldAmount }].filter((payout) => payout.amount > 0)
        });
      }
    }

    const mineLevelData = getMineLevelData(mine.level);
    if (!mineLevelData) {
      continue;
    }

    for (let index = 0; index < mineLevelData.slots; index += 1) {
      const worker = mine.workerIds[index];
      if (!worker) {
        mine.workerProgress[index] = 0;
        continue;
      }

      mine.workerProgress[index] += deltaSeconds;
      const collectionInterval = CONFIG.mine.collectionIntervalSeconds ?? 1;
      if (mine.workerProgress[index] < collectionInterval) {
        continue;
      }

      const payoutSeconds = mine.workerProgress[index];
      mine.workerProgress[index] = 0;
      const slotMultiplier = mineLevelData.slotProductionMultipliers[index] ?? 1;
      const resourceAmount =
        CONFIG.mine.baseProductionPerSecond * worker.level * slotMultiplier * payoutSeconds;
      const goldAmount =
        (CONFIG.mine.goldPerSecondPerWorkerLevel ?? 0) * worker.level * slotMultiplier * payoutSeconds;

      state.resources[mine.resourceKey] = clamp(
        state.resources[mine.resourceKey] + resourceAmount,
        0,
        Number.MAX_SAFE_INTEGER
      );
      state.resources.gold = clamp(
        state.resources.gold + goldAmount,
        0,
        Number.MAX_SAFE_INTEGER
      );
      state.resourceBursts.push({
        id: `${mine.id}-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        mineId: mine.id,
        slotIndex: index,
        payouts: [
          { resourceKey: mine.resourceKey, amount: resourceAmount },
          { resourceKey: "gold", amount: goldAmount }
        ].filter((payout) => payout.amount > 0)
      });
    }
  }
}
