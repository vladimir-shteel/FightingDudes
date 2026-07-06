import {
  CONFIG,
  getMineLevelData,
  getMineMaxLevel,
  getResourceIcon,
  getResourceLabel,
} from "./config.js";
import { formatNumber } from "./utils.js";
import {
  buyUnit,
  getUnitBuyCost,
  massMergeReserve,
  mergeReservePair
} from "./systems/reserveSystem.js";
import {
  assignReserveUnitToMine,
  getMineUpgradeCost,
  mergeReserveUnitIntoMineUnit,
  moveMineUnitToMineSlot,
  returnMineUnitToReserve,
  unlockMine,
  upgradeMine
} from "./systems/mineSystem.js";
import { startFortressBattle } from "./systems/fortressBattleSystem.js";
import {
  buyFortressBuilding,
  canAffordResources,
  canPlaceFortressBuilding,
  findFortressPlacement,
  getFortressBuildingBuyCost,
  moveFortressBuilding,
  removeFortressObstacle,
  upgradeFortressBuilding
} from "./systems/fortressSystem.js";
import { applyUpgradeChoice } from "./systems/upgradeSystem.js";

function getResourceIconMarkup(resourceKey, extraClass = "") {
  const icon = getResourceIcon(resourceKey);
  const suffix = extraClass ? ` ${extraClass}` : "";
  if (icon) {
    return `<span class="resource-icon resource-icon-emoji${suffix}" aria-hidden="true">${icon}</span>`;
  }
  return `<span class="resource-icon resource-icon-${resourceKey}${suffix}" aria-hidden="true"></span>`;
}

function createUnitCard(unit, options = {}) {
  const {
    origin = "reserve",
    draggable = false,
    compact = false
  } = options;

  const card = document.createElement("article");
  card.className = `unit-card ${origin}-card${compact ? " compact-card" : ""}`;
  card.dataset.unitId = unit.id;
  card.draggable = draggable;

  const icon = unit.icon ?? "W";
  const health = unit.maxHealth ?? unit.baseHealth ?? unit.health ?? 0;
  const attack = unit.attack ?? unit.baseAttack ?? 0;
  const level = unit.level ?? 1;

  card.dataset.gear = "worker";
  card.dataset.level = String(level);
  card.dataset.hit = unit.hitUntil && unit.hitUntil > performance.now() / 1000 ? "true" : "false";

  card.innerHTML = `
    <div class="unit-badges">
      <span class="unit-level-badge">${level}</span>
    </div>
    <div class="unit-character" aria-hidden="true">
      <div class="unit-icon">
        <span class="unit-icon-main">${icon}</span>
        </div>
      <div class="unit-shadow"></div>
    </div>
    <div class="unit-ui">
      <div class="unit-name">${unit.name}</div>
      <span class="unit-meta">ATK ${Math.round(attack)} | HP ${Math.round(health)}</span>
    </div>
    ${compact ? `<span class="compact-caption">ATK ${Math.round(attack)} | HP ${Math.round(health)}</span>` : ""}
  `;

  return card;
}

function createMineProgressMarkup(resourceKey, mineId, slotIndex, progress) {
  return `
    <div class="slot-progress" aria-label="Production progress">
      ${getResourceIconMarkup(resourceKey, "slot-progress-icon")}
      <div class="slot-progress-bar">
        <div
          class="slot-progress-fill slot-progress-fill-${resourceKey}"
          data-mine-progress-fill="${mineId}:${slotIndex}"
          style="width:${progress * 100}%"
        ></div>
      </div>
    </div>
  `;
}

function getVisibleResourceTarget(elements, resourceKey) {
  const candidates = [
    elements.fortressResourceList?.querySelector(`[data-fortress-resource-chip="${resourceKey}"]`),
    elements.resourceList?.querySelector(`[data-resource-chip="${resourceKey}"]`)
  ].filter(Boolean);

  return candidates.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) ?? candidates[0] ?? null;
}

