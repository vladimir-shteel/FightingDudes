import { CONFIG, getMineMaxLevel, getUnitLevelData } from "../config.js";
import { getMaxWorkerLevel } from "./workerTraitSystem.js";
import { applyFortressBaseHealthBonus } from "./fortressSystem.js";
import { getCapstoneBattleDamageBonus } from "./workerTraitSystem.js";

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function raiseUnitToLevel(unit, targetLevel) {
  if (!unit || unit.level >= targetLevel) {
    return false;
  }

  const levelData = getUnitLevelData(targetLevel);
  if (!levelData) {
    return false;
  }

  unit.name = levelData.name;
  unit.level = targetLevel;
  unit.icon = levelData.icon ?? unit.icon;
  unit.baseHealth = levelData.baseHealth;
  unit.baseAttack = levelData.baseAttack;
  unit.baseAttackSpeed = levelData.baseAttackSpeed;
  return true;
}

function getRewardDraftConfig() {
  return CONFIG.rewardDraft ?? {};
}

function getRewardCards() {
  return getRewardDraftConfig().cards ?? [];
}

function getRewardCardsByCategory(category) {
  return getRewardCards().filter((card) => card.category === category);
}

// Same weighted-pick shape as workerTraitSystem.rollWorkerTraitVector: cards with no `weight` (or a
// non-positive one) default to 1. A category whose cards all roll to zero total weight can't be drawn
// from — rollUpgradeChoices below treats that as "this category has nothing to offer this time".
function weightedRandomCard(cards) {
  const weights = cards.map((card) => Math.max(0, card.weight ?? 1));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return null;
  }
  let roll = Math.random() * totalWeight;
  for (let index = 0; index < cards.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) {
      return cards[index];
    }
  }
  return cards[cards.length - 1] ?? null;
}

function createCard({
  id,
  category,
  title,
  description,
  effectText,
  durationText,
  apply
}) {
  return {
    id,
    category,
    title,
    description,
    effectText,
    durationText,
    apply
  };
}

const TEMP_BONUS_LABELS = { production: "Production", damage: "Damage", defense: "Defense" };

// Numeric effects derive their card text from `effect.value` itself, so a designer retuning a number
// in the config editor can never leave the displayed text quoting a stale figure — a hardcoded
// duplicate of a config number is exactly the kind of drift this system used to have before the JSON
// consolidation. Effects with no single meaningful "value" (the one-shot actions) instead read a
// hand-authored `effectText` straight off the card definition.
function getCardEffectText(cardDef, effect) {
  switch (effect.kind) {
    case "goldMultiplier":
      return `Gold gain x${effect.value ?? 1}`;
    case "productionMultiplier":
      return `Resource gain x${effect.value ?? 1}`;
    case "baseHealthBonus":
      return `+${effect.value ?? 0} base HP`;
    case "temporaryMultiplier":
      return `${TEMP_BONUS_LABELS[effect.bonusKind] ?? "Effect"} x${effect.value ?? 1}`;
    default:
      return cardDef.effectText ?? "";
  }
}

function getCardDurationText(cardDef) {
  if (cardDef.category === "permanent") {
    return "Permanent";
  }
  if (cardDef.category !== "temporary") {
    return "Instant";
  }
  const seconds = Math.max(1, cardDef.effect?.durationSeconds ?? 60);
  return `${seconds}s`;
}

function upgradeFirstWorker(state) {
  const workers = [];
  for (const unit of state.reserveUnits) {
    workers.push({ unit, source: "reserve" });
  }
  for (const mine of state.mines) {
    for (const unit of mine.workerIds) {
      if (unit) {
        workers.push({ unit, source: mine.id });
      }
    }
  }

  // Respect the wave level cap — a free promotion must not vault a worker past the tier the wave
  // gate allows (that cap is what keeps the roster wide and paces capstones).
  const levelCap = getMaxWorkerLevel(state);
  const candidate = workers.find(({ unit }) => unit.level < levelCap) ?? null;
  if (!candidate) {
    return { ok: false, reason: "No worker can be promoted yet (level cap rises each wave)." };
  }

  const nextLevel = candidate.unit.level + 1;
  return raiseUnitToLevel(candidate.unit, nextLevel)
    ? { ok: true, reason: `${candidate.unit.name} promoted to level ${candidate.unit.level}.` }
    : { ok: false, reason: "Worker upgrade failed." };
}

function upgradeFirstBuilding(state) {
  // A free upgrade must not vault a building past the crystal gate (L4+). Otherwise this reward
  // skips the crystal economy entirely and breaks tier pacing.
  const crystalLevels = Object.keys(CONFIG.merge?.crystalCostByLevel ?? {}).map(Number).filter((n) => !Number.isNaN(n));
  const crystalGateLevel = crystalLevels.length ? Math.min(...crystalLevels) : Infinity;
  const building = state.fortress.buildings.find((item) =>
    item.type !== "hq"
    && item.level < (CONFIG.fortressBuildings[item.type]?.levels.length ?? 0)
    && item.level + 1 < crystalGateLevel
  );
  if (!building) {
    return { ok: false, reason: "No building can be upgraded for free (top tiers need 💎 crystal)." };
  }

  const definition = CONFIG.fortressBuildings[building.type];
  const nextLevel = definition.levels[building.level];
  if (!nextLevel) {
    return { ok: false, reason: "No building can be upgraded." };
  }

  building.level += 1;
  building.damageFloor = 0;
  building.maxHp = nextLevel.hp + (state.economy.baseHealthBonus ?? 0);
  building.hp = building.maxHp;
  return { ok: true, reason: `${definition.name} upgraded to level ${building.level}.` };
}

