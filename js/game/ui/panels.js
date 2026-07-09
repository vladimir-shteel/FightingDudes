import {
  CONFIG,
  getClassConfig,
  getMineLevelData,
  getMineMaxLevel,
  getUnitLevelData
} from "../config.js";
import { formatNumber } from "../utils.js";
import { mergeReservePair } from "../systems/reserveSystem.js";
import {
  assignReserveUnitToMine,
  getMineUpgradeCost,
  mergeReserveUnitIntoMineUnit,
  moveMineUnitToMineSlot,
  returnMineUnitToReserve,
  unlockMine,
  upgradeMine
} from "../systems/mineSystem.js";
import {
  createMineProgressMarkup,
  createUnitCard,
  formatCosts,
  getResourceIconMarkup,
  renderCostMarkup
} from "./helpers.js";

export function renderReserve(ctx) {
  const { state, elements, onStateChanged, selection } = ctx;
  const { getSelectedUnitContext, clearSelectedUnit, selectUnit } = selection;

  elements.reserveZone.innerHTML = "";
  const selected = getSelectedUnitContext();

  for (const unit of state.reserveUnits) {
    const card = createUnitCard(unit, { origin: "reserve", compact: true });

    card.addEventListener("click", () => {
      const currentSelection = getSelectedUnitContext();

      if (currentSelection?.unit.id === unit.id) {
        clearSelectedUnit();
        onStateChanged();
        return;
      }

      if (currentSelection?.source === "reserve") {
        const result = mergeReservePair(state, currentSelection.unit.id, unit.id);
        state.battle.log = result.reason;
        if (result.ok) {
          clearSelectedUnit();
        } else {
          selectUnit(unit.id);
        }
        onStateChanged();
        return;
      }

      selectUnit(unit.id);
      onStateChanged();
    });

    if (selected?.unit.id === unit.id) {
      card.classList.add("selection-source");
    } else if (selected?.source === "reserve" && selected.unit.level === unit.level) {
      card.classList.add("actionable-target");
    }

    elements.reserveZone.append(card);
  }

  elements.reservePanel.onclick = (event) => {
    if (event.target.closest(".unit-card") || event.target.closest("button")) {
      return;
    }

    const currentSelection = getSelectedUnitContext();
    if (!currentSelection) {
      return;
    }

    if (currentSelection.source === "mine") {
      const result = returnMineUnitToReserve(state, currentSelection.mineId, currentSelection.slotIndex);
      state.battle.log = result.reason;
      if (result.ok) {
        clearSelectedUnit();
      }
    } else {
      clearSelectedUnit();
    }

    onStateChanged();
  };

  elements.reservePanel.classList.toggle("actionable-target", selected?.source === "mine");
}

