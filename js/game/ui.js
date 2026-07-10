import {
  CONFIG,
  getFortressBuildingUnlockWave,
  getMineLevelData,
  getMineMaxLevel,
  getMineUnlockWave,
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
  buyMine,
  buyMineSlot,
  assignReserveUnitToMine,
  getCurrentWaveDemandResource,
  getMinePurchaseState,
  getMinePurchasedSlotCount,
  getMineSlotState,
  mergeReserveUnitIntoMineUnit,
  moveMineUnitToMineSlot,
  returnMineUnitToReserve
} from "./systems/mineSystem.js";
import { giveUpFortressBattle, startFortressBattle } from "./systems/fortressBattleSystem.js";
import {
  buyFortressBuilding,
  canAffordResources,
  canPlaceFortressBuilding,
  findFortressPlacement,
  getBuildingActiveCost,
  getBuildingActiveDefinition,
  demolishFortressBuilding,
  FORTRESS_HEIGHT,
  FORTRESS_WIDTH,
  getFortressBuildingBuyCost,
  getFortressBuildingDemolishGoldCost,
  getFortressBuildingRefund,
  getFortressRepairCost,
  getMergeCrystalCost,
  massMergeFortressBuildings,
  mergeFortressBuildings,
  moveFortressBuilding,
  removeFortressObstacle,
  repairFortressBuilding,
  triggerBuildingActive
} from "./systems/fortressSystem.js";
import { applyUpgradeChoice } from "./systems/upgradeSystem.js";
import {
  applyWorkerCapstone,
  getDominantTraitKey,
  getMaxRestCharges,
  getTraitIcon,
  getTraitLabel,
  getWorkerCapstoneEffect,
  getWorkerGoldenConversion,
  getWorkerRushMultiplier,
  getWorkerYieldMultiplier,
  WORKER_TRAIT_KEYS
} from "./systems/workerTraitSystem.js";

function buildTraitInfoMarkup() {
  const traits = CONFIG.workerTraits ?? {};
  const lines = traits.lines ?? {};
  const shift = traits.battleShift ?? {};
  const yieldPer = lines.yield?.resourceMultiplierPerPoint ?? 0;
  const goldenPer = lines.golden?.goldPerResourcePerPoint ?? 0;
  const rushPer = lines.rush?.battleMultiplierPerPoint ?? 0;
  const shiftBase = shift.baseMultiplier ?? 1;
  const rows = [
    {
      key: "yield",
      label: lines.yield?.label ?? "Yield",
      icon: lines.yield?.icon ?? "Y",
      text: `Each point adds +${(yieldPer * 100).toFixed(0)}% to that worker's mine output. Pill number = points.`
    },
    {
      key: "golden",
      label: lines.golden?.label ?? "Golden",
      icon: lines.golden?.icon ?? "G",
      text: `Each point converts +${(goldenPer * 100).toFixed(1)}% of that worker's production into gold on top of the resource.`
    },
    {
      key: "rush",
      label: lines.rush?.label ?? "Rush",
      icon: lines.rush?.icon ?? "R",
      text: `Boosts the battle Shift multiplier. Base ${shiftBase}×; each point adds +${(rushPer * 100).toFixed(0)}%. Applies only to committed workers during battle.`
    }
  ];
  const restMult = CONFIG.productionMultipliers?.rest ?? 1;
  const shiftCap = shift.maxCommitsPerMine ?? 2;
  const mechanics = [
    {
      key: "shift",
      icon: "👷",
      label: "Battle Shift",
      text: `Every worker WANTS a particular mine (shown on its badge). Stand it on that mine with Rest ⚡ and it auto-Shifts when battle starts (×${shiftBase} base + Rush) — the mine pumps faster, up to ${shiftCap} per mine. Spends one Rest per Shift.`
    },
    {
      key: "rested",
      icon: "⚡",
      label: "Mood & Rest",
      text: `Rest ⚡ builds (+1/wave, up to ceil(level/2)) whenever a worker is NOT on its wanted mine — sitting on a different mine (still mining at ×${restMult}) or resting in reserve. When Rest hits 0 its craving shifts to another mine — move it there to Shift again. That's the loop: chase each worker's mood.`
    }
  ];
  const renderRow = (row) => `
    <div class="trait-info-row">
      <span class="unit-trait unit-trait-${row.key}">${row.icon}</span>
      <div>
        <strong>${row.label}</strong>
        <p>${row.text}</p>
      </div>
    </div>
  `;
  const rowsHtml = rows.map(renderRow).join("");
  const mechanicsHtml = mechanics.map(renderRow).join("");
  return `
    <p class="trait-info-hint">Traits roll when a worker is bought and stack on merge (dominant line gets a bonus point). At max level a worker picks a capstone (★).</p>
    ${rowsHtml}
    <p class="trait-info-hint">Shifts &amp; rest — the mining-during-battle loop:</p>
    ${mechanicsHtml}
  `;
}

function getResourceIconMarkup(resourceKey, extraClass = "") {
  const icon = getResourceIcon(resourceKey);
  const suffix = extraClass ? ` ${extraClass}` : "";
  if (icon) {
    return `<span class="resource-icon resource-icon-emoji${suffix}" aria-hidden="true">${icon}</span>`;
  }
  return `<span class="resource-icon resource-icon-${resourceKey}${suffix}" aria-hidden="true"></span>`;
}

function isHitFlashing(entity) {
  return (entity?.hitUntil ?? 0) > performance.now() / 1000;
}

