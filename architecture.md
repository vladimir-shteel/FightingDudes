# Fighting Dudes — Fortress Prototype Architecture

This document describes the **current** prototype: a fortress-defense/merge game where the player
builds and upgrades defensive buildings on an 8×5 grid, staffs mines with mergeable workers, and
survives a fixed sequence of enemy waves. It replaces an earlier, structurally different prototype
(bridgehead/garrison/equipment/Planck.js physics) — none of that exists in the codebase anymore.

## Structure

- `index.html` — static shell for two swipeable "screens" inside `#screenDeck`: `#fortressScreen`
  (build field + battle) and `#productionScreen` (mines + reserve). Switching is a CSS class
  (`show-bottom`), not routing. Also hosts the victory-reward, capstone-choice, and run-end modal
  overlays as body-level siblings (so their `position: fixed` measures against the viewport, not the
  swipe-transformed screen deck).
- `styles.css` — visual theme and responsive layout for both screens and the overlays. No balance
  constants live here; every raw number quoted below lives in `data/config.json`.
- `js/main.js` — boots the game: awaits `initConfig()`, builds initial state, mounts the UI and dev
  tools, then runs the game loop (`tickMineProduction` + `tickFortressBattle` each tick, `ui.renderFrame()`
  every frame). Speed-multiplier cheats run the sim in whole extra sub-steps per tick rather than one
  bigger delta, so pathfinding/collisions stay stable while the clock runs faster. Exposes
  `window.__game = { state, ui, CONFIG, dev, configEditor }` for console/dev-tool access.
- `js/game/state.js` — builds the entire runtime state tree in one place (`createInitialState`).
- `js/game/config.js` — fetches `data/config.json` into one live `CONFIG` object, applies any
  locally-saved config-editor override on top, and exposes small accessor helpers.