function unlockOrExpandMine(state) {
  // Only unlock/expand what is ALREADY wave-eligible: the reward waives the gold cost, it does NOT
  // skip the wave gates. Unlocking a mine (esp. crystal) or a slot early would break the resource /
  // crystal-gate pacing — exactly the "auto mine upgrade" that facerolled the loop.
  const wave = state.fortress.waveNumber ?? 1;

  const lockedMine = state.mines.find((item) => !item.isUnlocked && wave >= (item.unlockWave ?? 1)) ?? null;
  if (lockedMine) {
    lockedMine.isUnlocked = true;
    lockedMine.purchasedSlotIndices[0] = true;
    lockedMine.level = Math.max(1, lockedMine.level);
    return { ok: true, reason: `${lockedMine.name} unlocked.` };
  }

  for (const mine of state.mines) {
    if (!mine.isUnlocked) continue;
    const nextSlotIndex = (mine.purchasedSlotIndices ?? []).findIndex((isPurchased) => !isPurchased);
    if (nextSlotIndex < 0) continue;
    const slotUnlockWave = mine.slotUnlockWaves?.[nextSlotIndex] ?? 1;
    if (wave < slotUnlockWave) continue;
    mine.purchasedSlotIndices[nextSlotIndex] = true;
    mine.level = Math.min(getMineMaxLevel(), Math.max(mine.level, nextSlotIndex + 1));
    return { ok: true, reason: `${mine.name} gained slot ${nextSlotIndex + 1}.` };
  }

  return { ok: false, reason: "No mine slot is available to expand yet." };
}

function repairFortress(state) {
  let repairedCount = 0;
  for (const building of state.fortress.buildings) {
    if (building.hp < building.maxHp) {
      building.hp = building.maxHp;
      repairedCount += 1;
    }
  }

  if (repairedCount === 0) {
    return { ok: false, reason: "No buildings need repairs." };
  }

  return { ok: true, reason: `Mass repair restored ${repairedCount} building(s).` };
}

function injectResources(state, effect) {
  const gold = Math.max(0, effect.goldInjection ?? 180);
  const resource = Math.max(0, effect.resourceInjection ?? 70);

  state.resources.gold += gold;
  for (const mineType of CONFIG.mine.resourceTypes) {
    state.resources[mineType.key] = (state.resources[mineType.key] ?? 0) + resource;
  }

  return { ok: true, reason: `Supply drop delivered +${gold} gold and +${resource} of each resource.` };
}

// Effect dispatch table — the same `effect.kind` pattern workerTraitSystem uses for capstones. Adding
// a brand-new reward card that reuses one of these kinds needs zero code changes (data/config.json
// only); a genuinely new kind of effect needs one new handler here.
const EFFECT_APPLIERS = {
  goldMultiplier(state, effect) {
    state.economy.goldMultiplier = (state.economy.goldMultiplier ?? 1) * (effect.value ?? 1);
  },
  productionMultiplier(state, effect) {
    state.economy.productionMultiplier = (state.economy.productionMultiplier ?? 1) * (effect.value ?? 1);
  },
  baseHealthBonus(state, effect) {
    const bonus = effect.value ?? 0;
    state.economy.baseHealthBonus = (state.economy.baseHealthBonus ?? 0) + bonus;
    applyFortressBaseHealthBonus(state, bonus);
  },
  temporaryMultiplier(state, effect) {
    // Stage 3: temporary bonuses are now realtime seconds, active immediately (no wave gating). The
    // main game loop ticks `state.fortress.activeUpgradeEffects` down each frame and pulls expired
    // ones. Multipliers on `state.economy.*` are recomputed from that list every tick.
    const seconds = Math.max(1, effect.durationSeconds ?? 60);
    state.fortress.activeUpgradeEffects.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: effect.bonusKind,
      multiplier: effect.value ?? 1,
      remainingSeconds: seconds,
      totalSeconds: seconds
    });
    refreshTemporaryMultiplierState(state);
  },
  promoteWorker(state) {
    return upgradeFirstWorker(state);
  },
  upgradeBuilding(state) {
    return upgradeFirstBuilding(state);
  },
  unlockMineSlot(state) {
    return unlockOrExpandMine(state);
  },
  supplyDrop(state, effect) {
    return injectResources(state, effect);
  },
  massRepair(state) {
    return repairFortress(state);
  }
};

