import { CONFIG, getClassConfig, getResourceLabel } from "../config.js";
import { createBattleUnit } from "../factories.js";
import { removeUnitFromReserve, returnUnitToReserve } from "./reserveSystem.js";
import { removeUnitFromMine, restoreUnitToMine } from "./mineSystem.js";
import { isBattleActive, startBattle } from "./battleSystem.js";

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

function getAllyRowSpawnX(formationRow) {
  const rows = CONFIG.battle.allyRowSpawnX ?? {};
  if (rows[formationRow] !== undefined) {
    return rows[formationRow];
  }
  const back = rows.back ?? CONFIG.battle.allySpawnX;
  return formationRow === "front" ? back + 10 : back;
}

function assignBattleY(state, unit, indexOffset = 0) {
  const index = state.battleUnits.length + indexOffset;
  const padding = CONFIG.battle.spawnSpreadPadding ?? 4;
  const spread = Math.max(1, CONFIG.battle.fieldHeight - padding * 2);
  const wave = index % 5;
  unit.y = padding + spread * (wave / 4);
}

export function stageUnitOnBridgehead(state, unitId, classId = state.ui.selectedClassId, formationRow = "front") {
  if (isBattleActive(state)) {
    return { ok: false, reason: "Казарма заблокирована на время боя." };
  }

  const maxSlots = CONFIG.bridgehead?.maxSlots ?? 8;
  if (state.bridgeheadUnits.length >= maxSlots) {
    return { ok: false, reason: `Плацдарм заполнен (${state.bridgeheadUnits.length}/${maxSlots}).` };
  }

  const classConfig = getClassConfig(classId);
  if (!classConfig) {
    return { ok: false, reason: "Выберите класс перед подготовкой юнита." };
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
    return { ok: false, reason: "Только юнит из резерва или шахты может уйти в казарму." };
  }

  const restoreSource = () => {
    if (source === "reserve") {
      returnUnitToReserve(state, sourceUnit);
    } else {
      restoreUnitToMine(state, removedMineSlot.mineId, removedMineSlot.slotIndex, sourceUnit);
    }
  };

  if (sourceUnit.level < (classConfig.minLevel ?? 1)) {
    restoreSource();
    return {
      ok: false,
      reason: `${classConfig.name}: нужен уровень ${classConfig.minLevel} (у юнита ${sourceUnit.level}).`
    };
  }

  const costs = classConfig.costs ?? {};
  const missingCosts = getMissingCosts(state, costs);
  if (missingCosts.length > 0) {
    restoreSource();
    return {
      ok: false,
      reason: `Не хватает ресурсов на ${classConfig.name}: ${missingCosts.join(", ")}.`
    };
  }

  spendCosts(state, costs);
  const battleUnit = createBattleUnit(sourceUnit, classId, formationRow);
  battleUnit.state = "ready";
  battleUnit.targetHint = "bridgehead";
  state.bridgeheadUnits.push(battleUnit);
  state.battle.log = `${classConfig.name} готов на плацдарме (${formationRow === "front" ? "передний" : "задний"} ряд).`;

  return { ok: true, reason: state.battle.log };
}

export function setBridgeheadUnitRow(state, unitId, formationRow) {
  const unit = state.bridgeheadUnits.find((entity) => entity.id === unitId);
  if (!unit) {
    return { ok: false, reason: "Юнит не найден на плацдарме." };
  }
  unit.formationRow = formationRow === "back" ? "back" : "front";
  return { ok: true, reason: `${unit.name}: ${unit.formationRow === "front" ? "передний" : "задний"} ряд.` };
}

export function sendBridgeheadToBattle(state) {
  if (isBattleActive(state)) {
    return { ok: false, reason: "Бой уже идёт." };
  }
  if (state.bridgeheadUnits.length === 0) {
    return { ok: false, reason: "Плацдарм пуст." };
  }

  const deployingUnits = state.bridgeheadUnits.splice(0);
  deployingUnits.forEach((unit, index) => {
    unit.x = getAllyRowSpawnX(unit.formationRow);
    assignBattleY(state, unit, index);
    unit.state = "marching";
    unit.targetHint = "advance";
    unit.lastAttackAt = 0;
    state.battleUnits.push(unit);
  });

  startBattle(state);
  state.battle.log = `${deployingUnits.length} юнит(ов) вступили в бой (волна ${state.battle.currentWaveIndex + 1}).`;

  return { ok: true, reason: state.battle.log };
}
