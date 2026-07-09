import { CONFIG, getUnitLevelData } from "../config.js";
import { stageUnitOnBridgehead } from "../systems/garrisonSystem.js";
import { canAffordCosts, renderCostMarkup } from "./helpers.js";

// Row chosen inside the modal for the unit being staged. Resets on open.
let selectedRow = "front";

export function isClassModalOpen(ctx) {
  return !ctx.elements.classModal.hidden;
}

export function closeClassModal(ctx) {
  ctx.elements.classModal.hidden = true;
  ctx.elements.classModal.dataset.unitId = "";
}

export function openClassModal(ctx, unit) {
  selectedRow = "front";
  ctx.elements.classModal.dataset.unitId = unit.id;
  renderClassModal(ctx, unit);
  ctx.elements.classModal.hidden = false;
}

function syncRowToggle(ctx) {
  ctx.elements.classModal.querySelectorAll("[data-modal-row]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.modalRow === selectedRow);
  });
}

export function renderClassModal(ctx, unit) {
  const { elements, state } = ctx;
  const levelData = getUnitLevelData(unit.level);

  elements.classModalTitle.textContent = `Класс для «${unit.name}» · ур.${unit.level}`;
  syncRowToggle(ctx);

  const grid = elements.classModalGrid;
  grid.innerHTML = "";

  for (const [classId, cfg] of Object.entries(CONFIG.classes ?? {})) {
    const minLevel = cfg.minLevel ?? 1;
    const levelLocked = unit.level < minLevel;
    const costs = cfg.costs ?? {};
    const affordable = canAffordCosts(state.resources, costs);
    const disabled = levelLocked || !affordable;

    const hp = Math.round((levelData?.baseHealth ?? 0) * (cfg.healthMult ?? 1));
    const atk = Math.round((levelData?.baseAttack ?? 0) * (cfg.attackMult ?? 1));

    const card = document.createElement("button");
    card.type = "button";
    card.className = "class-card";
    card.classList.toggle("is-locked", levelLocked);
    card.classList.toggle("is-unaffordable", !levelLocked && !affordable);
    card.disabled = disabled;
    card.dataset.classId = classId;

    const badge = levelLocked
      ? `<span class="class-card-flag">нужен ур.${minLevel}</span>`
      : (!affordable ? `<span class="class-card-flag">не хватает ресурсов</span>` : "");

    card.innerHTML = `
      <div class="class-card-head">
        <span class="class-card-icon">${cfg.icon ?? "❓"}</span>
        <span class="class-card-name">${cfg.name}</span>
        <span class="class-card-tier">ур.${minLevel}+</span>
      </div>
      <div class="class-card-stats">HP ${hp} · ATK ${atk}</div>
      <div class="class-card-cost">${renderCostMarkup(costs)}</div>
      <div class="class-card-desc">${cfg.description ?? ""}</div>
      ${badge}
    `;

    if (!disabled) {
      card.addEventListener("click", () => {
        const result = stageUnitOnBridgehead(state, unit.id, classId, selectedRow);
        state.battle.log = result.reason;
        if (result.ok) {
          ctx.selection.clearSelectedUnit();
          closeClassModal(ctx);
        }
        ctx.onStateChanged();
      });
    }

    grid.append(card);
  }
}

export function setupClassModal(ctx) {
  const { elements } = ctx;

  elements.classModal.querySelectorAll("[data-modal-row]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedRow = btn.dataset.modalRow === "back" ? "back" : "front";
      syncRowToggle(ctx);
    });
  });

  elements.classModalClose.addEventListener("click", () => closeClassModal(ctx));

  elements.classModal.addEventListener("click", (event) => {
    if (event.target === elements.classModal) {
      closeClassModal(ctx);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.classModal.hidden) {
      closeClassModal(ctx);
    }
  });
}