function buildRuntimeCard(cardDef) {
  const effect = cardDef.effect ?? {};
  const applier = EFFECT_APPLIERS[effect.kind];
  return createCard({
    id: cardDef.id,
    category: cardDef.category,
    title: cardDef.title,
    description: cardDef.description,
    effectText: getCardEffectText(cardDef, effect),
    durationText: getCardDurationText(cardDef),
    apply(state) {
      if (!applier) {
        return { ok: false, reason: `Reward card "${cardDef.id}" has an unrecognized effect kind.` };
      }
      return applier(state, effect);
    }
  });
}

function refreshTemporaryMultiplierState(state) {
  const activeEffects = state.fortress?.activeUpgradeEffects ?? [];
  // Temporary reward-card bonuses are ALWAYS-ON multipliers for their remaining seconds. The game loop
  // ticks them down (see tickUpgradeEffects) and refreshes these product multipliers each frame.
  state.economy.temporaryProductionMultiplier = activeEffects
    .filter((effect) => effect.kind === "production")
    .reduce((product, effect) => product * effect.multiplier, 1);
  state.economy.damageMultiplier = activeEffects
    .filter((effect) => effect.kind === "damage")
    .reduce((product, effect) => product * effect.multiplier, 1);
  state.economy.defenseMultiplier = activeEffects
    .filter((effect) => effect.kind === "defense")
    .reduce((product, effect) => product * effect.multiplier, 1);
}

// One card per category (permanent / temporary / oneShot), weighted-random within that category. A
// category with no cards (or all-zero weights) simply contributes nothing — the draft can come back
// with fewer than 3 cards rather than crashing, so a designer emptying a category out is safe.
// Stage 3: drafts are queued — a boss-wave drop pushes a fresh 3-card set onto pendingRewardDrafts and
// the modal walks the queue one draft at a time.
export function rollUpgradeChoices(state) {
  const draft = shuffle(
    ["permanent", "temporary", "oneShot"]
      .map((category) => weightedRandomCard(getRewardCardsByCategory(category)))
      .filter(Boolean)
      .map(buildRuntimeCard)
  );

  if (!Array.isArray(state.fortress.pendingRewardDrafts)) {
    state.fortress.pendingRewardDrafts = [];
  }
  state.fortress.pendingRewardDrafts.push(draft);
  return draft;
}

export function applyUpgradeChoice(state, choiceId) {
  const drafts = state.fortress.pendingRewardDrafts ?? [];
  const currentDraft = drafts[0];
  const choice = currentDraft?.find((item) => item.id === choiceId);
  if (!choice) {
    return { ok: false, reason: "Reward card is no longer available." };
  }

  const result = choice.apply(state);
  if (result?.ok === false) {
    return result;
  }

  if (choice.category === "temporary") {
    state.fortress.message = `${choice.title} active.`;
  } else {
    state.fortress.message = `${choice.title} applied.`;
  }

  // Drop the head draft — if more remain, the UI shows the next one immediately without closing.
  drafts.shift();
  return { ok: true, reason: state.fortress.message };
}

// Stage 3: `beginFortressWave`/`endFortressWave` are gone. Temporary bonuses now tick per-second in
// the main game loop instead of gating on wave boundaries. Effects with a `remainingSeconds` timer
// count down; when they hit zero the entry is dropped and multipliers are recomputed.
export function tickUpgradeEffects(state, deltaSeconds) {
  const active = state.fortress?.activeUpgradeEffects;
  if (!Array.isArray(active) || active.length === 0) {
    return;
  }
  let changed = false;
  for (const effect of active) {
    effect.remainingSeconds = (effect.remainingSeconds ?? 0) - deltaSeconds;
  }
  const survivors = active.filter((effect) => (effect.remainingSeconds ?? 0) > 0);
  if (survivors.length !== active.length) {
    changed = true;
  }
  state.fortress.activeUpgradeEffects = survivors;
  if (changed) {
    refreshTemporaryMultiplierState(state);
  }
}

export function getFortressGoldMultiplier(state) {
  return Math.max(1, state.economy.goldMultiplier ?? 1);
}

export function getFortressResourceMultiplier(state) {
  return Math.max(1, state.economy.productionMultiplier ?? 1);
}

export function getFortressBaseHealthBonus(state) {
  return Math.max(0, state.economy.baseHealthBonus ?? 0);
}

export function getTemporaryProductionMultiplier(state) {
  return Math.max(1, state.economy.temporaryProductionMultiplier ?? 1);
}

function getCommittedSkirmisherBonus(state) {
  if (!state.fortress.battle.active) {
    return 0;
  }
  let bonus = 0;
  // Stage 3: capstones now grant their battle damage bonus whenever the worker is standing on a mine
  // during an active match. The old `battleShiftCommitted` gate died with the shift/rest system in
  // stage 2 — this keeps capstones effective without reintroducing shift bookkeeping.
  for (const mine of state.mines) {
    for (const worker of mine.workerIds) {
      if (worker) {
        bonus += getCapstoneBattleDamageBonus(worker);
      }
    }
  }
  return bonus;
}

export function getFortressDamageMultiplier(state) {
  const base = Math.max(1, state.economy.damageMultiplier ?? 1);
  return base * (1 + getCommittedSkirmisherBonus(state));
}

export function getFortressDefenseMultiplier(state) {
  return Math.max(1, state.economy.defenseMultiplier ?? 1);
}
