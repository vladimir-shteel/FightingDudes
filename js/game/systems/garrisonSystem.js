import { CONFIG } from "../config.js";
import { createBattleUnit } from "../factories.js";
import { removeUnitFromReserve, returnUnitToReserve } from "./reserveSystem.js";
import { removeUnitFromMine, restoreUnitToMine } from "./mineSystem.js";

export function deployUnitToBattle(state, unitId) {
  const gearKey = state.ui.selectedGearKey;
  const gear = CONFIG.equipment[gearKey];
  if (!gear) {
    return { ok: false, reason: "Select gear before deployment." };
  }

  let source = "reserve";
  let removedMineSlot = null;
  let sourceUnit = removeUnitFromReserve(state, unitId);
  if (!sourceUnit) {
    const mineRemoval = removeUnitFromMine(state, unitId);
    sourceUnit = mineRemoval?.unit ?? null;
    if (sourceUnit) {
      source = "mine";
      removedMineSlot = mineRemoval;
    }
  }

  if (!sourceUnit) {
    return { ok: false, reason: "Only reserve or mining units can be sent to the garrison." };
  }

  if (state.resources.ore < gear.oreCost) {
    if (source === "reserve") {
      returnUnitToReserve(state, sourceUnit);
    } else {
      restoreUnitToMine(state, removedMineSlot.mineId, removedMineSlot.slotIndex, sourceUnit);
    }
    return { ok: false, reason: `Not enough ore for ${gear.label}.` };
  }

  state.resources.ore -= gear.oreCost;
  state.battleUnits.push(createBattleUnit(sourceUnit, gearKey));
  state.battle.log = `${sourceUnit.name} joined the battlefield with ${gear.label}.`;

  if (state.battle.status === "idle") {
    state.battle.status = "cooldown";
    state.battle.waveCooldownRemaining = CONFIG.battle.waveCooldownSeconds;
  }

  return { ok: true, reason: state.battle.log };
}
