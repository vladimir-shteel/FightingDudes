import { CONFIG, getMineLevelData, getMineMaxLevel } from "./config.js";
import { formatNumber } from "./utils.js";
import { buyUnit, getUnitBuyCost, massMergeReserve, mergeReservePair } from "./systems/reserveSystem.js";
import { assignReserveUnitToMine, getMineUpgradeCost, returnMineUnitToReserve, upgradeMine } from "./systems/mineSystem.js";
import { deployUnitToBattle } from "./systems/garrisonSystem.js";
import { getBattleSummary } from "./systems/battleSystem.js";

function createUnitCard(unit, options = {}) {
  const {
    origin = "reserve",
    draggable = false,
    showActions = false
  } = options;

  const card = document.createElement("article");
  card.className = `unit-card ${origin}-card`;
  card.dataset.unitId = unit.id;
  card.draggable = draggable;

  const gearText = unit.gearKey ? CONFIG.equipment[unit.gearKey].label : "No gear";
  const health = unit.maxHealth ?? unit.baseHealth ?? unit.health ?? 0;
  const attack = unit.attack ?? unit.baseAttack ?? 0;
  const level = unit.level ?? 1;

  card.innerHTML = `
    <span class="unit-level">Lvl ${level}</span>
    <div class="unit-name">${unit.name}</div>
    <span class="unit-meta">ATK ${Math.round(attack)} | HP ${Math.round(health)}</span>
    <span class="unit-gear">${gearText}</span>
  `;

  if (showActions) {
    const actions = document.createElement("div");
    actions.className = "unit-actions";
    card.append(actions);
  }

  return card;
}

function makeDropTarget(element, onDropUnit) {
  element.addEventListener("dragover", (event) => {
    event.preventDefault();
    element.classList.add("drop-hover");
  });

  element.addEventListener("dragleave", () => {
    element.classList.remove("drop-hover");
  });

  element.addEventListener("drop", (event) => {
    event.preventDefault();
    element.classList.remove("drop-hover");
    const unitId = event.dataTransfer.getData("text/unit-id");
    if (unitId) {
      onDropUnit(unitId);
    }
  });
}

function appendTokenHealth(card, currentHealth, maxHealth) {
  const hp = document.createElement("div");
  hp.className = "token-health";
  hp.innerHTML = `<div class="token-health-bar" style="width:${(Math.max(0, currentHealth) / maxHealth) * 100}%"></div>`;
  card.append(hp);
}

