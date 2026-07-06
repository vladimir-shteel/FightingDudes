import { CONFIG } from "../config.js";
import { createReserveUnit } from "../factories.js";

export function getUnitBuyCost(state) {
  const baseCost = CONFIG.unitBuyBaseCost + (state.economy.unitsPurchased ?? 0);
  return Math.max(1, Math.floor(baseCost * (state.economy.workerBuyDiscount ?? 1)));
}

export function buyUnit(state) {
  const cost = getUnitBuyCost(state);
  if (state.resources.gold < cost || state.game.isOver) {
    return { ok: false, reason: "Not enough gold." };
  }

  state.resources.gold -= cost;
  state.economy.unitsPurchased += 1;
  state.reserveUnits.push(createReserveUnit(state.economy.workerStartLevel ?? 1));

  return { ok: true, reason: "A fresh worker joined the pile." };
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

  const higherLevelUnit = createReserveUnit(first.level + 1);
  const keptUnits = state.reserveUnits.filter(
    (unit) => unit.id !== firstUnitId && unit.id !== secondUnitId
  );
  keptUnits.push(higherLevelUnit);
  state.reserveUnits = keptUnits;

  return { ok: true, reason: `Merged into level ${higherLevelUnit.level}.` };
}

export function massMergeReserve(state) {
  let didMerge = false;
  let mergedCount = 0;

  while (true) {
    const groups = new Map();
    for (const unit of state.reserveUnits) {
      if (!groups.has(unit.level)) {
        groups.set(unit.level, []);
      }
      groups.get(unit.level).push(unit.id);
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