function buildFortressBuffsMarkup(state) {
  const eco = state.economy ?? {};
  const goldMul = eco.goldMultiplier ?? 1;
  const prodMul = eco.productionMultiplier ?? 1;
  const hpBonus = eco.baseHealthBonus ?? 0;
  const permRows = [];
  if (goldMul > 1) permRows.push({ icon: "🪙", label: "Gold Dividend", effect: `Gold ×${goldMul.toFixed(2)}` });
  if (prodMul > 1) permRows.push({ icon: "⛏️", label: "Supply Line", effect: `Mine output ×${prodMul.toFixed(2)}` });
  if (hpBonus > 0) permRows.push({ icon: "🛡️", label: "Fortified Core", effect: `+${hpBonus} base HP` });

  const tempActive = eco.temporaryBonuses ?? [];
  const tempQueued = eco.queuedTemporaryBonuses ?? [];
  const kindMeta = {
    production: { icon: "⛏️", label: "Harvest Surge", metric: "Production" },
    damage: { icon: "⚔️", label: "War Drums", metric: "Damage" },
    defense: { icon: "🛡️", label: "Shield Wall", metric: "Defense" }
  };
  const tempActiveRows = tempActive.map((b) => {
    const meta = kindMeta[b.kind] ?? { icon: "✨", label: b.kind, metric: b.kind };
    return `<div class="trait-info-row"><span class="unit-trait">${meta.icon}</span><div><strong>${meta.label}</strong><p>${meta.metric} ×${b.multiplier} · ${b.remainingWaves} wave${b.remainingWaves === 1 ? "" : "s"} left</p></div></div>`;
  });
  const tempQueuedRows = tempQueued.map((b) => {
    const meta = kindMeta[b.kind] ?? { icon: "✨", label: b.kind, metric: b.kind };
    return `<div class="trait-info-row"><span class="unit-trait">${meta.icon}</span><div><strong>${meta.label} (queued)</strong><p>Starts next wave · ${meta.metric} ×${b.multiplier} for ${b.remainingWaves} wave${b.remainingWaves === 1 ? "" : "s"}</p></div></div>`;
  });

  const permHtml = permRows.length
    ? permRows.map((r) => `<div class="trait-info-row"><span class="unit-trait">${r.icon}</span><div><strong>${r.label}</strong><p>${r.effect}</p></div></div>`).join("")
    : `<p class="trait-info-hint">No permanent rewards yet.</p>`;
  const tempHtml = tempActiveRows.length || tempQueuedRows.length
    ? [...tempActiveRows, ...tempQueuedRows].join("")
    : `<p class="trait-info-hint">No temporary buffs active.</p>`;

  return `
    <strong>Permanent</strong>
    ${permHtml}
    <strong>Temporary</strong>
    ${tempHtml}
    <p class="trait-info-hint">Rewards from wave victories stack here. Temporary buffs count down after each wave you win.</p>
  `;
}

