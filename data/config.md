# Config Reference — `data/config.json`

A field-by-field reference for every parameter in `data/config.json`. Use this to look up "what does
this number do" while tuning values in the in-game **Config Editor** (`` ` `` → ⚙ Config) or editing the
JSON file directly.

This is a *reference*, not a tutorial — for how the systems actually consume these values (formulas,
call sites, file names), see [`architecture.md`](../architecture.md) in the project root. The two
documents are meant to be read together: architecture.md explains the machinery, this one explains the
knobs.

Sections below follow the same grouping the Config Editor uses (General / Combat / Waves & Enemies /
Buildings / Units & Merging / Mining / Rewards), so you can jump between the two.

## How to read the tables

- **Path** — dot path from the root of `config.json`, exactly as it appears in the Config Editor's
  tooltips and search filter. `#` stands for an array index (e.g. `fortressWaves.#.killGold` means
  "`killGold` on any entry in the `fortressWaves` array").
- **Type** — `number`, `string`, `boolean`, `object`, or `array`.
- **Enum** — if the field only accepts one of a fixed set of values, they're listed here. These render
  as a dropdown in the Config Editor, not a free-text box.
- Fields that are just descriptive names/icons/text for players (`name`, `icon`, `label`, `description`,
  `title`) generally aren't repeated field-by-field in the schema tables below — only the mechanically
  meaningful fields get a row.

---

## 1. General

Global pacing values: simulation speed, starting resources, the worker-buying cost curve.

| Path | Type | Description |
|---|---|---|
| `version` | number | Config format version. Don't hand-edit — the Config Editor's Save/Export buttons stamp this automatically (see **Versioning** below). |
| `tickRateMs` | number | Length of one simulation tick, in milliseconds. Lower = smoother but more CPU. Also sets the delay between animation frames in the main loop. |
| `goldIcon` | string | Emoji shown next to the gold currency everywhere in the UI. |
| `startingGold` | number | Gold the run starts with. |
| `startingResources` | object | `{ resourceKey: amount }` — non-gold resources the run starts with. Only keys that already exist in the resource ledger (i.e. real mine resource keys) take effect. |
| `unitBuyBaseCost` | number | Base gold cost of the very first reserve-worker purchase, before scaling. |
| `unitBuyExponent` | number | Growth rate of the worker-buy cost curve. Cost = `unitBuyBaseCost × unitBuyExponent ^ (total worker power owned)`, where "power" sums `2^(level-1)` over every reserve *and* mine worker. |

---

## 2. Combat

How the battle tick scales with waves, and how it *feels* moment-to-moment.

### `combat` — wave-scaling formulas

All of these are **multiplicative per wave past the first** (wave 1 = no bonus), which is what lets
different enemy archetypes keep their identity (glass-cannon "runner" vs. tanky "armored") instead of
every archetype's HP converging to one flat number by wave 20.

| Path | Type | Description |
|---|---|---|
| `combat.hpScalePerWave` | number | Enemy HP multiplier growth per wave. E.g. `0.14` → wave *n* enemy HP = `baseHp × (1 + 0.14 × (n-1))`. |
| `combat.attackScalePerWave` | number | Enemy attack growth per wave, same formula shape as HP. |
| `combat.armorScalePerWave` | number | Enemy armor growth per wave — only affects enemies that already have `armor > 0` in `fortressEnemies` (an enemy with 0 base armor never gains any). |
| `combat.armorMinFraction` | number (0–1) | Armor damage floor. Effective damage = `max(raw × armorMinFraction, raw − armor)` — a hit is **never** reduced below this fraction of its raw value, however high the target's armor. Keeps armor a soft counter (big hits still land) rather than granting immunity. |
| `combat.unitAttackPerLevel` | number | Attack bonus per **spawner-building level** for allies it trains — e.g. a level-3 Barracks' Warriors hit harder than a level-1 Barracks' Warriors. Multiplier = `1 + unitAttackPerLevel × (buildingLevel - 1)`. |
| `combat.unitHpPerLevel` | number | Same idea as `unitAttackPerLevel`, but for the trained unit's HP. |

### `combatEngine` — low-level battle-tick tuning

