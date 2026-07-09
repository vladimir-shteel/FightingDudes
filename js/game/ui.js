import {
  CONFIG,
  getAvailableClasses,
  getClassConfig,
  getResourceLabel
} from "./config.js";
import {
  buyUnit,
  massMergeReserve
} from "./systems/reserveSystem.js";
import {
  sendBridgeheadToBattle,
  stageUnitOnBridgehead
} from "./systems/garrisonSystem.js";
import {
  canAffordCosts,
  getResourceIconMarkup,
  getSelectedLoadoutCosts
} from "./ui/helpers.js";
import {
  flushBattleEffects,
  flushResourceBursts,
  renderBattle,
  renderBridgehead,
  renderMineProgressFrame,
  updateSelectionTether
} from "./ui/battlefield.js";
import {
  renderMines,
  renderReserve
} from "./ui/panels.js";
import {
  renderActionHints,
  renderBattleMeta,
  renderEconomyMeta,
  renderMeta,
  renderVictoryState
} from "./ui/meta.js";

export function mountUI(state, onStateChanged) {
  const elements = {
    resourceList: document.querySelector("#resourceList"),
    selectedUnitChip: document.querySelector("#selectedUnitChip"),
    selectedUnitValue: document.querySelector("#selectedUnitValue"),
    selectedUnitHint: document.querySelector("#selectedUnitHint"),
    waveValue: document.querySelector("#waveValue"),
    battleSummary: document.querySelector("#battleSummary"),
    battleTimer: document.querySelector("#battleTimer"),
    battleLog: document.querySelector("#battleLog"),
    bridgeheadSlots: document.querySelector("#bridgeheadSlots"),
    sendBridgeheadButton: document.querySelector("#sendBridgeheadButton"),
    battlefield: document.querySelector("#battlefield"),
    cheatPanel: document.querySelector("#cheatPanel"),
    grantResourcesButton: document.querySelector("#grantResourcesButton"),
    victoryOverlay: document.querySelector("#victoryOverlay"),
    victoryRestartButton: document.querySelector("#victoryRestartButton"),
    buyCostValue: document.querySelector("#buyCostValue"),
    reservePanel: document.querySelector(".reserve-panel"),
    reserveZone: document.querySelector("#reserveZone"),
    minesGrid: document.querySelector("#minesGrid"),
    enemyUnits: document.querySelector("#enemyUnits"),
    battleUnits: document.querySelector("#battleUnits"),
    garrisonDropzone: document.querySelector("#garrisonDropzone"),
    gearInfo: document.querySelector("#gearInfo"),
    classSelect: document.querySelector("#classSelect"),
    classInfo: document.querySelector("#classInfo"),
    buyUnitButton: document.querySelector("#buyUnitButton"),
    massMergeButton: document.querySelector("#massMergeButton"),
    restartButton: document.querySelector("#restartButton"),
    fxLayer: document.querySelector("#fxLayer")
  };

  const resourceOrder = [
    "gold",
    ...CONFIG.mine.resourceTypes.map((resourceType) => resourceType.key)
  ];
  const resourceValueMap = new Map();

  elements.resourceList.innerHTML = "";
  for (const resourceKey of resourceOrder) {
    const chip = document.createElement("div");
    chip.className = "resource-chip";
    chip.dataset.resourceChip = resourceKey;
    chip.innerHTML = `
      <div class="resource-chip-top">
        ${getResourceIconMarkup(resourceKey)}
        <span class="resource-label">${getResourceLabel(resourceKey)}</span>
      </div>
      <strong data-resource-value="${resourceKey}">0</strong>
    `;
    elements.resourceList.append(chip);
    resourceValueMap.set(resourceKey, chip.querySelector("strong"));
  }

  elements.classSelect.innerHTML = "";
  for (const classConfig of getAvailableClasses(99)) {
    const option = document.createElement("option");
    option.value = classConfig.id;
    option.textContent = `${classConfig.icon} ${classConfig.name} (ур.${classConfig.minLevel ?? 1}+)`;
    elements.classSelect.append(option);
  }

  elements.classSelect.value = state.ui.selectedClassId;

  const mineProgressCache = new Map();

  function getSelectedUnitContext() {
    const selectedUnitId = state.ui.selectedUnitId;
    if (!selectedUnitId) {
      return null;
    }

    const reserveUnit = state.reserveUnits.find((unit) => unit.id === selectedUnitId);
    if (reserveUnit) {
      return { unit: reserveUnit, source: "reserve" };
    }

    for (const mine of state.mines) {
      for (let index = 0; index < mine.workerIds.length; index += 1) {
        const worker = mine.workerIds[index];
        if (worker?.id === selectedUnitId) {
          return { unit: worker, source: "mine", mineId: mine.id, slotIndex: index };
        }
      }
    }

    state.ui.selectedUnitId = null;
    return null;
  }

  function clearSelectedUnit() {
    state.ui.selectedUnitId = null;
  }

  function selectUnit(unitId) {
    state.ui.selectedUnitId = unitId;
  }

  function canDeploySelectedUnit() {
    const selected = getSelectedUnitContext();
    if (!selected) {
      return false;
    }

    const combinedCosts = getSelectedLoadoutCosts(state);
    if (!combinedCosts) {
      return false;
    }

    return canAffordCosts(state.resources, combinedCosts) &&
      state.bridgeheadUnits.length < (CONFIG.bridgehead?.maxSlots ?? 8);
  }

  const ctx = {
    state,
    elements,
    onStateChanged,
    resourceOrder,
    resourceValueMap,
    mineProgressCache,
    selection: {
      getSelectedUnitContext,
      clearSelectedUnit,
      selectUnit,
      canDeploySelectedUnit
    }
  };

  elements.buyUnitButton.addEventListener("click", () => {
    const result = buyUnit(state);
    state.battle.log = result.reason;
    onStateChanged();
  });

  elements.massMergeButton.addEventListener("click", () => {
    const result = massMergeReserve(state);
    state.battle.log = result.reason;
    clearSelectedUnit();
    onStateChanged();
  });

  elements.grantResourcesButton.addEventListener("click", () => {
    for (const resourceKey of resourceOrder) {
      state.resources[resourceKey] = (state.resources[resourceKey] ?? 0) + 1000;
    }
    state.battle.log = "Cheat: +1000 to every resource.";
    onStateChanged();
  });

  window.addEventListener("keydown", (event) => {
    const tagName = event.target?.tagName?.toLowerCase();
    if (
      event.repeat ||
      tagName === "input" ||
      tagName === "select" ||
      tagName === "textarea" ||
      event.key.toLowerCase() !== "e"
    ) {
      return;
    }

    state.ui.isCheatsOpen = !state.ui.isCheatsOpen;
    onStateChanged();
  });

  elements.restartButton.addEventListener("click", () => {
    window.location.reload();
  });

  elements.victoryRestartButton.addEventListener("click", () => {
    window.location.reload();
  });

  elements.sendBridgeheadButton.addEventListener("click", () => {
    const result = sendBridgeheadToBattle(state);
    state.battle.log = result.reason;
    onStateChanged();
  });

  elements.classSelect.addEventListener("change", () => {
    state.ui.selectedClassId = elements.classSelect.value;
    state.battle.log = `Выбран класс: ${getClassConfig(state.ui.selectedClassId)?.name}.`;
    onStateChanged();
  });

  elements.garrisonDropzone.addEventListener("click", () => {
    const selected = getSelectedUnitContext();
    if (!selected) {
      return;
    }

    const result = stageUnitOnBridgehead(state, selected.unit.id);
    state.battle.log = result.reason;
    if (result.ok) {
      clearSelectedUnit();
    }
    onStateChanged();
  });

  function render() {
    renderMeta(ctx);
    renderReserve(ctx);
    renderMines(ctx);
    renderMineProgressFrame(ctx);
    renderBattle(ctx);
    renderBridgehead(ctx);
    updateSelectionTether(ctx);
    flushResourceBursts(ctx);
    flushBattleEffects(ctx);
  }

  function renderFrame() {
    renderEconomyMeta(ctx);
    renderBattleMeta(ctx);
    renderMineProgressFrame(ctx);
    renderBattle(ctx);
    renderBridgehead(ctx);
    renderActionHints(ctx);
    renderVictoryState(ctx);
    updateSelectionTether(ctx);
    flushResourceBursts(ctx);
    flushBattleEffects(ctx);
  }

  return { render, renderFrame };
}