- `js/game/configEditor.js` — in-browser visual config editor (see **Config Editor & Dev Tools**).
- `js/game/devTools.js` — the `` ` ``-toggled playtest panel (speed/cheats) that also opens the config editor.
- `js/game/factories.js` — builds runtime entities with stable shapes: reserve workers, mines.
- `js/game/utils.js` — `generateId`, `clamp`, `formatNumber`, `sum`.
- `js/game/systems/*.js` — isolated gameplay rules by domain (see **Main Systems**).
- `js/game/ui.js` — the DOM renderer and interaction layer (tap/click only, no native drag-and-drop).
  Returns `{ render, renderFrame }`: `render()` does a full rebuild after any discrete state change
  (a purchase, a config edit, a merge…), `renderFrame()` is the cheap per-tick redraw the game loop
  calls for live battle animation.
- `data/config.json` — the single balancing/content data file (see **Data Files**).

## Runtime Model

`createInitialState()` (`js/game/state.js`) builds:

- `resources` — a flat currency ledger: `gold` plus one entry per `CONFIG.mine.resourceTypes[].key`
  (currently `wood`, `ore`, `iron`, `crystal`). Seeded from `startingGold`, then `startingResources`
  (per-key override), then `startingOre` (a floor applied on top of `ore` specifically, independent of
  `startingResources.ore`).
- `fortress` — the whole build/battle side of the game, from `fortressSystem.createFortressState()`:
  `field` (an 8×5 tile array, each `{x, y, occupant}` where occupant is `null`, `"obstacle"`, or
  `{buildingId}`), `buildings` (starts with just the HQ), `obstacleRemovalCost` (rises each use),
  `waveNumber`, `unlockedBuildingTypes`, `pendingRewardDrafts[]` (a queue of boss-wave reward drafts
  awaiting a pick), `stream` (the continuous-wave state machine — see **Continuous stream mode (v2)**
  below), and `battle` (`active`, `enemies`, `allies`, `projectiles`, spawn queue/counters, `result`).
- `reserveUnits` — mergeable workers not currently staffing a mine.
- `mines` — one per `CONFIG.mine.resourceTypes` entry (`createMine`), each with its own `workerIds`/
  `workerProgress` arrays, unlock state, purchased-slot bitmap, and level.
- `economy` — multiplier/bonus fields fed by reward cards: `goldMultiplier`, `productionMultiplier`,
  `temporaryProductionMultiplier`, `damageMultiplier`, `defenseMultiplier`, `baseHealthBonus`, plus the
  queued/active temporary-bonus lists that `upgradeSystem` ticks down wave by wave.
- `ui` — `selectedUnitId`, `dragUnitId`, `fortressPopup`, `workerActionPopup`, `handledResourceBurstIds`,
  `isCheatsOpen`. Drives which popover/selection state the renderer shows; no drag-and-drop payload.
- `resourceBursts` — short-lived payout events the UI turns into flying resource-chip animations.
- `game` — `{ isOver, result }`, set once the stream reaches `done` with no enemies left (victory) or
  the HQ's `hp` drops to 0 (defeat) — both are terminal now; see **Continuous stream mode (v2)** below.

## Main Systems

### `fortressSystem.js` — build field, buildings, economy sinks
- Owns the `FORTRESS_WIDTH`/`FORTRESS_HEIGHT` (9×7) grid and building lifecycle: unlock-by-wave
  (`getUnlockedFortressBuildingTypes`), buy (auto-places on a random valid empty tile —
  `findFortressPlacement` — the player repositions afterward via **Move**), upgrade, repair, demolish,
  merge, and move.
- **Buy cost escalation** (`getFortressBuildingBuyCost`): scales with the total *invested power* of
  that building type on the field, `Σ 2^(level-1)` over its instances — exactly like the reserve-worker
  buy curve — so both building wide and building tall raise the next copy's price, and merging is
  power-neutral (two L1 = one L2 in cost terms).
- **Merging** (`mergeFortressBuildings`/`massMergeFortressBuildings`): two same-type, same-level
  buildings combine into one at the next level. Buildings flagged `crystalMergeGated: true` in
  `config.json → fortressBuildings` (barracks, archery, turret, stables, mage tower) additionally
  require crystal for their top-tier merges (`merge.crystalCostByLevel`), gating late power behind the
  one currency mining never produces on its own.
- **Repair** (`getFortressRepairCost`): cost scales with the *missing HP fraction*, not absolute HP, so
  a maxed building never costs an absurd amount to top off; basis is `buyCost × level` (falls back to
  a flat `fortress.repairFallbackWoodPerLevel` × level of wood for buildings with no buy cost, i.e. the HQ).
- **Demolish** (`getFortressBuildingDemolishGoldCost`/`getFortressBuildingRefund`): costs gold
  (`demolish.goldCostPerCopy` × invested copies) and refunds a fraction (`demolish.refundFraction`) of
  the resources (and any crystal) sunk into the building.
- **Attrition coupling** (`applyBuildingAttrition`/`getBuildingMaxHpCap`): a building's `maxHp` is
  always `baseHp + economy.baseHealthBonus` — attrition (see fortress battle system) only ever eats
  current `hp`, never `maxHp`, so a reward-card HP bonus applies retroactively too.
- **Building actives** (`getBuildingActiveDefinition`/`triggerBuildingActive`): only a building's
  top level can carry an `active` ability. Each cast this battle raises the cost of the *next* cast
  (`abilityCostAccumulation ^ castsThisBattle`), making actives a real recurring sink rather than
  free-to-spam. Effect kinds: `buildingDamageBoost` (turret overcharge), `spawnSquad` (barracks/stables
  rally, delegates to `fortressBattleSystem.spawnAllyForBuilding`), `volley` (archery, delegates to
  `volleyFromBuilding`), `frost` (mage tower slow), `shield` (wall damage-reduction aura).

### `fortressBattleSystem.js` — the battle tick
- Enemies and allies move on continuous (non-tile-snapped) coordinates across the same 8×5 field;
  pathing is real A* (`pathfinding.js`) on the tile grid, re-planned every
  `combatEngine.repathIntervalSeconds` or whenever the current target changes. Only live buildings
  block a path tile — scenery obstacles are walkable (clearing them is purely a gold sink, not a
  defensive perk) and trap-mine buildings are transparent to pathfinding (enemies are meant to walk
  into them).
- **Enemy AI** (`tickEnemies`): attack the nearest live ally if in melee-ish range
  (`enemy.range + combatEngine.meleeEngageBuffer`); otherwise check every trap-mine building for
  contact (`combatEngine.trapMineTriggerRadius`) — stepping on one deals its damage to the enemy and
  destroys the mine; otherwise path toward the nearest non-mine attackable building and, once within
  `combatEngine.buildingContactRadius` of its footprint, stop and attack it instead of continuing to path.
- **Ally AI** (`tickAllies`): chase the nearest live enemy; once in range, units past
  `combatEngine.rangedAttackThreshold` tiles of range fire a projectile (`createProjectile`, travels at
  `combatEngine.projectileSpeed`, lands within `combatEngine.projectileHitRadius`, can carry a
  splash radius), everyone else hits directly.
- **Unit separation** (`resolveUnitCollisions`): every live actor pair closer than
  `combatEngine.unitCollisionRadius × 2` gets pushed apart (`combatEngine.unitPushStrength`); a
  near-perfect overlap is broken with a small id-derived deterministic jitter. All actors are then
  clamped inside the field vertically (`combatEngine.fieldVerticalMargin`) — horizontally they're left
  free so enemies can walk in from just off the right edge.
- **Wave scaling** (`createFortressEnemy`): enemy HP/attack/armor scale *multiplicatively* per wave
  past the first (`combat.hpScalePerWave`/`attackScalePerWave`/`armorScalePerWave`) so archetype
  identity (swarm vs. tank) survives into the late game instead of every archetype converging toward
  one flat HP slab.
- **Ally scaling** (`createFortressAlly`): a spawner building's *level* scales the unit it trains
  (`combat.unitAttackPerLevel`/`unitHpPerLevel`), so merging spawner buildings keeps their trained
  units relevant against multiplicatively-scaled enemies.
- **Armor** (`applyDamageToEnemy`): `effective = max(raw × combat.armorMinFraction, raw − armor)` — a
  fractional floor (not zero, not a flat chip) makes armor a real rock-paper-scissors lever: many small
  hits bounce to ~15%, so burst damage (turret/mine) is the efficient counter, but nothing is fully immune.
- **Boss mechanics** (`tickBossMechanic`): `aura` (periodic AoE damage to nearby allies/buildings every
  `combatEngine.bossAuraTickSeconds`) or `summon` (spawns another enemy archetype on an interval).
- **Wave lifecycle**: waves are no longer discrete start/end events the player triggers — see
  **Continuous stream mode (v2)** below for the streaming state machine that now owns spawning,
  pacing, rewards, and win/loss detection (`tickFortressBattle`/`updateBattleMessage`).
- **Per-kill gold** (`awardEnemyKillGold`): each wave sets `killGold`, paid immediately per kill.

### `mineSystem.js` — resource production
- **Production** (`tickMineProduction`): each occupied, purchased slot accumulates progress and pays
  out on a rolling collection interval. `config.json → mine`'s `workerProductionByLevel` table is the
  preferred source of the per-payout amount (`amount[workerLevel] × slotProductionMultiplier`); an
  older flat `baseProductionPerSecond × level × seconds` formula is a fallback if that table is absent.
  Every worker mines at the same rate whether a battle is active or not — the worker-shift/rest system
  that used to modulate this per-worker during battle has been removed (stage 2 of the continuous-stream
  rework). A **passive gold trickle** runs independently per unlocked mine
  (`passiveGoldPerSecondPerUnlockedMine` every `passiveGoldPayoutIntervalSeconds`) purely so the game
  can't soft-lock after every worker gets committed to battle.
- **Wave demand** (`getCurrentWaveDemandResource`/`getDemandMultiplier`): the active wave can name one
  resource; mines producing it get `waveDemand.slotProductionMultiplier` (plus any capstone demand bonus).
- Worker placement/movement (`assignReserveUnitToMine`, `moveMineUnitToMineSlot`,
  `mergeReserveUnitIntoMineUnit`, `returnMineUnitToReserve`…) work the same whether or not a battle is
  active — there is no more shift-lock preventing a worker from being pulled or merged mid-battle.

### `workerTraitSystem.js` — Yield/Rush traits and merge capstones
- Every new worker rolls a trait vector across two lines — **Yield** (production multiplier),
  **Rush** (battle-shift multiplier) — weighted by `workerTraits.lines[key].rollWeight`.
- Merging sums both workers' trait vectors and adds `workerTraits.mergeBonusPoints` to whichever trait
  is now dominant (`mergeWorkerTraitVectors`).
- The worker level cap is wave-gated (`getMaxWorkerLevel`): `merge.workerLevelUnlockWaves[i]` is the
  wave at which level `i+1` becomes reachable, capped at `merge.maxLevel`. This keeps the early roster
  *wide* (surplus bodies sit in reserve, feeding the Shift loop) and paces when capstones unlock.
- At `merge.maxLevel`, a merge offers **capstone** choices (`pickCapstoneCandidates`): the dominant
  trait's own capstones, plus the hybrid capstone if the second-highest trait is within
  `workerTraits.hybridThreshold` of the dominant one (`warlord` = Rush+Yield).
  All five capstones (2 per line + 1 hybrid) are fully data-driven — every capstone's numeric payoff
  lives in `config.json → workerTraits.capstones`, read via `effect.value` (or, for the hybrid
  capstone, its own named field — see **Data Files**).

### `upgradeSystem.js` — victory reward drafts and multiplier accessors
- The reward pool itself is fully data-driven: `config.json → rewardDraft.cards` is a flat array, each
  entry `{ id, category, title, description, weight, effect, effectText? }`. `category` is one of
  `permanent`/`temporary`/`oneShot`; `effect.kind` selects which handler in the `EFFECT_APPLIERS` table
  runs it (`goldMultiplier`, `productionMultiplier`, `baseHealthBonus`, `temporaryMultiplier`,
  `promoteWorker`, `upgradeBuilding`, `unlockMineSlot`, `supplyDrop`, `massRepair`). Adding, removing, or
  retuning a card — including its odds — is a `config.json` edit; a genuinely new *kind* of effect needs
  one new handler function.
  - Numeric effects (`goldMultiplier`, `productionMultiplier`, `baseHealthBonus`, `temporaryMultiplier`)
    render their card text from `effect.value` itself (`getCardEffectText`), so retuning a number can
    never leave the card quoting a stale figure — deliberately, after a past incident where a hand-typed
    fallback number drifted from the real config value (see the git history around the JSON
    consolidation). One-shot action cards (no single meaningful "value") instead carry a hand-authored
    `effectText` string on the card itself.
- `rollUpgradeChoices` draws one card per category after a victory, **weighted** by each card's
  `weight` (default 1 if omitted; a card with `weight: 0` never appears — this is the "rarity" knob).
  Mirrors the same weighted-pick shape `workerTraitSystem.rollWorkerTraitVector` uses for trait lines. A
  category left with zero total weight (or no cards) simply contributes nothing to the draft that time,
  rather than erroring.
  - **Permanent** cards (stock: Gold Dividend / Supply Line / Fortified Core) apply immediately and
    persist for the whole run — including a `baseHealthBonus` retroactively boosting existing buildings.
  - **Temporary** cards (stock: Harvest Surge / War Drums / Shield Wall) queue a production/damage/
    defense multiplier that activates at the *start* of the next battle (`beginFortressWave`) and decays
    after `effect.durationWaves` waves (`endFortressWave`, per-card, defaults to 2 if omitted).
  - **One-shot** cards (stock: Worker Promotion / Building Upgrade / Free Mine Slot / Supply Drop / Mass
    Repair) are instant, and deliberately respect the same gates a normal purchase would (a free building
    upgrade can't skip the crystal-tier gate; a free mine unlock only opens what's already wave-eligible)
    so reward cards can't be used to skip pacing — an ineligible one-shot card reports why and stays in
    the draft rather than being silently consumed.
- Exposes the multiplier accessors other systems read: `getFortressGoldMultiplier`,
  `getFortressResourceMultiplier`, `getFortressDamageMultiplier` (also folds in a flat bonus from any
  battle-shift-committed worker holding the Skirmisher capstone), `getFortressDefenseMultiplier`,
  `getFortressBaseHealthBonus`, `getTemporaryProductionMultiplier`.

### `reserveSystem.js` — buying and merging workers outside a mine
- **Buy cost** (`getUnitBuyCost`): `max(1, floor(unitBuyBaseCost × unitBuyExponent^power × workerBuyDiscount))`,
  where `power = Σ 2^(level-1)` over *every* reserve and mine worker. Buying gets more expensive the
  more total worker "power" you've accumulated, regardless of where those workers currently sit.
- `buyUnit` seeds the new worker with 1 rest charge and a random open mine as its desired mine, so it
  can take a battle shift on its very first fight without ever touching the reserve UI.
- `mergeReservePair`/`massMergeReserve` mirror the mine-slot merge path for reserve-only pairs.

### `pathfinding.js`
- `findTilePath`: a plain 4-neighbour A* (Manhattan heuristic) over the fortress tile grid, shared by
  enemy and ally movement. No gameplay numbers live here.

### `factories.js`
- `createReserveUnit(level, options)` — stats from `config.json → unitLevels`, traits rolled or carried
  over from a merge, rest charges clamped to the level's cap.
- `createMine(index)` — one mine per `config.json → mine.resourceTypes[index % length]` entry, with its
  unlock/slot-wave gates, buy/slot costs, and (for resource types marked `unlockedByDefault`) its first
  slot pre-purchased.

### `ui.js`
- Pure tap/click interaction, no native HTML drag-and-drop: tap a reserve/mine worker card to select
  it, tap another card or an empty mine slot to assign/merge/move it, tap an empty fortress tile to
  buy-and-auto-place a building or clear an obstacle, tap a placed building for a popup
  (Repair/Demolish/Move/Use-Active). Victory-reward and capstone choices render as modal overlay cards.

## Continuous stream mode (v2)

Waves used to be discrete: the player pressed a per-wave start button, fought, and the match paused
between waves for the player to repair/shop. That model is gone. The match now starts with a single
click and waves flow continuously until the run ends.

- **Starting a match**: one click on `#fortressFightButton` (labelled **Start**) calls
  `startFortressBattle`, which activates `state.fortress.stream`. There is no per-wave start button and
  no early-start bonus window (`earlyStart` no longer exists on `state.fortress`).
- **The stream state machine** lives in `state.fortress.stream` (`active`, `phase`,
  `currentWaveIndex`, `gapTimer`) and is driven by `tickFortressBattle`
  (`js/game/systems/fortressBattleSystem.js`). Phases: `idle → spawning → gap → spawning (next
  wave) → … → done`. A boss wave (`wave.waitForClear: true`) substitutes `waitClear` for `gap`: the
  stream holds there until the field is fully clear of enemies before advancing, instead of just
  waiting out a timer.
  - `gap` waits `CONFIG.waveGapSeconds` (global) between non-boss waves.
  - `waitClear` (boss waves only) waits for `enemies.length === 0` regardless of elapsed time.
  - `done` is reached once every wave in `CONFIG.fortressWaves` has been dispatched. **Victory** is
    `phase === "done" && enemies.length === 0`. **Defeat** is HQ `hp <= 0` at any point — it ends the
    match outright now; a lost wave no longer resets to a retryable state.
- **Rewards**: a boss wave's `waitClear → gap` transition pushes a fresh reward draft onto
  `state.fortress.pendingRewardDrafts[]` (queue, not a single slot) — 4 drafts total across a full run.
  The `#upgradeOverlay` modal is **non-blocking**: the game keeps running behind it, and
  `#upgradeAvailableButton` pulses to prompt the player to open the queued draft(s) on their own time.
  `CONFIG.rewardDraftEnabled` gates the whole feature — currently `false`, so no cards drop yet.
- **Repair / Move / Demolish** are casts, not instant actions: triggering one sets
  `building.casting = { kind, startedAt, durationSeconds, ... }`, and `tickBuildingCasts` (called from
  the main loop) resolves it once its duration elapses. **Merge remains instant** — it does not use the
  casting system.
- **Removed**: worker battle-shift/rest, attrition (`damageFloor`/`postDefeatHpFraction`), and the
  per-wave lifecycle functions `finishBattle`, `giveUpFortressBattle`, `earlyStart`,
  `beginFortressWave`, `endFortressWave` no longer exist anywhere in the codebase. Do not reference them
  when describing current behavior.

## Config Editor & Dev Tools

- **`devTools.js`** — the `` ` ``-toggled corner panel: a simulation speed multiplier (1×/2×/4×/8×, run
  as whole extra sub-steps per tick so physics/pathfinding stay stable rather than one giant delta) and
  cheat buttons (+1000 every resource, insta-win the active wave, jump a wave forward, repair every
  building). Its **⚙ Config** button opens the config editor.
- **`configEditor.js`** — a generic tree editor over the *entire* live `CONFIG` object: it walks
  whatever keys exist and renders a number/text/checkbox field for every leaf, so any key added to
  `data/config.json` shows up automatically with no editor code changes. `CONFIG`'s top-level keys are
  sorted into named navigation categories purely for display (`CATEGORIES` — General / Combat /
  Waves & Enemies / Buildings / Units & Merging / Mining / Rewards); a key that shows up on `CONFIG` but
  isn't listed in any category (e.g. a brand-new key this file hasn't been updated for) still renders,
  under a catch-all "Other" category, so nothing is ever silently hidden. A separate `HINTS` map (keyed
  by full dot-path, not just top-level) supplies a one-line description for most sections and several
  dozen individually non-obvious fields — shown as visible text under a section's header, or folded into
  a leaf field's hover tooltip (with a dotted underline marking which leaves have one, so a designer
  knows where to hover) so the couple-hundred plain-named leaves (e.g. `hp`, `damage`) don't get buried
  in text they don't need. Also features a path-substring search filter (auto-expanding matching
  sections at any depth), a version badge next to the title (see below), and explicit **Save** (writes
  the current `CONFIG` to `localStorage`), **Export JSON** (downloads the live config as one file),
  **Import JSON** (merges an uploaded file over `CONFIG` and saves it), and **Reset to defaults** (clears
  the saved override and reloads). Edits apply to the live `CONFIG` immediately — already-existing
  enemies/buildings keep the stats they were created with; only the *next* spawn or purchase picks up a
  changed number.
  - **Enum fields render as a `<select>`, not free text** (`getEnumOptions`/`getKindEnumOptions`): a
    `kind` field means something different depending on where it sits — a reward card's `effect.kind`, a
    boss's `mechanic.kind`, a capstone's `effect.kind`, and a building active's `effect.kind` are four
    unrelated, code-defined vocabularies that happen to share a field name — so the option list is chosen
    by matching the field's *path*, not just its name; `bonusKind` and reward-card `category` (exactly
    `permanent`/`temporary`/`oneShot` — `upgradeSystem.js` filters/dispatches on these literal strings)
    get the same fixed-list treatment. `unit` (under `fortressBuildings`), `archetype`, and
    `fortressWaves[].demandResource` are references into another part of `CONFIG` rather than a fixed
    vocabulary, so their options are read live off `Object.keys(CONFIG.fortressUnits)` /
    `Object.keys(CONFIG.fortressEnemies)` / `CONFIG.mine.resourceTypes[].key` and automatically include
    anything a designer has already added (`demandResource` deliberately excludes `"gold"` — mines are
    never keyed by it, so a wave demanding it would silently match no mine). `fortressEnemies[].tag` is a
    hybrid: only the literal value `"boss"` is functionally read (`ui.js` gates the boss HP bar on it),
    the rest are free-form design labels, so its options are collected live from whatever tags already
    exist across all enemies plus `"boss"` — protects the one value that matters while still letting
    designers invent new descriptive tags. A value already on `CONFIG` that doesn't match any known
    option (stale data, or an option set that changed since) is kept as an extra, visibly-flagged option
    (⚠, red border) rather than the `<select>` silently coercing it to its first entry — rendering the
    tree must never itself change data. Same goal Dice Lords Eredan's ability editor solves for effect
    kinds: make a typo in one of these fields structurally impossible, since the game does nothing useful
    for a value outside the known set.
  - **Export produces exactly `data/config.json`'s shape** — the whole point of `CONFIG` being one flat
    object loaded from one file. A designer can tune values in the running game, hit Export, and hand
    that downloaded file back; dropping it in as the new `data/config.json` (and committing it) makes
    those tweaks the baseline for every player, with no reassembly step in between.
- **Versioning** (`config.js` — `getDefaultConfigVersion`/`stampNextConfigVersion`, top-level
  `CONFIG.version`): every config carries a `version` number. **Save** and **Export** both stamp
  `CONFIG.version = <the shipped default's version at boot> + 1` before persisting/downloading —
  clicking either multiple times in one session keeps landing on the same number rather than climbing
  (2, 2, 2…, not 2, 3, 4…), since it's always "+1 of what's shipped," not "+1 of whatever I saved last."
  On boot, `initConfig()` only applies a saved `localStorage` override if `override.version >
  shippedDefault.version` — **strictly greater**. This is what makes shipping an updated
  `data/config.json` retire everyone's stale local overrides automatically: a designer's local v2 sticks
  around across reloads until the shipped file itself reaches v2 (e.g. because their own Export became
  the new `data/config.json`), at which point `2 > 2` is false, the leftover local copy is dropped
  (and its `localStorage` entry cleared) on the very next load, and the shipped file's own values take
  over — no stale local override can silently keep overriding a newer shipped baseline forever.
  Importing a file does **not** stamp a new version — an imported file's own version travels with it, so
  importing something already-superseded by the current shipped default is subject to the same
  discard-on-next-boot rule as any other saved override.

## Data Files

`js/game/config.js` fetches **one file**, `data/config.json` (with `cache: "no-store"`), straight into
`CONFIG` — no assembly step, because the file already has every key `CONFIG` needs at the top level.
(This used to be seven separate files — `balance.json`, `unit-levels.json`, `mine-levels.json`,
`fortress-buildings.json`, `fortress-units.json`, `fortress-enemies.json`, `fortress-waves.json` —
merged at load time; they were consolidated into one file specifically so the config editor's Export
output and the shipped default file are the *same shape*, making a designer's tuning pass a straight
drop-in replacement instead of a manual reassembly across seven files.)

Top-level keys in `data/config.json`:

- `tickRateMs`, `goldIcon`, `startingGold`/`startingResources`/`startingOre`, `unitBuyBaseCost`/
  `unitBuyExponent`, `productionMultipliers.rest`, `abilityCostAccumulation` — global pacing values.
  (`passiveGoldPerSecond` at the top level is defined but currently **unread by any system** — the live
  passive-trickle knob is `passiveGoldPerSecondPerUnlockedMine` below; don't expect the plain one to do
  anything until/unless a system is wired to it.)
- `combat` — wave-scaling formulas for enemy HP/attack/armor and per-level ally stat bonuses (see
  `fortressBattleSystem.js` above).
- `combatEngine` — low-level battle-tick tuning: repathing cadence, collision/push, projectile speed and
  hit radius, engage/contact/trigger distances, boss aura tick length, the ranged-vs-melee threshold.
  Added so these no longer live as bare magic numbers inside `fortressBattleSystem.js`.
- `fortress` — field setup: obstacle count and its removal-cost curve, the repair-cost fallback rate.
- `buildingCostEscalation`, `demolish`, `waveDemand` — see `fortressSystem.js`/`mineSystem.js` above.
- `workerTraits` — the two trait lines, `battleShift` tuning, `hybridThreshold`, and all five
  `capstones` (each `effect` carries the numbers its `kind` needs — e.g. `{"kind":"yieldMul","value":1.6}`;
  the hybrid capstone instead uses its own named field, `productionMultiplier`).
- `merge` — worker merge cap, `workerLevelUnlockWaves`, and `crystalCostByLevel` for gated buildings.
- `attrition` — see `fortressBattleSystem.js` above.
- `rewardDraft.cards` — the whole victory-reward pool as a flat array (see `upgradeSystem.js` above for
  the card shape, effect kinds, and weighted-pick mechanic).
- `unitLevels` — an array (`name`/`icon`/`baseHealth`/`baseAttack`/`baseAttackSpeed` per reserve-worker
  merge level, currently 7).
- `mine` — `resourceTypes[]` (one entry per mine — `key`, `label`, `icon`, `mineName`, unlock gates,
  buy/slot costs) and `levels[]` (`slots` count and `slotProductionMultipliers[]` per mine level, later
  slots worth more so the UI can badge "fill this one first"), plus the shared
  `collectionIntervalSeconds`, `workerProductionByLevel` table, and the legacy `baseProductionPerSecond`/
  `goldPerSecondPerWorkerLevel` fallback formula inputs.
- `fortressBuildings` — one entry per building type: `name`/`icon`/`description`, `footprint` (tile
  offsets), `unlockedByDefault`/`unlockWave`, `buyCost`, optional `crystalMergeGated`, and a `levels[]`
  array where each level carries whatever that building type needs (`hp` always; `cooldownSeconds`+
  `unit` for trainers; `damage`+`range` for the turret; `upgradeCost` for every non-max level; an
  `active` ability definition only on the top level).
- `fortressUnits` — base `hp`/`attack`/`cooldownSeconds`/`rangeTiles`/`speedTilesPerSecond` (and
  optional `splashRadius`) per trainable ally type (warrior/archer/rider/mage).
- `fortressEnemies` — base stats per enemy archetype, plus an optional `mechanic` block (`aura`,
  `summon`, or `breach`) for the three boss archetypes.
- `fortressWaves` — an ordered array, one entry per wave: `enemyCount`, `spawnIntervalSeconds`,
  `killGold`, `demandResource`, and `composition` (an array of `{archetype, count}` groups that
  `expandComposition` round-robins into an interleaved spawn queue rather than spawning one group at a
  time). Boss waves add `"type": "boss"`/`"isBoss": true` as a display flag and, functionally,
  `waitForClear: true` (see **Continuous stream mode (v2)**).

## Extension Points

- Add a new building type by adding an entry to `config.json → fortressBuildings` (footprint, cost,
  per-level stats) — `fortressSystem.js` and the shop UI pick it up with no code changes as long as its
  `levels[]` shape matches an existing pattern (trainer, turret-like, or trap-like).
- Add a new enemy archetype by adding it to `config.json → fortressEnemies` and referencing its key from
  a wave's `composition` in `config.json → fortressWaves`; give it a `mechanic` block to make it a boss.
- Add a wave by appending to `config.json → fortressWaves` — nothing else needs to change.
- Add a new worker trait line or capstone by extending `config.json → workerTraits`; the effect
  dispatch in `workerTraitSystem.js` reads `effect.kind`/`effect.value`, so a brand-new numeric effect
  kind needs one new `case`-style branch there, but existing kinds need zero code changes to retune.
- Add, remove, or reweight a victory-reward card by editing `config.json → rewardDraft.cards` — reusing
  an existing `effect.kind` needs zero code changes, including tuning its odds via `weight`. A genuinely
  new effect kind needs one new handler in `upgradeSystem.js`'s `EFFECT_APPLIERS`.
- Any new key added to `data/config.json` is automatically editable in the visual config editor — no
  editor code to touch (see **Config Editor & Dev Tools**).
- Replace DOM rendering with canvas or a framework later without rewriting the systems — rules are
  already fully separated from `ui.js`.

## Current Prototype Constraints

- Building purchase auto-places on a random valid tile; the player repositions with **Move** rather
  than dragging a placement preview.
- Loss is terminal: HQ `hp` reaching 0 sets `game.isOver` immediately, same as clearing the final wave.
  There is no retryable-wave/attrition safety net anymore (see **Continuous stream mode (v2)**).
- Reward cards deliberately never bypass wave/crystal gates, even the "free" one-shot ones.
- Because data loads through `fetch()`, the prototype must be opened through a local/static web server
  (see `start-server.bat`) or GitHub Pages — not directly as `file://`.
- The config editor's **Save** persists overrides per-browser via `localStorage`; it does not write back
  to `data/config.json` on disk by itself. To make a tuning pass the new baseline for everyone, use
  **Export JSON** and replace `data/config.json` with the downloaded file — the shapes match exactly, so
  no manual editing or reassembly is needed, just overwrite and commit.