function getBattlefieldBurstPosition(elements, battlefield) {
  if (!battlefield || !elements.fortressField) {
    return null;
  }

  const fieldRect = elements.fortressField.getBoundingClientRect();
  if (fieldRect.width <= 0 || fieldRect.height <= 0) {
    return null;
  }

  const x = Math.max(0, Math.min(5, battlefield.x));
  const y = Math.max(0, Math.min(7, battlefield.y));
  return {
    x: fieldRect.left + (x / 5) * fieldRect.width,
    y: fieldRect.top + (y / 7) * fieldRect.height
  };
}

function playResourceBurst(elements, burst) {
  let startX;
  let startY;

  const battlefieldPosition = getBattlefieldBurstPosition(elements, burst.battlefield);
  if (battlefieldPosition) {
    startX = battlefieldPosition.x;
    startY = battlefieldPosition.y;
  } else {
    const source = burst.slotIndex >= 0
      ? elements.minesGrid.querySelector(`[data-mine-slot="${burst.mineId}:${burst.slotIndex}"]`)
      : elements.minesGrid.querySelector(`[data-mine-passive="${burst.mineId}"]`)
        ?? elements.minesGrid.querySelector(`[data-mine-card="${burst.mineId}"]`);
    if (!source) {
      return;
    }

    const sourceRect = source.getBoundingClientRect();
    startX = sourceRect.left + sourceRect.width / 2;
    startY = sourceRect.top + sourceRect.height / 2;
  }

  for (const payout of burst.payouts) {
    const displayAmount = Math.round(payout.amount);
    if (displayAmount <= 0) {
      continue;
    }

    const target = getVisibleResourceTarget(elements, payout.resourceKey);
    if (!target) {
      continue;
    }

    const targetRect = target.getBoundingClientRect();
    const endX = targetRect.left + targetRect.width / 2;
    const endY = targetRect.top + targetRect.height / 2;
    const token = document.createElement("div");
    token.className = `resource-fly resource-${payout.resourceKey}`;
    token.innerHTML = `
      ${getResourceIconMarkup(payout.resourceKey, "resource-fly-icon")}
      <span class="resource-fly-text">+${displayAmount}</span>
    `;
    token.style.left = `${startX}px`;
    token.style.top = `${startY}px`;
    elements.fxLayer.append(token);

    requestAnimationFrame(() => {
      token.style.transform = `translate(${endX - startX}px, ${endY - startY}px) scale(0.72)`;
      token.style.opacity = "0";
    });

    window.setTimeout(() => token.remove(), 760);
  }
}

