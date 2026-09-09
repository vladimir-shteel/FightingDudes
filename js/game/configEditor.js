// Visual config editor — a designer-facing overlay that walks the whole live CONFIG object and
// renders an editable field for every leaf value it finds. Nothing here is hand-curated per section:
// add a key to any data/*.json file and it shows up here automatically, in exchange for a plainer
// layout than a hand-built form would give you (see architecture note: CONFIG is one flat object
// assembled from all data/*.json files, so walking it walks everything at once).
//
// Edits apply to the LIVE CONFIG immediately (systems read CONFIG.* at the point of use, so this
// needs no separate "apply" step) — already-spawned enemies/buildings keep the stats they were
// created with, but the next spawn/purchase picks up the new numbers. Persistence across a reload is
// a separate, explicit action (Save), so a designer can try a value without it surviving a refresh.
import {
  CONFIG,
  saveConfigOverride,
  clearConfigOverride,
  applyConfigOverride,
  getDefaultConfigVersion,
  stampNextConfigVersion
} from "./config.js";

// Top-level CONFIG keys grouped into named categories purely for navigation in this editor — CONFIG
// itself stays one flat object, this is just how the tree is presented. A category is rendered only if
// at least one of its keys actually exists on CONFIG; any key that shows up on CONFIG but isn't listed
// in any category here (e.g. a brand-new key from a future data/config.json addition that this file
// hasn't been updated for) falls into a catch-all "Other" category at the end, so nothing is ever
// silently hidden.
const CATEGORIES = [
  {
    name: "General",
    hint: "Global pacing: tick rate, starting resources, worker buy-cost curve, passive gold trickle.",
    keys: [
      "version", "tickRateMs", "goldIcon",
      "startingGold", "startingResources", "startingOre",
      "unitBuyBaseCost", "unitBuyExponent", "productionMultipliers",
      "passiveGoldPerSecond", "passiveGoldPerSecondPerUnlockedMine", "passiveGoldPayoutIntervalSeconds"
    ]
  },
  {
    name: "Combat",
    hint: "How the battle tick feels and scales: wave-scaling formulas plus low-level engine tuning (pathing, collision, projectile speed, engage ranges).",
    keys: ["combat", "combatEngine"]
  },
  {
    name: "Waves & Enemies",
    hint: "The wave order (composition, pacing, rewards) and the enemy archetypes that populate it.",
    keys: ["fortressWaves", "fortressEnemies", "waveDemand"]
  },
  {
    name: "Buildings",
    hint: "Everything about the build field: per-building stats/costs, cost escalation, demolish/repair economics, and the field's starting obstacles.",
    keys: [
      "fortressBuildings", "fortressUnits", "buildingCostEscalation",
      "demolish", "fortress", "attrition", "abilityCostAccumulation"
    ]
  },
  {
    name: "Units & Merging",
    hint: "Reserve-worker stats per level, the merge cap and its wave-gated ramp, and the worker trait/capstone system.",
    keys: ["unitLevels", "merge", "workerTraits"]
  },
  {
    name: "Mining",
    hint: "Mine resource types, unlock/slot costs, and per-level production.",
    keys: ["mine"]
  },
  {
    name: "Rewards",
    hint: "The victory-reward card pool — composition, odds, and effect strength.",
    keys: ["rewardDraft"]
  }
];

