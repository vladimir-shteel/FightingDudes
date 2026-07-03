import { CONFIG, getArmorConfig, getFormationRowConfig, getResourceLabel, getWeaponConfig } from "../config.js";
import { createBattleUnit } from "../factories.js";
import { removeUnitFromReserve, returnUnitToReserve } from "./reserveSystem.js";
import { removeUnitFromMine, restoreUnitToMine } from "./mineSystem.js";

function assignBattlePosition(state, unit, indexOffset = 0) {
  const index = state.battleUnits.length + indexOffset;
  const padding = 4;
  const spread = Math.max(1, CONFIG.battle.fieldHeight - padding * 2);
  const wave = index % 5;
  const ratio = wave / 4;
  unit.x = getFormationRowConfig(unit.formationRow)?.spawnX ?? CONFIG.battle.allySpawnX;
  unit.y = padding + spread * ratio;
}

function getCombinedCosts(weapon, armor) {
  const costs = {};

  for (const [resourceKey, amount] of Object.entries(weapon.costs ?? {})) {
    costs[resourceKey] = (costs[resourceKey] ?? 0) + amount;
  }

  for (const [resourceKey, amount] of Object.entries(armor.costs ?? {})) {
    costs[resourceKey] = (costs[resourceKey] ?? 0) + amount;
  }

  return costs;
}

function getMissingCosts(state, costs) {
  const missing = [];

  for (const [resourceKey, cost] of Object.entries(costs)) {
    const currentAmount = state.resources[resourceKey] ?? 0;
    if (currentAmount < cost) {
      missing.push(`${getResourceLabel(resourceKey)} ${Math.floor(currentAmount)}/${cost}`);
    }
  }

  return missing;
}

function spendCosts(state, costs) {
  for (const [resourceKey, cost] of Object.entries(costs)) {
    state.resources[resourceKey] -= cost;
  }
}

export function stageUnitOnBridgehead(state, unitId) {
  const maxSlots = CONFIG.bridgehead?.maxSlots ?? 8;
  if (state.bridgeheadUnits.length >= maxSlots) {
    return { ok: false, reason: `Bridgehead is full (${state.bridgeheadUnits.length}/${maxSlots}).` };
  }

  const weaponKey = state.ui.selectedWeaponKey;
  const armorKey = state.ui.selectedArmorKey;
  const weapon = getWeaponConfig(weaponKey);
  const armor = getArmorConfig(armorKey);

  if (!weapon || !armor) {
    return { ok: false, reason: "Select both weapon and armor before preparing a unit." };
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

  const combinedCosts = getCombinedCosts(weapon, armor);
  const missingCosts = getMissingCosts(state, combinedCosts);
  if (missingCosts.length > 0) {
    if (source === "reserve") {
      returnUnitToReserve(state, sourceUnit);
    } else {
      restoreUnitToMine(state, removedMineSlot.mineId, removedMineSlot.slotIndex, sourceUnit);
    }
    return {
      ok: false,
      reason: `Not enough resources for ${weapon.label} + ${armor.label}: ${missingCosts.join(", ")}.`
    };
  }

  spendCosts(state, combinedCosts);
  const battleUnit = createBattleUnit(sourceUnit, weaponKey, armorKey, CONFIG.formation.defaultRow ?? "front");
  battleUnit.state = "ready";
  battleUnit.targetHint = "bridgehead";
  state.bridgeheadUnits.push(battleUnit);
  state.battle.log =
    `${sourceUnit.name} is ready on the bridgehead with ${weapon.label} and ${armor.label}.`;

  return { ok: true, reason: state.battle.log };
}

export function setBridgeheadFormationRow(state, unitId, formationRow) {
  const unit = state.bridgeheadUnits.find((item) => item.id === unitId);
  if (!unit) {
    return { ok: false, reason: "Unit is no longer on the bridgehead." };
  }

  const rowConfig = getFormationRowConfig(formationRow);
  if (!rowConfig) {
    return { ok: false, reason: "Unknown formation row." };
  }

  unit.formationRow = formationRow;
  const damageMultiplier = unit.attackType === "ranged"
    ? rowConfig.rangedDamageMultiplier ?? rowConfig.damageMultiplier ?? 1
    : rowConfig.damageMultiplier ?? 1;
  unit.attack = (unit.baseEquippedAttack ?? unit.attack) * damageMultiplier;
  state.battle.log = `${unit.name} moved to ${rowConfig.label}.`;
  return { ok: true, reason: state.battle.log };
}

export function sendBridgeheadToBattle(state) {
  if (state.bridgeheadUnits.length === 0) {
    return { ok: false, reason: "Bridgehead is empty." };
  }

  const deployingUnits = state.bridgeheadUnits.splice(0);
  deployingUnits.forEach((unit, index) => {
    assignBattlePosition(state, unit, index);
    unit.state = "marching";
    unit.targetHint = "castle";
    unit.lastAttackAt = 0;
    state.battleUnits.push(unit);
  });

  if (state.battle.retreatWaveIndex !== null && state.battle.status === "retreating") {
    state.battle.log = `${deployingUnits.length} units entered the field. Enemies are returning from the castle.`;
  } else if (state.battle.status === "idle") {
    state.battle.status = "cooldown";
    state.battle.waveCooldownRemaining = CONFIG.battle.waveCooldownSeconds;
    state.battle.log = `${deployingUnits.length} units moved from the bridgehead into battle.`;
  } else {
    state.battle.log = `${deployingUnits.length} units moved from the bridgehead into battle.`;
  }

  return { ok: true, reason: state.battle.log };
}
