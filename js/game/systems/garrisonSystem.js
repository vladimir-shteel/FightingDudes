import { CONFIG, getArmorConfig, getResourceLabel, getWeaponConfig } from "../config.js";
import { createBattleUnit } from "../factories.js";
import { removeUnitFromReserve, returnUnitToReserve } from "./reserveSystem.js";
import { removeUnitFromMine, restoreUnitToMine } from "./mineSystem.js";

function getDeploymentY(state) {
  const index = state.battleUnits.length;
  const padding = 4;
  const spread = Math.max(1, CONFIG.battle.fieldHeight - padding * 2);
  const wave = index % 5;
  const ratio = wave / 4;
  return padding + spread * ratio;
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

export function deployUnitToBattle(state, unitId) {
  const weaponKey = state.ui.selectedWeaponKey;
  const armorKey = state.ui.selectedArmorKey;
  const weapon = getWeaponConfig(weaponKey);
  const armor = getArmorConfig(armorKey);

  if (!weapon || !armor) {
    return { ok: false, reason: "Select both weapon and armor before deployment." };
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
  const battleUnit = createBattleUnit(sourceUnit, weaponKey, armorKey);
  battleUnit.x = CONFIG.battle.allySpawnX;
  battleUnit.y = getDeploymentY(state);
  state.battleUnits.push(battleUnit);
  state.battle.log = `${sourceUnit.name} joined the battlefield with ${weapon.label} and ${armor.label}.`;

  if (state.battle.retreatWaveIndex !== null && state.battle.status === "retreating") {
    state.battle.log = `${sourceUnit.name} entered the field. Enemies are returning from the castle.`;
  } else if (state.battle.status === "idle") {
    state.battle.status = "cooldown";
    state.battle.waveCooldownRemaining = CONFIG.battle.waveCooldownSeconds;
  }

  return { ok: true, reason: state.battle.log };
}