// Descriptions keyed by full dot-path from the CONFIG root. Looked up for BOTH container headers (a
// visible line under the section name) and leaf rows (folded into the hover tooltip, since a visible
// line on every one of a few hundred leaf rows would bury the tree rather than help navigate it).
// Not exhaustive by design: a field whose name is already self-explanatory in context (e.g. `hp` inside
// a specific enemy) doesn't need an entry here — this targets the genuinely non-obvious knobs.
const HINTS = {
  version: "Config format version. Auto-stamped by this editor's Save/Export — see the version badge above. Rarely worth hand-editing.",
  tickRateMs: "Simulation tick length in ms — lower is smoother but costs more CPU. Also paces the main loop's frame delay.",
  goldIcon: "Emoji shown next to the gold currency everywhere in the UI.",
  passiveGoldPerSecond: "Not currently read by any system — the live passive-gold knob is passiveGoldPerSecondPerUnlockedMine below.",
  passiveGoldPerSecondPerUnlockedMine: "Passive gold trickle per unlocked mine, paid out regardless of whether anyone is mining — keeps committing every worker to a battle from soft-locking the economy.",
  passiveGoldPayoutIntervalSeconds: "How often (seconds) the passive gold trickle above pays out.",
  startingGold: "Gold the run starts with.",
  startingResources: "Non-gold resources the run starts with, per resource key.",
  startingOre: "A floor applied to starting ore specifically, on top of (not instead of) startingResources.ore.",
  unitBuyBaseCost: "Base gold cost of the very first reserve worker, before the exponential scaling below.",
  unitBuyExponent: "Growth rate of reserve-worker buy cost: cost = unitBuyBaseCost × unitBuyExponent^(total worker power owned).",
  productionMultipliers: "Baseline mine production multiplier while a worker is resting (not on a battle shift).",

  combat: "Wave-scaling formulas for enemy HP/attack/armor growth and per-level ally stat bonuses. Coefficients only.",
  "combat.hpScalePerWave": "Enemy HP growth per wave past the first — multiplicative, so archetype identity (swarm vs tank) survives instead of everything converging to one flat HP late-game.",
  "combat.attackScalePerWave": "Enemy attack growth per wave, same multiplicative model as HP.",
  "combat.armorScalePerWave": "Enemy armor growth per wave — only affects enemies that already have armor > 0.",
  "combat.armorMinFraction": "Armor damage floor: a hit is never reduced below this fraction of its raw damage, however high the target's armor is. Keeps armor a soft counter, not full immunity.",
  "combat.unitAttackPerLevel": "Attack bonus per spawner-building level for trained allies (a level-3 barracks' warriors hit harder than a level-1's).",
  "combat.unitHpPerLevel": "HP bonus per spawner-building level for trained allies, same idea as unitAttackPerLevel.",

  combatEngine: "Low-level battle-tick tuning — the constants that shape how the fight FEELS, not how strong anyone is.",
  "combatEngine.repathIntervalSeconds": "How often (seconds) a moving unit recalculates its path to its target.",
  "combatEngine.waypointArrivalDistance": "How close (tiles) a unit must get to a path waypoint before advancing to the next one.",
  "combatEngine.unitCollisionRadius": "Half the minimum distance kept between two units before they push each other apart.",
  "combatEngine.unitPushStrength": "How hard overlapping units push apart per tick — 1.0 fully resolves the overlap each tick.",
  "combatEngine.hitFlashSeconds": "How long a unit visually flashes after being hit.",
  "combatEngine.fieldVerticalMargin": "How far past the field's top/bottom edge a unit is still allowed to stand.",
  "combatEngine.enemySpawnOffset": "Where enemies appear relative to the field when a wave spawns them (x = horizontal offset past the right edge; yMargin/yPadding shape the vertical spread).",
  "combatEngine.squadSpawnSpacing": "Vertical spacing (tiles) between units spawned together as a squad (e.g. a Rally Squad active).",
  "combatEngine.spawnDistanceFromBuilding": "How far in front of its spawner building a newly trained unit appears.",
  "combatEngine.projectileSpeed": "Travel speed (tiles/second) of ranged attacks (turret shots, ranged units, volleys).",
  "combatEngine.projectileHitRadius": "How close a projectile must get to its target to count as a hit.",
  "combatEngine.turretDefaultRange": "Fallback attack range for a turret level that doesn't specify its own range.",
  "combatEngine.meleeEngageBuffer": "Extra range past an enemy's own stated range at which it still counts as in contact with an ally — keeps units from stopping just short of hitting range.",
  "combatEngine.trapMineTriggerRadius": "How close an enemy must walk to a trap-mine building to trigger it.",
  "combatEngine.buildingContactRadius": "How close an enemy must get to a building's footprint before it stops and starts attacking it.",
  "combatEngine.bossAuraTickSeconds": "How often (seconds) a boss with an 'aura' mechanic pulses its area damage.",
  "combatEngine.rangedAttackThreshold": "Allies with attack range ABOVE this value fire a projectile; at or below it, they hit directly with no travel time.",

  fortressWaves: "Wave order: enemy composition (round-robin interleaved into a spawn queue, not one group at a time), spawn pacing, gold rewards, and the early-start bonus. One entry per wave, in play order.",
  fortressEnemies: "Enemy archetypes: hp/attack/speed/armor/tag, plus an optional boss mechanic (aura / summon / breach).",
  waveDemand: "Bonus production multiplier for whichever mine matches the current wave's demanded resource.",
  "waveDemand.slotProductionMultiplier": "Production multiplier applied to a mine's slots when that mine's resource matches the current wave's demandResource.",

  fortressBuildings: "Per-building footprint, buy cost, and per-level stats (hp/damage/cooldown/upgradeCost/active). One entry per building type.",
  fortressUnits: "Base stats for units trained by buildings (warrior/archer/rider/mage).",
  buildingCostEscalation: "Per-building-type cost growth factor as more copies of that type get built. 'default' applies to any type without its own entry.",
  demolish: "Refund fraction and gold cost when demolishing a fortress building.",
  "demolish.refundFraction": "Fraction of resources (and any crystal) sunk into a building that's returned when it's demolished.",
  "demolish.goldCostPerCopy": "Gold cost to demolish a building, per unit of 'invested power' (2^(level-1)) it represents.",
  fortress: "Field setup: starting obstacle count, the cost curve for clearing them, and the fallback repair rate for buildings with no buyCost (the HQ).",
  "fortress.obstacleCount": "Number of scenery obstacle (tree) tiles scattered on the field when a run starts.",
  "fortress.obstacleRemovalBaseCost": "Gold cost to clear the first obstacle tile.",
  "fortress.obstacleRemovalCostStep": "How much the obstacle-clearing cost rises after each tile cleared.",
  "fortress.repairFallbackWoodPerLevel": "Repair cost (wood, per building level) used only for buildings with no buyCost — currently just the HQ.",
  attrition: "How much HP a building loses permanently per defeat, what fraction it's restored to, and the repair cost rate — the per-wave sink coupling mining and combat.",
  "attrition.floorPerDefeat": "Permanent HP-restore penalty added to a building each time it's destroyed — repeated losses squeeze its restored HP until repaired.",
  "attrition.postDefeatHpFraction": "Base fraction of maxHp a destroyed building is restored to, and the floor a win can never delete a building below.",
  "attrition.repairCostPerHpFractionOfBuyCost": "Repair cost rate: fraction of (buyCost × building level) charged per fraction of missing HP.",
  abilityCostAccumulation: "Each building-active cast THIS battle raises the cost of the NEXT cast by this factor — makes actives a recurring sink instead of free-to-spam.",

  unitLevels: "Explicit reserve-worker stats per merge level (name/icon/health/attack/attack speed).",
  merge: "Worker merge cap and its wave-gated unlock schedule, plus the crystal cost for merging fortress buildings into their top tiers.",
  "merge.maxLevel": "Hard cap on worker merge level, regardless of wave.",
  "merge.workerLevelUnlockWaves": "Wave-gated cap ramp — index i is the wave at which merge level i+1 becomes reachable. Keeps the early roster wide instead of racing to max level.",
  "merge.crystalCostByLevel": "Crystal cost to merge a crystalMergeGated building (see fortressBuildings) up to the given target level.",
  workerTraits: "The three worker trait lines (Yield/Golden/Rush), the battle-shift rest mechanic, and the merge-cap capstone bonuses.",
  "workerTraits.mergeBonusPoints": "Extra trait points added to the dominant trait line whenever two workers merge, on top of simply summing their trait vectors.",
  "workerTraits.hybridThreshold": "How close the second-highest trait must be to the dominant one (as a fraction) for a hybrid capstone (Foreman/Warlord) to be offered.",
  "workerTraits.battleShift": "Tuning for the battle-shift mechanic: base Rush strength, how many workers per mine can shift at once, and how rest charges are gained/spent.",
  "workerTraits.battleShift.baseMultiplier": "Rush multiplier a worker gets from shifting with zero Rush trait points — the floor, before any Rush-line bonus.",
  "workerTraits.battleShift.maxCommitsPerMine": "Maximum workers that can be on a battle shift at the same mine simultaneously.",
  "workerTraits.battleShift.restChargePerLevel": "Rest-charge pool size scales with worker level × this — higher-level workers can shift more battles before recharging.",
  "workerTraits.battleShift.restRechargePerWave": "Rest charges regained per wave for a worker NOT currently shifting on its desired mine.",
  "workerTraits.lines": "The three trait lines' display label/icon, their relative odds of being rolled on a new worker (rollWeight), and their per-point bonus strength.",
  "workerTraits.capstones": "The two capstone choices per trait line at max merge level, plus the two hybrid capstones (Foreman, Warlord).",

  mine: "Mine resource types (unlock waves, buy/slot costs) and per-level slot counts/production multipliers.",
  "mine.collectionIntervalSeconds": "Base seconds between production payouts for an occupied slot, before the worker's rest/shift rate factor is applied.",
  "mine.workerProductionByLevel": "Preferred production table: resource amount per payout, keyed by worker level. Used instead of the baseProductionPerSecond formula when present.",
  "mine.baseProductionPerSecond": "Fallback production formula input, only used if workerProductionByLevel has no entry for a worker's level.",
  "mine.goldPerSecondPerWorkerLevel": "Fallback active-worker gold formula input, paired with baseProductionPerSecond.",
  "mine.resourceTypes": "One entry per mine: resource key/label/icon, unlock wave, buy cost, and per-slot unlock waves/costs.",
  "mine.levels": "Per mine-level slot count and per-slot production multipliers — later slots are worth more.",

  rewardDraft: "The victory-reward card pool — a flat list under 'cards'. Each card: category (permanent/temporary/oneShot), weight (odds within its category — 0 means it never appears; this is the rarity knob), and effect (a kind plus whatever numbers that kind needs, e.g. value / durationWaves)."
};

