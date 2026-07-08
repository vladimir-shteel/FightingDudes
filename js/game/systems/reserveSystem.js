import { CONFIG } from "../config.js";
import { createReserveUnit } from "../factories.js";
import { getMaxWorkerLevel, isWorkerBattleShiftLocked, mergeWorkerTraitVectors, pickCapstoneCandidates } from "./workerTraitSystem.js";

function getWorkerPower(unit) {
  const level = Math.max(1, unit?.level ?? 1);
  return 2 ** (level - 1);
}

function getTotalWorkerPower(state) {
  let total = 0;

  for (const unit of state.reserveUnits) {
    total += getWorkerPower(unit);
  }

  for (const mine of state.mines) {
    for (const unit of mine.workerIds) {
      if (unit) {
        total += getWorkerPower(unit);
      }
    }
  }

  return total;
}

export function getUnitBuyCost(state) {
  const workerPower = getTotalWorkerPower(state);
  const baseCost = CONFIG.unitBuyBaseCost * ((CONFIG.unitBuyExponent ?? 1) ** workerPower);
  return Math.max(1, Math.floor(baseCost * (state.economy.workerBuyDiscount ?? 1)));
}

export function buyUnit(state) {
  const cost = getUnitBuyCost(state);
  if (state.resources.gold < cost || state.game.isOver) {
    return { ok: false, reason: "Not enough gold." };
  }

  state.resources.gold -= cost;
  state.economy.unitsPurchased += 1;
  // A freshly bought worker arrives wanting a random open mine, with one rest charge — place it on
  // that mine and it Shifts on its very first battle (discoverable without ever using reserve).
  const openMines = state.mines.filter((mine) => mine.isUnlocked).map((mine) => mine.resourceKey);
  const desiredMine = openMines.length ? openMines[Math.floor(Math.random() * openMines.length)] : null;
  state.reserveUnits.push(createReserveUnit(state.economy.workerStartLevel ?? 1, { restCharges: 1, desiredMine }));

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

  if (isWorkerBattleShiftLocked(state, first) || isWorkerBattleShiftLocked(state, second)) {
    return { ok: false, reason: "Committed workers are locked until the battle ends." };
  }

  if (first.level !== second.level) {
    return { ok: false, reason: "Only equal-level units can merge." };
  }

  const levelCap = getMaxWorkerLevel(state);
  if (first.level >= levelCap) {
    return {
      ok: false,
      reason: levelCap < (CONFIG.merge.maxLevel ?? 5)
        ? `Level cap is Lv${levelCap} for now — it rises each wave.`
        : "This unit has reached max merge level."
    };
  }

  const mergedLevel = first.level + 1;
  const mergedTraits = mergeWorkerTraitVectors(first.traits, second.traits);
  const higherLevelUnit = createReserveUnit(mergedLevel, {
    traits: mergedTraits,
    restCharges: Math.max(first.restCharges ?? 0, second.restCharges ?? 0),
    desiredMine: first.desiredMine ?? second.desiredMine ?? null,
    pendingCapstone: mergedLevel === CONFIG.merge.maxLevel ? pickCapstoneCandidates(mergedTraits) : null
  });
  const keptUnits = state.reserveUnits.filter(
    (unit) => unit.id !== firstUnitId && unit.id !== secondUnitId
  );
  keptUnits.push(higherLevelUnit);
  state.reserveUnits = keptUnits;

  return { ok: true, reason: `Merged into level ${higherLevelUnit.level}.` };
}

export function massMergeReserve(state) {
  let mergedCount = 0;

  while (true) {
    // Only pair workers that are actually mergeable: below max level and not
    // locked into a battle shift. Iterating over all reserve units and breaking
    // on the first failing pair used to stop the whole run whenever a
    // committed worker was in the middle of the pile.
    const levelCap = getMaxWorkerLevel(state);
    const groups = new Map();
    for (const unit of state.reserveUnits) {
      if (unit.level >= levelCap) continue;
      if (isWorkerBattleShiftLocked(state, unit)) continue;
      if (!groups.has(unit.level)) groups.set(unit.level, []);
      groups.get(unit.level).push(unit.id);
    }

    const pair = [...groups.values()].find((ids) => ids.length >= 2);
    if (!pair) break;

    const result = mergeReservePair(state, pair[0], pair[1]);
    if (!result.ok) break;
    mergedCount += 1;
  }

  return mergedCount > 0
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
