import {
  CONFIG,
  getMineLevelData,
  getMineSlotBuyCost,
  getMineSlotUnlockWave,
  getMineUnlockWave
} from "../config.js";
import { clamp } from "../utils.js";
import { createReserveUnit } from "../factories.js";
import { removeUnitFromReserve, returnUnitToReserve } from "./reserveSystem.js";
import { spendResources } from "./fortressSystem.js";
import {
  getFortressBattleProductionMultiplier,
  getFortressGoldMultiplier,
  getFortressResourceMultiplier
} from "./upgradeSystem.js";
import {
  getWorkerGoldenConversion,
  getWorkerRushMultiplier,
  getWorkerYieldMultiplier,
  isWorkerBattleShiftLocked,
  mergeWorkerTraitVectors
} from "./workerTraitSystem.js";

function isWaveUnlocked(state, unlockWave) {
  return (state.fortress.waveNumber ?? 1) >= (unlockWave ?? 1);
}

function isSlotPurchased(mine, slotIndex) {
  return Boolean(mine.purchasedSlotIndices?.[slotIndex]);
}

function setSlotPurchased(mine, slotIndex) {
  mine.purchasedSlotIndices ??= Array.from({ length: mine.workerIds.length }, () => false);
  mine.purchasedSlotIndices[slotIndex] = true;
  mine.level = Math.max(mine.level, slotIndex + 1);
}

function getProductionMultiplier(state) {
  const battleMultiplier = state.fortress.battle.active
    ? getFortressBattleProductionMultiplier(state)
    : 1;
  return getFortressResourceMultiplier(state) * battleMultiplier;
}

export function getCurrentWaveDemandResource(state) {
  const wave = CONFIG.fortressWaves[(state.fortress.waveNumber ?? 1) - 1];
  return wave?.demandResource ?? null;
}

function getDemandMultiplier(state, mine) {
  return mine.resourceKey === getCurrentWaveDemandResource(state)
    ? CONFIG.waveDemand?.slotProductionMultiplier ?? 1
    : 1;
}

export function getMinePurchasedSlotCount(mine) {
  return (mine.purchasedSlotIndices ?? []).filter(Boolean).length;
}

export function getMinePurchaseState(state, mine) {
  const unlockWave = mine.unlockWave ?? getMineUnlockWave(mine.resourceKey);
  const buyCost = mine.buyCost ?? {};

  if (mine.isUnlocked) {
    return { kind: "owned", unlockWave, buyCost };
  }

  if (!isWaveUnlocked(state, unlockWave)) {
    return { kind: "locked-by-wave", unlockWave, buyCost };
  }

  return { kind: "available-to-buy", unlockWave, buyCost };
}

export function getMineSlotState(state, mine, slotIndex) {
  const unlockWave = mine.slotUnlockWaves?.[slotIndex] ?? getMineSlotUnlockWave(mine.resourceKey, slotIndex);
  const buyCost = mine.slotBuyCosts?.[slotIndex] ?? getMineSlotBuyCost(mine.resourceKey, slotIndex) ?? {};

  if (isSlotPurchased(mine, slotIndex)) {
    return { kind: "bought", unlockWave, buyCost };
  }

  if (!mine.isUnlocked || !isWaveUnlocked(state, unlockWave)) {
    return { kind: "locked-by-wave", unlockWave, buyCost };
  }

  return { kind: "available-to-buy", unlockWave, buyCost };
}

export function buyMine(state, mineId) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }

  const purchaseState = getMinePurchaseState(state, mine);
  if (purchaseState.kind === "owned") {
    return { ok: false, reason: "Mine is already owned." };
  }
  if (purchaseState.kind !== "available-to-buy") {
    return { ok: false, reason: `Mine unlocks at wave ${purchaseState.unlockWave}.` };
  }
  if (!spendResources(state.resources, purchaseState.buyCost)) {
    return { ok: false, reason: "Not enough gold for this mine." };
  }

  mine.isUnlocked = true;
  setSlotPurchased(mine, 0);
  return { ok: true, reason: `${mine.name} purchased.` };
}