function describeBuildingActive(active) {
  if (!active) return "";
  const effect = active.effect ?? {};
  switch (effect.kind) {
    case "shield":
      return `Shields nearby buildings (radius ${effect.radius}) for ${effect.durationSeconds}s, reducing damage taken by ${Math.round((effect.damageReduction ?? 0) * 100)}%.`;
    case "spawnSquad":
      return `Rallies ${effect.count}× ${effect.unit} at the fortress.`;
    case "volley":
      return `Fires ${effect.count} arrows dealing ${effect.damage} damage each.`;
    case "buildingDamageBoost":
      return `Overcharges this building for ${effect.durationSeconds}s: ×${effect.multiplier} damage.`;
    case "frost":
      return `Slows enemies within radius to ${Math.round((effect.slowMultiplier ?? 0) * 100)}% speed for ${effect.durationSeconds}s.`;
    default:
      return "";
  }
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
  const traits = unit.traits ?? {};
  const dominantTrait = getDominantTraitKey(traits);
  const traitBadges = WORKER_TRAIT_KEYS
    .filter((key) => (traits[key] ?? 0) > 0)
    .map((key) => {
      const points = traits[key];
      const lineCfg = CONFIG.workerTraits?.lines?.[key] ?? {};
      let tip;
      if (key === "yield") tip = `Yield ${points} · +${Math.round((lineCfg.resourceMultiplierPerPoint ?? 0) * points * 100)}% mine output`;
      else if (key === "golden") tip = `Golden ${points} · +${((lineCfg.goldPerResourcePerPoint ?? 0) * points * 100).toFixed(1)}% of production paid as gold`;
      else if (key === "rush") tip = `Rush ${points} · +${Math.round((lineCfg.battleMultiplierPerPoint ?? 0) * points * 100)}% Shift multiplier`;
      else tip = `${getTraitLabel(key)} ${points}`;
      return `<span class="unit-trait unit-trait-${key}" title="${tip}"><span class="unit-trait-icon">${getTraitIcon(key)}</span><span class="unit-trait-num">${points}</span></span>`;
    })
    .join("");

  card.dataset.gear = "worker";
  card.dataset.level = String(level);
  card.dataset.trait = dominantTrait;
  card.classList.toggle("is-shifted", Boolean(unit.battleShiftCommitted));
  card.classList.toggle("is-rested", (unit.restCharges ?? 0) > 0);
  card.classList.toggle("is-hit", isHitFlashing(unit));
  card.classList.toggle("has-pending-capstone", Boolean(unit.pendingCapstone?.length));
  card.dataset.hit = isHitFlashing(unit) ? "true" : "false";

  // Capstone no longer prints its (long) label on the card — that deformed the layout. Instead a ★
  // sits on the level badge; the full name + effect live in the worker popover.
  const capstoneEffect = getWorkerCapstoneEffect(unit);
  const capstoneStar = capstoneEffect
    ? `<span class="unit-capstone-star" title="${capstoneEffect.label}">★</span>`
    : "";

  // The status badge now shows the mine this worker WANTS (place it there to Shift). Its colour is
  // the Rest state: bright = charged & ready to Shift, gold = currently Shifting, dim = building desire.
  const restCharges = unit.restCharges ?? 0;
  const maxRest = getMaxRestCharges(level);
  const desireIcon = unit.desiredMine ? (getResourceIcon(unit.desiredMine) ?? "•") : "•";
  const desireLabel = unit.desiredMine ? getResourceLabel(unit.desiredMine) : "a mine";
  const countSuffix = restCharges > 1 ? `×${restCharges}` : "";
  let statusBadge;
  if (unit.battleShiftCommitted) {
    statusBadge = `<span class="unit-status-badge is-shift" title="On Shift at the ${desireLabel} mine">${desireIcon}</span>`;
  } else if (restCharges > 0) {
    statusBadge = `<span class="unit-status-badge is-rested" title="Wants the ${desireLabel} mine — ${restCharges}/${maxRest} Shift charge${restCharges > 1 ? "s" : ""}. Place it there to Shift.">${desireIcon}${countSuffix}</span>`;
  } else {
    statusBadge = `<span class="unit-status-badge is-depleted" title="Building desire for the ${desireLabel} mine — works at base rate meanwhile.">${desireIcon}</span>`;
  }
  card.innerHTML = `
    <div class="unit-badges">
      <div class="unit-badges-row">
        <span class="unit-level-badge">${level}${capstoneStar}</span>
        ${statusBadge}
      </div>
      ${!compact && traitBadges ? `<div class="unit-traits">${traitBadges}</div>` : ""}
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
    ${compact && traitBadges ? `<div class="unit-traits compact-traits">${traitBadges}</div>` : ""}
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

function renderResourceCost(costs) {
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

function getVisibleResourceTarget(elements, resourceKey) {
  const candidates = [
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

// Where a burst originates: battlefield bursts live on the Fortress screen ("top"),
// mine/worker bursts on the Production screen ("bottom").
function getBurstSourceScreen(burst) {
  return burst.battlefield ? "top" : "bottom";
}

// Flash the resource chip in place with a quick "+N" pop — used when the burst's source
// screen is off-screen, so we don't fling tokens across from a hidden origin.
function flashResourceTick(elements, target, resourceKey, displayAmount, isShift = false) {
  target.animate(
    isShift
      ? [
          { transform: "scale(1)", filter: "brightness(1)" },
          { transform: "scale(1.22)", filter: "brightness(1.9)" },
          { transform: "scale(1)", filter: "brightness(1)" }
        ]
      : [
          { transform: "scale(1)", filter: "brightness(1)" },
          { transform: "scale(1.12)", filter: "brightness(1.55)" },
          { transform: "scale(1)", filter: "brightness(1)" }
        ],
    { duration: isShift ? 300 : 340, easing: "ease-out" }
  );

  const rect = target.getBoundingClientRect();
  const token = document.createElement("div");
  token.className = `resource-tick resource-${resourceKey}${isShift ? " is-shift" : ""}`;
  token.textContent = isShift ? `⚡+${displayAmount}` : `+${displayAmount}`;
  token.style.left = `${rect.left + rect.width / 2}px`;
  token.style.top = `${rect.top}px`;
  elements.fxLayer.append(token);
  window.setTimeout(() => token.remove(), 620);
}

function playResourceBurst(elements, burst, activeScreen) {
  const sourceVisible = getBurstSourceScreen(burst) === activeScreen;

  let startX;
  let startY;

  if (sourceVisible) {
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

    // Source screen hidden: no flight — just flash the counter in place. Shift payouts (which fire
    // during battle while the player is on the fortress screen) flash brighter with a ⚡ so the
    // mining spike is legible across screens.
    if (!sourceVisible) {
      flashResourceTick(elements, target, payout.resourceKey, displayAmount, Boolean(burst.shift));
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
    traitInfoButton: document.querySelector("#traitInfoButton"),
    traitInfoPanel: document.querySelector("#traitInfoPanel"),
    fortressBuffsButton: document.querySelector("#fortressBuffsButton"),
    fortressBuffsPanel: document.querySelector("#fortressBuffsPanel"),
    fxLayer: document.querySelector("#fxLayer")
    ,
    fortressGiveUpButton: document.querySelector("#fortressGiveUpButton"),
    waveTelegraph: document.querySelector("#waveTelegraph"),
    fortressFightButton: document.querySelector("#fortressFightButton"),
    fortressMessage: document.querySelector("#fortressMessage"),
    bossHpBar: document.querySelector("#bossHpBar"),
    fortressField: document.querySelector("#fortressField"),
    fortressShop: document.querySelector("#fortressShop"),
    fortressMassMergeButton: document.querySelector("#fortressMassMergeButton"),
    upgradeOverlay: document.querySelector("#upgradeOverlay"),
    upgradeChoices: document.querySelector("#upgradeChoices"),
    capstoneOverlay: document.querySelector("#capstoneOverlay"),
    capstoneChoices: document.querySelector("#capstoneChoices"),
    runEndOverlay: document.querySelector("#runEndOverlay"),
    runEndTitle: document.querySelector("#runEndTitle"),
    runEndText: document.querySelector("#runEndText"),
    runEndRestartButton: document.querySelector("#runEndRestartButton")
  };

  if (elements.selectedUnitChip) {
    elements.selectedUnitChip.style.display = "none";
  }

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

  function openWorkerActionPopup(unitId) {
    state.ui.workerActionPopup = { unitId };
  }

  function closeWorkerActionPopup() {
    state.ui.workerActionPopup = null;
  }

  function getWorkerActionContext() {
    const popup = state.ui.workerActionPopup;
    if (!popup) {
      return null;
    }
    const reserveUnit = state.reserveUnits.find((unit) => unit.id === popup.unitId);
    if (reserveUnit) {
      return { unit: reserveUnit, source: "reserve" };
    }
    for (const mine of state.mines) {
      for (let index = 0; index < mine.workerIds.length; index += 1) {
        const worker = mine.workerIds[index];
        if (worker?.id === popup.unitId) {
          return { unit: worker, source: "mine", mineId: mine.id, slotIndex: index };
        }
      }
    }
    state.ui.workerActionPopup = null;
    return null;
  }

  // First tap on a worker card opens this popover instead of directly entering
  // move-mode; move-mode itself is entered from the popover's "Move / Merge" button.
  function handleWorkerCardTap(unitId) {
    const currentSelection = getSelectedUnitContext();
    if (currentSelection) {
      // Already mid move/merge — let the existing target-select handlers run.
      return false;
    }
    if (state.ui.workerActionPopup?.unitId === unitId) {
      closeWorkerActionPopup();
    } else {
      openWorkerActionPopup(unitId);
    }
    onStateChanged();
    return true;
  }

  function renderWorkerActionPopover() {
    const existing = document.querySelector(".worker-action-popover");
    existing?.remove();

    const context = getWorkerActionContext();
    if (!context || state.ui.selectedUnitId) {
      return;
    }

    const anchor = document.querySelector(`.unit-card[data-unit-id="${context.unit.id}"]`);
    if (!anchor) {
      closeWorkerActionPopup();
      return;
    }

    const unit = context.unit;
    const anchorRect = anchor.getBoundingClientRect();
    const popover = document.createElement("div");
    popover.className = "worker-action-popover";

    const yieldPct = Math.round((getWorkerYieldMultiplier(unit) - 1) * 100);
    const goldenPct = Math.round(getWorkerGoldenConversion(unit) * 1000) / 10;
    const rushMult = Math.round(getWorkerRushMultiplier(unit) * 100) / 100;
    const capstoneEffect = getWorkerCapstoneEffect(unit);

    const inMine = context.source === "mine";
    const charges = unit.restCharges ?? 0;
    const maxCharges = getMaxRestCharges(unit.level);
    const desiredLabel = unit.desiredMine ? getResourceLabel(unit.desiredMine) : "a mine";
    const desiredIcon = unit.desiredMine ? (getResourceIcon(unit.desiredMine) ?? "") : "";
    const currentMine = inMine ? state.mines.find((mine) => mine.id === context.mineId) : null;
    const onDesired = Boolean(currentMine && currentMine.resourceKey === unit.desiredMine);
    // A worker Shifts (battle production spike) only while standing on the mine it currently WANTS and
    // holding Rest ⚡. Off its mine (wrong mine or reserve) it builds Rest toward it at base rate.
    let shiftNote;
    if (unit.battleShiftCommitted) {
      shiftNote = `<div class="worker-popover-shift is-shifted">👷 On Shift at ${desiredIcon} ${desiredLabel} — mining ×${rushMult}</div>`;
    } else if (onDesired && charges > 0) {
      shiftNote = `<div class="worker-popover-shift is-rested">${desiredIcon} On its wanted mine — Shifts next battle (×${rushMult}) · ${charges}/${maxCharges} ⚡</div>`;
    } else if (charges > 0) {
      shiftNote = `<div class="worker-popover-shift is-rested">Wants ${desiredIcon} ${desiredLabel} · ${charges}/${maxCharges} ⚡ — move it there to Shift</div>`;
    } else {
      shiftNote = `<div class="worker-popover-shift">💤 Building desire for ${desiredIcon} ${desiredLabel} — works at base rate</div>`;
    }
    const headerStatus = unit.battleShiftCommitted ? ` 👷${desiredIcon}` : ` ${desiredIcon}`;
    popover.innerHTML = `
      <strong>${unit.name} · Lv${unit.level}${headerStatus}</strong>
      <div class="worker-popover-traits">
        <span class="unit-trait unit-trait-yield" title="Yield">Y +${yieldPct}%</span>
        <span class="unit-trait unit-trait-golden" title="Golden">G ${goldenPct}%</span>
        <span class="unit-trait unit-trait-rush" title="Rush">R ${rushMult}× Shift</span>
      </div>
      ${capstoneEffect ? `<div class="worker-popover-capstone"><strong>★ ${capstoneEffect.label}</strong>${capstoneEffect.description ? `<span>${capstoneEffect.description}</span>` : ""}</div>` : ""}
      <button class="fortress-popover-action primary-action" type="button" data-popover-move>Move / Merge</button>
      ${shiftNote}
      ${unit.pendingCapstone?.length ? `<button class="fortress-popover-action" type="button" data-popover-capstone>Choose Capstone</button>` : ""}
      ${inMine ? `<button class="fortress-popover-action" type="button" data-popover-return>Return to Reserve</button>` : ""}
      <button class="fortress-popover-action" type="button" data-popover-close>Close</button>
    `;

    popover.querySelector("[data-popover-move]").addEventListener("click", () => {
      selectUnit(unit.id);
      closeWorkerActionPopup();
      refreshSelectionOnly();
    });

    popover.querySelector("[data-popover-capstone]")?.addEventListener("click", () => {
      closeWorkerActionPopup();
      onStateChanged();
    });

    popover.querySelector("[data-popover-return]")?.addEventListener("click", () => {
      const result = returnMineUnitToReserve(state, context.mineId, context.slotIndex);
      state.fortress.message = result.reason;
      closeWorkerActionPopup();
      onStateChanged();
    });

    popover.querySelector("[data-popover-close]").addEventListener("click", () => {
      closeWorkerActionPopup();
      refreshSelectionOnly();
    });

    document.body.append(popover);

    const popoverRect = popover.getBoundingClientRect();
    const viewportW = window.innerWidth || document.documentElement.clientWidth;
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    let left = anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2;
    left = Math.max(6, Math.min(left, viewportW - popoverRect.width - 6));
    let top = anchorRect.bottom + 8;
    if (top + popoverRect.height > viewportH - 6) {
      top = anchorRect.top - popoverRect.height - 8;
    }
    top = Math.max(6, top);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    window.setTimeout(() => {
      const dismissOnOutsideClick = (event) => {
        if (popover.contains(event.target) || anchor.contains(event.target)) {
          return;
        }
        closeWorkerActionPopup();
        refreshSelectionOnly();
        document.removeEventListener("pointerdown", dismissOnOutsideClick, true);
      };
      document.addEventListener("pointerdown", dismissOnOutsideClick, true);
    }, 0);
  }

  function renderMoveModeCancelButton() {
    // Cancel Move button removed — tap the same worker (or the Worker Pile) to abort.
    document.querySelector(".worker-move-cancel")?.remove();
  }

  function refreshSelectionOnly() {
    const selected = getSelectedUnitContext();
    const selectedId = state.ui.selectedUnitId;
    const selectedLevel = selected?.unit.level ?? null;
    const selectedSource = selected?.source ?? null;
    const inMoveMode = !!selected;

    document.querySelectorAll("#reserveZone .unit-card").forEach((card) => {
      const uid = card.dataset.unitId;
      const level = Number(card.dataset.level ?? 0);
      card.classList.toggle("selection-source", selectedId === uid);
      card.classList.toggle(
        "actionable-target",
        selectedSource === "reserve" && level === selectedLevel && selectedId !== uid
      );
    });

    elements.reservePanel?.classList.toggle("actionable-target", selectedSource === "mine");

    document.querySelectorAll(".mines-grid .slot").forEach((slot) => {
      if (!slot.classList.contains("is-open")) return;
      const workerCard = slot.querySelector(".unit-card");
      if (workerCard) {
        const uid = workerCard.dataset.unitId;
        const level = Number(workerCard.dataset.level ?? 0);
        workerCard.classList.toggle("selection-source", selectedId === uid);
        workerCard.classList.toggle(
          "actionable-target",
          inMoveMode && level === selectedLevel && selectedId !== uid
        );
        slot.classList.toggle("actionable-target", false);
      } else {
        slot.classList.toggle("actionable-target", inMoveMode);
      }
    });

    updateSelectionTether();
    renderWorkerActionPopover();
  }

  function updateSelectionTether() {
    // The SELECTED chip this tether pointed to is hidden now that the worker
    // action popover replaces it — nothing to tether to anymore.
    elements.fxLayer.querySelector(".selection-tether")?.remove();
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

  elements.fortressMassMergeButton?.addEventListener("click", () => {
    const result = massMergeFortressBuildings(state);
    state.fortress.message = result.reason;
    closeFortressPopup();
    onStateChanged();
  });

  function attachAnchoredTooltip(button, panel, buildMarkup) {
    if (!button || !panel) return;
    let outsideHandler = null;
    const close = () => {
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (outsideHandler) {
        document.removeEventListener("pointerdown", outsideHandler, true);
        outsideHandler = null;
      }
    };
    const position = () => {
      const anchorRect = button.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const viewportW = window.innerWidth || document.documentElement.clientWidth;
      const viewportH = window.innerHeight || document.documentElement.clientHeight;
      let left = anchorRect.left + anchorRect.width / 2 - panelRect.width / 2;
      left = Math.max(6, Math.min(left, viewportW - panelRect.width - 6));
      let top = anchorRect.bottom + 8;
      if (top + panelRect.height > viewportH - 6) {
        top = anchorRect.top - panelRect.height - 8;
      }
      top = Math.max(6, top);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const open = () => {
      panel.innerHTML = `
        <button class="trait-info-close" type="button" aria-label="Close">✕</button>
        ${buildMarkup()}
      `;
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      position();
      panel.querySelector(".trait-info-close")?.addEventListener("click", close);
      window.setTimeout(() => {
        outsideHandler = (event) => {
          if (panel.contains(event.target)) return;
          if (event.target === button) return;
          close();
        };
        document.addEventListener("pointerdown", outsideHandler, true);
      }, 0);
    };
    button.addEventListener("click", () => {
      if (panel.hidden) open();
      else close();
    });
  }

  attachAnchoredTooltip(elements.traitInfoButton, elements.traitInfoPanel, buildTraitInfoMarkup);
  attachAnchoredTooltip(elements.fortressBuffsButton, elements.fortressBuffsPanel, () => buildFortressBuffsMarkup(state));

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

  elements.fortressGiveUpButton.addEventListener("click", () => {
    if (!state.fortress.battle.active) {
      return;
    }
    if (!window.confirm("Give up this wave? Your fortress takes the loss and you can try again.")) {
      return;
    }
    const result = giveUpFortressBattle(state);
    state.fortress.message = result.reason;
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
          refreshSelectionOnly();
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

        if (currentSelection) {
          // Move-mode active but this card isn't a valid target — leave move-mode on.
          return;
        }

        handleWorkerCardTap(unit.id);
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
    const demandResource = getCurrentWaveDemandResource(state);

    for (const mine of state.mines) {
      const purchaseState = getMinePurchaseState(state, mine);
      const purchasedSlotCount = getMinePurchasedSlotCount(mine);
      const card = document.createElement("article");
      card.className = `mine-card ${mine.isUnlocked ? "" : "is-locked"}`;
      card.dataset.resourceKey = mine.resourceKey;
      card.dataset.mineCard = mine.id;
      card.classList.toggle("is-demand-resource", demandResource === mine.resourceKey);

      const mineLevelData = getMineLevelData(mine.level);
      const slotMultipliers = mineLevelData?.slotProductionMultipliers ?? [];
      const passiveInterval = Math.max(0.001, CONFIG.passiveGoldPayoutIntervalSeconds ?? 1);
      const passiveProgress = mine.isUnlocked
        ? Math.min(1, (mine.passiveProgress ?? 0) / passiveInterval)
        : 0;
      const showPassive = mine.isUnlocked && (CONFIG.passiveGoldPerSecondPerUnlockedMine ?? 0) > 0;
      const producesGold = showPassive || (CONFIG.mine.goldPerSecondPerWorkerLevel ?? 0) > 0;
      const headerAction = purchaseState.kind === "owned"
        ? `<span class="tag">Owned</span>`
        : purchaseState.kind === "available-to-buy"
          ? `<button class="secondary-button mine-buy-button" type="button">
              Buy Mine ${renderResourceCost(purchaseState.buyCost)}
            </button>`
          : `<span class="tag">Unlocks Wave ${purchaseState.unlockWave}</span>`;
      card.innerHTML = `
        <div class="mine-head">
          <div class="mine-title-wrap">
            <div class="mine-title">
              ${getResourceIconMarkup(mine.resourceKey, "mine-resource-icon")}
              <div class="mine-title-text">
                <h3>${mine.name}</h3>
                <p class="eyebrow">Produces ${mine.resourceLabel}${producesGold ? " + Gold" : ""}</p>
              </div>
            </div>
          </div>
          ${headerAction}
        </div>
        <div class="mine-stats">
          <span class="tag">${mine.isUnlocked ? `Slots ${purchasedSlotCount}/${getMineMaxLevel()}` : "Locked"}</span>
          <span class="tag">${mine.isUnlocked ? "Bought" : `Wave ${purchaseState.unlockWave}`}</span>
          ${demandResource === mine.resourceKey ? `<span class="tag demand-tag" title="Wave Demand"><span class="demand-tag-full">Wave Demand </span>×${CONFIG.waveDemand?.slotProductionMultiplier ?? 1}</span>` : ""}
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

      const mineBuyButton = card.querySelector(".mine-buy-button");
      mineBuyButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        const result = buyMine(state, mine.id);
        state.fortress.message = result.reason;
        onStateChanged();
      });

      const slots = document.createElement("div");
      slots.className = "mine-slots";

      for (let index = 0; index < getMineMaxLevel(); index += 1) {
        const slot = document.createElement("div");
        const slotState = getMineSlotState(state, mine, index);
        const isBoughtSlot = slotState.kind === "bought";
        const isBuyableSlot = slotState.kind === "available-to-buy";
        const baseState = isBoughtSlot ? "is-open" : isBuyableSlot ? "" : "is-locked";
        slot.className = `slot ${baseState} ${isBuyableSlot ? "is-buyable" : ""}`.trim();
        slot.dataset.mineSlot = `${mine.id}:${index}`;

        const slotMultiplier = slotMultipliers[index] ?? 1;
        const demandMultiplier = demandResource === mine.resourceKey ? CONFIG.waveDemand?.slotProductionMultiplier ?? 1 : 1;
        const displayedMultiplier = slotMultiplier * demandMultiplier;
        const slotBadge = isBoughtSlot && mine.isUnlocked
          ? `<span class="slot-bonus ${demandMultiplier > 1 ? "is-demand" : ""}" title="Production bonus for this slot">×${displayedMultiplier.toFixed(displayedMultiplier % 1 === 0 ? 0 : 2).replace(/\.?0+$/, "")}</span>`
          : "";

        const worker = mine.workerIds[index];
        if (!mine.isUnlocked) {
          slot.innerHTML = purchaseState.kind === "available-to-buy"
            ? `<div class="slot-placeholder">Buy mine</div>`
            : `<div class="slot-placeholder">Unlocks Wave ${purchaseState.unlockWave}</div>`;
        } else if (!isBoughtSlot) {
          slot.innerHTML = slotState.kind === "available-to-buy"
            ? `<button class="slot-action secondary-button" type="button">
                Buy Slot ${index + 1} ${renderResourceCost(slotState.buyCost)}
              </button>`
            : `<div class="slot-placeholder">Unlocks Wave ${slotState.unlockWave}</div>`;
          if (slotState.kind === "available-to-buy") {
            const button = slot.querySelector("button");
            button?.addEventListener("click", (event) => {
              event.stopPropagation();
              const result = buyMineSlot(state, mine.id, index);
              state.fortress.message = result.reason;
              onStateChanged();
            });
          }
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
          // Golden highlight on the slot while its worker is pulling a battle Shift.
          slotShell.classList.toggle("slot-shifting", Boolean(worker.battleShiftCommitted && state.fortress.battle.active));
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
              refreshSelectionOnly();
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

            handleWorkerCardTap(worker.id);
          });
          slotShell.append(workerCard);
          slotShell.insertAdjacentHTML(
            "beforeend",
            createMineProgressMarkup(mine.resourceKey, mine.id, index, progress)
          );
          // Shift toggle now lives in the worker action popover — kept out of the slot cell
          // to declutter the mines grid. `worker.battleShiftCommitted` still styles the card.
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
    return renderResourceCost(costs);
  }

  function renderBossHpBar() {
    if (!elements.bossHpBar) {
      return;
    }
    const bosses = state.fortress.battle.active
      ? state.fortress.battle.enemies.filter((enemy) => enemy.tag === "boss" && enemy.hp > 0)
      : [];
    if (bosses.length === 0) {
      elements.bossHpBar.hidden = true;
      elements.bossHpBar.innerHTML = "";
      return;
    }
    elements.bossHpBar.hidden = false;
    elements.bossHpBar.innerHTML = bosses.map((boss) => {
      const definition = CONFIG.fortressEnemies[boss.archetype];
      const pct = Math.max(0, boss.hp / boss.maxHp) * 100;
      return `
        <div class="boss-hp-row">
          <span class="boss-hp-name">${definition?.icon ?? ""} ${definition?.name ?? "Boss"}</span>
          <div class="boss-hp-track"><i style="width:${pct}%"></i></div>
          <span class="boss-hp-value">${Math.round(boss.hp)}/${boss.maxHp}</span>
        </div>
      `;
    }).join("");
  }

  function renderFortressField() {
    elements.fortressField.innerHTML = "";
    // Drive the grid + actor/popover positioning off the real field size so the CSS never drifts.
    elements.fortressField.style.setProperty("--fortress-cols", String(FORTRESS_WIDTH));
    elements.fortressField.style.setProperty("--fortress-rows", String(FORTRESS_HEIGHT));
    elements.fortressField.classList.toggle("is-battle-active", state.fortress.battle.active);
    renderBossHpBar();

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
        tileButton.classList.toggle("is-hit", isHitFlashing(building));
        tileButton.classList.toggle("is-damaged", building.hp > 0 && building.hp < building.maxHp);
        tileButton.classList.toggle("is-destroyed", building.hp <= 0);
        const activeDefinition = state.fortress.battle.active ? getBuildingActiveDefinition(building) : null;
        tileButton.innerHTML = `
          ${isSolidBuilding ? "" : renderFortressBuildingShape(building, buildingBounds)}
          <span class="fortress-tile-icon">${definition.icon}</span>
          <strong>${definition.name}</strong>
          <small>Lv ${building.level} · HP ${Math.round(building.hp)}/${building.maxHp}</small>
        `;

        if (activeDefinition && building.hp > 0) {
          const onCooldown = (building.activeCooldown ?? 0) > 0;
          const indicator = document.createElement("span");
          indicator.className = "fortress-active-indicator";
          indicator.innerHTML = onCooldown
            ? `<span class="fortress-active-cooldown">${Math.ceil(building.activeCooldown)}s</span>`
            : `<span class="fortress-active-icon">⚡</span>`;
          tileButton.append(indicator);
        }

        const movingBuildingId = state.fortress.movingBuildingId;
        if (movingBuildingId && movingBuildingId !== building.id) {
          const movingBuilding = state.fortress.buildings.find((item) => item.id === movingBuildingId);
          const canMerge =
            movingBuilding &&
            movingBuilding.type === building.type &&
            movingBuilding.type !== "hq" &&
            movingBuilding.level === building.level &&
            Boolean(definition.levels[building.level]);
          if (canMerge) {
            tileButton.classList.add("is-merge-target");
            tileButton.addEventListener("click", () => {
              const result = mergeFortressBuildings(state, movingBuildingId, building.id);
              state.fortress.message = result.reason;
              state.fortress.movingBuildingId = null;
              onStateChanged();
            });
          } else {
            tileButton.classList.add("is-invalid-target");
            tileButton.disabled = true;
          }
        } else {
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
        }
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
      token.classList.toggle("is-hit", isHitFlashing(enemy));
      token.style.setProperty("--x", enemy.x);
      token.style.setProperty("--y", enemy.y);
      token.innerHTML = `<span>${enemy.icon}</span><i style="width:${Math.max(0, enemy.hp / enemy.maxHp) * 100}%"></i>`;
      elements.fortressField.append(token);
    }

    for (const ally of state.fortress.battle.allies) {
      const token = document.createElement("div");
      token.className = "fortress-actor fortress-ally";
      token.classList.toggle("is-hit", isHitFlashing(ally));
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
    if (!popupState) {
      return;
    }
    const battleActive = state.fortress.battle.active;
    if (popupState.kind === "obstacle" && battleActive) {
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
      const nextLevel = definition.levels[building.level];
      const needsRepair = building.hp < building.maxHp && building.type !== "mine";
      const repairCost = needsRepair ? getFortressRepairCost(state, building) : {};
      const canRepair = needsRepair && canAffordResources(state.resources, repairCost);
      const active = getBuildingActiveDefinition(building);
      const activeDescription = describeBuildingActive(active);
      const activeCost = active ? getBuildingActiveCost(state, building) : {};
      const activeOnCooldown = active && (building.activeCooldown ?? 0) > 0;
      const activeAffordable = active && canAffordResources(state.resources, activeCost);
      const activeBlock = active ? `
        <div class="fortress-popover-active">
          <strong class="fortress-popover-active-title">⚡ ${active.label}</strong>
          <span class="fortress-popover-active-desc">${activeDescription}</span>
          <span class="fortress-popover-active-meta">Cost ${renderFortressCost(activeCost)} · Cooldown ${active.cooldownSeconds}s</span>
        </div>
      ` : "";
      const useButton = active && battleActive ? `
        <button class="fortress-popover-action primary-action" type="button" data-popup-use ${activeOnCooldown || !activeAffordable ? "disabled" : ""}>
          ${activeOnCooldown ? `On cooldown ${Math.ceil(building.activeCooldown)}s` : `Use ${active.label}`}
        </button>
      ` : "";
      // Surface the crystal gate: the next merge may cost 💎, and crystal itself only unlocks mid-run.
      // Before this hint the merge just silently refused ("Need 30 💎") with no clue crystal comes later.
      const nextMergeCrystal = nextLevel ? getMergeCrystalCost(building.type, building.level + 1) : 0;
      const crystalUnlockWave = getMineUnlockWave("crystal");
      const crystalReady = (state.fortress.waveNumber ?? 1) >= crystalUnlockWave;
      const crystalHint = nextMergeCrystal > 0
        ? (crystalReady
            ? ` Merge to Lv ${building.level + 1} costs 💎${nextMergeCrystal}.`
            : ` Merge to Lv ${building.level + 1} needs 💎${nextMergeCrystal} — 💎 crystal unlocks at Wave ${crystalUnlockWave}.`)
        : "";
      const maxLevel = definition.levels?.length ?? 1;
      const upgradeNote = battleActive ? "" : (nextLevel
        ? `<span class="fortress-popover-note">Move a same-level ${definition.name} onto this one to upgrade (max Lv ${maxLevel}).${crystalHint}</span>`
        : `<span class="fortress-popover-note">Max level (Lv ${building.level})</span>`);
      const demolishRefund = building.type === "hq" ? {} : getFortressBuildingRefund(state, building);
      const hasRefund = Object.keys(demolishRefund).length > 0;
      const demolishGold = building.type === "hq" ? 0 : getFortressBuildingDemolishGoldCost(state, building);
      const canDemolish = (state.resources.gold ?? 0) >= demolishGold;
      const outOfBattleButtons = battleActive ? "" : `
        ${needsRepair ? `
          <button class="fortress-popover-action" type="button" data-popup-repair ${canRepair ? "" : "disabled"}>
            Repair ${renderFortressCost(repairCost)}
          </button>
        ` : ""}
        <button class="fortress-popover-action" type="button" data-popup-move ${building.type === "hq" ? "disabled" : ""}>Move / Merge</button>
        ${building.type === "hq" ? "" : `
          <button class="fortress-popover-action is-danger" type="button" data-popup-demolish ${canDemolish ? "" : "disabled"}>
            <span>Demolish${demolishGold > 0 ? ` −${demolishGold}${CONFIG.goldIcon ?? "💰"}` : ""}</span>${hasRefund ? `<span class="fortress-popover-refund">+${renderFortressCost(demolishRefund)}</span>` : ""}
          </button>
        `}
      `;
      popup.innerHTML = `
        <strong>${definition.name} Lv ${building.level}</strong>
        ${upgradeNote}
        ${activeBlock}
        ${useButton}
        ${outOfBattleButtons}
        <button class="fortress-popover-action" type="button" data-popup-close>Close</button>
      `;

      popup.querySelector("[data-popup-use]")?.addEventListener("click", () => {
        const result = triggerBuildingActive(state, building.id);
        state.fortress.message = result.reason;
        if (result.ok) closeFortressPopup();
        onStateChanged();
      });
      popup.querySelector("[data-popup-repair]")?.addEventListener("click", () => {
        const result = repairFortressBuilding(state, building.id);
        state.fortress.message = result.reason;
        closeFortressPopup();
        onStateChanged();
      });
      popup.querySelector("[data-popup-demolish]")?.addEventListener("click", () => {
        const result = demolishFortressBuilding(state, building.id);
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
    const unlockWave = getFortressBuildingUnlockWave(type);
    const isUnlocked = state.fortress.unlockedBuildingTypes.includes(type);
    const buyCost = getFortressBuildingBuyCost(state, type);
    const hasSpace = Boolean(findFortressPlacement(state, type));
    const canBuy = isUnlocked && hasSpace && canAffordResources(state.resources, buyCost);
    const maxLevel = definition.levels?.length ?? 1;
    // Top tier gated by crystal? Surface it on the card so the tier ceiling + its cost are legible
    // before you commit (barracks etc. cap at L4, and L4/L5 merges cost 💎 crystal).
    const topCrystal = getMergeCrystalCost(type, maxLevel);
    const maxLevelTag = `Max Lv ${maxLevel}${topCrystal > 0 ? " · 💎" : ""}`;
    const card = document.createElement("article");
    card.className = `fortress-shop-card ${isUnlocked ? "" : "is-locked"} ${!hasSpace ? "has-no-space" : ""}`;
    card.tabIndex = canBuy ? 0 : -1;
    card.innerHTML = `
      <div class="fortress-shop-icon">${definition.icon}</div>
      <strong>${definition.name}</strong>
      <span class="tag">${isUnlocked ? "Available" : `Wave ${unlockWave}`}</span>
      <span class="fortress-shop-maxlevel">${maxLevelTag}</span>
      ${definition.description ? `<p class="fortress-shop-desc">${definition.description}</p>` : ""}
      <div class="fortress-shop-cost">${renderFortressCost(buyCost)}</div>
      <button class="secondary-button" type="button">${isUnlocked ? (hasSpace ? "Buy" : "No Space") : `Locked until Wave ${unlockWave}`}</button>
    `;
    card.dataset.buildingType = type;
    const button = card.querySelector("button");
    button.disabled = !canBuy;
    const buy = () => {
      const currentCost = getFortressBuildingBuyCost(state, type);
      const currentlyCanBuy = state.fortress.unlockedBuildingTypes.includes(type) &&
        Boolean(findFortressPlacement(state, type)) &&
        canAffordResources(state.resources, currentCost);
      if (!currentlyCanBuy) {
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

  function updateFortressShopAffordability() {
    for (const card of elements.fortressShop.querySelectorAll("[data-building-type]")) {
      const type = card.dataset.buildingType;
      const button = card.querySelector("button");
      if (!type || !button) {
        continue;
      }

      const unlockWave = getFortressBuildingUnlockWave(type);
      const isUnlocked = state.fortress.unlockedBuildingTypes.includes(type);
      const hasSpace = Boolean(findFortressPlacement(state, type));
      const canBuy = isUnlocked &&
        hasSpace &&
        canAffordResources(state.resources, getFortressBuildingBuyCost(state, type));

      card.classList.toggle("is-locked", !isUnlocked);
      card.classList.toggle("has-no-space", !hasSpace);
      card.tabIndex = canBuy ? 0 : -1;
      button.disabled = !canBuy;
      button.innerHTML = isUnlocked
        ? (hasSpace ? `Buy ${renderFortressCost(getFortressBuildingBuyCost(state, type))}` : "No Space")
        : `Locked until Wave ${unlockWave}`;
      const tag = card.querySelector(".tag");
      if (tag) {
        tag.textContent = isUnlocked ? "Available" : `Wave ${unlockWave}`;
      }
    }
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
    const choices = state.fortress.pendingRewardDraft ?? [];
    elements.upgradeOverlay.hidden = choices.length === 0;
    elements.upgradeChoices.innerHTML = "";

    for (const choice of choices) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `upgrade-choice-card reward-${choice.category}`;
      const categoryLabel = choice.category === "oneShot"
        ? "One Shot"
        : choice.category.charAt(0).toUpperCase() + choice.category.slice(1);
      card.innerHTML = `
        <div class="reward-card-head">
          <span class="reward-category-pill">${categoryLabel}</span>
          <strong>${choice.title}</strong>
        </div>
        <span class="reward-effect">${choice.effectText}</span>
        <span class="reward-duration">${choice.durationText}</span>
        <p>${choice.description}</p>
      `;
      card.addEventListener("click", () => {
        const result = applyUpgradeChoice(state, choice.id);
        state.fortress.message = result.reason;
        onStateChanged();
      });
      elements.upgradeChoices.append(card);
    }
  }

  function findPendingCapstoneWorker() {
    for (const unit of state.reserveUnits) {
      if (unit.pendingCapstone?.length) {
        return unit;
      }
    }
    for (const mine of state.mines) {
      for (const worker of mine.workerIds) {
        if (worker?.pendingCapstone?.length) {
          return worker;
        }
      }
    }
    return null;
  }

  function renderCapstoneChoices() {
    const worker = findPendingCapstoneWorker();
    elements.capstoneOverlay.hidden = !worker;
    elements.capstoneChoices.innerHTML = "";

    if (!worker) {
      return;
    }

    const capstoneLines = CONFIG.workerTraits?.capstones ?? {};
    const allCapstones = Object.values(capstoneLines).flat();

    for (const capstoneId of worker.pendingCapstone) {
      const capstone = allCapstones.find((entry) => entry.id === capstoneId);
      if (!capstone) {
        continue;
      }
      const card = document.createElement("button");
      card.type = "button";
      card.className = "upgrade-choice-card";
      card.innerHTML = `
        <div class="reward-card-head">
          <strong>${capstone.label}</strong>
        </div>
        <p>${capstone.description}</p>
      `;
      card.addEventListener("click", () => {
        const result = applyWorkerCapstone(state, worker.id, capstone.id);
        state.fortress.message = result.reason;
        onStateChanged();
      });
      elements.capstoneChoices.append(card);
    }
  }

  function renderEconomyMeta() {
    const demandResource = getCurrentWaveDemandResource(state);
    for (const resourceKey of resourceOrder) {
      resourceValueMap.get(resourceKey).textContent = formatNumber(state.resources[resourceKey] ?? 0);
      resourceValueMap.get(resourceKey).closest(".resource-chip")?.classList.toggle("is-demand-resource", demandResource === resourceKey);
    }
    const buyCost = formatNumber(getUnitBuyCost(state));
    if (elements.buyCostValue) {
      elements.buyCostValue.textContent = buyCost;
    }
    elements.buyUnitButton.innerHTML = `Buy Worker <span class="button-cost">${buyCost} Gold</span>`;
  }

  function renderBattleMeta() {
    elements.waveValue.textContent = `${state.fortress.waveNumber} / ${CONFIG.fortressWaves.length}`;
    renderWaveTelegraph();
  }

  function renderWaveTelegraph() {
    if (!elements.waveTelegraph) {
      return;
    }
    const currentIndex = state.fortress.waveNumber - 1;
    const waves = CONFIG.fortressWaves.slice(currentIndex, currentIndex + 3);
    elements.waveTelegraph.innerHTML = waves.map((wave, offset) => {
      const archetypes = (wave.composition ?? [{ archetype: "grunt" }])
        .map((entry) => CONFIG.fortressEnemies[entry.archetype]?.icon ?? "")
        .join(" ");
      const bossBadge = wave.isBoss ? `<span class="wave-telegraph-boss">BOSS</span>` : "";
      return `
        <div class="wave-telegraph-chip${offset === 0 ? " is-current" : ""}">
          <span class="wave-telegraph-label">W${currentIndex + offset + 1}</span>
          <span class="wave-telegraph-icons">${archetypes}</span>
          ${bossBadge}
        </div>
      `;
    }).join("");
  }

  // Top-panel SELECTED chip replaced by the worker action popover; keep as no-ops
  // since renderMeta/renderFrame still call them.
  function renderSelectedUnitMeta() {}

  function renderActionHints() {}

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

      for (let index = 0; index < getMineMaxLevel(); index += 1) {
        if (!mine.purchasedSlotIndices?.[index] || !mine.workerIds[index]) {
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
      // Both zones are visible on the single page, so every burst animates from its real source.
      playResourceBurst(elements, burst, getBurstSourceScreen(burst));
    }

    state.ui.handledResourceBurstIds = [...handled].slice(-160);
    if (state.resourceBursts.length > 80) {
      state.resourceBursts = state.resourceBursts.slice(-80);
    }
  }

  function updateEarlyStartHint(button, gameState) {
    const early = gameState.fortress.earlyStart;
    if (!early || early.window <= 0 || gameState.fortress.battle.active) {
      button.removeAttribute("data-early-bonus");
      button.removeAttribute("title");
      return;
    }
    const fraction = Math.max(0, Math.min(1, early.remaining / early.window));
    const bonus = Math.round(early.bonus * fraction);
    button.dataset.earlyBonus = String(bonus);
    button.title = bonus > 0
      ? `Early-start bonus: +${bonus} gold (${early.remaining.toFixed(1)}s left)`
      : "Early-start bonus expired.";
  }

  function renderMeta() {
    document.body.classList.toggle("fortress-battle-active", state.fortress.battle.active);
    elements.fortressFightButton.disabled = state.fortress.battle.active || state.game.isOver || Boolean(state.fortress.pendingRewardDraft?.length);
    elements.fortressFightButton.hidden = state.fortress.battle.active;
    elements.fortressGiveUpButton.hidden = !state.fortress.battle.active;
    updateEarlyStartHint(elements.fortressFightButton, state);
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
    renderCapstoneChoices();
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
    renderWorkerActionPopover();
    renderMoveModeCancelButton();
    flushResourceBursts();
  }

  let lastBattleActive = false;
  function renderFrame() {
    document.body.classList.toggle("fortress-battle-active", state.fortress.battle.active);
    renderEconomyMeta();
    renderBattleMeta();
    elements.fortressFightButton.disabled = state.fortress.battle.active || state.game.isOver || Boolean(state.fortress.pendingRewardDraft?.length);
    updateEarlyStartHint(elements.fortressFightButton, state);
    elements.fortressMessage.textContent = state.fortress.message;
    updateFortressShopAffordability();
    // Full fortress field rebuild is heavy — only do it while battle is animating.
    // Outside battle, `render()` on state change is authoritative and instant.
    // Also do a one-shot rebuild the tick a battle ends, so stale enemy/ally sprites clear.
    const battleActive = state.fortress.battle.active;
    if (battleActive) {
      renderFortressField();
    } else if (lastBattleActive) {
      // Battle just ended this tick — do a full render so the field DOM,
      // reward draft overlay, and capstone overlay all catch up in one shot.
      render();
    }
    lastBattleActive = battleActive;
    renderMineProgressFrame();
    renderActionHints();
    updateSelectionTether();
    renderMoveModeCancelButton();
    flushResourceBursts();
  }

  return { render, renderFrame };
}