These constants shape *how the fight feels* — pathing cadence, physical spacing, projectile behavior —
not how strong anyone is. Changing them rarely needs to track balance changes elsewhere.

| Path | Type | Description |
|---|---|---|
| `combatEngine.repathIntervalSeconds` | number (sec) | How often a moving unit recalculates its path to its current target. |
| `combatEngine.waypointArrivalDistance` | number (tiles) | How close a unit must get to a path waypoint before advancing to the next one. |
| `combatEngine.unitCollisionRadius` | number (tiles) | Half the minimum distance kept between two units before they push apart. Must stay small enough that opposing melee units can still overlap into each other's attack range — see the code comment in `fortressBattleSystem.js` for the exact reasoning if you change unit ranges. |
| `combatEngine.unitPushStrength` | number | How hard overlapping units push apart per tick. `1.0` fully resolves the overlap in one tick; lower values resolve it gradually (softer crowding). |
| `combatEngine.hitFlashSeconds` | number (sec) | How long a unit visually flashes white after being hit. Cosmetic only. |
| `combatEngine.fieldVerticalMargin.top` / `.bottom` | number (tiles) | How far past the field's top/bottom edge a unit is still allowed to stand before being clamped back in. |
| `combatEngine.enemySpawnOffset.x` | number (tiles) | Horizontal distance past the field's right edge where enemies spawn. |
| `combatEngine.enemySpawnOffset.yMargin` / `.yPadding` | number (tiles) | Shape the vertical spread of enemy spawn points: `y = random(0, FORTRESS_HEIGHT − yMargin) + yPadding`. |
| `combatEngine.squadSpawnSpacing` | number (tiles) | Vertical spacing between units spawned together as a squad (e.g. a Rally Squad active). |
| `combatEngine.spawnDistanceFromBuilding` | number (tiles) | How far in front of its spawner building a newly trained/spawned unit appears. |
| `combatEngine.projectileSpeed` | number (tiles/sec) | Travel speed of ranged attacks — turret shots, ranged ally attacks, volley/frost-style abilities. |
| `combatEngine.projectileHitRadius` | number (tiles) | How close a projectile must get to its target before it counts as a hit. |
| `combatEngine.turretDefaultRange` | number (tiles) | Fallback attack range used by a turret level that doesn't set its own `range` field (see §4). |
| `combatEngine.meleeEngageBuffer` | number (tiles) | Extra range past an enemy's own stated `rangeTiles` at which it still counts as "in contact" with an ally target — prevents units visibly stopping just short of hitting range. |
| `combatEngine.trapMineTriggerRadius` | number (tiles) | How close an enemy must walk to a Trap Mine building to trigger it. |
| `combatEngine.buildingContactRadius` | number (tiles) | How close an enemy must get to a building's footprint before it stops moving and starts attacking it instead of still pathing closer. |
| `combatEngine.bossAuraTickSeconds` | number (sec) | How often a boss with an `aura` mechanic (see §3) pulses its area damage. |
| `combatEngine.rangedAttackThreshold` | number (tiles) | Allies whose `rangeTiles` is **above** this fire a projectile (travel time applies); at or below it, they hit their target directly with no travel time. |

---

## 3. Waves & Enemies

### `fortressWaves` — array, one entry per wave, in play order

| Field | Type | Description |
|---|---|---|
| `enemyCount` | number | Total enemies this wave spawns. Should equal the sum of `composition[].count` — it's read independently by the UI for progress display, so keep it in sync by hand. |
| `spawnIntervalSeconds` | number (sec) | Time between individual enemy spawns within the wave. |
| `killGold` | number | Gold paid **immediately per kill**. Most early waves use `1`; later waves bump it. |
| `demandResource` | string (enum) | Which mine resource gets `waveDemand.slotProductionMultiplier` (§1/General has the multiplier; see `waveDemand` below) applied to its slots this wave. **Enum**: any key from `mine.resourceTypes[].key` (`wood`/`ore`/`iron`/`crystal` by default) — never `"gold"`, since gold isn't a mine resource and a demand on it would silently do nothing. |
| `composition` | array of `{archetype, count}` | Enemy groups for this wave. `expandComposition` round-robins these into an interleaved spawn queue (so a wave with grunt×5 + runner×2 alternates types as they arrive, rather than 5 grunts then 2 runners back to back). |
| `composition[].archetype` | string (enum) | Which `fortressEnemies` key to spawn. **Enum**: any key in `fortressEnemies` (see below). |
| `composition[].count` | number | How many of that archetype in this wave. |
| `type` | string | **Cosmetic only — not read by any system.** `"boss"` is used by convention on boss waves but nothing checks it; `isBoss` (below) is what actually matters. |
| `isBoss` | boolean *(optional)* | Drives the "BOSS" badge in the wave telegraph UI (`ui.js`). Set alongside `type: "boss"` by convention, but only this field is functionally read. |