export function buyMineSlot(state, mineId, slotIndex) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }
  if (slotIndex < 0 || slotIndex >= mine.workerIds.length) {
    return { ok: false, reason: "Mine slot not found." };
  }

  const slotState = getMineSlotState(state, mine, slotIndex);
  if (slotState.kind === "bought") {
    return { ok: false, reason: "Mine slot is already bought." };
  }
  if (slotState.kind !== "available-to-buy") {
    return { ok: false, reason: `Mine slot unlocks at wave ${slotState.unlockWave}.` };
  }
  if (!spendResources(state.resources, slotState.buyCost)) {
    return { ok: false, reason: "Not enough gold for this mine slot." };
  }

  setSlotPurchased(mine, slotIndex);
  return { ok: true, reason: `${mine.name} slot ${slotIndex + 1} purchased.` };
}

export function unlockMineSlotWithCard(state, mineId, slotIndex) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }
  if (slotIndex < 0 || slotIndex >= mine.workerIds.length) {
    return { ok: false, reason: "Mine slot not found." };
  }
  if (!mine.isUnlocked) {
    return { ok: false, reason: "Buy the mine first." };
  }
  if (isSlotPurchased(mine, slotIndex)) {
    return { ok: false, reason: "Mine slot is already bought." };
  }

  setSlotPurchased(mine, slotIndex);
  return { ok: true, reason: `${mine.name} slot ${slotIndex + 1} unlocked for free.` };
}

export function unlockFreeMineSlot(state, preferredResourceKey = null) {
  const mines = preferredResourceKey
    ? state.mines.filter((mine) => mine.resourceKey === preferredResourceKey)
    : state.mines;

  for (const mine of mines) {
    const purchaseState = getMinePurchaseState(state, mine);
    if (!mine.isUnlocked && purchaseState.kind === "available-to-buy") {
      mine.isUnlocked = true;
      setSlotPurchased(mine, 0);
      return { ok: true, reason: `${mine.name} unlocked for free.` };
    }

    if (!mine.isUnlocked) {
      continue;
    }

    for (let index = 0; index < mine.workerIds.length; index += 1) {
      if (getMineSlotState(state, mine, index).kind === "available-to-buy") {
        setSlotPurchased(mine, index);
        return { ok: true, reason: `${mine.name} slot ${index + 1} unlocked for free.` };
      }
    }
  }

  return { ok: false, reason: "No mine slot is available to unlock." };
}

