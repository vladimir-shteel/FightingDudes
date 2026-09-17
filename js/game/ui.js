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
  canMergeFortressBuildings,
  findAnyFortressBuilding,
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
  hasFortressPlacementOrMerge,
  massMergeFortressBuildings,
  mergeFortressBuildings,
  moveFortressBuilding,
  normalizeFootprint,
  removeFortressObstacle,
  repairFortressBuilding,
  triggerBuildingActive
} from "./systems/fortressSystem.js";
import { attachDrag } from "./dragDrop.js";
import { applyUpgradeChoice } from "./systems/upgradeSystem.js";
import {
  applyWorkerCapstone,
  getDominantTraitKey,
  getMaxRestCharges,
  getTraitIcon,
  getTraitLabel,
  getWorkerCapstoneEffect,
  getWorkerRushMultiplier,
  getWorkerYieldMultiplier,
  WORKER_TRAIT_KEYS
} from "./systems/workerTraitSystem.js";

function buildTraitInfoMarkup() {
  const traits = CONFIG.workerTraits ?? {};
  const lines = traits.lines ?? {};
  const shift = traits.battleShift ?? {};
  const yieldPer = lines.yield?.resourceMultiplierPerPoint ?? 0;
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
    unplacedTray: document.querySelector("#unplacedTray"),
    trayActions: document.querySelector("#trayActions"),
    trayMassMergeButton: document.querySelector("#trayMassMergeButton"),
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

  function handleWorkerCardTap(unitId) {
    if (state.ui.workerActionPopup?.unitId === unitId) {
      closeWorkerActionPopup();
    } else {
      openWorkerActionPopup(unitId);
    }
    onStateChanged();
  }

  function renderWorkerActionPopover() {
    const existing = document.querySelector(".worker-action-popover");
    existing?.remove();

    const context = getWorkerActionContext();
    if (!context) {
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
        <span class="unit-trait unit-trait-rush" title="Rush">R ${rushMult}× Shift</span>
      </div>
      ${capstoneEffect ? `<div class="worker-popover-capstone"><strong>★ ${capstoneEffect.label}</strong>${capstoneEffect.description ? `<span>${capstoneEffect.description}</span>` : ""}</div>` : ""}
      ${shiftNote}
      ${unit.pendingCapstone?.length ? `<button class="fortress-popover-action" type="button" data-popover-capstone>Choose Capstone</button>` : ""}
      ${inMine ? `<button class="fortress-popover-action" type="button" data-popover-return>Return to Reserve</button>` : ""}
      <button class="fortress-popover-action" type="button" data-popover-close>Close</button>
    `;

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
      renderWorkerActionPopover();
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
        renderWorkerActionPopover();
        document.removeEventListener("pointerdown", dismissOnOutsideClick, true);
      };
      document.addEventListener("pointerdown", dismissOnOutsideClick, true);
    }, 0);
  }

  elements.buyUnitButton.addEventListener("click", () => {
    const result = buyUnit(state);
    state.fortress.message = result.reason;
    onStateChanged();
  });

  elements.massMergeButton.addEventListener("click", () => {
    const result = massMergeReserve(state);
    state.fortress.message = result.reason;
    onStateChanged();
  });

  elements.fortressMassMergeButton?.addEventListener("click", () => {
    const result = massMergeFortressBuildings(state);
    state.fortress.message = result.reason;
    closeFortressPopup();
    onStateChanged();
  });

  elements.trayMassMergeButton?.addEventListener("click", () => {
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

    for (const unit of state.reserveUnits) {
      const card = createUnitCard(unit, { origin: "reserve", compact: true });

      card.addEventListener("click", () => {
        handleWorkerCardTap(unit.id);
      });

      attachWorkerDrag(card, { source: "reserve", unitId: unit.id });

      elements.reserveZone.append(card);
    }
  }

  function renderMines() {
    elements.minesGrid.innerHTML = "";
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
          slot.innerHTML = `${slotBadge}<div class="slot-placeholder">Drag here</div>`;
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
            handleWorkerCardTap(worker.id);
          });
          attachWorkerDrag(workerCard, {
            source: "mine",
            unitId: worker.id,
            mineId: mine.id,
            slotIndex: index
          });
          slotShell.append(workerCard);
          slotShell.insertAdjacentHTML(
            "beforeend",
            createMineProgressMarkup(mine.resourceKey, mine.id, index, progress)
          );
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

  // ---------------------------------------------------------------------------
  // Drag & drop (pointer-based, mouse + touch).
  //
  // Every interaction below ends in one of the existing system calls
  // (moveFortressBuilding / mergeFortressBuildings / assignReserveUnitToMine / …) —
  // drag is a new INPUT layer, not new rules. Releasing the pointer over nothing
  // valid cancels silently (unplaced buildings just stay in the tray).
  // ---------------------------------------------------------------------------

  const isUnplacedFortressBuilding = (buildingId) =>
    (state.fortress.unplacedBuildings ?? []).some((item) => item.id === buildingId);

  // Drop targets are resolved GEOMETRICALLY (pointer → field rect → tile coords), not via
  // event.target: battle sprites and the pointer-events:none battle tiles must not break the
  // hit-test, and mid-drag DOM rebuilds (cheats, config editor) can't leave dangling references.
  function tileFromPoint(clientX, clientY) {
    const fieldRect = elements.fortressField.getBoundingClientRect();
    if (!fieldRect.width || !fieldRect.height) {
      return null;
    }
    const col = Math.floor(((clientX - fieldRect.left) / fieldRect.width) * FORTRESS_WIDTH);
    const row = Math.floor(((clientY - fieldRect.top) / fieldRect.height) * FORTRESS_HEIGHT);
    if (col < 0 || col >= FORTRESS_WIDTH || row < 0 || row >= FORTRESS_HEIGHT) {
      return null;
    }
    return state.fortress.field.find((tile) => tile.x === col && tile.y === row) ?? null;
  }

  let fortressHighlightEls = [];
  function setFortressDropHighlight(tiles, ok) {
    for (const el of fortressHighlightEls) {
      el.classList.remove("drag-drop-ok", "drag-drop-bad");
    }
    fortressHighlightEls = [];
    for (const tile of tiles) {
      const el = elements.fortressField.querySelector(`[data-x="${tile.x}"][data-y="${tile.y}"]`);
      if (el) {
        el.classList.add(ok ? "drag-drop-ok" : "drag-drop-bad");
        fortressHighlightEls.push(el);
      }
    }
  }
  function clearFortressDropHighlight() {
    setFortressDropHighlight([], true);
    clearTrayDropHighlight();
  }

  let trayHighlightEl = null;
  function clearTrayDropHighlight() {
    if (trayHighlightEl) {
      trayHighlightEl.classList.remove("drag-drop-ok");
      trayHighlightEl = null;
    }
  }
  function setTrayDropHighlight(targetId) {
    clearTrayDropHighlight();
    const el = elements.unplacedTray?.querySelector(`[data-building-id="${targetId}"]`);
    if (el) {
      el.classList.add("drag-drop-ok");
      trayHighlightEl = el;
    }
  }
  function trayBuildingIdFromPoint(clientX, clientY) {
    const token = document.elementFromPoint(clientX, clientY)?.closest("[data-building-id]");
    if (!token || !token.closest("#unplacedTray")) return null;
    return token.dataset.buildingId ?? null;
  }

  // What would happen if `buildingId` were released on tile (x, y)?
  // Returns { ok, action, ... } where action is "place" | "merge" | "invalid", or null
  // when the building no longer exists (drop should be a silent no-op then).
  function describeFortressDrop(buildingId, x, y) {
    const building = findAnyFortressBuilding(state, buildingId);
    if (!building) {
      return null;
    }
    const tile = state.fortress.field.find((item) => item.x === x && item.y === y);
    if (!tile) {
      return null;
    }
    if (tile.occupant === "obstacle") {
      return { ok: false, action: "invalid" };
    }
    if (!tile.occupant) {
      const fits = canPlaceFortressBuilding(state, building.type, { x, y }, building.id);
      return { ok: fits, action: fits ? "place" : "invalid", x, y };
    }
    const target = getFortressBuildingForTile(tile);
    if (target && canMergeFortressBuildings(state, building, target)) {
      return { ok: true, action: "merge", targetId: target.id };
    }
    return { ok: false, action: "invalid" };
  }

  function highlightFortressDrop(buildingId, x, y) {
    const descriptor = describeFortressDrop(buildingId, x, y);
    const building = findAnyFortressBuilding(state, buildingId);
    if (!descriptor || !building) {
      clearFortressDropHighlight();
      return;
    }
    if (descriptor.action === "place") {
      // Show the whole footprint lighting up, not just the tile under the cursor.
      const tiles = normalizeFootprint(building.type).map((offset) => ({
        x: x + offset.x,
        y: y + offset.y
      }));
      setFortressDropHighlight(tiles, true);
    } else {
      setFortressDropHighlight([{ x, y }], descriptor.ok);
    }
  }

  function executeFortressDrop(buildingId, x, y) {
    const descriptor = describeFortressDrop(buildingId, x, y);
    if (!descriptor) {
      return false;
    }
    if (descriptor.action === "place") {
      const result = moveFortressBuilding(state, buildingId, { x, y });
      state.fortress.message = result.reason;
      if (result.ok) {
        state.fortress.movingBuildingId = null;
      }
      onStateChanged();
      return true;
    }
    if (descriptor.action === "merge") {
      const result = mergeFortressBuildings(state, buildingId, descriptor.targetId);
      state.fortress.message = result.reason;
      if (result.ok) {
        state.fortress.movingBuildingId = null;
      }
      onStateChanged();
      return true;
    }
    // Valid target missing under the cursor: cancel, nothing moves.
    state.fortress.message = "Nothing fits there — building stays put.";
    onStateChanged();
    return true;
  }

  function dismissInteractionOverlays() {
    // Popover DOM lives outside the drag payload; drop it immediately so it doesn't dangle
    // under the ghost. (State flags are cleared too; the next render re-syncs.)
    closeFortressPopup();
    closeWorkerActionPopup();
    document.querySelector(".fortress-action-popover")?.remove();
    document.querySelector(".worker-action-popover")?.remove();
  }

  function attachFortressBuildingDrag(element, buildingId) {
    attachDrag(element, {
      getPayload: () => (findAnyFortressBuilding(state, buildingId) ? { buildingId } : null),
      onDragStart: () => dismissInteractionOverlays(),
      onDragMove: (payload, event) => {
        const tile = tileFromPoint(event.clientX, event.clientY);
        if (tile) {
          clearTrayDropHighlight();
          highlightFortressDrop(payload.buildingId, tile.x, tile.y);
        } else {
          clearFortressDropHighlight();
          const trayTargetId = trayBuildingIdFromPoint(event.clientX, event.clientY);
          if (trayTargetId && trayTargetId !== payload.buildingId) {
            const source = findAnyFortressBuilding(state, payload.buildingId);
            const target = findAnyFortressBuilding(state, trayTargetId);
            if (source && target && canMergeFortressBuildings(state, source, target)) {
              setTrayDropHighlight(trayTargetId);
            }
          }
        }
      },
      onDragEnd: (payload, event) => {
        clearFortressDropHighlight();
        const tile = tileFromPoint(event.clientX, event.clientY);
        if (tile) {
          return executeFortressDrop(payload.buildingId, tile.x, tile.y);
        }
        const trayTargetId = trayBuildingIdFromPoint(event.clientX, event.clientY);
        if (trayTargetId && trayTargetId !== payload.buildingId) {
          const source = findAnyFortressBuilding(state, payload.buildingId);
          const target = findAnyFortressBuilding(state, trayTargetId);
          if (source && target && canMergeFortressBuildings(state, source, target)) {
            const result = mergeFortressBuildings(state, payload.buildingId, trayTargetId);
            state.fortress.message = result.reason;
            if (result.ok) state.fortress.movingBuildingId = null;
            onStateChanged();
            return true;
          }
        }
        // Released off the field: unplaced buildings stay in the tray, placed ones stay put.
        if (isUnplacedFortressBuilding(payload.buildingId)) {
          state.fortress.message = "Drop the building on the fortress field to place it.";
          onStateChanged();
        }
        return false;
      },
      onDragCancel: () => clearFortressDropHighlight()
    });
  }

  // --- worker drag (reserve ⇄ mine slots, merge on matching levels) ---

  let workerHighlightEl = null;
  function setWorkerDropHighlight(el, ok) {
    if (workerHighlightEl) {
      workerHighlightEl.classList.remove("drag-drop-ok", "drag-drop-bad");
    }
    workerHighlightEl = el ?? null;
    if (el) {
      el.classList.add(ok ? "drag-drop-ok" : "drag-drop-bad");
    }
  }
  function clearWorkerDropHighlight() {
    setWorkerDropHighlight(null);
  }

  function findWorkerUnit(payload) {
    if (payload.source === "reserve") {
      const unit = state.reserveUnits.find((item) => item.id === payload.unitId);
      return unit ? { unit, source: "reserve" } : null;
    }
    const mine = state.mines.find((item) => item.id === payload.mineId);
    const unit = mine?.workerIds[payload.slotIndex];
    return unit && unit.id === payload.unitId
      ? { unit, source: "mine", mineId: payload.mineId, slotIndex: payload.slotIndex }
      : null;
  }

  // Drop resolution for a dragged worker. Returns { ok, action, ... } with action one of
  // "to-slot" (assign/move/swap), "merge-mine", "merge-reserve", "return", "invalid" —
  // or null when the drop location is irrelevant (silent cancel).
  function describeWorkerDrop(payload, targetEl) {
    const context = findWorkerUnit(payload);
    if (!context || !targetEl) {
      return null;
    }

    const slotEl = targetEl.closest("[data-mine-slot]");
    if (slotEl && slotEl.classList.contains("is-open")) {
      const [mineId, slotIndexRaw] = slotEl.dataset.mineSlot.split(":");
      const slotIndex = Number(slotIndexRaw);
      const mine = state.mines.find((item) => item.id === mineId);
      if (mine) {
        if (payload.source === "mine" && payload.mineId === mineId && payload.slotIndex === slotIndex) {
          return null; // dropped back into its own slot
        }
        const targetUnit = mine.workerIds[slotIndex] ?? null;
        if (!targetUnit) {
          return { ok: true, action: "to-slot", mineId, slotIndex };
        }
        if (payload.source === "reserve") {
          const sameLevel = targetUnit.level === context.unit.level;
          return {
            ok: sameLevel,
            action: sameLevel ? "merge-mine" : "invalid",
            mineId,
            slotIndex
          };
        }
        // mine → occupied slot: moveMineUnitToMineSlot merges equal levels, swaps otherwise.
        return { ok: true, action: "to-slot", mineId, slotIndex };
      }
    }

    const reserveCard = targetEl.closest("#reserveZone .unit-card[data-unit-id]");
    if (reserveCard && reserveCard.dataset.unitId !== payload.unitId) {
      const other = state.reserveUnits.find((item) => item.id === reserveCard.dataset.unitId);
      if (other) {
        if (payload.source !== "reserve") {
          // Mine workers return via the pile itself, not by dropping onto another worker.
          return { ok: false, action: "invalid" };
        }
        const sameLevel = other.level === context.unit.level;
        return {
          ok: sameLevel,
          action: sameLevel ? "merge-reserve" : "invalid",
          targetUnitId: other.id
        };
      }
    }

    if (targetEl.closest("#reserveZone") || targetEl.closest(".reserve-panel")) {
      if (payload.source === "mine") {
        return { ok: true, action: "return" };
      }
      return null; // reserve worker dropped on the pile: nothing to do
    }

    return null;
  }

  function highlightWorkerDrop(payload, targetEl) {
    const descriptor = describeWorkerDrop(payload, targetEl);
    if (!descriptor) {
      clearWorkerDropHighlight();
      return;
    }
    const el =
      targetEl.closest("[data-mine-slot]") ??
      targetEl.closest("#reserveZone .unit-card[data-unit-id]") ??
      targetEl.closest("#reserveZone") ??
      targetEl.closest(".reserve-panel");
    setWorkerDropHighlight(el, descriptor.ok);
  }

  function executeWorkerDrop(payload, targetEl) {
    clearWorkerDropHighlight();
    const descriptor = describeWorkerDrop(payload, targetEl);
    if (!descriptor) {
      return false;
    }

    let result;
    if (descriptor.action === "to-slot") {
      result = payload.source === "reserve"
        ? assignReserveUnitToMine(state, payload.unitId, descriptor.mineId, descriptor.slotIndex)
        : moveMineUnitToMineSlot(state, payload.mineId, payload.slotIndex, descriptor.mineId, descriptor.slotIndex);
    } else if (descriptor.action === "merge-mine") {
      result = mergeReserveUnitIntoMineUnit(state, payload.unitId, descriptor.mineId, descriptor.slotIndex);
    } else if (descriptor.action === "merge-reserve") {
      result = mergeReservePair(state, payload.unitId, descriptor.targetUnitId);
    } else if (descriptor.action === "return") {
      result = returnMineUnitToReserve(state, payload.mineId, payload.slotIndex);
    } else {
      state.fortress.message = "Workers drop onto mine slots or matching workers.";
      onStateChanged();
      return true;
    }

    state.fortress.message = result.reason;
    onStateChanged();
    return true;
  }

  function attachWorkerDrag(element, payload) {
    attachDrag(element, {
      getPayload: () => (findWorkerUnit(payload) ? payload : null),
      onDragStart: () => dismissInteractionOverlays(),
      onDragMove: (dragPayload, event, targetEl) => highlightWorkerDrop(dragPayload, targetEl),
      onDragEnd: (dragPayload, event, targetEl) => executeWorkerDrop(dragPayload, targetEl),
      onDragCancel: () => clearWorkerDropHighlight()
    });
  }

  // --- tray for bought-but-unplaced buildings ---

  function renderUnplacedTray() {
    const tray = elements.unplacedTray;
    if (!tray) {
      return;
    }
    tray.innerHTML = "";
    const unplaced = state.fortress.unplacedBuildings ?? [];
    tray.hidden = unplaced.length === 0;
    if (elements.trayActions) {
      elements.trayActions.hidden = unplaced.length === 0;
    }

    for (const building of unplaced) {
      const definition = CONFIG.fortressBuildings[building.type];
      const token = document.createElement("button");
      token.type = "button";
      token.className = "unplaced-token";
      token.dataset.buildingId = building.id;
      token.classList.toggle("is-moving-source", state.fortress.movingBuildingId === building.id);
      token.innerHTML = `
        <span class="fortress-tile-icon">${definition.icon}</span>
        <strong>${definition.name}</strong>
        <small>Lv ${building.level}</small>
      `;

      attachFortressBuildingDrag(token, building.id);

      // Tap = classic click-placement (same move-mode the field uses); tap again to cancel.
      token.addEventListener("click", () => {
        if (state.fortress.movingBuildingId === building.id) {
          state.fortress.movingBuildingId = null;
          state.fortress.message = "Placement cancelled.";
        } else {
          state.fortress.movingBuildingId = building.id;
          state.fortress.message = "Tap a valid free tile to place this building.";
        }
        onStateChanged();
      });

      tray.append(token);
    }
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

  const battleSpriteRegistry = {
    enemies: new Map(),
    allies: new Map(),
    projectiles: new Map(),
    bursts: new Map(),
    auras: new Map(),
  };

  function clearBattleSpriteRegistry() {
    // The tile-pass wipes elements.fortressField.innerHTML, which destroys these elements too —
    // just forget the now-dead references so the next renderFortressBattleSprites() rebuilds clean.
    for (const map of Object.values(battleSpriteRegistry)) {
      map.clear();
    }
  }

  function updateFortressBuildingTile(building) {
    const tileEl = elements.fortressField.querySelector(`[data-building-id="${building.id}"]`);
    if (!tileEl) {
      return;
    }
    tileEl.classList.toggle("is-hit", isHitFlashing(building));
    tileEl.classList.toggle("is-damaged", building.hp > 0 && building.hp < building.maxHp);
    tileEl.classList.toggle("is-destroyed", building.hp <= 0);
    const hpLine = tileEl.querySelector("small");
    if (hpLine) {
      hpLine.textContent = `Lv ${building.level} · HP ${Math.round(building.hp)}/${building.maxHp}`;
    }
    const indicator = tileEl.querySelector(".fortress-active-indicator");
    if (indicator) {
      const activeDefinition = getBuildingActiveDefinition(building);
      if (activeDefinition && building.hp > 0) {
        const onCooldown = (building.activeCooldown ?? 0) > 0;
        indicator.innerHTML = onCooldown
          ? `<span class="fortress-active-cooldown">${Math.ceil(building.activeCooldown)}s</span>`
          : `<span class="fortress-active-icon">⚡</span>`;
        indicator.hidden = false;
      } else {
        indicator.hidden = true;
      }
    }
  }

  function renderFortressBattleSprites() {
    renderBossHpBar();

    if (state.fortress.battle.active) {
      for (const building of state.fortress.buildings) {
        updateFortressBuildingTile(building);
      }
    }

    const seenAuras = new Set();
    for (const enemy of state.fortress.battle.enemies) {
      if (enemy.hp <= 0 || enemy.mechanic?.kind !== "aura") {
        continue;
      }
      seenAuras.add(enemy.id);
      let auraEl = battleSpriteRegistry.auras.get(enemy.id);
      if (!auraEl) {
        auraEl = document.createElement("div");
        auraEl.className = "fortress-aura";
        elements.fortressField.append(auraEl);
        battleSpriteRegistry.auras.set(enemy.id, auraEl);
      }
      auraEl.style.setProperty("--x", enemy.x);
      auraEl.style.setProperty("--y", enemy.y);
      auraEl.style.setProperty("--radius", enemy.mechanic.radius);
    }
    for (const [id, el] of battleSpriteRegistry.auras) {
      if (!seenAuras.has(id)) {
        el.remove();
        battleSpriteRegistry.auras.delete(id);
      }
    }

    const seenEnemies = new Set();
    for (const enemy of state.fortress.battle.enemies) {
      seenEnemies.add(enemy.id);
      let token = battleSpriteRegistry.enemies.get(enemy.id);
      if (!token) {
        token = document.createElement("div");
        token.className = "fortress-actor fortress-enemy";
        token.innerHTML = "<span></span><i></i>";
        token._icon = token.querySelector("span");
        token._hpBar = token.querySelector("i");
        elements.fortressField.append(token);
        battleSpriteRegistry.enemies.set(enemy.id, token);
      }
      token.classList.toggle("is-hit", isHitFlashing(enemy));
      token.style.setProperty("--x", enemy.x);
      token.style.setProperty("--y", enemy.y);
      token._icon.textContent = enemy.icon;
      token._hpBar.style.width = `${Math.max(0, enemy.hp / enemy.maxHp) * 100}%`;
    }
    for (const [id, el] of battleSpriteRegistry.enemies) {
      if (!seenEnemies.has(id)) {
        el.remove();
        battleSpriteRegistry.enemies.delete(id);
      }
    }

    const seenAllies = new Set();
    for (const ally of state.fortress.battle.allies) {
      seenAllies.add(ally.id);
      let token = battleSpriteRegistry.allies.get(ally.id);
      if (!token) {
        token = document.createElement("div");
        token.className = "fortress-actor fortress-ally";
        token.innerHTML = "<span></span><i></i>";
        token._icon = token.querySelector("span");
        token._hpBar = token.querySelector("i");
        elements.fortressField.append(token);
        battleSpriteRegistry.allies.set(ally.id, token);
      }
      token.classList.toggle("is-hit", isHitFlashing(ally));
      token.style.setProperty("--x", ally.x);
      token.style.setProperty("--y", ally.y);
      token._icon.textContent = ally.icon;
      token._hpBar.style.width = `${Math.max(0, ally.hp / ally.maxHp) * 100}%`;
    }
    for (const [id, el] of battleSpriteRegistry.allies) {
      if (!seenAllies.has(id)) {
        el.remove();
        battleSpriteRegistry.allies.delete(id);
      }
    }

    const seenProjectiles = new Set();
    for (const projectile of state.fortress.battle.projectiles) {
      seenProjectiles.add(projectile.id);
      let shot = battleSpriteRegistry.projectiles.get(projectile.id);
      if (!shot) {
        shot = document.createElement("div");
        shot.className = `fortress-projectile projectile-${projectile.type}`;
        elements.fortressField.append(shot);
        battleSpriteRegistry.projectiles.set(projectile.id, shot);
      }
      shot.style.setProperty("--x", projectile.x);
      shot.style.setProperty("--y", projectile.y);
    }
    for (const [id, el] of battleSpriteRegistry.projectiles) {
      if (!seenProjectiles.has(id)) {
        el.remove();
        battleSpriteRegistry.projectiles.delete(id);
      }
    }

    const seenBursts = new Set();
    for (const burst of state.fortress.battle.bursts ?? []) {
      if (!(burst.duration > 0)) {
        continue;
      }
      seenBursts.add(burst.id);
      let burstEl = battleSpriteRegistry.bursts.get(burst.id);
      if (!burstEl) {
        burstEl = document.createElement("div");
        burstEl.className = "fortress-burst";
        elements.fortressField.append(burstEl);
        battleSpriteRegistry.bursts.set(burst.id, burstEl);
      }
      burstEl.style.setProperty("--x", burst.x);
      burstEl.style.setProperty("--y", burst.y);
      burstEl.style.setProperty("--radius", burst.radius);
      burstEl.style.setProperty("--progress", 1 - burst.remaining / burst.duration);
    }
    for (const [id, el] of battleSpriteRegistry.bursts) {
      if (!seenBursts.has(id)) {
        el.remove();
        battleSpriteRegistry.bursts.delete(id);
      }
    }
  }

  function renderFortressField() {
    elements.fortressField.innerHTML = "";
    clearBattleSpriteRegistry();
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
        tileButton.dataset.buildingId = building.id;
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
          const movingBuilding = findAnyFortressBuilding(state, movingBuildingId);
          const canMerge = canMergeFortressBuildings(state, movingBuilding, building);
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

        attachFortressBuildingDrag(tileButton, building.id);
      } else {
        const movingBuilding = findAnyFortressBuilding(state, state.fortress.movingBuildingId);
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

    // Rebuild the persistent actor/projectile/burst DOM on top of the freshly-rebuilt tiles,
    // since the innerHTML wipe above destroyed the previous sprite elements too.
    renderFortressBattleSprites();
  }

  function closeFortressPopup() {
    state.ui.fortressPopup = null;
  }

  // Position the action popover with `position: fixed` so it escapes the panel's overflow:hidden
  // (which otherwise clips it now that the battle panel is content-height). Anchors on the tapped
  // tile, prefers to sit below it, flips above when it would run off the bottom, and stays on screen.
  function positionFortressPopover(popup, tileX, tileY) {
    const fieldRect = elements.fortressField.getBoundingClientRect();
    if (!fieldRect.width || !fieldRect.height) {
      return;
    }
    const anchorX = fieldRect.left + ((tileX + 0.5) / FORTRESS_WIDTH) * fieldRect.width;
    const anchorY = fieldRect.top + ((tileY + 0.5) / FORTRESS_HEIGHT) * fieldRect.height;
    const cellH = fieldRect.height / FORTRESS_HEIGHT;
    const margin = 6;
    popup.style.position = "fixed";
    popup.style.transform = "none";
    popup.style.left = "0px";
    popup.style.top = "0px";
    const rect = popup.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    let left = anchorX - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    let top = anchorY + cellH / 2 + 8;
    if (top + height > window.innerHeight - margin) {
      const above = anchorY - cellH / 2 - 8 - height;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
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
    }

    popup.querySelector("[data-popup-close]")?.addEventListener("click", () => {
      closeFortressPopup();
      onStateChanged();
    });
    elements.fortressField.append(popup);
    positionFortressPopover(popup, popupState.x, popupState.y);
  }

  function buildFortressShopCard(type, definition) {
    const unlockWave = getFortressBuildingUnlockWave(type);
    const isUnlocked = state.fortress.unlockedBuildingTypes.includes(type);
    // Manual placement: buying is still only offered when the copy has somewhere to go —
    // a free tile exists OR an existing same-type pair can absorb it via merge.
    const hasSpace = hasFortressPlacementOrMerge(state, type);
    const buyCost = getFortressBuildingBuyCost(state, type);
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
        hasFortressPlacementOrMerge(state, type) &&
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
      const hasSpace = hasFortressPlacementOrMerge(state, type);
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

    // Desktop mouse wheels scroll vertically; without this handler the wheel goes to the PAGE as
    // soon as the page itself is scrollable (e.g. the unplaced-buildings tray adds height), and
    // the strip stops responding. Convert vertical wheel to horizontal scroll while hovering the
    // strip. Shift+wheel / pinch-zoom keep their native handling.
    shop.addEventListener("wheel", (event) => {
      if (event.ctrlKey || shop.scrollWidth <= shop.clientWidth + 1) {
        return;
      }
      const delta = event.shiftKey ? 0 : (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX);
      if (!delta) {
        return;
      }
      event.preventDefault();
      isProgrammaticScroll = true;
      shop.scrollLeft += delta;
      requestAnimationFrame(() => { isProgrammaticScroll = false; });
    }, { passive: false });
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
    renderUnplacedTray();
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
    renderWorkerActionPopover();
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
    // During battle only update the persistent actor/projectile/burst DOM (CSS tweens
    // their positions between ticks) — never rebuild the tile grid, so the transition
    // isn't reset every 100ms. Outside battle, `render()` on state change is authoritative.
    // Also do a one-shot rebuild the tick a battle ends, so stale enemy/ally sprites clear.
    const battleActive = state.fortress.battle.active;
    if (battleActive) {
      renderFortressBattleSprites();
    } else if (lastBattleActive) {
      // Battle just ended this tick — do a full render so the field DOM,
      // reward draft overlay, and capstone overlay all catch up in one shot.
      render();
    }
    lastBattleActive = battleActive;
    renderMineProgressFrame();
    renderActionHints();
    flushResourceBursts();
  }

  return { render, renderFrame };
}