// A handful of string fields only ever take one of a small, code-defined set of values — the game
// simply does nothing (or nothing useful) for anything outside that set, since each value maps to a
// specific `case`-style branch somewhere in the systems. Free-typing these is exactly where a designer
// who doesn't have the source open can silently typo something that looks plausible ("goldMult" instead
// of "goldMultiplier") and get a card that quietly does nothing. Rendering them as a <select> instead
// makes a wrong value structurally impossible to enter — same idea as Dice Lords Eredan's ability
// editor constraining effect kinds to its known list rather than a free text field.
const CAPSTONE_EFFECT_KINDS = [
  "yieldMul", "demandMul", "goldenConversion", "passiveGold", "rushBonus", "battleDamageBonus", "foreman", "warlord"
];
const REWARD_EFFECT_KINDS = [
  "goldMultiplier", "productionMultiplier", "baseHealthBonus", "temporaryMultiplier",
  "promoteWorker", "upgradeBuilding", "unlockMineSlot", "supplyDrop", "massRepair"
];
const BUILDING_ACTIVE_EFFECT_KINDS = ["buildingDamageBoost", "spawnSquad", "volley", "frost", "shield"];
const BOSS_MECHANIC_KINDS = ["aura", "summon", "breach"];
const TEMP_BONUS_KINDS = ["production", "damage", "defense"];

