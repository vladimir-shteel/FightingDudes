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
  getFortressGoldMultiplier,
  getFortressResourceMultiplier,
  getTemporaryProductionMultiplier
} from "./upgradeSystem.js";
import {
  getCapstoneDemandMultiplierBonus,
  getCapstoneGoldenBonus,
  getCapstonePassiveGoldPerSecond,
  getCapstoneWarlordProductionMultiplier,
  getCapstoneYieldMultiplier,
  getMaxRestCharges,
  getMaxWorkerLevel,
  getWorkerGoldenConversion,
  getWorkerRushMultiplier,
  getWorkerYieldMultiplier,
  isWorkerBattleShiftLocked,
  mergeWorkerTraitVectors,
  pickCapstoneCandidates
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
  // No blanket battle multiplier: non-committed workers mine at their normal rate during battle.
  // Only committed shift workers get a boost (applied per-worker as shiftMultiplier below).
  return getFortressResourceMultiplier(state) * getTemporaryProductionMultiplier(state);
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

  if (unit.level === targetUnit.level && unit.level < getMaxWorkerLevel(state)) {
    const mergedLevel = unit.level + 1;
    const mergedTraits = mergeWorkerTraitVectors(unit.traits, targetUnit.traits);
    fromMine.workerIds[fromSlotIndex] = null;
    fromMine.workerProgress[fromSlotIndex] = 0;
    toMine.workerIds[toSlotIndex] = createReserveUnit(mergedLevel, {
      traits: mergedTraits,
      restCharges: Math.max(unit.restCharges ?? 0, targetUnit.restCharges ?? 0),
      desiredMine: unit.desiredMine ?? targetUnit.desiredMine ?? null,
      pendingCapstone: mergedLevel === CONFIG.merge.maxLevel ? pickCapstoneCandidates(mergedTraits) : null
    });
    toMine.workerProgress[toSlotIndex] = 0;
    return { ok: true, reason: `Merged into level ${mergedLevel} worker.` };
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

  const levelCap = getMaxWorkerLevel(state);
  if (reserveUnit.level >= levelCap) {
    return {
      ok: false,
      reason: levelCap < (CONFIG.merge.maxLevel ?? 5)
        ? `Level cap is Lv${levelCap} for now — it rises each wave.`
        : "This unit has reached max merge level."
    };
  }

  removeUnitFromReserve(state, reserveUnitId);
  const mergedLevel = mineUnit.level + 1;
  const mergedTraits = mergeWorkerTraitVectors(mineUnit.traits, reserveUnit.traits);
  mine.workerIds[slotIndex] = createReserveUnit(mergedLevel, {
    traits: mergedTraits,
    restCharges: Math.max(mineUnit.restCharges ?? 0, reserveUnit.restCharges ?? 0),
    desiredMine: mineUnit.desiredMine ?? reserveUnit.desiredMine ?? null,
    pendingCapstone: mergedLevel === CONFIG.merge.maxLevel ? pickCapstoneCandidates(mergedTraits) : null
  });
  mine.workerProgress[slotIndex] = 0;
  return { ok: true, reason: `Merged into level ${mergedLevel} worker.` };
}

export function getShiftMaxPerMine() {
  return CONFIG.workerTraits?.battleShift?.maxCommitsPerMine ?? Number.POSITIVE_INFINITY;
}

// Pick a random UNLOCKED mine's resource key, preferring one different from `excludeKey`. Used to
// (re)roll a worker's desired mine — never targets a locked mine (no forced-bad placements).
export function pickDesiredMine(state, excludeKey = null) {
  const open = (state.mines ?? []).filter((m) => m.isUnlocked).map((m) => m.resourceKey);
  const choices = open.filter((k) => k !== excludeKey);
  const pool = choices.length ? choices : open;
  if (!pool.length) return excludeKey ?? null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// A worker staffing its DESIRED mine with Rest ⚡ automatically takes the battle shift when combat
// starts (spends one charge). Only workers standing on the mine they currently want can spike — that
// is what makes placement matter. Highest-level first, up to getShiftMaxPerMine() per mine.
export function autoCommitBattleShifts(state) {
  const cap = getShiftMaxPerMine();
  for (const mine of state.mines) {
    const eligible = (mine.workerIds ?? [])
      .map((worker, index) => ({ worker, index }))
      .filter(({ worker }) => worker && (worker.restCharges ?? 0) > 0 && worker.desiredMine === mine.resourceKey)
      .sort((a, b) => (b.worker.level ?? 0) - (a.worker.level ?? 0));
    let committed = 0;
    for (const { worker } of eligible) {
      if (committed >= cap) break;
      worker.battleShiftCommitted = true;
      committed += 1;
    }
  }
}

export function accrueWorkerRest(state) {
  // Rest builds toward a worker's DESIRED mine whenever it is NOT working that mine — parked in
  // reserve, or staffing a DIFFERENT mine (where it still mines at base rate). +1 per wave, capped.
  // Being ON the desired mine drains Rest instead (via the shift). No idle-in-reserve requirement:
  // a "recharging" worker is still productive, which is the whole point of the mood rework.
  const rechargePerWave = CONFIG.workerTraits?.battleShift?.restRechargePerWave ?? 1;
  const accrue = (unit) => {
    if (!unit) return;
    if (!unit.desiredMine) unit.desiredMine = pickDesiredMine(state, null);   // self-heal legacy units
    unit.restCharges = Math.min(getMaxRestCharges(unit.level), (unit.restCharges ?? 0) + rechargePerWave);
  };
  for (const unit of state.reserveUnits) accrue(unit);
  for (const mine of state.mines) {
    for (const worker of mine.workerIds) {
      if (worker && worker.desiredMine !== mine.resourceKey) accrue(worker);
    }
  }
}

export function consumeShiftRestFlags(state) {
  for (const mine of state.mines) {
    for (const worker of mine.workerIds) {
      if (!worker?.battleShiftCommitted) continue;
      worker.restCharges = Math.max(0, (worker.restCharges ?? 0) - 1);
      if (worker.restCharges === 0) {
        // Satisfied: preference drifts to a different open mine. The worker keeps mining its current
        // mine at base rate (rebuilding Rest) until you move it to the new one to shift again.
        worker.desiredMine = pickDesiredMine(state, worker.desiredMine);
      }
    }
  }
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
  const goldMultiplier = getFortressGoldMultiplier(state);

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
      // Shift/rest is delivered as FREQUENCY, not magnitude: a committed shift worker's payout fires
      // MORE often (the mine visibly "pumps" faster), a resting worker fires slower. The per-payout
      // lump is unchanged, so total output equals the equivalent multiplier — but it's legible (you
      // SEE the faster drips) instead of an invisible bigger number. (productionTable path only; the
      // legacy per-second fallback below is frequency-neutral.)
      const isShifting = Boolean(worker.battleShiftCommitted && state.fortress.battle.active);
      const rateFactor = isShifting
        ? getWorkerRushMultiplier(worker)
        : (CONFIG.productionMultipliers?.rest ?? 1);
      const collectionInterval = (CONFIG.mine.collectionIntervalSeconds ?? 1) / Math.max(0.05, rateFactor);
      if (mine.workerProgress[index] < collectionInterval) {
        continue;
      }

      const payoutSeconds = mine.workerProgress[index];
      mine.workerProgress[index] = 0;
      const slotMultiplier = mineLevelData.slotProductionMultipliers[index] ?? 1;
      const productionTable = CONFIG.mine.workerProductionByLevel ?? null;
      const productionMultiplier = getProductionMultiplier(state);
      const traitMultiplier = getWorkerYieldMultiplier(worker) * getCapstoneYieldMultiplier(worker) * getCapstoneWarlordProductionMultiplier(state, worker);
      const demandMultiplier = getDemandMultiplier(state, mine) * getCapstoneDemandMultiplierBonus(worker);
      const totalWorkerMultiplier = traitMultiplier * demandMultiplier;
      const resourceAmount = productionTable
        ? (productionTable[String(worker.level)] ?? 1) * slotMultiplier * productionMultiplier * totalWorkerMultiplier
        : CONFIG.mine.baseProductionPerSecond * worker.level * slotMultiplier * payoutSeconds * productionMultiplier * totalWorkerMultiplier;
      const traitGoldAmount = resourceAmount * (getWorkerGoldenConversion(worker) + getCapstoneGoldenBonus(worker)) * getFortressGoldMultiplier(state);
      const capstonePassiveGoldAmount = getCapstonePassiveGoldPerSecond(worker) * payoutSeconds * goldMultiplier;
      const goldAmount = (productionTable
        ? traitGoldAmount
        : ((CONFIG.mine.goldPerSecondPerWorkerLevel ?? 0) * worker.level * slotMultiplier * payoutSeconds * goldMultiplier) + traitGoldAmount)
        + capstonePassiveGoldAmount;

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
        shift: isShifting,
        payouts: [
          { resourceKey: mine.resourceKey, amount: resourceAmount },
          { resourceKey: "gold", amount: goldAmount }
        ].filter((payout) => payout.amount > 0)
      });
    }
  }
}
