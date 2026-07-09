import {
  CONFIG,
  getClassConfig,
  getResourceIcon,
  getResourceLabel
} from "../config.js";
import { formatNumber } from "../utils.js";

export function getResourceIconMarkup(resourceKey, extraClass = "") {
  const icon = getResourceIcon(resourceKey);
  const suffix = extraClass ? ` ${extraClass}` : "";
  if (icon) {
    return `<span class="resource-icon resource-icon-emoji${suffix}" aria-hidden="true">${icon}</span>`;
  }
  return `<span class="resource-icon resource-icon-${resourceKey}${suffix}" aria-hidden="true"></span>`;
}

export function createUnitCard(unit, options = {}) {
  const {
    origin = "reserve",
    draggable = false,
    compact = false
  } = options;

  const card = document.createElement("article");
  card.className = `unit-card ${origin}-card${compact ? " compact-card" : ""}`;
  card.dataset.unitId = unit.id;
  card.draggable = draggable;

  const health = unit.maxHealth ?? unit.baseHealth ?? unit.health ?? 0;
  const attack = unit.attack ?? unit.baseAttack ?? 0;
  const level = unit.level ?? 1;
  const visualGear = unit.class ?? (origin === "enemy" ? "enemy" : "worker");
  const className = unit.class ? (getClassConfig(unit.class)?.name ?? "") : "";
  const icon = unit.icon ?? "🚧";
  const classIcon = unit.classIcon ?? "";

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
        ${classIcon ? `<span class="unit-icon-gear">${classIcon}</span>` : ""}
      </div>
      <div class="unit-shadow"></div>
    </div>
    <div class="unit-ui">
      <div class="unit-name">${unit.name}</div>
      <span class="unit-meta">ATK ${Math.round(attack)} | HP ${Math.round(health)}</span>
      ${className ? `<span class="unit-gear">${className}</span>` : ""}
    </div>
    ${compact ? `<span class="compact-caption">ATK ${Math.round(attack)} | HP ${Math.round(health)}</span>` : ""}
  `;

  return card;
}

export function createMineProgressMarkup(resourceKey, mineId, slotIndex, progress) {
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

export function appendTokenHealth(card, currentHealth, maxHealth) {
  const hp = document.createElement("div");
  hp.className = "token-health";
  hp.innerHTML = `<div class="token-health-bar" style="width:${(Math.max(0, currentHealth) / maxHealth) * 100}%"></div>`;
  card.append(hp);
}

export function formatCosts(costs) {
  return Object.entries(costs ?? {})
    .map(([resourceKey, amount]) => `${getResourceLabel(resourceKey)} ${amount}`)
    .join(" | ");
}

export function renderCostMarkup(costs) {
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

export function canAffordCosts(resources, costs) {
  return Object.entries(costs ?? {}).every(([resourceKey, amount]) => (resources[resourceKey] ?? 0) >= amount);
}

export function playResourceBurst(elements, burst) {
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