export function renderMines(ctx) {
  const { state, elements, onStateChanged, selection } = ctx;
  const { getSelectedUnitContext, clearSelectedUnit, selectUnit } = selection;

  elements.minesGrid.innerHTML = "";
  const selected = getSelectedUnitContext();

  for (const mine of state.mines) {
    const card = document.createElement("article");
    card.className = "mine-card";
    card.dataset.resourceKey = mine.resourceKey;
    card.dataset.mineCard = mine.id;

    const upgradeCost = getMineUpgradeCost(mine);
    const mineLevelData = getMineLevelData(mine.level);
    const openSlots = mineLevelData?.slots ?? 0;
    const slotMultipliers = mineLevelData?.slotProductionMultipliers ?? [];
    const nextLevelData = getMineLevelData(mine.level + 1);
    const upgradeCurrency = nextLevelData?.upgradeCurrency ?? "gold";
    const passiveInterval = Math.max(0.001, CONFIG.passiveGoldPayoutIntervalSeconds ?? 1);
    const passiveProgress = mine.isUnlocked
      ? Math.min(1, (mine.passiveProgress ?? 0) / passiveInterval)
      : 0;
    const showPassive = mine.isUnlocked && (CONFIG.passiveGoldPerSecondPerUnlockedMine ?? 0) > 0;
    const actionLabel = !mine.isUnlocked
      ? `Unlock <span class="btn-cost">${formatNumber(mine.unlockCost)}${getResourceIconMarkup(mine.unlockCurrency, "btn-cost-icon")}</span>`
      : upgradeCost === null
        ? "Max Level"
        : `Upgrade <span class="btn-cost">${formatNumber(upgradeCost)}${getResourceIconMarkup(upgradeCurrency, "btn-cost-icon")}</span>`;
    card.innerHTML = `
      <div class="mine-head">
        <div class="mine-title-wrap">
          <div class="mine-title">
            ${getResourceIconMarkup(mine.resourceKey, "mine-resource-icon")}
            <div class="mine-title-text">
              <h3>${mine.name}</h3>
              <p class="eyebrow">Produces ${mine.resourceLabel} + Gold</p>
            </div>
          </div>
        </div>
        <button class="secondary-button" data-upgrade-mine="${mine.id}">
          ${actionLabel}
        </button>
      </div>
      <div class="mine-stats">
        ${showPassive ? `
          <div class="mine-passive" data-mine-passive="${mine.id}" title="Passive gold trickle">
            ${getResourceIconMarkup("gold", "mine-passive-icon")}
            <div class="mine-passive-bar">
              <div
                class="mine-passive-fill"
                data-mine-passive-fill="${mine.id}"
                style="width:${passiveProgress * 100}%"
              ></div>
            </div>
          </div>
        ` : ""}
        <span class="tag">Lv ${mine.level}</span>
      </div>
    `;

    const slots = document.createElement("div");
    slots.className = "mine-slots";

    for (let index = 0; index < getMineMaxLevel(); index += 1) {
      const slot = document.createElement("div");
      const isOpen = index < openSlots;
      slot.className = `slot ${isOpen ? "is-open" : "is-locked"}`;
      slot.dataset.mineSlot = `${mine.id}:${index}`;

      const slotMultiplier = slotMultipliers[index] ?? 1;
      const slotBadge = isOpen && mine.isUnlocked
        ? `<span class="slot-bonus" title="Production bonus for this slot">×${slotMultiplier.toFixed(slotMultiplier % 1 === 0 ? 0 : 2).replace(/\.?0+$/, "")}</span>`
        : "";

      const worker = mine.workerIds[index];
      if (!mine.isUnlocked) {
        slot.innerHTML = '<div class="slot-placeholder">Locked</div>';
      } else if (!isOpen) {
        slot.innerHTML = '<div class="slot-placeholder">Locked</div>';
      } else if (!worker) {
        slot.innerHTML = `${slotBadge}<div class="slot-placeholder">Tap to place</div>`;
        slot.classList.toggle("actionable-target", selected?.source === "reserve" || selected?.source === "mine");
        slot.addEventListener("click", () => {
          const selected = getSelectedUnitContext();
          if (!selected) {
            return;
          }

          const result = selected.source === "reserve"
            ? assignReserveUnitToMine(state, selected.unit.id, mine.id, index)
            : moveMineUnitToMineSlot(state, selected.mineId, selected.slotIndex, mine.id, index);
          state.battle.log = result.reason;
          if (result.ok) {
            clearSelectedUnit();
          }
          onStateChanged();
        });
      } else {
        const slotShell = document.createElement("div");
        slotShell.className = "slot slot-filled is-open";
        slotShell.dataset.mineSlot = `${mine.id}:${index}`;
        if (slotBadge) {
          slotShell.insertAdjacentHTML("afterbegin", slotBadge);
        }
        const progress = Math.min(
          1,
          (mine.workerProgress[index] ?? 0) / Math.max(0.001, CONFIG.mine.collectionIntervalSeconds ?? 1)
        );
        const workerCard = createUnitCard(worker, { origin: "reserve", compact: true });
        workerCard.addEventListener("click", () => {
          const selected = getSelectedUnitContext();

          if (selected?.unit.id === worker.id) {
            clearSelectedUnit();
            onStateChanged();
            return;
          }

          if (selected?.source === "reserve") {
            const result = mergeReserveUnitIntoMineUnit(state, selected.unit.id, mine.id, index);
            state.battle.log = result.reason;
            if (result.ok) {
              clearSelectedUnit();
            } else {
              selectUnit(worker.id);
            }
            onStateChanged();
            return;
          }

          if (selected?.source === "mine") {
            const result = moveMineUnitToMineSlot(state, selected.mineId, selected.slotIndex, mine.id, index);
            state.battle.log = result.reason;
            if (result.ok) {
              clearSelectedUnit();
            } else {
              selectUnit(worker.id);
            }
            onStateChanged();
            return;
          }

          selectUnit(worker.id);
          onStateChanged();
        });
        slotShell.append(workerCard);
        slotShell.insertAdjacentHTML(
          "beforeend",
          createMineProgressMarkup(mine.resourceKey, mine.id, index, progress)
        );
        if (selected?.unit.id === worker.id) {
          slotShell.classList.add("selection-source");
        } else if (
          (selected?.source === "reserve" && selected.unit.level === worker.level) ||
          selected?.source === "mine"
        ) {
          slotShell.classList.add("actionable-target");
        }
        slots.append(slotShell);
        continue;
      }

      slots.append(slot);
    }

    card.append(slots);
    card.querySelector(`[data-upgrade-mine="${mine.id}"]`).addEventListener("click", () => {
      const result = mine.isUnlocked ? upgradeMine(state, mine.id) : unlockMine(state, mine.id);
      state.battle.log = result.reason;
      onStateChanged();
    });

    elements.minesGrid.append(card);
  }
}

export function renderGearMeta(ctx) {
  const { state, elements, selection } = ctx;
  const { getSelectedUnitContext } = selection;

  elements.classSelect.value = state.ui.selectedClassId;
  const classConfig = getClassConfig(state.ui.selectedClassId);

  if (!classConfig) {
    elements.classInfo.innerHTML = "";
    elements.gearInfo.textContent = "Выберите класс.";
    return;
  }

  elements.classInfo.innerHTML = renderCostMarkup(classConfig.costs);

  const healthMult = classConfig.healthMult ?? 1;
  const attackMult = classConfig.attackMult ?? 1;
  const selected = getSelectedUnitContext();
  const levelData = selected ? getUnitLevelData(selected.unit.level) : null;

  let statsText;
  if (levelData) {
    const hp = Math.round(levelData.baseHealth * healthMult);
    const atk = Math.round(levelData.baseAttack * attackMult);
    statsText = `HP ${hp} | ATK ${atk} (ур.${selected.unit.level})`;
  } else {
    statsText = `HP ×${healthMult} | ATK ×${attackMult}`;
  }

  const costText = formatCosts(classConfig.costs) || "free";
  elements.gearInfo.textContent =
    `${classConfig.icon} ${classConfig.name} (ур.${classConfig.minLevel ?? 1}+) | ` +
    `${statsText} | ${costText}. ${classConfig.description ?? ""}`;
}
