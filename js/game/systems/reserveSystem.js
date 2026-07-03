import { CONFIG } from "../config.js";
import { createReserveUnit } from "../factories.js";

function getSpecializationKey(unit) {
  return unit?.specializationKey ?? null;
}

export function canMergeUnits(left, right) {
  return Boolean(left && right) &&
    left.level === right.level &&
    left.level < CONFIG.merge.maxLevel &&
    getSpecializationKey(left) === getSpecializationKey(right);
}

export function createMergedUnit(left, right) {
  if (!canMergeUnits(left, right)) {
    return null;
  }

  return createReserveUnit(left.level + 1, getSpecializationKey(left));
}

function getBaseUnitEquivalent(unit) {
  return Math.pow(2, Math.max(0, (unit?.level ?? 1) - 1));
}

function getTotalOwnedBaseUnitEquivalents(state) {
  const reserveCount = state.reserveUnits.reduce(
    (total, unit) => total + getBaseUnitEquivalent(unit),
    0
  );
  const mineCount = state.mines.reduce(
    (total, mine) => total + mine.workerIds.reduce(
      (mineTotal, worker) => mineTotal + (worker ? getBaseUnitEquivalent(worker) : 0),
      0
    ),
    0
  );
  return reserveCount + mineCount;
}

export function getUnitBuyCost(state) {
  const ownedBaseUnits = getTotalOwnedBaseUnitEquivalents(state);
  return Math.max(1, Math.floor(CONFIG.unitBuyBaseCost * Math.pow(CONFIG.unitBuyExponent, ownedBaseUnits)));
}

export function buyUnit(state) {
  const cost = getUnitBuyCost(state);
  if (state.resources.gold < cost || state.game.isOver) {
    return { ok: false, reason: "Not enough gold." };
  }

  state.resources.gold -= cost;
  state.economy.unitsPurchased += 1;
  state.reserveUnits.push(createReserveUnit(1));

  return { ok: true, reason: "A fresh unit joined the reserve." };
}

export function mergeReservePair(state, firstUnitId, secondUnitId) {
  if (firstUnitId === secondUnitId) {
    return { ok: false, reason: "Choose two different units." };
  }

  const firstIndex = state.reserveUnits.findIndex((unit) => unit.id === firstUnitId);
  const secondIndex = state.reserveUnits.findIndex((unit) => unit.id === secondUnitId);

  if (firstIndex === -1 || secondIndex === -1) {
    return { ok: false, reason: "Unit is no longer in the reserve." };
  }

  const first = state.reserveUnits[firstIndex];
  const second = state.reserveUnits[secondIndex];

  if (first.level !== second.level) {
    return { ok: false, reason: "Only equal-level units can merge." };
  }

  if (first.level >= CONFIG.merge.maxLevel) {
    return { ok: false, reason: "This unit has reached max merge level." };
  }

  if (!canMergeUnits(first, second)) {
    return { ok: false, reason: "Only units with the same class can merge." };
  }

  const higherLevelUnit = createMergedUnit(first, second);
  const keptUnits = state.reserveUnits.filter(
    (unit) => unit.id !== firstUnitId && unit.id !== secondUnitId
  );
  keptUnits.push(higherLevelUnit);
  state.reserveUnits = keptUnits;

  const specializationText = higherLevelUnit.specializationLabel ? ` ${higherLevelUnit.specializationLabel}` : "";
  return { ok: true, reason: `Merged into level ${higherLevelUnit.level}${specializationText}.` };
}

export function massMergeReserve(state) {
  let didMerge = false;
  let mergedCount = 0;

  while (true) {
    const groups = new Map();
    for (const unit of state.reserveUnits) {
      const groupKey = `${unit.level}:${unit.specializationKey ?? "none"}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey).push(unit.id);
    }

    const mergeableLevel = [...groups.entries()].find(([, unitIds]) => unitIds.length >= 2)?.[0];
    if (!mergeableLevel) {
      break;
    }

    const [firstUnitId, secondUnitId] = groups.get(mergeableLevel);
    const result = mergeReservePair(state, firstUnitId, secondUnitId);
    if (!result.ok) {
      break;
    }
    didMerge = true;
    mergedCount += 1;
  }

  return didMerge
    ? { ok: true, reason: `Mass merge completed: ${mergedCount} merge(s).` }
    : { ok: false, reason: "No matching reserve pairs found." };
}

export function removeUnitFromReserve(state, unitId) {
  const index = state.reserveUnits.findIndex((unit) => unit.id === unitId);
  if (index === -1) {
    return null;
  }

  const [unit] = state.reserveUnits.splice(index, 1);
  return unit;
}

export function returnUnitToReserve(state, unit) {
  state.reserveUnits.push(unit);
}