// `kind` means something different depending on WHERE it sits — a reward card's effect.kind and a
// boss's mechanic.kind are unrelated vocabularies that just happen to share a field name. Dispatch on
// the surrounding path (structurally, not by regex on the joined string) rather than the key alone.
function getKindEnumOptions(path) {
  if (path[0] === "workerTraits" && path[1] === "capstones" && path[path.length - 2] === "effect") {
    return CAPSTONE_EFFECT_KINDS;
  }
  if (path[0] === "rewardDraft" && path[1] === "cards" && path[path.length - 2] === "effect") {
    return REWARD_EFFECT_KINDS;
  }
  if (path[0] === "fortressBuildings" && path[path.length - 2] === "effect" && path.includes("active")) {
    return BUILDING_ACTIVE_EFFECT_KINDS;
  }
  if (path[0] === "fortressEnemies" && path[path.length - 2] === "mechanic") {
    return BOSS_MECHANIC_KINDS;
  }
  return null;
}

// `unit`/`archetype` fields are references INTO another part of CONFIG (a trainable unit type, an
// enemy archetype) rather than a fixed vocabulary — so their option list is read live off CONFIG
// instead of being a hardcoded array, and automatically includes anything a designer has already added.
function getEnumOptions(path) {
  const key = path[path.length - 1];
  if (key === "kind") {
    return getKindEnumOptions(path);
  }
  if (key === "bonusKind" && path[0] === "rewardDraft") {
    return TEMP_BONUS_KINDS;
  }
  if (key === "unit" && path[0] === "fortressBuildings") {
    return Object.keys(CONFIG.fortressUnits ?? {});
  }
  if (key === "archetype") {
    return Object.keys(CONFIG.fortressEnemies ?? {});
  }
  if (key === "category" && path[0] === "rewardDraft") {
    // upgradeSystem.js filters/dispatches on these exact three strings (getRewardCardsByCategory,
    // getCardDurationText, applyUpgradeChoice's message branch) — a typo here means the card can never
    // be drawn into a draft at all, silently.
    return ["permanent", "temporary", "oneShot"];
  }
  if (key === "demandResource" && path[0] === "fortressWaves") {
    // Must be one of the mine resource keys (never "gold" — gold isn't a mine resourceKey) or the
    // wave-demand production bonus silently matches no mine at all.
    return (CONFIG.mine?.resourceTypes ?? []).map((resourceType) => resourceType.key);
  }
  if (key === "tag" && path[0] === "fortressEnemies") {
    // Only "boss" is actually read by code (ui.js gates the boss HP bar on it) — the rest are free-form
    // design labels. Still offered as a closed, live-collected list so "boss" can't be mistyped into
    // silently losing its HP bar, while designers can keep inventing new descriptive tags by editing
    // one enemy's tag to a new word (it'll then appear as an option for every other enemy too).
    return [...new Set([...Object.values(CONFIG.fortressEnemies ?? {}).map((enemy) => enemy.tag), "boss"])];
  }
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getValueAtPath(root, path) {
  let node = root;
  for (const part of path) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

function setValueAtPath(root, path, value) {
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    node = node[path[i]];
  }
  node[path[path.length - 1]] = value;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function createConfigEditor(requestRender) {
  let dirty = false;

  // Closed by default via `display:none` — NOT the `hidden` attribute: this element already carries an
  // inline `display:flex` (needed to center the panel while open), and an inline style always beats the
  // browser's low-specificity `[hidden] { display: none }` rule, so `.hidden = true` would silently do
  // nothing and leave the overlay visible. Toggle `style.display` directly instead (see open/close below).
  const overlay = el("div", "fd-cfg-overlay");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:10000",
    "background:rgba(10,8,4,0.55)",
    "display:none", "align-items:center", "justify-content:center",
    "font:500 12px/1.35 system-ui,sans-serif"
  ].join(";");

  const panel = el("div", "fd-cfg-panel");
  panel.style.cssText = [
    "width:min(760px, 94vw)", "height:min(640px, 88vh)",
    "background:#1c160c", "color:#ffe9b0",
    "border-radius:14px", "box-shadow:0 20px 60px rgba(0,0,0,0.5)",
    "display:flex", "flex-direction:column", "overflow:hidden"
  ].join(";");

  const header = el("div", "fd-cfg-header");
  header.style.cssText = "padding:12px 14px;border-bottom:1px solid rgba(255,233,176,0.15);display:flex;flex-direction:column;gap:8px;";

  const titleRow = el("div");
  titleRow.style.cssText = "display:flex;align-items:center;gap:8px;";
  const title = el("strong", null, "Config Editor");
  title.style.cssText = "font-size:14px;letter-spacing:0.02em;";
  const versionBadge = el("span", "fd-cfg-version");
  versionBadge.style.cssText = "opacity:0.6;font-size:11px;flex:1;";
  const closeButton = button("✕", () => close());
  titleRow.append(title, versionBadge, closeButton);

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Filter by path (e.g. \"turret\", \"hp\", \"combatEngine\")";
  searchInput.style.cssText = inputStyle() + "width:100%;";
  searchInput.addEventListener("input", () => applyFilter(searchInput.value));

  const actionRow = el("div");
  actionRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";
  const saveButton = button("💾 Save", () => {
    const version = stampNextConfigVersion();
    saveConfigOverride();
    dirty = false;
    updateSaveButton();
    updateVersionBadge();
    setStatus(`Saved as v${version} — survives a reload, and a shipped update at v${version} or later will retire it automatically.`);
  });
  const exportButton = button("⬇ Export JSON", exportConfig);
  const importButton = button("⬆ Import JSON", () => fileInput.click());
  const resetButton = button("↩ Reset to defaults", resetToDefaults);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.hidden = true;
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) importConfigFile(file);
  });

  actionRow.append(saveButton, exportButton, importButton, resetButton, fileInput);

  const status = el("div", "fd-cfg-status");
  status.style.cssText = "min-height:14px;opacity:0.85;";

  header.append(titleRow, searchInput, actionRow, status);

  const body = el("div", "fd-cfg-body");
  body.style.cssText = "flex:1;overflow:auto;padding:10px 14px;";

  panel.append(header, body);
  overlay.append(panel);
  document.body.append(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay.style.display !== "none") close();
  });

  function inputStyle() {
    return "background:rgba(255,233,176,0.08);border:1px solid rgba(255,233,176,0.25);border-radius:6px;" +
      "color:inherit;font:inherit;padding:5px 7px;";
  }

  function button(text, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.style.cssText = "cursor:pointer;border:1px solid rgba(255,233,176,0.3);border-radius:7px;" +
      "background:rgba(255,233,176,0.08);color:inherit;font:inherit;padding:5px 9px;";
    b.addEventListener("click", onClick);
    return b;
  }

  function updateSaveButton() {
    saveButton.style.background = dirty ? "rgba(255,214,92,0.9)" : "rgba(255,233,176,0.08)";
    saveButton.style.color = dirty ? "#231a09" : "#ffe9b0";
  }

  function setStatus(text, isBad = false) {
    status.textContent = text;
    status.style.color = isBad ? "#ff9d8a" : "#ffe9b0";
  }

  function updateVersionBadge() {
    const defaultVersion = getDefaultConfigVersion();
    versionBadge.textContent = CONFIG.version === defaultVersion
      ? `v${CONFIG.version} (shipped default)`
      : `v${CONFIG.version} — ahead of shipped default v${defaultVersion}`;
  }

  function open() {
    overlay.style.display = "flex";
    searchInput.value = "";
    buildTree();
    updateVersionBadge();
    setStatus("");
  }

  function close() {
    overlay.style.display = "none";
  }

  function toggle() {
    if (overlay.style.display === "none") open();
    else close();
  }

  function commitChange(path) {
    dirty = true;
    updateSaveButton();
    requestRender();
  }

  function buildTree() {
    body.innerHTML = "";
    const shownKeys = new Set();
    for (const category of CATEGORIES) {
      const presentKeys = category.keys.filter((key) => Object.prototype.hasOwnProperty.call(CONFIG, key));
      presentKeys.forEach((key) => shownKeys.add(key));
      if (presentKeys.length === 0) continue;
      body.append(renderCategory(category.name, category.hint, presentKeys));
    }
    // Anything on CONFIG that isn't in any category above (e.g. a new key this file hasn't been
    // updated for yet) still shows up here rather than silently vanishing from the editor.
    const leftoverKeys = Object.keys(CONFIG).filter((key) => !shownKeys.has(key));
    if (leftoverKeys.length > 0) {
      body.append(renderCategory("Other", "Keys not yet sorted into a category above.", leftoverKeys));
    }
  }

  function renderCategory(name, hint, keys) {
    const details = document.createElement("details");
    details.className = "fd-cfg-category";
    details.open = true;
    details.style.cssText = "margin:0 0 14px 0;padding-top:10px;border-top:1px solid rgba(255,233,176,0.25);";

    const summary = document.createElement("summary");
    summary.textContent = name;
    summary.style.cssText = "cursor:pointer;font-weight:800;font-size:13px;letter-spacing:0.06em;" +
      "text-transform:uppercase;color:#ffd65c;padding:2px 0 4px;";
    details.append(summary);

    if (hint) {
      const hintLine = el("div", "fd-cfg-hint", hint);
      hintLine.style.cssText = "opacity:0.65;font-size:11px;margin:0 0 8px 1px;";
      details.append(hintLine);
    }

    for (const key of keys) {
      details.append(renderNode([key], CONFIG[key], 0));
    }
    return details;
  }

  function renderNode(path, value, depth) {
    if (Array.isArray(value)) {
      return renderContainer(path, value, true, depth);
    }
    if (isPlainObject(value)) {
      return renderContainer(path, value, false, depth);
    }
    return renderLeafRow(path, value);
  }

  function renderContainer(path, obj, isArray, depth) {
    const details = document.createElement("details");
    details.className = "fd-cfg-group";
    details.style.cssText = `margin:2px 0 2px ${depth === 0 ? 0 : 10}px;padding-left:8px;` +
      "border-left:2px solid rgba(255,233,176,0.15);";

    const summary = document.createElement("summary");
    const lastKey = path[path.length - 1];
    const countLabel = isArray ? ` [${obj.length}]` : "";
    summary.textContent = `${lastKey}${countLabel}`;
    summary.style.cssText = `cursor:pointer;padding:3px 0;${depth === 0 ? "font-weight:700;font-size:13px;" : "opacity:0.9;"}`;
    const hint = HINTS[path.join(".")];
    summary.title = hint ? `${path.join(".")} — ${hint}` : path.join(".");
    details.append(summary);

    if (hint) {
      const hintLine = el("div", "fd-cfg-hint", hint);
      hintLine.style.cssText = "opacity:0.6;font-size:11px;margin:0 0 4px 2px;";
      details.append(hintLine);
    }

    const keys = isArray ? obj.map((_, index) => index) : Object.keys(obj);
    for (const key of keys) {
      details.append(renderNode([...path, key], obj[key], depth + 1));
    }
    return details;
  }

  function renderLeafRow(path, value) {
    const row = el("div", "fd-cfg-row");
    row.dataset.path = path.join(".").toLowerCase();
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:2px 0 2px 10px;";

    const fullPath = path.join(".");
    const hint = HINTS[fullPath];
    const label = el("span", null, path[path.length - 1]);
    label.title = hint ? `${fullPath} — ${hint}` : fullPath;
    label.style.cssText = "flex:0 0 170px;opacity:0.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      (hint ? "border-bottom:1px dotted rgba(255,233,176,0.5);" : "");
    row.append(label);

    if (typeof value === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.addEventListener("change", () => {
        setValueAtPath(CONFIG, path, input.checked);
        commitChange(path);
      });
      row.append(input);
    } else if (typeof value === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.value = value;
      input.style.cssText = inputStyle() + "width:110px;";
      input.addEventListener("change", () => {
        const parsed = Number(input.value);
        if (Number.isFinite(parsed)) {
          setValueAtPath(CONFIG, path, parsed);
          commitChange(path);
        } else {
          input.value = getValueAtPath(CONFIG, path);
        }
      });
      row.append(input);
    } else if (typeof value === "string" && getEnumOptions(path)) {
      row.append(renderEnumSelect(path, value, getEnumOptions(path)));
    } else if (typeof value === "string") {
      const input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.style.cssText = inputStyle() + "width:240px;";
      input.addEventListener("change", () => {
        setValueAtPath(CONFIG, path, input.value);
        commitChange(path);
      });
      row.append(input);
    } else {
      const placeholder = el("span", null, value === null ? "null" : String(value));
      placeholder.style.opacity = "0.5";
      row.append(placeholder);
    }

    return row;
  }

  // A value already on CONFIG that isn't in the known list (stale data, or a value from before an
  // enum's option set changed) is kept as an extra, visibly-flagged option instead of being silently
  // swapped to whatever the list's first entry is — rendering a <select> must never itself change data.
  function renderEnumSelect(path, value, options) {
    const select = document.createElement("select");
    select.style.cssText = inputStyle() + "width:200px;";

    const isKnown = options.includes(value);
    const displayOptions = isKnown ? options : [value, ...options];
    for (const optionValue of displayOptions) {
      const optionEl = document.createElement("option");
      optionEl.value = optionValue;
      optionEl.textContent = optionValue === value && !isKnown ? `⚠ ${optionValue} (not recognized)` : optionValue;
      if (optionValue === value) optionEl.selected = true;
      select.append(optionEl);
    }
    if (!isKnown) {
      select.style.borderColor = "rgba(255,157,138,0.8)";
      select.title = "Current value doesn't match any known option — selecting a listed one will replace it.";
    }
    select.addEventListener("change", () => {
      setValueAtPath(CONFIG, path, select.value);
      commitChange(path);
    });
    return select;
  }

  function applyFilter(term) {
    const query = term.trim().toLowerCase();
    const rows = body.querySelectorAll(".fd-cfg-row");
    // Categories wrap groups, so both need the same "am I still relevant?" treatment when filtering.
    const containers = body.querySelectorAll(".fd-cfg-group, .fd-cfg-category");

    if (!query) {
      rows.forEach((row) => { row.style.display = ""; });
      body.querySelectorAll(".fd-cfg-category").forEach((category) => { category.style.display = ""; category.open = true; });
      body.querySelectorAll(".fd-cfg-group").forEach((group) => { group.style.display = ""; group.open = false; });
      return;
    }

    rows.forEach((row) => {
      row.style.display = row.dataset.path.includes(query) ? "" : "none";
    });
    // Innermost containers first: a container's own visibility depends on whether any row inside
    // survived, checked directly against descendant rows regardless of nesting depth.
    Array.from(containers).reverse().forEach((container) => {
      const hasVisibleRow = Array.from(container.querySelectorAll(".fd-cfg-row"))
        .some((row) => row.style.display !== "none");
      container.style.display = hasVisibleRow ? "" : "none";
      if (hasVisibleRow) container.open = true;
    });
  }

  function exportConfig() {
    // Bumping here (not just relying on whatever's already in CONFIG.version) means an export always
    // represents "the next release" relative to the shipped baseline, even if the designer never
    // clicked Save first.
    const version = stampNextConfigVersion();
    updateVersionBadge();
    const blob = new Blob([JSON.stringify(CONFIG, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = `fightingdudes-config-v${version}-${stamp}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(`Exported as v${version} — drop this in as data/config.json to make it the new shipped baseline.`);
  }

  function importConfigFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (error) {
        setStatus(`${file.name}: not valid JSON (${error.message}).`, true);
        return;
      }
      if (!isPlainObject(data)) {
        setStatus(`${file.name}: expected a JSON object at the top level.`, true);
        return;
      }
      applyConfigOverride(data);
      dirty = false;
      updateSaveButton();
      buildTree();
      updateVersionBadge();
      requestRender();
      setStatus(`${file.name} imported — applied live and saved.`);
    };
    reader.onerror = () => setStatus(`Could not read ${file.name}.`, true);
    reader.readAsText(file);
  }

  function resetToDefaults() {
    const confirmed = window.confirm("Reset all config values to the data/*.json defaults and restart the page? This discards saved overrides.");
    if (!confirmed) return;
    clearConfigOverride();
    window.location.reload();
  }

  return { open, close, toggle };
}