### `fortressEnemies` — object keyed by archetype

One entry per enemy archetype. The object's own key (`grunt`, `runner`, …) *is* the archetype id
referenced by `fortressWaves[].composition[].archetype` and `mechanic.archetype` (summon) elsewhere.

| Field | Type | Description |
|---|---|---|
| `hp` | number | Base hit points, before `combat.hpScalePerWave` scaling. |
| `attack` | number | Base attack damage, before `combat.attackScalePerWave` scaling. |
| `cooldownSeconds` | number | Time between this enemy's attacks. |
| `rangeTiles` | number | Attack range in tiles. `≤ ~0.5` reads as melee; large values (2+) are ranged attackers. |
| `speedTilesPerSecond` | number | Movement speed. |
| `armor` | number | Base armor, before `combat.armorScalePerWave` scaling. `0` = no armor scaling ever applies to this archetype, regardless of wave. |
| `tag` | string (enum) | Only the literal value `"boss"` is functionally read (`ui.js` gates the boss HP bar on `enemy.tag === "boss"`). Everything else (`normal`, `fast`, `armored`, `ranged`, …) is a free-form design label with no code behavior — the Config Editor's dropdown here is populated from whatever tags already exist across all enemies (plus `"boss"`), so inventing a new descriptive tag is still possible by typing it into any one enemy's `tag`. |
| `mechanic` | object *(optional)* | Present only on bosses. See below. |

**`mechanic` variants** (discriminated by `mechanic.kind`, enum: `aura` / `summon` / `breach`):

| `mechanic.kind` | Extra fields | Behavior |
|---|---|---|
| `aura` | `radius` (tiles), `damagePerSecond` | Every `combatEngine.bossAuraTickSeconds`, deals `damagePerSecond` to every live ally **and** every building within `radius` tiles. |
| `summon` | `archetype` (enum: any `fortressEnemies` key), `intervalSeconds` | Spawns one enemy of the given archetype next to the boss every `intervalSeconds`. |
| `breach` | `damageMultVsBuildings` | Multiplies this enemy's damage **against buildings only** (not allies) by this factor. |

### `waveDemand`

| Path | Type | Description |
|---|---|---|
| `waveDemand.slotProductionMultiplier` | number | Multiplier applied to a mine's slot production when that mine's resource matches the current wave's `demandResource`. |

---

## 4. Buildings

### `fortressBuildings` — object keyed by building type

The object's own key (`wall`, `turret`, `barracks`, …) is the building type referenced by
`fortressBuildings.*.levels[].unit`, `buyCost`/`upgradeCost` keys elsewhere, and the runtime
`building.type` field.

| Field | Type | Description |
|---|---|---|
| `footprint` | array of `[x, y]` pairs | Tile offsets from the building's placement origin. `[[0,0]]` = 1×1; multi-tile buildings (e.g. Big Wall's `[[0,0],[1,0],[2,0]]`) list every occupied offset. |
| `unlockedByDefault` | boolean | If `true`, this building type is buildable from wave 1 regardless of `unlockWave`. |
| `unlockWave` | number *(required unless `unlockedByDefault`)* | Wave at which this building type becomes buildable. |
| `buyCost` | object `{resourceKey: amount}` | Base cost to place the first copy. Actual cost also factors in `buildingCostEscalation` (see below) and any `buildingBuyDiscount` from run state. |
| `crystalMergeGated` | boolean *(optional, default false)* | If `true`, merging this building type into its top tiers additionally costs crystal, per `merge.crystalCostByLevel` (§5). Currently set on Barracks/Archery/Turret/Stables/Mage Tower — not on Wall/Big Wall/Trap Mine/HQ. |
| `levels` | array | One entry per tier, index 0 = level 1. See below. |