export function assignReserveUnitToMine(state, unitId, mineId, slotIndex) {
  const mine = state.mines.find((item) => item.id === mineId);
  if (!mine) {
    return { ok: false, reason: "Mine not found." };
  }

  if (!mine.isUnlocked) {
    return { ok: false, reason: "Mine is locked." };
  }

  if (getMineSlotState(state, mine, slotIndex).kind !== "bought") {
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
  if (isWorkerBattleShiftLocked(state, unit)) {
    return { ok: false, reason: "This worker is committed until the battle ends." };
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

  if (
    getMineSlotState(state, fromMine, fromSlotIndex).kind !== "bought" ||
    getMineSlotState(state, toMine, toSlotIndex).kind !== "bought"
  ) {
    return { ok: false, reason: "This mine slot is still locked." };
  }

  if (fromMineId === toMineId && fromSlotIndex === toSlotIndex) {
    return { ok: false, reason: "Unit is already in that slot." };
  }

  const unit = fromMine.workerIds[fromSlotIndex];
  if (!unit) {
    return { ok: false, reason: "No mine unit in that slot." };
  }
  if (isWorkerBattleShiftLocked(state, unit)) {
    return { ok: false, reason: "This worker is committed until the battle ends." };
  }

  const targetUnit = toMine.workerIds[toSlotIndex];
  if (isWorkerBattleShiftLocked(state, targetUnit)) {
    return { ok: false, reason: "That worker is committed until the battle ends." };
  }
  if (!targetUnit) {
    fromMine.workerIds[fromSlotIndex] = null;
    fromMine.workerProgress[fromSlotIndex] = 0;
    toMine.workerIds[toSlotIndex] = unit;
    toMine.workerProgress[toSlotIndex] = 0;
    return { ok: true, reason: `${unit.name} moved to ${toMine.name}.` };
  }

  if (unit.level === targetUnit.level && unit.level < CONFIG.merge.maxLevel) {
    fromMine.workerIds[fromSlotIndex] = null;
    fromMine.workerProgress[fromSlotIndex] = 0;
    toMine.workerIds[toSlotIndex] = createReserveUnit(unit.level + 1, {
      traits: mergeWorkerTraitVectors(unit.traits, targetUnit.traits)
    });
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
  if (!mine || getMineSlotState(state, mine, slotIndex).kind !== "bought") {
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

  if (getMineSlotState(state, mine, slotIndex).kind !== "bought") {
    return { ok: false, reason: "This mine slot is still locked." };
  }

  const mineUnit = mine.workerIds[slotIndex];
  if (!mineUnit) {
    return { ok: false, reason: "No mine unit in that slot." };
  }
  if (isWorkerBattleShiftLocked(state, mineUnit)) {
    return { ok: false, reason: "This worker is committed until the battle ends." };
  }

  const reserveUnit = state.reserveUnits.find((unit) => unit.id === reserveUnitId);
  if (!reserveUnit) {
    return { ok: false, reason: "Reserve unit not found." };
  }
  if (isWorkerBattleShiftLocked(state, reserveUnit)) {
    return { ok: false, reason: "Committed workers are locked until the battle ends." };
  }

  if (reserveUnit.level !== mineUnit.level) {
    return { ok: false, reason: "Only equal-level units can merge." };
  }

  if (reserveUnit.level >= CONFIG.merge.maxLevel) {
    return { ok: false, reason: "This unit has reached max merge level." };
  }

  removeUnitFromReserve(state, reserveUnitId);
  mine.workerIds[slotIndex] = createReserveUnit(mineUnit.level + 1, {
    traits: mergeWorkerTraitVectors(mineUnit.traits, reserveUnit.traits)
  });
  mine.workerProgress[slotIndex] = 0;
  return { ok: true, reason: `Merged into level ${mineUnit.level + 1} worker.` };
}

export function toggleWorkerBattleShift(state, mineId, slotIndex) {
  if (state.fortress.battle.active) {
    return { ok: false, reason: "Battle shifts are locked during combat." };
  }
  const mine = state.mines.find((item) => item.id === mineId);
  const worker = mine?.workerIds?.[slotIndex];
  if (!worker) {
    return { ok: false, reason: "No worker in that slot." };
  }

  worker.battleShiftCommitted = !worker.battleShiftCommitted;
  return {
    ok: true,
    reason: worker.battleShiftCommitted
      ? `${worker.name} committed to the next battle shift.`
      : `${worker.name} left the battle shift.`
  };
}

export function clearWorkerBattleShifts(state) {
  for (const unit of state.reserveUnits) {
    unit.battleShiftCommitted = false;
  }
  for (const mine of state.mines) {
    for (const worker of mine.workerIds) {
      if (worker) {
        worker.battleShiftCommitted = false;
      }
    }
  }
}

export function tickMineProduction(state, deltaSeconds) {
  const passivePerMine = CONFIG.passiveGoldPerSecondPerUnlockedMine ?? 0;
  const passiveInterval = Math.max(0.001, CONFIG.passiveGoldPayoutIntervalSeconds ?? 1);
  const goldMultiplier = getFortressGoldMultiplier(state) * getFortressBattleProductionMultiplier(state);

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
        const goldAmount = passivePerMine * payoutSeconds * goldMultiplier;
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

    for (let index = 0; index < mine.workerIds.length; index += 1) {
      if (!isSlotPurchased(mine, index)) {
        mine.workerProgress[index] = 0;
        continue;
      }

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
      const productionTable = CONFIG.mine.workerProductionByLevel ?? null;
      const productionMultiplier = getProductionMultiplier(state);
      const traitMultiplier = getWorkerYieldMultiplier(worker);
      const demandMultiplier = getDemandMultiplier(state, mine);
      const shiftMultiplier = worker.battleShiftCommitted && state.fortress.battle.active
        ? getWorkerRushMultiplier(worker)
        : 1;
      const totalWorkerMultiplier = traitMultiplier * demandMultiplier * shiftMultiplier;
      const resourceAmount = productionTable
        ? (productionTable[String(worker.level)] ?? 1) * slotMultiplier * productionMultiplier * totalWorkerMultiplier
        : CONFIG.mine.baseProductionPerSecond * worker.level * slotMultiplier * payoutSeconds * productionMultiplier * totalWorkerMultiplier;
      const traitGoldAmount = resourceAmount * getWorkerGoldenConversion(worker) * getFortressGoldMultiplier(state);
      const goldAmount = productionTable
        ? traitGoldAmount
        : ((CONFIG.mine.goldPerSecondPerWorkerLevel ?? 0) * worker.level * slotMultiplier * payoutSeconds * goldMultiplier) + traitGoldAmount;

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