export function mountUI(state, onStateChanged) {
  const elements = {
    resourceList: document.querySelector("#resourceList"),
    selectedUnitChip: document.querySelector("#selectedUnitChip"),
    selectedUnitValue: document.querySelector("#selectedUnitValue"),
    selectedUnitHint: document.querySelector("#selectedUnitHint"),
    waveValue: document.querySelector("#waveValue"),
    cheatPanel: document.querySelector("#cheatPanel"),
    grantResourcesButton: document.querySelector("#grantResourcesButton"),
    buyCostValue: document.querySelector("#buyCostValue"),
    reservePanel: document.querySelector(".reserve-panel"),
    reserveZone: document.querySelector("#reserveZone"),
    minesGrid: document.querySelector("#minesGrid"),
    buyUnitButton: document.querySelector("#buyUnitButton"),
    massMergeButton: document.querySelector("#massMergeButton"),
    restartButton: document.querySelector("#restartButton"),
    fxLayer: document.querySelector("#fxLayer")
    ,
    screenDeck: document.querySelector("#screenDeck"),
    showFortressButton: document.querySelector("#showFortressButton"),
    showProductionButton: document.querySelector("#showProductionButton"),
    fortressResourceList: document.querySelector("#fortressResourceList"),
    fortressWaveValue: document.querySelector("#fortressWaveValue"),
    fortressFightButton: document.querySelector("#fortressFightButton"),
    fortressMessage: document.querySelector("#fortressMessage"),
    fortressField: document.querySelector("#fortressField"),
    fortressShop: document.querySelector("#fortressShop"),
    upgradeOverlay: document.querySelector("#upgradeOverlay"),
    upgradeChoices: document.querySelector("#upgradeChoices"),
    runEndOverlay: document.querySelector("#runEndOverlay"),
    runEndTitle: document.querySelector("#runEndTitle"),
    runEndText: document.querySelector("#runEndText"),
    runEndRestartButton: document.querySelector("#runEndRestartButton")
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

  const fortressResourceValueMap = new Map();
  elements.fortressResourceList.innerHTML = "";
  for (const resourceKey of resourceOrder) {
    const chip = document.createElement("div");
    chip.className = "resource-chip";
    chip.dataset.fortressResourceChip = resourceKey;
    chip.innerHTML = `
      <div class="resource-chip-top">
        ${getResourceIconMarkup(resourceKey)}
        <span class="resource-label">${getResourceLabel(resourceKey)}</span>
      </div>
      <strong data-fortress-resource-value="${resourceKey}">0</strong>
    `;
    elements.fortressResourceList.append(chip);
    fortressResourceValueMap.set(resourceKey, chip.querySelector("strong"));
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

  function updateSelectionTether() {
    const existing = elements.fxLayer.querySelector(".selection-tether");
    const selected = getSelectedUnitContext();

    if (!selected) {
      existing?.remove();
      return;
    }

    const source = document.querySelector(`.unit-card[data-unit-id="${selected.unit.id}"]`);
    if (!source || !elements.selectedUnitChip) {
      existing?.remove();
      return;
    }

    const sourceRect = source.getBoundingClientRect();
    const viewportW = window.innerWidth || document.documentElement.clientWidth;
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const isSourceVisible =
      sourceRect.bottom > 0 &&
      sourceRect.right > 0 &&
      sourceRect.top < viewportH &&
      sourceRect.left < viewportW;

    if (isSourceVisible) {
      existing?.remove();
      return;
    }

    const targetRect = elements.selectedUnitChip.getBoundingClientRect();
    const startX = sourceRect.left + sourceRect.width / 2;
    const startY = sourceRect.top + sourceRect.height / 2;
    const endX = targetRect.left + targetRect.width / 2;
    const endY = targetRect.top + targetRect.height / 2;
    const length = Math.hypot(endX - startX, endY - startY);
    const angle = Math.atan2(endY - startY, endX - startX) * (180 / Math.PI);
    const tether = existing ?? document.createElement("div");

    tether.className = "selection-tether";
    tether.style.left = `${startX}px`;
    tether.style.top = `${startY}px`;
    tether.style.width = `${length}px`;
    tether.style.transform = `rotate(${angle}deg)`;

    if (!existing) {
      elements.fxLayer.append(tether);
    }
  }

  elements.buyUnitButton.addEventListener("click", () => {
    const result = buyUnit(state);
    state.fortress.message = result.reason;
    onStateChanged();
  });

  elements.massMergeButton.addEventListener("click", () => {
    const result = massMergeReserve(state);
    state.fortress.message = result.reason;
    clearSelectedUnit();
    onStateChanged();
  });

  elements.grantResourcesButton.addEventListener("click", () => {
    for (const resourceKey of resourceOrder) {
      state.resources[resourceKey] = (state.resources[resourceKey] ?? 0) + 1000;
    }
    state.fortress.message = "Cheat: +1000 to every resource.";
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

  elements.runEndRestartButton.addEventListener("click", () => {
    window.location.reload();
  });

  elements.fortressFightButton.addEventListener("click", () => {
    const result = startFortressBattle(state);
    state.fortress.message = result.reason;
    state.ui.fortressPopup = null;
    onStateChanged();
  });

  function showScreen(screen) {
    state.fortress.screen = screen;
    elements.screenDeck.classList.toggle("show-top", screen === "top");
    elements.screenDeck.classList.toggle("show-bottom", screen !== "top");
  }

  elements.showFortressButton.addEventListener("click", () => {
    showScreen("top");
    onStateChanged();
  });

  elements.showProductionButton.addEventListener("click", () => {
    showScreen("bottom");
    onStateChanged();
  });

  let swipeStartY = 0;
  let swipeStartX = 0;
  let swipeStartScreen = null;
  let swipeStartAtTop = false;
  let swipeStartAtBottom = false;

  function getVisibleScreenElement() {
    return state.fortress.screen === "top"
      ? document.querySelector("#fortressScreen")
      : document.querySelector("#productionScreen");
  }

  elements.screenDeck.addEventListener("pointerdown", (event) => {
    swipeStartY = event.clientY;
    swipeStartX = event.clientX;
    const visible = getVisibleScreenElement();
    swipeStartScreen = state.fortress.screen;
    const scrollTop = visible?.scrollTop ?? 0;
    const scrollHeight = visible?.scrollHeight ?? 0;
    const clientHeight = visible?.clientHeight ?? 0;
    swipeStartAtTop = scrollTop <= 1;
    swipeStartAtBottom = scrollTop + clientHeight >= scrollHeight - 1;
  });

  elements.screenDeck.addEventListener("pointerup", (event) => {
    const dy = event.clientY - swipeStartY;
    const dx = event.clientX - swipeStartX;
    if (Math.abs(dy) < window.innerHeight * 0.14 || Math.abs(dy) < Math.abs(dx)) {
      return;
    }
    // Swipe DOWN at top edge → reveal screen above.
    if (dy > 0 && swipeStartAtTop && swipeStartScreen === "bottom") {
      showScreen("top");
      onStateChanged();
      return;
    }
    // Swipe UP at bottom edge → reveal screen below.
    if (dy < 0 && swipeStartAtBottom && swipeStartScreen === "top") {
      showScreen("bottom");
      onStateChanged();
    }
  });

  function renderReserve() {
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
          state.fortress.message = result.reason;
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
        state.fortress.message = result.reason;
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

  function renderMines() {
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
            state.fortress.message = result.reason;
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
              state.fortress.message = result.reason;
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
              state.fortress.message = result.reason;
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

      elements.minesGrid.append(card);
    }
  }

  function getFortressBuildingForTile(tile) {
    if (!tile.occupant || tile.occupant === "obstacle") {
      return null;
    }
    return state.fortress.buildings.find((building) => building.id === tile.occupant.buildingId) ?? null;
  }

  function isFortressBuildingOrigin(building, tile) {
    const minX = Math.min(...building.tiles.map((item) => item.x));
    const minY = Math.min(...building.tiles.map((item) => item.y));
    return tile.x === minX && tile.y === minY;
  }

  function getFortressBuildingBounds(building) {
    const minX = Math.min(...building.tiles.map((item) => item.x));
    const maxX = Math.max(...building.tiles.map((item) => item.x));
    const minY = Math.min(...building.tiles.map((item) => item.y));
    const maxY = Math.max(...building.tiles.map((item) => item.y));
    return {
      minX,
      minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    };
  }

  function isFortressBuildingSolid(building, bounds) {
    return building.tiles.length === bounds.width * bounds.height;
  }

  function renderFortressBuildingShape(building, bounds) {
    return `
      <span
        class="fortress-building-shape"
        style="grid-template-columns: repeat(${bounds.width}, minmax(0, 1fr)); grid-template-rows: repeat(${bounds.height}, minmax(0, 1fr));"
        aria-hidden="true"
      >
        ${building.tiles.map((buildingTile) => `
          <span
            class="fortress-building-shape-cell"
            style="grid-column:${buildingTile.x - bounds.minX + 1}; grid-row:${buildingTile.y - bounds.minY + 1};"
          ></span>
        `).join("")}
      </span>
    `;
  }

  function renderFortressCost(costs) {
    const entries = Object.entries(costs ?? {}).filter(([, amount]) => amount > 0);
    if (entries.length === 0) {
      return '<span class="gear-cost-free">Free</span>';
    }
    return entries.map(([resourceKey, amount]) => `
      <span class="gear-cost-pill gear-cost-${resourceKey}">
        ${getResourceIconMarkup(resourceKey, "gear-cost-icon")}
        <span>${formatNumber(amount)}</span>
      </span>
    `).join("");
  }

  function renderFortressField() {
    elements.fortressField.innerHTML = "";
    elements.fortressField.classList.toggle("is-battle-active", state.fortress.battle.active);
    if (state.fortress.battle.active) {
      state.ui.fortressPopup = null;
    }

    for (const tile of state.fortress.field) {
      const building = getFortressBuildingForTile(tile);
      const buildingBounds = building ? getFortressBuildingBounds(building) : null;
      const isSolidBuilding = building && buildingBounds && isFortressBuildingSolid(building, buildingBounds);

      const isBuildingOrigin = building && isFortressBuildingOrigin(building, tile);
      if (building && !isBuildingOrigin) {
        continue;
      }

      const tileButton = document.createElement("button");
      tileButton.type = "button";
      tileButton.className = "fortress-tile";
      tileButton.dataset.x = String(tile.x);
      tileButton.dataset.y = String(tile.y);
      tileButton.style.gridColumnStart = String(tile.x + 1);
      tileButton.style.gridRowStart = String(tile.y + 1);
      if (building && buildingBounds) {
        if (buildingBounds.width > 1) tileButton.style.gridColumnEnd = `span ${buildingBounds.width}`;
        if (buildingBounds.height > 1) tileButton.style.gridRowEnd = `span ${buildingBounds.height}`;
      }

      if (tile.occupant === "obstacle") {
        tileButton.classList.add("is-obstacle");
        tileButton.innerHTML = `
          <span class="fortress-tile-icon">🌲</span>
        `;
        tileButton.addEventListener("click", () => {
          state.ui.fortressPopup = { kind: "obstacle", x: tile.x, y: tile.y };
          onStateChanged();
        });
      } else if (building && isBuildingOrigin) {
        const definition = CONFIG.fortressBuildings[building.type];
        tileButton.classList.add("is-building", `building-${building.type}`);
        if (!isSolidBuilding) {
          tileButton.classList.add("is-shaped-building");
        }
        tileButton.classList.toggle("is-damaged", building.hp > 0 && building.hp < building.maxHp);
        tileButton.classList.toggle("is-destroyed", building.hp <= 0);
        tileButton.innerHTML = `
          ${isSolidBuilding ? "" : renderFortressBuildingShape(building, buildingBounds)}
          <span class="fortress-tile-icon">${definition.icon}</span>
          <strong>${definition.name}</strong>
          <small>Lv ${building.level} · HP ${Math.round(building.hp)}/${building.maxHp}</small>
        `;
        tileButton.addEventListener("click", () => {
          if (state.fortress.movingBuildingId === building.id) {
            state.fortress.movingBuildingId = null;
            state.ui.fortressPopup = null;
            state.fortress.message = "Move cancelled.";
          } else {
            state.ui.fortressPopup = { kind: "building", buildingId: building.id, x: tile.x, y: tile.y };
          }
          onStateChanged();
        });

      } else {
        const movingBuilding = state.fortress.buildings.find((item) => item.id === state.fortress.movingBuildingId);
        if (movingBuilding) {
          const canMove = canPlaceFortressBuilding(state, movingBuilding.type, tile, movingBuilding.id);
          tileButton.classList.add(canMove ? "is-valid-target" : "is-invalid-target");
          tileButton.disabled = !canMove;
          tileButton.addEventListener("click", () => {
            const result = moveFortressBuilding(state, movingBuilding.id, tile);
            state.fortress.message = result.reason;
            state.fortress.movingBuildingId = null;
            onStateChanged();
          });
        } else {
          tileButton.innerHTML = '<span class="fortress-tile-empty">+</span>';
        }
      }

      elements.fortressField.append(tileButton);
    }

    renderFortressPopup();

    for (const enemy of state.fortress.battle.enemies) {
      const token = document.createElement("div");
      token.className = "fortress-actor fortress-enemy";
      token.style.setProperty("--x", enemy.x);
      token.style.setProperty("--y", enemy.y);
      token.innerHTML = `<span>${enemy.icon}</span><i style="width:${Math.max(0, enemy.hp / enemy.maxHp) * 100}%"></i>`;
      elements.fortressField.append(token);
    }

    for (const ally of state.fortress.battle.allies) {
      const token = document.createElement("div");
      token.className = "fortress-actor fortress-ally";
      token.style.setProperty("--x", ally.x);
      token.style.setProperty("--y", ally.y);
      token.innerHTML = `<span>${ally.icon}</span><i style="width:${Math.max(0, ally.hp / ally.maxHp) * 100}%"></i>`;
      elements.fortressField.append(token);
    }

    for (const projectile of state.fortress.battle.projectiles) {
      const shot = document.createElement("div");
      shot.className = `fortress-projectile projectile-${projectile.type}`;
      shot.style.setProperty("--x", projectile.x);
      shot.style.setProperty("--y", projectile.y);
      elements.fortressField.append(shot);
    }
  }

  function closeFortressPopup() {
    state.ui.fortressPopup = null;
  }

  function renderFortressPopup() {
    const popupState = state.ui.fortressPopup;
    if (!popupState || state.fortress.battle.active) {
      return;
    }

    const popup = document.createElement("div");
    popup.className = "fortress-action-popover";
    popup.style.setProperty("--x", popupState.x + 0.5);
    popup.style.setProperty("--y", popupState.y + 0.5);

    if (popupState.kind === "obstacle") {
      const canClear = (state.resources.gold ?? 0) >= state.fortress.obstacleRemovalCost;
      popup.innerHTML = `
        <button class="fortress-popover-action primary-action" type="button" ${canClear ? "" : "disabled"}>
          Clear ${state.fortress.obstacleRemovalCost} Gold
        </button>
        <button class="fortress-popover-action" type="button" data-popup-close>Close</button>
      `;
      popup.querySelector(".primary-action").addEventListener("click", () => {
        const result = removeFortressObstacle(state, popupState.x, popupState.y);
        state.fortress.message = result.reason;
        closeFortressPopup();
        onStateChanged();
      });
    } else if (popupState.kind === "building") {
      const building = state.fortress.buildings.find((item) => item.id === popupState.buildingId);
      if (!building) {
        closeFortressPopup();
        return;
      }
      const definition = CONFIG.fortressBuildings[building.type];
      const currentLevel = definition.levels[building.level - 1];
      const nextLevel = definition.levels[building.level];
      const upgradeCost = currentLevel?.upgradeCost ?? {};
      const canUpgrade = nextLevel && canAffordResources(state.resources, upgradeCost);
      popup.innerHTML = `
        <strong>${definition.name} Lv ${building.level}</strong>
        ${nextLevel ? `
          <button class="fortress-popover-action primary-action" type="button" ${canUpgrade ? "" : "disabled"}>
            Upgrade ${renderFortressCost(upgradeCost)}
          </button>
        ` : `<span class="fortress-popover-note">Max level</span>`}
        <button class="fortress-popover-action" type="button" data-popup-move ${building.type === "hq" ? "disabled" : ""}>Move</button>
        <button class="fortress-popover-action" type="button" data-popup-close>Close</button>
      `;

      popup.querySelector(".primary-action")?.addEventListener("click", () => {
        const result = upgradeFortressBuilding(state, building.id);
        state.fortress.message = result.reason;
        closeFortressPopup();
        onStateChanged();
      });
      popup.querySelector("[data-popup-move]")?.addEventListener("click", () => {
        state.fortress.movingBuildingId = building.id;
        state.fortress.message = "Tap a valid free tile to move this building.";
        closeFortressPopup();
        onStateChanged();
      });
    }

    popup.querySelector("[data-popup-close]")?.addEventListener("click", () => {
      closeFortressPopup();
      onStateChanged();
    });
    elements.fortressField.append(popup);
  }

  function buildFortressShopCard(type, definition) {
    const isUnlocked = state.fortress.unlockedBuildingTypes.includes(type);
    const buyCost = getFortressBuildingBuyCost(state, type);
    const hasSpace = Boolean(findFortressPlacement(state, type));
    const canBuy = isUnlocked && hasSpace && canAffordResources(state.resources, buyCost);
    const card = document.createElement("article");
    card.className = `fortress-shop-card ${isUnlocked ? "" : "is-locked"} ${!hasSpace ? "has-no-space" : ""}`;
    card.tabIndex = canBuy ? 0 : -1;
    card.innerHTML = `
      <div class="fortress-shop-icon">${definition.icon}</div>
      <strong>${definition.name}</strong>
      <div class="fortress-shop-cost">${renderFortressCost(buyCost)}</div>
      <button class="secondary-button" type="button">${isUnlocked ? (hasSpace ? "Buy" : "No Space") : "Locked"}</button>
    `;
    const button = card.querySelector("button");
    button.disabled = !canBuy;
    const buy = () => {
      if (!canBuy) {
        return;
      }
      const result = buyFortressBuilding(state, type);
      state.fortress.message = result.reason;
      onStateChanged();
    };
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      buy();
    });
    card.addEventListener("click", buy);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        buy();
      }
    });
    return card;
  }

  let isProgrammaticScroll = false;

  function renderFortressShop() {
    const shop = elements.fortressShop;
    const prevScroll = shop.scrollLeft;
    const wasEmpty = shop.childElementCount === 0;
    shop.innerHTML = "";

    const types = Object.entries(CONFIG.fortressBuildings).filter(([type]) => type !== "hq");
    const copies = 3;
    for (let copy = 0; copy < copies; copy += 1) {
      for (const [type, definition] of types) {
        const card = buildFortressShopCard(type, definition);
        card.dataset.shopCopy = String(copy);
        shop.append(card);
      }
    }

    requestAnimationFrame(() => {
      const blockWidth = shop.scrollWidth / copies;
      // Пропускаем собственную коррекцию, чтобы обработчик не вмешивался
      isProgrammaticScroll = true;
      if (wasEmpty || prevScroll <= 0) {
        shop.scrollLeft = blockWidth;
      } else {
        shop.scrollLeft = prevScroll;
      }
      // Даём браузеру применить изменение, затем снимаем флаг
      requestAnimationFrame(() => {
        isProgrammaticScroll = false;
      });
    });
  }

  function setupFortressShopLoop() {
    const shop = elements.fortressShop;
    if (shop.dataset.loopBound === "1") return;
    shop.dataset.loopBound = "1";

    shop.addEventListener("scroll", () => {
      if (isProgrammaticScroll) return;   // защита от рекурсии
      if (shop.childElementCount === 0) return;

      const blockWidth = shop.scrollWidth / 3;
      if (shop.scrollLeft < blockWidth * 0.5) {
        isProgrammaticScroll = true;
        shop.scrollLeft += blockWidth;
        requestAnimationFrame(() => { isProgrammaticScroll = false; });
      } else if (shop.scrollLeft > blockWidth * 2.5) {
        isProgrammaticScroll = true;
        shop.scrollLeft -= blockWidth;
        requestAnimationFrame(() => { isProgrammaticScroll = false; });
      }
    }, { passive: true });
  }
  setupFortressShopLoop();

  function renderUpgradeChoices() {
    const choices = state.fortress.pendingUpgradeChoices ?? [];
    elements.upgradeOverlay.hidden = choices.length === 0;
    elements.upgradeChoices.innerHTML = "";

    for (const choice of choices) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "upgrade-choice-card";
      card.innerHTML = `
        <strong>${choice.title}</strong>
        <span>${choice.description}</span>
      `;
      card.addEventListener("click", () => {
        const result = applyUpgradeChoice(state, choice.id);
        state.fortress.message = result.reason;
        onStateChanged();
      });
      elements.upgradeChoices.append(card);
    }
  }

  function renderEconomyMeta() {
    for (const resourceKey of resourceOrder) {
      resourceValueMap.get(resourceKey).textContent = formatNumber(state.resources[resourceKey] ?? 0);
      fortressResourceValueMap.get(resourceKey).textContent = formatNumber(state.resources[resourceKey] ?? 0);
    }
    const buyCost = formatNumber(getUnitBuyCost(state));
    if (elements.buyCostValue) {
      elements.buyCostValue.textContent = buyCost;
    }
    elements.buyUnitButton.innerHTML = `Buy Worker <span class="button-cost">${buyCost} Gold</span>`;
  }

  function renderBattleMeta() {
    elements.waveValue.textContent = `${state.fortress.waveNumber} / ${CONFIG.fortressWaves.length}`;
    elements.fortressWaveValue.textContent = `${state.fortress.waveNumber} / ${CONFIG.fortressWaves.length}`;
  }

  function renderSelectedUnitMeta() {
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
      ? "Tap empty slot to move, Worker Pile to return, or another worker to merge."
      : "Tap mine slot or matching worker.";
  }

  function renderActionHints() {
    const selected = getSelectedUnitContext();
    elements.selectedUnitChip.classList.toggle("is-selected", Boolean(selected));
    if (!selected) {
      elements.selectedUnitChip.classList.remove("is-selected");
    }
  }

  function renderMineProgressFrame() {
    const collectionInterval = Math.max(0.001, CONFIG.mine.collectionIntervalSeconds ?? 1);
    const passiveInterval = Math.max(0.001, CONFIG.passiveGoldPayoutIntervalSeconds ?? 1);

    for (const mine of state.mines) {
      if (!mine.isUnlocked) {
        continue;
      }

      const passiveFill = elements.minesGrid.querySelector(`[data-mine-passive-fill="${mine.id}"]`);
      if (passiveFill) {
        const passiveProgress = Math.min(1, (mine.passiveProgress ?? 0) / passiveInterval);
        const cacheKey = `${mine.id}:passive`;
        const previousProgress = mineProgressCache.get(cacheKey) ?? passiveProgress;
        const isPassiveReset = passiveProgress < previousProgress;
        if (isPassiveReset) {
          passiveFill.classList.add("is-resetting");
        } else {
          passiveFill.classList.remove("is-resetting");
        }
        passiveFill.style.width = `${passiveProgress * 100}%`;
        mineProgressCache.set(cacheKey, passiveProgress);
        if (isPassiveReset) {
          requestAnimationFrame(() => passiveFill.classList.remove("is-resetting"));
        }
      }

      const openSlots = getMineLevelData(mine.level)?.slots ?? 0;
      for (let index = 0; index < openSlots; index += 1) {
        if (!mine.workerIds[index]) {
          continue;
        }

        const fill = elements.minesGrid.querySelector(`[data-mine-progress-fill="${mine.id}:${index}"]`);
        if (!fill) {
          continue;
        }

        const progress = Math.min(1, (mine.workerProgress[index] ?? 0) / collectionInterval);
        const progressKey = `${mine.id}:${index}`;
        const previousProgress = mineProgressCache.get(progressKey) ?? progress;
        const isReset = progress < previousProgress;

        if (isReset) {
          fill.classList.add("is-resetting");
        } else {
          fill.classList.remove("is-resetting");
        }

        fill.style.width = `${progress * 100}%`;
        mineProgressCache.set(progressKey, progress);

        if (isReset) {
          requestAnimationFrame(() => {
            fill.classList.remove("is-resetting");
          });
        }
      }
    }
  }

  function flushResourceBursts() {
    const handled = new Set(state.ui.handledResourceBurstIds);

    for (const burst of state.resourceBursts) {
      if (handled.has(burst.id)) {
        continue;
      }
      handled.add(burst.id);
      playResourceBurst(elements, burst);
    }

    state.ui.handledResourceBurstIds = [...handled].slice(-160);
    if (state.resourceBursts.length > 80) {
      state.resourceBursts = state.resourceBursts.slice(-80);
    }
  }

  function renderMeta() {
    showScreen(state.fortress.screen);
    document.body.classList.toggle("fortress-battle-active", state.fortress.battle.active);
    elements.fortressFightButton.disabled = state.fortress.battle.active || state.game.isOver;
    elements.fortressMessage.textContent = state.fortress.message;
    renderEconomyMeta();
    renderBattleMeta();
    renderSelectedUnitMeta();
    renderActionHints();
    elements.cheatPanel.hidden = !state.ui.isCheatsOpen;
    renderVictoryState();
    renderFortressField();
    renderFortressShop();
    renderUpgradeChoices();
  }

  function renderVictoryState() {
    elements.runEndOverlay.hidden = state.game.result !== "win";
    elements.runEndTitle.textContent = "Prototype Complete";
    elements.runEndText.textContent = "The fortress survived every wave.";
    document.body.classList.toggle("state-win", state.game.result === "win");
  }

  function render() {
    renderMeta();
    renderReserve();
    renderMines();
    renderMineProgressFrame();
    updateSelectionTether();
    flushResourceBursts();
  }

  function renderFrame() {
    document.body.classList.toggle("fortress-battle-active", state.fortress.battle.active);
    renderEconomyMeta();
    renderBattleMeta();
    elements.fortressFightButton.disabled = state.fortress.battle.active || state.game.isOver;
    elements.fortressMessage.textContent = state.fortress.message;
    renderFortressField();
    renderUpgradeChoices();
    renderMineProgressFrame();
    renderActionHints();
    renderVictoryState();
    updateSelectionTether();
    flushResourceBursts();
  }

  return { render, renderFrame };
}



