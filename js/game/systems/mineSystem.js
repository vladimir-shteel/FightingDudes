import { CONFIG, getMineLevelData, getMineMaxLevel } from "../config.js";
import { clamp } from "../utils.js";
import { removeUnitFromReserve, returnUnitToReserve } from "./reserveSystem.js";

export function getMineUpgradeCost(mine) {
  const nextLevelData = getMineLevelData(mine.level + 1);
  return nextLevelData?.upgradeOreCost ?? null;
}

export function upgradeMine(state, mineId) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }

  if (mine.level >= getMineMaxLevel()) {
    return { ok: false, reason: "Mine already reached max level." };
  }

  const cost = getMineUpgradeCost(mine);
  if (cost === null || state.resources.ore < cost) {
    return { ok: false, reason: "Not enough ore for mine upgrade." };
  }

  state.resources.ore -= cost;
  mine.level += 1;
  return { ok: true, reason: `${mine.name} upgraded to level ${mine.level}.` };
}

export function assignReserveUnitToMine(state, unitId, mineId, slotIndex) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
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
  returnUnitToReserve(state, unit);
  return { ok: true, reason: `${unit.name} returned to reserve.` };
}

export function removeUnitFromMine(state, unitId) {
  for (const mine of state.mines) {
    for (let index = 0; index < mine.workerIds.length; index += 1) {
      const worker = mine.workerIds[index];
      if (worker?.id === unitId) {
        mine.workerIds[index] = null;
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
  return true;
}

export function tickMineProduction(state, deltaSeconds) {
  let totalProduced = 0;

  for (const mine of state.mines) {
    const mineLevelData = getMineLevelData(mine.level);
    if (!mineLevelData) {
      continue;
    }

    for (let index = 0; index < mineLevelData.slots; index += 1) {
      const worker = mine.workerIds[index];
      if (!worker) {
        continue;
      }

      const slotMultiplier = mineLevelData.slotProductionMultipliers[index] ?? 1;
      const amount =
        CONFIG.mine.baseProductionPerSecond * worker.level * slotMultiplier * deltaSeconds;
      totalProduced += amount;
    }
  }

  state.resources.ore = clamp(state.resources.ore + totalProduced, 0, Number.MAX_SAFE_INTEGER);
}