**`levels[]` fields** (not every building uses every field — a building is either a *trainer* with
`unit`+`cooldownSeconds`, a *turret-like* with `damage`+`range`, or a *trap* with just `hp`+`damage`):

| Field | Type | Applies to | Description |
|---|---|---|---|
| `hp` | number | all | HP at this level (before any run's `baseHealthBonus` reward is added). |
| `cooldownSeconds` | number | trainers, turret | Time between this level's trained-unit spawns, or between turret shots. |
| `unit` | string (enum: any `fortressUnits` key) | trainers | Which unit type this level trains. |
| `damage` | number | turret, trap mine | Damage dealt per shot (turret) or on trigger (trap mine). |
| `range` | number (tiles) | turret | Attack range. Falls back to `combatEngine.turretDefaultRange` if omitted. |
| `upgradeCost` | object `{resourceKey: amount}` | every level except the last | Cost to upgrade **from** this level to the next. The last (max) level has no `upgradeCost`. |
| `active` | object *(optional)* | only the max level | An ability triggerable during battle. See below. Only the top tier of a building can carry one. |

**`active` fields:**

| Field | Type | Description |
|---|---|---|
| `cooldownSeconds` | number | Cooldown between casts. |
| `cost` | object `{resourceKey: amount}` | Base resource cost per cast. Actual cost escalates within a battle — see `abilityCostAccumulation` (§4 below) — so this is only the *first* cast's price that battle. |
| `effect` | object | Discriminated by `effect.kind`. See table below. |

**`active.effect` variants** (enum for `effect.kind`: `buildingDamageBoost` / `spawnSquad` / `volley` /
`frost` / `shield`):

| `effect.kind` | Extra fields | Behavior | Used by (shipped default) |
|---|---|---|---|---|
| `buildingDamageBoost` | `multiplier`, `durationSeconds` | Multiplies the building's own damage for the duration. | Turret's Overcharge |
| `spawnSquad` | `unit` (enum: `fortressUnits` key), `count` | Instantly spawns `count` of `unit` next to the building. | Barracks' Rally Squad, Stables' Charge |
| `volley` | `count`, `damage` | Fires `count` projectiles at the nearest enemies for `damage` each. | Archery's Volley |
| `frost` | `durationSeconds`, `slowMultiplier` | Slows every live enemy's speed to `speed × slowMultiplier` for the duration. | Mage Tower's Frost Nova |
| `shield` | `radius` (tiles), `durationSeconds`, `damageReduction` (0–1) | Grants every building within `radius` a damage-reduction shield for the duration. | Wall/Big Wall's Shield |

### `fortressUnits` — object keyed by unit type

Base stats for units *trained by buildings* (as opposed to reserve workers, which use `unitLevels` in
§5). Referenced by `fortressBuildings.*.levels[].unit` and `active.effect.unit` (for `spawnSquad`).

| Field | Type | Description |
|---|---|---|
| `hp`, `attack`, `cooldownSeconds`, `rangeTiles`, `speedTilesPerSecond` | number | Same meaning as the equivalent `fortressEnemies` fields. |
| `splashRadius` | number (tiles) *(optional)* | If set, this unit's attacks are AoE within this radius instead of single-target. Only Mage currently has one. |

Per-level `attack`/`hp` bonuses come from `combat.unitAttackPerLevel`/`unitHpPerLevel` applied to the
*spawner building's* level — `fortressUnits` itself holds only the level-1 baseline.

### Building economics

| Path | Type | Description |
|---|---|---|
| `buildingCostEscalation.default` | number | Cost-growth factor applied per unit of "invested power" (`Σ 2^(level-1)` over that type's instances on the field) for any building type without its own override below. |
| `buildingCostEscalation.<type>` | number *(optional per type)* | Override growth factor for a specific building type (e.g. `wall`/`bigWall` are shipped lower than default — cheap chaff shouldn't escalate as fast as real defenses). |
| `demolish.refundFraction` | number (0–1) | Fraction of resources (and any crystal) sunk into a building that's returned when it's demolished. |
| `demolish.goldCostPerCopy` | number | Gold cost to demolish, per unit of invested power (`2^(level-1)`). |
| `fortress.obstacleCount` | number | Scenery obstacle (tree) tiles scattered on the field at run start. Purely a gold sink to clear — obstacles don't block enemy pathing. |
| `fortress.obstacleRemovalBaseCost` | number | Gold cost to clear the first obstacle. |
| `fortress.obstacleRemovalCostStep` | number | How much the clearing cost rises after each tile cleared. |
| `fortress.repairFallbackWoodPerLevel` | number | Repair cost (in wood, × building level) used **only** for buildings with an empty `buyCost` — currently just the HQ, which has no normal buy cost to base a repair rate on. |
| `attrition.repairCostPerHpFractionOfBuyCost` | number | Repair cost rate: `missingHpFraction × rate × buyCost × buildingLevel`. This is the only field left under `attrition` — the old post-defeat HP penalty/restore mechanics it used to describe (`floorPerDefeat`, `postDefeatHpFraction`) were never read and have been removed. |
| `abilityCostAccumulation` | number | Each building-active cast **this battle** (any building) raises the cost of the *next* cast, battle-wide, by this factor: `cost × abilityCostAccumulation ^ castsSoFarThisBattle`. Resets each battle. |

---

## 5. Units & Merging

### `unitLevels` — array, index+1 = reserve-worker merge level

| Field | Type | Description |
|---|---|---|
| `level` | number | Should match `index + 1` — read by `getUnitLevelData` via `.find(item => item.level === level)`, so gaps or out-of-order entries are technically fine but confusing. |
| `baseHealth`, `baseAttack`, `baseAttackSpeed` | number | Base stats for a reserve worker at this merge level (before weapon/armor-style modifiers — this prototype has none currently, these are the final combat stats). |

### `merge`

| Path | Type | Description |
|---|---|---|
| `merge.maxLevel` | number | Hard cap on worker merge level, regardless of wave. Also the level at which a capstone choice is offered. |
| `merge.workerLevelUnlockWaves` | array of numbers | Wave-gated cap ramp: index *i* is the wave at which merge level *i+1* becomes reachable. E.g. `[1,1,1,3,5]` means levels 1–3 are available from wave 1, level 4 unlocks at wave 3, level 5 at wave 5. Keeps the early roster wide instead of racing to max level immediately. |
| `merge.crystalCostByLevel` | object `{"level": crystalAmount}` | Crystal cost to merge a `crystalMergeGated` building (§4) up to the given target level. Keys are level numbers **as strings** (JSON object keys are always strings). Only levels present here require crystal — levels 1–3 typically aren't listed (free), levels 4–5 are. |

### `workerTraits`

| Path | Type | Description |
|---|---|---|
| `workerTraits.mergeBonusPoints` | number | Extra trait points added to the dominant trait line whenever two workers merge, on top of simply summing their trait vectors. |
| `workerTraits.hybridThreshold` | number (0–1) | How close the second-highest trait must be to the dominant one (as a fraction of the dominant's value) for the **hybrid** capstone (Warlord) to be offered alongside the dominant line's own capstones. |
| `workerTraits.lines.<yield\|rush>.label` / `.icon` | string | Display name/icon for the trait line. |
| `workerTraits.lines.<line>.rollWeight` | number | Relative odds this line is the one rolled dominant on a brand-new worker. Same weighted-pick model as reward-card `weight` (§6) — `0` means the line never gets rolled as a new worker's starting trait (existing workers already holding it are unaffected). |
| `workerTraits.lines.yield.resourceMultiplierPerPoint` | number | Yield: production multiplier gained per point of this trait. |

### `workerTraits.capstones` — capstone catalog

Structured as `capstones.<yield|rush|hybrid>`, each an array of capstone definitions. Which
*array* a capstone lives in only affects the editor's own organization — `getWorkerCapstoneEffect`
searches all three arrays by `id`, so a capstone's *behavior* comes entirely from its own `effect` object,
not which array it's filed under.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique capstone id, referenced by a worker's `capstone`/`pendingCapstone` runtime fields. |
| `label`, `description` | string | Display text shown in the capstone-choice UI. |
| `effect.kind` | string (enum, 5 values — see below) | Which capstone behavior this is. |

**`effect` variants** (enum for `effect.kind`):

| `effect.kind` | Extra fields | Behavior |
|---|---|---|
| `yieldMul` | `value` | Multiplies the worker's Yield-trait production multiplier by `value`. |
| `demandMul` | `value` | Multiplies the wave-demand bonus (§3 `waveDemand`) this worker benefits from by `value`. |
| `rushBonus` | `value` | Defined in the schema (Warmind capstone) but currently unread by any system — dead effect kind. |
| `battleDamageBonus` | `value` | While this worker is staffing a mine slot (not parked in reserve), adds `value` (as a fraction, e.g. `0.2` = +20%) to the fortress's overall damage multiplier. |
| `warlord` | `productionMultiplier` | Hybrid (Rush+Yield): production multiplier that applies **only** while the worker is staffing a mine slot (not parked in reserve). |

---

## 6. Mining

### `mine`

| Path | Type | Description |
|---|---|---|
| `mine.collectionIntervalSeconds` | number (sec) | Base time between production payouts for an occupied, purchased slot, before the worker's rest/shift rate factor divides it. |
| `mine.workerProductionByLevel` | object `{"level": amount}` | **Preferred** production table — resource amount per payout, keyed by worker level (as a string). Used instead of the formula below whenever an entry exists for the worker's level. |
| `mine.baseProductionPerSecond` | number | Legacy fallback formula input: `amount = baseProductionPerSecond × workerLevel × slotMultiplier × secondsElapsed`, used only if `workerProductionByLevel` has no entry for that level. `0` in the shipped default — i.e. this fallback is currently dormant since `workerProductionByLevel` covers every level in play. |
| `mine.goldPerSecondPerWorkerLevel` | number | Paired legacy fallback for active-worker bonus gold, same "only used if the table doesn't cover this level" rule. |
| `mine.resourceTypes` | array | One entry per mine. See below. |
| `mine.levels` | array | One entry per mine level (shared across all mines — a level-3 Lumber Camp and a level-3 Stone Quarry both use `levels[2]`). See below. |

**`mine.resourceTypes[]` fields:**

| Field | Type | Description |
|---|---|---|
| `key` | string | The resource's identifier — used as the key in `resources`, `startingResources`, every `buyCost`/`upgradeCost` object, and `fortressWaves[].demandResource`. This is the canonical *definition*, not itself a reference — don't expect a dropdown here. |
| `label`, `icon`, `mineName` | string | Display text: resource name, resource icon, and the mine building's own name (e.g. "Lumber Camp" produces `wood`). |
| `unlockedByDefault` | boolean | If `true`, this mine (and its first slot) starts owned. |
| `unlockWave` | number | Wave at which the mine becomes purchasable (ignored if `unlockedByDefault`). |
| `buyCost` | object `{resourceKey: amount}` | Cost to unlock the mine (usually `{gold: N}`). |
| `slotUnlockWaves` | array of numbers | Wave at which each additional slot (index 0 = the 2nd slot, since slot 0 comes free with unlock... — see `slotBuyCosts` below for the exact indexing) becomes purchasable. |
| `slotBuyCosts` | array of `{resourceKey: amount}` | Gold cost per slot index. Index 0 is normally `{gold: 0}` (free with the mine unlock itself). |

**`mine.levels[]` fields:**

| Field | Type | Description |
|---|---|---|
| `level` | number | Mine level (1-indexed, should match array position + 1). |
| `slots` | number | How many worker slots are open at this mine level. |
| `slotProductionMultipliers` | array of numbers | Per-slot production multiplier, index-aligned with slot position. Later slots are worth more (`1, 1.1, 1.2, …`) so the UI can badge "fill this one first." |

---

## 7. Rewards

### `rewardDraft.cards` — the entire victory-reward pool, as one flat array

After every victory, `rollUpgradeChoices` draws **one card per category**, weighted within that
category by `weight`. A category with no cards (or all-zero weights) simply contributes nothing to that
draft — the game doesn't error, the player just sees fewer than 3 choices.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique id, referenced when the player picks a card. |
| `category` | string (enum: `permanent` / `temporary` / `oneShot`) | Which of the three draft slots this card competes for. `upgradeSystem.js` filters and dispatches on these exact three strings — anything else means the card can never be drawn. |
| `title`, `description` | string | Display text on the reward card. |
| `weight` | number | Odds of being the one drawn *within its category*, relative to other cards in the same category. Default `1` if omitted. **`0` = never drawn — this is the rarity/exclusion knob.** Not normalized to a percentage — a card with `weight: 3` next to two `weight: 1` cards is drawn 3× as often as either one. |
| `effectText` | string *(only for the "action" effect kinds below)* | Hand-authored effect description. **Only used for kinds with no single meaningful numeric value** (`promoteWorker`, `upgradeBuilding`, `unlockMineSlot`, `supplyDrop`, `massRepair`) — the numeric kinds (below) generate their own effect text from `effect.value` directly, so that text can never drift out of sync with the actual number. |
| `effect.kind` | string (enum, 9 values — see below) | Which effect this card grants. |

**`effect` variants** (enum for `effect.kind`):

| `effect.kind` | Extra fields | Behavior | Category it's meant for |
|---|---|---|---|---|
| `goldMultiplier` | `value` | Permanently multiplies gold income. | `permanent` |
| `productionMultiplier` | `value` | Permanently multiplies mine production. | `permanent` |
| `baseHealthBonus` | `value` | Adds flat HP to every fortress building, immediately (retroactive, not just future builds). | `permanent` |
| `temporaryMultiplier` | `bonusKind` (enum: `production`/`damage`/`defense`), `value`, `durationSeconds` | Applies a multiplier immediately and counts it down in real time; it's dropped once `durationSeconds` elapses. | `temporary` |
| `promoteWorker` | — | Instantly promotes one eligible reserve/mine worker by one level (respects the wave-gated level cap — §5). | `oneShot` |
| `upgradeBuilding` | — | Instantly upgrades one eligible building for free (respects the crystal-tier gate — won't skip past it). | `oneShot` |
| `unlockMineSlot` | — | Unlocks a mine or opens one more slot on an already-open mine, for free — but only if it's already wave-eligible; never skips a gate. | `oneShot` |
| `supplyDrop` | `goldInjection`, `resourceInjection` | Instantly grants `goldInjection` gold plus `resourceInjection` of **every** mine resource. | `oneShot` |
| `massRepair` | — | Instantly repairs every damaged building to full HP, for free. | `oneShot` |

`category` and `effect.kind` are independent fields — nothing stops you from technically pairing a
`permanent`-flavored effect kind with `category: "oneShot"`, but the shipped cards always match them
sensibly (a `temporaryMultiplier` effect only makes sense wired to `category: "temporary"`, since that's
what makes `getCardDurationText` show the wave count instead of "Permanent"/"Instant").

---

## Versioning

`config.json`'s top-level `version` field powers the Config Editor's override system:

- **Save** / **Export** in the editor stamp `version = <shipped file's version at page load> + 1` before
  writing/downloading — so a designer's in-progress tweaks are always understood as "one release ahead
  of whatever's currently shipped," no matter how many times Save is clicked in one sitting.
- On boot, a locally-saved override (kept in the browser's `localStorage`, per-browser) is only applied
  if its `version` is **strictly greater** than the freshly-loaded `data/config.json`'s `version`.
- Practical effect: when you take a designer's **Export**ed file and drop it in as the new
  `data/config.json`, every other browser's stale local override — saved back when the shipped version
  was lower — gets silently retired on its next load instead of continuing to override forever. Nobody
  needs to remember to click "Reset to defaults."

See `js/game/config.js` (`stampNextConfigVersion`, `getDefaultConfigVersion`) and `architecture.md`'s
**Config Editor & Dev Tools** section for the full mechanism.