export function mountUI(state, onStateChanged) {
  const elements = {
    goldValue: document.querySelector("#goldValue"),
    oreValue: document.querySelector("#oreValue"),
    waveValue: document.querySelector("#waveValue"),
    battleSummary: document.querySelector("#battleSummary"),
    battleTimer: document.querySelector("#battleTimer"),
    castleHealth: document.querySelector("#castleHealth"),
    castleHealthBar: document.querySelector("#castleHealthBar"),
    battleLog: document.querySelector("#battleLog"),
    buyCostValue: document.querySelector("#buyCostValue"),
    reserveZone: document.querySelector("#reserveZone"),
    minesGrid: document.querySelector("#minesGrid"),
    enemyUnits: document.querySelector("#enemyUnits"),
    battleUnits: document.querySelector("#battleUnits"),
    laneMarkers: document.querySelector("#laneMarkers"),
    garrisonDropzone: document.querySelector("#garrisonDropzone"),
    gearInfo: document.querySelector("#gearInfo"),
    buyUnitButton: document.querySelector("#buyUnitButton"),
    massMergeButton: document.querySelector("#massMergeButton"),
    restartButton: document.querySelector("#restartButton"),
    buyGearButton: document.querySelector("#buyGearButton")
  };

  elements.laneMarkers.innerHTML = "";
  for (let lane = 1; lane < CONFIG.battle.laneCount; lane += 1) {
    const marker = document.createElement("div");
    marker.className = "lane-marker";
    marker.style.top = `${(lane / CONFIG.battle.laneCount) * 100}%`;
    elements.laneMarkers.append(marker);
  }

  let mergeSelection = [];

  elements.buyUnitButton.addEventListener("click", () => {
    const result = buyUnit(state);
    state.battle.log = result.reason;
    onStateChanged();
  });

  elements.massMergeButton.addEventListener("click", () => {
    const result = massMergeReserve(state);
    state.battle.log = result.reason;
    mergeSelection = [];
    onStateChanged();
  });

  elements.restartButton.addEventListener("click", () => {
    window.location.reload();
  });

  elements.buyGearButton.addEventListener("click", () => {
    const gear = CONFIG.equipment[state.ui.selectedGearKey];
    state.battle.log = `Selected ${gear.label}. Drop a unit onto the garrison to deploy it.`;
    onStateChanged();
  });

  document.querySelectorAll(".gear-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.selectedGearKey = button.dataset.gear;
      onStateChanged();
    });
  });

  makeDropTarget(elements.garrisonDropzone, (unitId) => {
    const result = deployUnitToBattle(state, unitId);
    state.battle.log = result.reason;
    onStateChanged();
  });

  function wireDrag(card, unitId) {
    card.addEventListener("dragstart", (event) => {
      state.ui.dragUnitId = unitId;
      event.dataTransfer.setData("text/unit-id", unitId);
      event.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("dragend", () => {
      state.ui.dragUnitId = null;
    });
  }

  function renderReserve() {
    elements.reserveZone.innerHTML = "";
    for (const unit of state.reserveUnits) {
      const card = createUnitCard(unit, { origin: "reserve", draggable: true });
      wireDrag(card, unit.id);

      card.addEventListener("click", () => {
        if (mergeSelection.includes(unit.id)) {
          mergeSelection = mergeSelection.filter((id) => id !== unit.id);
        } else {
          mergeSelection.push(unit.id);
          mergeSelection = mergeSelection.slice(-2);
        }

        if (mergeSelection.length === 2) {
          const result = mergeReservePair(state, mergeSelection[0], mergeSelection[1]);
          state.battle.log = result.reason;
          mergeSelection = [];
          onStateChanged();
          return;
        }

        onStateChanged();
      });

      if (mergeSelection.includes(unit.id)) {
        card.classList.add("drop-hover");
      }

      makeDropTarget(card, (draggedUnitId) => {
        if (draggedUnitId === unit.id) {
          return;
        }
        const result = mergeReservePair(state, draggedUnitId, unit.id);
        state.battle.log = result.reason;
        mergeSelection = [];
        onStateChanged();
      });

      elements.reserveZone.append(card);
    }
  }

  function renderMines() {
    elements.minesGrid.innerHTML = "";

    for (const mine of state.mines) {
      const card = document.createElement("article");
      card.className = "mine-card";

      const upgradeCost = getMineUpgradeCost(mine);
      const openSlots = getMineLevelData(mine.level)?.slots ?? 0;
      card.innerHTML = `
        <div class="mine-head">
          <div>
            <h3>${mine.name}</h3>
            <p class="eyebrow">Level ${mine.level}</p>
          </div>
          <button class="secondary-button" data-upgrade-mine="${mine.id}">
            ${upgradeCost === null ? "Max Level" : `Upgrade (${formatNumber(upgradeCost)} ore)`}
          </button>
        </div>
        <div class="mine-stats">
          <span class="tag">Open slots: ${openSlots} / ${getMineMaxLevel()}</span>
          <span class="tag">Rate: ${mine.workerIds.slice(0, openSlots).filter(Boolean).length} workers</span>
        </div>
      `;

      const slots = document.createElement("div");
      slots.className = "mine-slots";

      for (let index = 0; index < getMineMaxLevel(); index += 1) {
        const slot = document.createElement("div");
        const isOpen = index < openSlots;
        slot.className = `slot ${isOpen ? "is-open" : "is-locked"}`;

        const worker = mine.workerIds[index];
        if (!isOpen) {
          slot.innerHTML = '<div class="slot-placeholder">Locked slot</div>';
        } else if (!worker) {
          slot.innerHTML = '<div class="slot-placeholder">Drop reserve unit here</div>';
          makeDropTarget(slot, (unitId) => {
            const result = assignReserveUnitToMine(state, unitId, mine.id, index);
            state.battle.log = result.reason;
            onStateChanged();
          });
        } else {
          const slotShell = document.createElement("div");
          slotShell.className = "slot is-open";
          const workerCard = createUnitCard(worker, { origin: "reserve", draggable: true, showActions: true });

          const backButton = document.createElement("button");
          backButton.className = "micro-button";
          backButton.textContent = "Return to reserve";
          backButton.addEventListener("click", () => {
            const result = returnMineUnitToReserve(state, mine.id, index);
            state.battle.log = result.reason;
            onStateChanged();
          });

          const deployButton = document.createElement("button");
          deployButton.className = "micro-button warn";
          deployButton.textContent = "Deploy via garrison";
          deployButton.addEventListener("click", () => {
            const result = deployUnitToBattle(state, worker.id);
            state.battle.log = result.reason;
            onStateChanged();
          });

          workerCard.querySelector(".unit-actions").append(backButton, deployButton);
          wireDrag(workerCard, worker.id);
          slotShell.append(workerCard);
          slots.append(slotShell);
          continue;
        }

        slots.append(slot);
      }

      card.append(slots);
      card.querySelector(`[data-upgrade-mine="${mine.id}"]`).addEventListener("click", () => {
        const result = upgradeMine(state, mine.id);
        state.battle.log = result.reason;
        onStateChanged();
      });

      elements.minesGrid.append(card);
    }
  }

  function renderBattle() {
    const castleRatio = state.castle.health / state.castle.maxHealth;
    elements.castleHealth.textContent = `${formatNumber(state.castle.health)} / ${formatNumber(state.castle.maxHealth)}`;
    elements.castleHealthBar.style.width = `${castleRatio * 100}%`;
    elements.battleLog.textContent = state.battle.log;

    elements.battleUnits.innerHTML = "";
    for (const unit of state.battleUnits) {
      const card = createUnitCard(unit, { origin: "battle" });
      card.classList.add("battle-token");
      card.classList.toggle("is-engaged", unit.state === "engaged");
      card.style.left = `${unit.x}%`;
      card.style.top = `${((unit.lane + 0.5) / CONFIG.battle.laneCount) * 100}%`;

      const meta = document.createElement("span");
      meta.className = "unit-meta";
      meta.textContent = `Target: ${unit.targetHint} | HP ${Math.max(0, Math.round(unit.health))}`;
      card.append(meta);
      appendTokenHealth(card, unit.health, unit.maxHealth);
      elements.battleUnits.append(card);
    }

    elements.enemyUnits.innerHTML = "";
    for (const enemy of state.enemies) {
      const card = createUnitCard(enemy, { origin: "enemy" });
      card.classList.add("battle-token");
      card.classList.toggle("is-engaged", enemy.state === "engaged");
      card.style.left = `${enemy.x}%`;
      card.style.top = `${((enemy.lane + 0.5) / CONFIG.battle.laneCount) * 100}%`;

      const meta = document.createElement("span");
      meta.className = "unit-meta";
      meta.textContent = `ATK ${Math.round(enemy.attack)} | HP ${Math.max(0, Math.round(enemy.health))}`;
      card.append(meta);
      appendTokenHealth(card, enemy.health, enemy.maxHealth);
      elements.enemyUnits.append(card);
    }
  }

  function renderMeta() {
    const summary = getBattleSummary(state);
    elements.goldValue.textContent = formatNumber(state.resources.gold);
    elements.oreValue.textContent = formatNumber(state.resources.ore);
    elements.waveValue.textContent = `${state.battle.nextWaveIndex} / ${CONFIG.waves.length}`;
    elements.buyCostValue.textContent = formatNumber(getUnitBuyCost(state));
    elements.battleSummary.textContent =
      `${summary.friendlyCount} allies | ${summary.enemyCount} enemies | power ${Math.round(summary.squadPower)}`;

    if (state.battle.status === "cooldown" && !state.game.isOver) {
      elements.battleTimer.textContent = `Next wave: ${Math.ceil(state.battle.waveCooldownRemaining)}s`;
    } else if (state.battle.status === "fighting") {
      elements.battleTimer.textContent = "Wave in progress";
    } else if (state.battle.status === "siege") {
      elements.battleTimer.textContent = "All waves cleared";
    } else if (state.game.isOver) {
      elements.battleTimer.textContent = "Run complete";
    } else {
      elements.battleTimer.textContent = "Next wave: -";
    }

    const selectedGear = CONFIG.equipment[state.ui.selectedGearKey];
    document.querySelectorAll(".gear-button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.gear === state.ui.selectedGearKey);
    });

    elements.gearInfo.textContent =
      `${selectedGear.label}: cost ${selectedGear.oreCost} ore, ` +
      `ATK x${selectedGear.attackMultiplier}, HP +${selectedGear.healthBonus}, ` +
      `speed x${selectedGear.attackSpeedMultiplier}.`;

    document.body.classList.toggle("state-win", state.game.result === "win");
  }

  function render() {
    renderMeta();
    renderReserve();
    renderMines();
    renderBattle();
  }

  return { render };
}
