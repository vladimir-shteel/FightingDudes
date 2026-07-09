import {
  CONFIG,
  getResourceLabel
} from "./config.js";
import {
  buyUnit,
  massMergeReserve
} from "./systems/reserveSystem.js";
import {
  sendBridgeheadToBattle
} from "./systems/garrisonSystem.js";
import {
  getResourceIconMarkup
} from "./ui/helpers.js";
import { setupClassModal } from "./ui/classModal.js";
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
    locationToast: document.querySelector("#locationToast"),
    victoryRestartButton: document.querySelector("#victoryRestartButton"),
    buyCostValue: document.querySelector("#buyCostValue"),
    reservePanel: document.querySelector(".reserve-panel"),
    reserveZone: document.querySelector("#reserveZone"),
    minesGrid: document.querySelector("#minesGrid"),
    enemyUnits: document.querySelector("#enemyUnits"),
    battleUnits: document.querySelector("#battleUnits"),
    classModal: document.querySelector("#classModal"),
    classModalTitle: document.querySelector("#classModalTitle"),
    classModalGrid: document.querySelector("#classModalGrid"),
    classModalClose: document.querySelector("#classModalClose"),
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

    return state.battle.status !== "fighting" &&
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

  setupClassModal(ctx);

  // Fire the "location cleared" toast once per new seq, then auto-dismiss it.
  let lastToastSeq = 0;
  let toastTimer = null;
  function renderLocationToast() {
    const toast = state.battle.locationToast;
    if (!toast || toast.seq === lastToastSeq) {
      return;
    }
    lastToastSeq = toast.seq;

    const el = elements.locationToast;
    el.innerHTML =
      `<span class="location-toast-title">Локация ${toast.location} пройдена!</span>` +
      `<span class="location-toast-sub">Слияние теперь до ур.${toast.mergeCap}</span>`;
    el.hidden = false;
    el.classList.remove("is-visible");
    void el.offsetWidth; // restart the entrance animation
    el.classList.add("is-visible");

    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(() => {
      el.classList.remove("is-visible");
      window.setTimeout(() => { el.hidden = true; }, 400);
    }, 3200);
  }

  function render() {
    renderMeta(ctx);
    renderReserve(ctx);
    renderMines(ctx);
    renderMineProgressFrame(ctx);
    renderBattle(ctx);
    renderBridgehead(ctx);
    renderLocationToast();
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
    renderLocationToast();
    updateSelectionTether(ctx);
    flushResourceBursts(ctx);
    flushBattleEffects(ctx);
  }

  return { render, renderFrame };
}
