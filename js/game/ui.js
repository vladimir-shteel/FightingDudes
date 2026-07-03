import {
  CONFIG,
  getArmorConfig,
  getMineLevelData,
  getMineMaxLevel,
  getResourceIcon,
  getResourceLabel,
  getWeaponConfig
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
import { sendBridgeheadToBattle, stageUnitOnBridgehead } from "./systems/garrisonSystem.js";
import { getBattleSummary } from "./systems/battleSystem.js";
import { acceptMerchantOffer } from "./systems/merchantSystem.js";

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

  const weapon = unit.weaponKey ? getWeaponConfig(unit.weaponKey) : null;
  const armor = unit.armorKey ? getArmorConfig(unit.armorKey) : null;
  const health = unit.maxHealth ?? unit.baseHealth ?? unit.health ?? 0;
  const attack = unit.attack ?? unit.baseAttack ?? 0;
  const level = unit.level ?? 1;
  const visualGear = unit.weaponKey ?? (origin === "enemy" ? "enemy" : "worker");
  const armorText = armor?.label ?? "No armor";
  const icon = unit.icon ?? "🚧";
  const weaponIcon = unit.weaponIcon ?? weapon?.icon ?? "";

  card.dataset.gear = visualGear;
  card.dataset.level = String(level);
  card.dataset.hit = unit.hitUntil && unit.hitUntil > performance.now() / 1000 ? "true" : "false";

  card.innerHTML = `
    <div class="unit-badges">
      <span class="unit-level-badge">${level}</span>
    </div>
    <div class="unit-character" aria-hidden="true">
      <div class="unit-icon">
        <span class="unit-icon-main">${icon}</span>
        ${weaponIcon ? `<span class="unit-icon-gear">${weaponIcon}</span>` : ""}
      </div>
      <div class="unit-shadow"></div>
    </div>
    <div class="unit-ui">
      <div class="unit-name">${unit.name}</div>
      <span class="unit-meta">ATK ${Math.round(attack)} | HP ${Math.round(health)}</span>
      <span class="unit-gear">${armorText}</span>
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

function appendTokenHealth(card, currentHealth, maxHealth) {
  const hp = document.createElement("div");
  hp.className = "token-health";
  hp.innerHTML = `<div class="token-health-bar" style="width:${(Math.max(0, currentHealth) / maxHealth) * 100}%"></div>`;
  card.append(hp);
}

function formatCosts(costs) {
  return Object.entries(costs ?? {})
    .map(([resourceKey, amount]) => `${getResourceLabel(resourceKey)} ${amount}`)
    .join(" | ");
}

function getCombinedCosts(weapon, armor) {
  const combinedCosts = {};

  for (const [resourceKey, amount] of Object.entries(weapon?.costs ?? {})) {
    combinedCosts[resourceKey] = (combinedCosts[resourceKey] ?? 0) + amount;
  }

  for (const [resourceKey, amount] of Object.entries(armor?.costs ?? {})) {
    combinedCosts[resourceKey] = (combinedCosts[resourceKey] ?? 0) + amount;
  }

  return combinedCosts;
}

function renderCostMarkup(costs) {
  const entries = Object.entries(costs ?? {});
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

function renderResourceSetMarkup(resources) {
  return Object.entries(resources ?? {}).map(([resourceKey, amount]) => `
    <span class="gear-cost-pill gear-cost-${resourceKey}">
      ${getResourceIconMarkup(resourceKey, "gear-cost-icon")}
      <span>${formatNumber(amount)}</span>
    </span>
  `).join("");
}

function canAffordCosts(resources, costs) {
  return Object.entries(costs ?? {}).every(([resourceKey, amount]) => (resources[resourceKey] ?? 0) >= amount);
}

function getSelectedLoadoutCosts(state) {
  const weapon = getWeaponConfig(state.ui.selectedWeaponKey);
  const armor = getArmorConfig(state.ui.selectedArmorKey);
  return weapon && armor ? getCombinedCosts(weapon, armor) : null;
}

function playResourceBurst(elements, burst) {
  let startX;
  let startY;

  if (burst.battlefield && elements.battlefield) {
    const fieldRect = elements.battlefield.getBoundingClientRect();
    const px = fieldRect.left + (burst.battlefield.x / CONFIG.battle.fieldWidth) * fieldRect.width;
    const py = fieldRect.top + (burst.battlefield.y / CONFIG.battle.fieldHeight) * fieldRect.height;
    startX = px;
    startY = py;
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

    const target = elements.resourceList.querySelector(`[data-resource-chip="${payout.resourceKey}"]`);
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
    battleSummary: document.querySelector("#battleSummary"),
    battleTimer: document.querySelector("#battleTimer"),
    castleHealth: document.querySelector("#castleHealth"),
    castleHealthBar: document.querySelector("#castleHealthBar"),
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
    weaponCostInfo: document.querySelector("#weaponCostInfo"),
    armorCostInfo: document.querySelector("#armorCostInfo"),
    gearTotalCostInfo: document.querySelector("#gearTotalCostInfo"),
    weaponSelect: document.querySelector("#weaponSelect"),
    armorSelect: document.querySelector("#armorSelect"),
    buyUnitButton: document.querySelector("#buyUnitButton"),
    massMergeButton: document.querySelector("#massMergeButton"),
    restartButton: document.querySelector("#restartButton"),
    castleSprite: document.querySelector("#castleSprite"),
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

  elements.weaponSelect.innerHTML = "";
  for (const [weaponKey, weapon] of Object.entries(CONFIG.equipment.weapons ?? {})) {
    const option = document.createElement("option");
    option.value = weaponKey;
    option.textContent = weapon.icon ? `${weapon.icon}  ${weapon.label}` : weapon.label;
    elements.weaponSelect.append(option);
  }

  elements.armorSelect.innerHTML = "";
  for (const [armorKey, armor] of Object.entries(CONFIG.equipment.armors ?? {})) {
    const option = document.createElement("option");
    option.value = armorKey;
    option.textContent = armor.icon ? `${armor.icon}  ${armor.label}` : armor.label;
    elements.armorSelect.append(option);
  }

  elements.weaponSelect.value = state.ui.selectedWeaponKey;
  elements.armorSelect.value = state.ui.selectedArmorKey;

  const merchantPanel = document.createElement("div");
  merchantPanel.className = "merchant-panel";
  elements.garrisonDropzone.insertAdjacentElement("afterend", merchantPanel);

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

  elements.weaponSelect.addEventListener("change", () => {
    state.ui.selectedWeaponKey = elements.weaponSelect.value;
    state.battle.log = `Selected weapon: ${getWeaponConfig(state.ui.selectedWeaponKey)?.label}.`;
    onStateChanged();
  });

  elements.armorSelect.addEventListener("change", () => {
    state.ui.selectedArmorKey = elements.armorSelect.value;
    state.battle.log = `Selected armor: ${getArmorConfig(state.ui.selectedArmorKey)?.label}.`;
    onStateChanged();
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

  function renderBattle() {
    const castleRatio = state.castle.health / state.castle.maxHealth;
    elements.castleHealth.textContent = `${formatNumber(state.castle.health)}/${formatNumber(state.castle.maxHealth)}`;
    elements.castleHealthBar.style.width = `${castleRatio * 100}%`;
    elements.battleLog.textContent = state.battle.log;
    elements.castleSprite.classList.toggle("is-hit", (state.castle.hitUntil ?? 0) > performance.now() / 1000);

    elements.battleUnits.innerHTML = "";
    for (const unit of state.battleUnits) {
      const card = createUnitCard(unit, { origin: "battle" });
      card.classList.add("battle-token");
      card.classList.toggle("is-engaged", unit.state === "engaged");
      card.classList.toggle("is-hit", (unit.hitUntil ?? 0) > performance.now() / 1000);
      card.dataset.state = unit.state ?? "marching";
      card.style.left = `${unit.x}%`;
      card.style.top = `${((unit.y ?? (CONFIG.battle.fieldHeight / 2)) / CONFIG.battle.fieldHeight) * 100}%`;

      const meta = document.createElement("span");
      meta.className = "battle-caption";
      meta.textContent = `${Math.max(0, Math.round(unit.health))}`;
      card.append(meta);
      appendTokenHealth(card, unit.health, unit.maxHealth);
      elements.battleUnits.append(card);
    }

    elements.enemyUnits.innerHTML = "";
    for (const enemy of state.enemies) {
      const card = createUnitCard(enemy, { origin: "enemy" });
      card.classList.add("battle-token");
      card.classList.toggle("is-engaged", enemy.state === "engaged");
      card.classList.toggle("is-hit", (enemy.hitUntil ?? 0) > performance.now() / 1000);
      card.dataset.state = enemy.state ?? "marching";
      card.style.left = `${enemy.x}%`;
      card.style.top = `${((enemy.y ?? (CONFIG.battle.fieldHeight / 2)) / CONFIG.battle.fieldHeight) * 100}%`;

      const meta = document.createElement("span");
      meta.className = "battle-caption";
      meta.textContent = enemy.state === "retreating"
        ? `Ret ${Math.max(0, Math.round(enemy.health))}`
        : `${Math.max(0, Math.round(enemy.health))}`;
      card.append(meta);
      appendTokenHealth(card, enemy.health, enemy.maxHealth);
      elements.enemyUnits.append(card);
    }
  }

  function renderBridgehead() {
    const maxSlots = CONFIG.bridgehead?.maxSlots ?? 8;
    elements.bridgeheadSlots.innerHTML = "";
    elements.sendBridgeheadButton.disabled = state.bridgeheadUnits.length === 0 || state.game.isOver;

    for (let index = 0; index < maxSlots; index += 1) {
      const slot = document.createElement("div");
      slot.className = `bridgehead-slot ${state.bridgeheadUnits[index] ? "is-filled" : "is-empty"}`;

      const unit = state.bridgeheadUnits[index];
      if (unit) {
        slot.append(createUnitCard(unit, { origin: "battle", compact: true }));
      } else {
        slot.innerHTML = '<span class="slot-placeholder">Empty</span>';
      }

      elements.bridgeheadSlots.append(slot);
    }
  }

  function renderEconomyMeta() {
    for (const resourceKey of resourceOrder) {
      resourceValueMap.get(resourceKey).textContent = formatNumber(state.resources[resourceKey] ?? 0);
    }
    const buyCost = formatNumber(getUnitBuyCost(state));
    if (elements.buyCostValue) {
      elements.buyCostValue.textContent = buyCost;
    }
    elements.buyUnitButton.innerHTML = `Buy Unit <span class="button-cost">${buyCost} Gold</span>`;
  }

  function renderBattleMeta() {
    const summary = getBattleSummary(state);
    elements.waveValue.textContent = `${state.battle.nextWaveIndex} / ${CONFIG.waves.length}`;
    elements.battleSummary.textContent =
      `${summary.friendlyCount} allies | ${state.bridgeheadUnits.length} staged | ${summary.enemyCount} enemies | power ${Math.round(summary.squadPower)}`;

    if (state.battle.status === "cooldown" && !state.game.isOver) {
      elements.battleTimer.textContent = `Next wave: ${Math.ceil(state.battle.waveCooldownRemaining)}s`;
    } else if (state.battle.status === "fighting") {
      elements.battleTimer.textContent = "Wave in progress";
    } else if (state.battle.status === "retreating") {
      elements.battleTimer.textContent = "Wave retreating";
    } else if (state.battle.status === "siege") {
      elements.battleTimer.textContent = "All waves cleared";
    } else if (state.game.isOver) {
      elements.battleTimer.textContent = "Run complete";
    } else {
      elements.battleTimer.textContent = "Next wave: -";
    }
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
      ? "Tap empty slot to move, Reserve to return, or Garrison to prepare."
      : "Tap mine slot, worker, or Garrison.";
  }

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

  function renderActionHints() {
    const selected = getSelectedUnitContext();
    const canDeploy = canDeploySelectedUnit();

    elements.garrisonDropzone.classList.toggle("actionable-target", Boolean(selected) && canDeploy);
    elements.garrisonDropzone.classList.toggle("is-disabled-target", Boolean(selected) && !canDeploy);
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

  function renderGearMeta() {
    elements.weaponSelect.value = state.ui.selectedWeaponKey;
    elements.armorSelect.value = state.ui.selectedArmorKey;
    const selectedWeapon = getWeaponConfig(state.ui.selectedWeaponKey);
    const selectedArmor = getArmorConfig(state.ui.selectedArmorKey);
    const totalCosts = getCombinedCosts(selectedWeapon, selectedArmor);
    elements.weaponCostInfo.innerHTML = renderCostMarkup(selectedWeapon.costs);
    elements.armorCostInfo.innerHTML = renderCostMarkup(selectedArmor.costs);
    elements.gearTotalCostInfo.innerHTML = `
      <span class="gear-total-label">Total</span>
      <span class="gear-total-pills">${renderCostMarkup(totalCosts)}</span>
    `;
    elements.gearInfo.textContent =
      `Weapon: ${selectedWeapon.label} (${formatCosts(selectedWeapon.costs) || "free"}) | ` +
      `ATK x${selectedWeapon.attackMultiplier} | speed x${selectedWeapon.attackSpeedMultiplier} | ` +
      `range ${Math.round(((CONFIG.battle.baseAttackReach ?? 0) + (selectedWeapon.attackRangeBonus ?? selectedWeapon.attackRange ?? 0)) * 10) / 10}. ` +
      `Armor: ${selectedArmor.label} (${formatCosts(selectedArmor.costs) || "free"}) | HP +${selectedArmor.healthBonus}.`;
  }

  function renderMerchant() {
    merchantPanel.hidden = !state.merchant.isActive;
    merchantPanel.innerHTML = "";
    if (!state.merchant.isActive) {
      return;
    }

    const title = document.createElement("div");
    title.className = "merchant-title";
    title.textContent = `Caravan - wave ${state.merchant.lastArrivalWave}`;
    merchantPanel.append(title);

    for (const offer of state.merchant.offers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "merchant-offer";
      button.innerHTML = `
        <span>${renderResourceSetMarkup(offer.pay)}</span>
        <strong>-></strong>
        <span>${renderResourceSetMarkup(offer.receive)}</span>
      `;
      button.addEventListener("click", () => {
        const result = acceptMerchantOffer(state, offer.key);
        state.battle.log = result.reason;
        onStateChanged();
      });
      merchantPanel.append(button);
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

  function playRangedAttackEffect(effect) {
    const rect = elements.battlefield.getBoundingClientRect();
    const startX = rect.left + (effect.fromX / CONFIG.battle.fieldWidth) * rect.width;
    const startY = rect.top + (effect.fromY / CONFIG.battle.fieldHeight) * rect.height;
    const endX = rect.left + (effect.toX / CONFIG.battle.fieldWidth) * rect.width;
    const endY = rect.top + (effect.toY / CONFIG.battle.fieldHeight) * rect.height;
    const length = Math.hypot(endX - startX, endY - startY);
    const angle = Math.atan2(endY - startY, endX - startX) * (180 / Math.PI);
    const line = document.createElement("div");

    line.className = "ranged-shot-line";
    line.style.left = `${startX}px`;
    line.style.top = `${startY}px`;
    line.style.width = `${length}px`;
    line.style.transform = `rotate(${angle}deg)`;
    elements.fxLayer.append(line);
    window.setTimeout(() => line.remove(), 220);
  }

  function flushBattleEffects() {
    const handled = new Set(state.ui.handledBattleEffectIds);

    for (const effect of state.battleEffects) {
      if (handled.has(effect.id)) {
        continue;
      }
      handled.add(effect.id);
      if (effect.type === "ranged-line") {
        playRangedAttackEffect(effect);
      }
    }

    state.ui.handledBattleEffectIds = [...handled].slice(-160);
    if (state.battleEffects.length > 80) {
      state.battleEffects = state.battleEffects.slice(-80);
    }
  }

  function renderMeta() {
    renderEconomyMeta();
    renderBattleMeta();
    renderSelectedUnitMeta();
    renderActionHints();
    renderGearMeta();
    renderMerchant();
    renderBridgehead();
    renderMerchant();
    elements.cheatPanel.hidden = !state.ui.isCheatsOpen;
    renderVictoryState();
  }

  function renderVictoryState() {
    elements.victoryOverlay.hidden = state.game.result !== "win";
    document.body.classList.toggle("state-win", state.game.result === "win");
  }

  function render() {
    renderMeta();
    renderReserve();
    renderMines();
    renderMineProgressFrame();
    renderBattle();
    renderBridgehead();
    updateSelectionTether();
    flushResourceBursts();
    flushBattleEffects();
  }

  function renderFrame() {
    renderEconomyMeta();
    renderBattleMeta();
    renderMineProgressFrame();
    renderBattle();
    renderBridgehead();
    renderActionHints();
    renderVictoryState();
    updateSelectionTether();
    flushResourceBursts();
    flushBattleEffects();
  }

  return { render, renderFrame };
}
