import { CONFIG, getMineLevelData } from "../config.js";
import { setBridgeheadUnitRow } from "../systems/garrisonSystem.js";
import {
  appendTokenHealth,
  createUnitCard,
  playResourceBurst
} from "./helpers.js";

export function updateSelectionTether(ctx) {
  const { elements, selection } = ctx;
  const { getSelectedUnitContext } = selection;

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

function placeToken(card, entity) {
  const fieldHeight = CONFIG.battle.fieldHeight;
  const isFlying = (entity.movementType ?? "ground") === "flying";
  // Anchor the token on the ground; the flight altitude is a CSS lift applied
  // to the icon only, so the shadow stays on the ground to convey height.
  // Keep a minimum ground anchor for flyers so the lifted icon never clips the
  // top edge of the (overflow-hidden) battlefield — worst on short mobile fields.
  const rawY = entity.y ?? fieldHeight / 2;
  const renderY = isFlying ? Math.max(fieldHeight * 0.28, rawY) : rawY;
  card.style.left = `${entity.x}%`;
  card.style.top = `${(renderY / fieldHeight) * 100}%`;
  card.classList.toggle("is-flying", isFlying);
}

export function renderBattle(ctx) {
  const { state, elements } = ctx;

  elements.battleLog.textContent = state.battle.log;

  elements.battleUnits.innerHTML = "";
  for (const unit of state.battleUnits) {
    const card = createUnitCard(unit, { origin: "battle" });
    card.classList.add("battle-token");
    card.classList.toggle("is-engaged", unit.state === "engaged");
    card.classList.toggle("is-hit", (unit.hitUntil ?? 0) > performance.now() / 1000);
    card.dataset.state = unit.state ?? "marching";
    placeToken(card, unit);

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
    placeToken(card, enemy);

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

// Cache the last rendered composition so the rAF loop doesn't wipe and rebuild
// the bridgehead DOM every frame — that race destroyed the row-toggle button
// between mousedown and mouseup, so clicks were silently dropped.
let bridgeheadSignature = null;

export function renderBridgehead(ctx) {
  const { state, elements, onStateChanged } = ctx;

  const maxSlots = CONFIG.bridgehead?.maxSlots ?? 8;
  elements.sendBridgeheadButton.disabled =
    state.bridgeheadUnits.length === 0 ||
    state.game.isOver ||
    state.battle.status === "fighting";

  const signature = JSON.stringify({
    status: state.battle.status,
    maxSlots,
    slots: state.bridgeheadUnits.map(
      (unit) => `${unit.id}:${unit.formationRow}:${unit.level}:${Math.round(unit.health)}`
    )
  });
  if (signature === bridgeheadSignature) {
    return;
  }
  bridgeheadSignature = signature;

  elements.bridgeheadSlots.innerHTML = "";

  for (let index = 0; index < maxSlots; index += 1) {
    const slot = document.createElement("div");
    slot.className = `bridgehead-slot ${state.bridgeheadUnits[index] ? "is-filled" : "is-empty"}`;

    const unit = state.bridgeheadUnits[index];
    if (unit) {
      slot.append(createUnitCard(unit, { origin: "battle", compact: true }));

      const rowToggle = document.createElement("button");
      rowToggle.type = "button";
      rowToggle.className = "bridgehead-row-toggle";
      rowToggle.dataset.row = unit.formationRow === "back" ? "back" : "front";
      rowToggle.textContent = unit.formationRow === "back" ? "Задний" : "Передний";
      rowToggle.disabled = state.battle.status === "fighting";
      rowToggle.addEventListener("click", () => {
        const nextRow = unit.formationRow === "front" ? "back" : "front";
        const result = setBridgeheadUnitRow(state, unit.id, nextRow);
        state.battle.log = result.reason;
        onStateChanged();
      });
      slot.append(rowToggle);
    } else {
      slot.innerHTML = '<span class="slot-placeholder">Empty</span>';
    }

    elements.bridgeheadSlots.append(slot);
  }
}

export function renderMineProgressFrame(ctx) {
  const { state, elements, mineProgressCache } = ctx;

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

export function flushResourceBursts(ctx) {
  const { state, elements } = ctx;

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

export function playRangedAttackEffect(ctx, effect) {
  const { elements } = ctx;

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

export function playSplashEffect(ctx, effect) {
  const { elements } = ctx;

  const rect = elements.battlefield.getBoundingClientRect();
  const centerX = rect.left + (effect.x / CONFIG.battle.fieldWidth) * rect.width;
  const centerY = rect.top + (effect.y / CONFIG.battle.fieldHeight) * rect.height;
  const diameter = ((effect.radius * 2) / CONFIG.battle.fieldWidth) * rect.width;
  const ring = document.createElement("div");

  ring.className = "splash-ring";
  ring.style.left = `${centerX}px`;
  ring.style.top = `${centerY}px`;
  ring.style.width = `${diameter}px`;
  ring.style.height = `${diameter}px`;
  elements.fxLayer.append(ring);
  window.setTimeout(() => ring.remove(), 320);
}

export function flushBattleEffects(ctx) {
  const { state } = ctx;

  const handled = new Set(state.ui.handledBattleEffectIds);

  for (const effect of state.battleEffects) {
    if (handled.has(effect.id)) {
      continue;
    }
    handled.add(effect.id);
    if (effect.type === "ranged-line") {
      playRangedAttackEffect(ctx, effect);
    } else if (effect.type === "splash-ring") {
      playSplashEffect(ctx, effect);
    }
  }

  state.ui.handledBattleEffectIds = [...handled].slice(-160);
  if (state.battleEffects.length > 80) {
    state.battleEffects = state.battleEffects.slice(-80);
  }
}
