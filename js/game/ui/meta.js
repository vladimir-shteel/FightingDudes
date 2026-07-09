import { CONFIG } from "../config.js";
import { formatNumber } from "../utils.js";
import { getUnitBuyCost } from "../systems/reserveSystem.js";
import { getBattleSummary } from "../systems/battleSystem.js";
import { renderBridgehead } from "./battlefield.js";

export function renderEconomyMeta(ctx) {
  const { state, elements, resourceOrder, resourceValueMap } = ctx;

  for (const resourceKey of resourceOrder) {
    resourceValueMap.get(resourceKey).textContent = formatNumber(state.resources[resourceKey] ?? 0);
  }
  const buyCost = formatNumber(getUnitBuyCost(state));
  if (elements.buyCostValue) {
    elements.buyCostValue.textContent = buyCost;
  }
  elements.buyUnitButton.innerHTML = `Buy Unit <span class="button-cost">${buyCost} Gold</span>`;
}

export function renderBattleMeta(ctx) {
  const { state, elements } = ctx;

  const summary = getBattleSummary(state);
  const totalWaves = CONFIG.waves.length;
  elements.waveValue.textContent = `${state.battle.currentWaveIndex + 1} / ${totalWaves}`;
  elements.battleSummary.textContent =
    `${summary.friendlyCount} allies | ${state.bridgeheadUnits.length} staged | ${summary.enemyCount} enemies | power ${Math.round(summary.squadPower)}`;

  const waveNumber = Math.min(state.battle.currentWaveIndex + 1, totalWaves);
  const wavePrefix = totalWaves > 0 ? `Волна ${waveNumber}/${totalWaves} · ` : "";

  if (state.battle.status === "won") {
    elements.battleTimer.textContent = "Победа!";
  } else if (state.game.isOver) {
    elements.battleTimer.textContent = "Run complete";
  } else if (state.battle.status === "fighting") {
    elements.battleTimer.textContent = `${wavePrefix}бой идёт`;
  } else if (state.battle.status === "lost") {
    elements.battleTimer.textContent = `${wavePrefix}${state.battle.log}`;
  } else {
    elements.battleTimer.textContent = `${wavePrefix}готовьте отряд`;
  }
}

export function renderSelectedUnitMeta(ctx) {
  const { elements, selection } = ctx;
  const { getSelectedUnitContext } = selection;

  const selected = getSelectedUnitContext();

  if (!selected) {
    elements.selectedUnitChip.classList.add("is-empty");
    elements.selectedUnitChip.classList.remove("is-selected");
    elements.selectedUnitValue.textContent = "None";
    elements.selectedUnitHint.textContent = "Tap a unit to choose it.";
    return;
  }

  elements.selectedUnitChip.classList.remove("is-empty");
  elements.selectedUnitChip.classList.add("is-selected");
  elements.selectedUnitValue.textContent = `${selected.unit.name} Lv${selected.unit.level}`;
  elements.selectedUnitHint.textContent = selected.source === "mine"
    ? "Tap empty slot to move, Reserve to return, or Garrison to prepare."
    : "Tap mine slot, worker, or Garrison.";
}

export function renderActionHints(ctx) {
  const { elements, selection } = ctx;
  const { getSelectedUnitContext } = selection;

  const selected = getSelectedUnitContext();
  elements.selectedUnitChip.classList.toggle("is-selected", Boolean(selected));
}

export function renderVictoryState(ctx) {
  const { state, elements } = ctx;

  elements.victoryOverlay.hidden = state.game.result !== "win";
  document.body.classList.toggle("state-win", state.game.result === "win");
}

export function renderMeta(ctx) {
  const { state, elements } = ctx;

  renderEconomyMeta(ctx);
  renderBattleMeta(ctx);
  renderSelectedUnitMeta(ctx);
  renderActionHints(ctx);
  renderBridgehead(ctx);
  elements.cheatPanel.hidden = !state.ui.isCheatsOpen;
  renderVictoryState(ctx);
}
