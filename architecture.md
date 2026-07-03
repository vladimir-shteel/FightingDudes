# Fighting Dudes Prototype Architecture

## Structure

- `index.html` contains the static layout for the three game zones: battle, mines/garrison, and reserve.
- `styles.css` defines the visual theme and responsive layout for desktop/mobile GitHub Pages deployment.
- `js/main.js` wires the game loop and connects the UI to the game state.
- `js/game/state.js` creates the full runtime state tree in one place.
- `data/*.json` stores balancing values and content definitions: economy, unit levels, mine levels, equipment and waves.
- `js/game/config.js` loads JSON data and exposes helper accessors for systems.
- `js/game/factories.js` creates runtime entities with stable shapes: reserve units, mines, battle units, enemies.
- `js/game/systems/*.js` contains isolated gameplay rules by domain.
- `js/game/physics/battlePhysics.js` owns the Planck.js world for the battle zone and synchronizes physics bodies with gameplay entities.
- `js/game/ui.js` is the DOM renderer and interaction layer. It does not contain balance constants.
  - Unit interactions now use `tap-to-select / tap-to-place` as the primary input model for both desktop and mobile instead of relying on native HTML drag-and-drop.

## Runtime Model

- `reserveUnits` contains units that can be merged or assigned to a mine.
- `mines` stores its own worker slots, current level, unlock state and upgrade progression.
- `battleUnits` contains deployed units only. Units moved here cannot return.
- `enemies` is the current active wave on the battlefield.
- `castle` stores enemy castle health and is the final battle objective.
- `resourceBursts` stores short-lived payout events that the UI turns into flying resource chips.
- Each mine is bound to its own resource type and produces that specific resource.
- The battlefield now uses free movement inside a bounded 2D field:
  - allies spawn on the left and search for the nearest enemy, otherwise advance on the castle
  - enemies spawn near the castle and search for the nearest allied unit
  - each actor has an attack range and stops moving once it can hit its target
  - movement, body blocking and crowding in the top zone are resolved through a dedicated Planck.js physics world
- If a wave kills the last allied unit, that wave retreats back toward the castle, despawns, and is restored when a new ally is deployed again.
- Each enemy spawned from a wave keeps its original wave slot index. Defeated wave indexes are remembered so retreating waves only respawn surviving members.
- `resources` currently has two currencies:
  - `gold` for buying fresh units and mine progression, earned from active miners
  - mine resources such as stone, wood, crystal and iron for battle equipment
- `ui.selectedUnitId` tracks the currently selected reserve or mine unit so the top HUD and tap targets can react consistently.

## Main Systems

- `reserveSystem`
  - Buys new units
  - Merges matching reserve units
  - Scales buy price exponentially from owned base-unit equivalents outside battle: level 1 = 1, level 2 = 2, level 3 = 4, etc.
  - Supports recursive mass merge
- `mineSystem`
  - Unlocks mines progressively
  - Upgrades mines
  - Assigns and returns workers
  - Supports merging reserve units into mine workers
  - Pays out resource + gold bursts on a timed collection interval per occupied slot
  - Pushes visual payout events for the flying-resource UI effect
- `ui interaction flow`
  - Tap a reserve or mine unit to select it
  - Tap an empty mine slot to assign a selected reserve unit
  - Tap a mine worker with a selected matching reserve unit to merge into the mine slot
  - Tap the garrison to deploy the selected reserve or mine unit
  - Tap the reserve panel to return a selected mine worker back to reserve
- `garrisonSystem`
  - Pulls a unit from reserve or mine
  - Spends combined multi-resource costs from one selected weapon and one selected armor
  - Converts the unit into an irreversible battle unit
- `battleSystem`
  - Manages wave cooldowns and wave spawning
  - Handles retreat/despawn when enemies win the current skirmish
  - Tracks defeated enemy indexes per wave so a retreating wave does not return with killed enemies restored
  - Assigns nearest-target intent for allies and enemies
  - Applies range-based attacks once a target is close enough
  - Keeps castle damage as the fallback objective after the final wave
- `battlePhysics`
  - Syncs runtime units/enemies into Planck bodies
  - Drives bodies toward their current target or fallback destination with low-friction Planck circles and damping
  - Keeps visual unit size separate from `physicsRadius`; attack range is a simple `baseAttackReach + weapon/enemy bonus`
  - Uses a tiny `attackStopSlack` for movement and `attackRangeTolerance` for combat so units do not stop just outside attack range
  - Keeps targets sticky inside `targetLeashDistance` to avoid rapid nearest-target flicker in clustered fights
  - Lets same-team bodies collide while opposing teams use combat range checks instead of physically pushing each other
  - Stops actors with direct velocity hold once their target is inside reach, avoiding reverse braking forces near melee range
  - Treats the castle as a movement target with its own radius, so melee and ranged units stop at their weapon distance instead of walking into the castle
  - Switches into a softer combat-hold mode near attack range to reduce frontline jitter
  - Preserves physical blocking, bumping and crowd compression in the battlefield
  - Keeps allies from sliding into the castle footprint

## Extension Points

- Add new equipment by extending `CONFIG.equipment`.
- Add new enemy compositions by extending `CONFIG.waves`.
- Add more mine types by introducing new mine factory fields and a dedicated production rule.
- Add hero traits or status effects by enriching unit factory output and updating `battleSystem`.
- Replace DOM rendering with canvas or a framework later without rewriting the core systems, because rules are already separated from HTML.

## JSON Content Files

- `data/balance.json`
  - Global pacing values: tick, starting resources, unit buy scaling, merge cap, castle HP.
- `data/unit-levels.json`
  - Explicit stats and optional display icon per unit level instead of formulas in code.
- `data/mine-levels.json`
  - Explicit mine resource types, unlock costs/currencies, slot counts, upgrade costs/currencies and production multipliers per mine level.
  - Each `resourceType` may declare an `icon` emoji (mirrors the enemy/weapon/armor `icon` field). When present, the UI renders that emoji everywhere the resource appears; when absent, the UI falls back to the built-in CSS shape keyed on `resource-icon-${key}`. `balance.json` holds the matching `goldIcon` since gold is not a mine-produced resource.
- `data/equipment.json`
  - Separate weapon and armor definitions, optional display icons, combat modifiers and per-resource costs.
  - Weapons form a tier ladder from wood-only entry gear up to mixed iron/crystal high-tier options; each weapon declares `attackMultiplier`, `attackSpeedMultiplier`, `attackType` (`melee` or `ranged`), and an `attackRangeBonus` that extends `baseAttackReach`.
  - Armors similarly ladder from `none` to multi-resource plate; each declares a flat `healthBonus`.
- `data/waves.json`
  - Enemy wave compositions in order, including optional enemy icons.
  - Enemy definitions may override `moveSpeed` and `attackRangeBonus` to introduce ranged attackers (Archer), fast skirmishers (Wolf), and slow bruisers (Ogre/Warlord) alongside the base melee types.
  - Enemy definitions may declare an optional `goldReward` that is paid to the player on kill. Enemies without the field grant no gold.

## Balance Formulas (in code, not JSON)

These formulas live in the systems, not in JSON. JSON supplies the coefficients; the formulas here explain what those coefficients mean.

- **Reserve unit buy cost** (`reserveSystem.getUnitBuyCost`): `max(1, floor(unitBuyBaseCost × unitBuyExponent^ownedBaseUnitEquivalents))`, where `baseUnitEquivalent(unit) = 2^(level-1)` summed over all reserve units and mine workers (battle units are excluded). Deploying units to battle temporarily lowers the price.
- **Mine payout per collection tick** (`mineSystem.tickMineProduction`, one tick per `collectionIntervalSeconds` of accumulated worker progress):
  - `resource = baseProductionPerSecond × workerLevel × slotProductionMultipliers[slot] × payoutSeconds`
  - `activeWorkerGold = goldPerSecondPerWorkerLevel × workerLevel × slotProductionMultipliers[slot] × payoutSeconds`
- **Passive mine gold trickle** (`mineSystem.tickMineProduction`): each unlocked mine independently accumulates `passiveProgress` in seconds and, once it reaches `passiveGoldPayoutIntervalSeconds`, pays out `passiveGoldPerSecondPerUnlockedMine × payoutSeconds` gold and emits a `resourceBurst` with `slotIndex: -1`. The UI renders `passiveProgress / passiveGoldPayoutIntervalSeconds` as a small progress bar in the mine card corner and routes the burst from the mine card element. Keeps the game from soft-locking after the player commits all their units to battle.
- **Uneven slot production**: `mineLevels.slotProductionMultipliers[slot]` scales both resource and gold output per slot within a mine. Later slots are worth more than earlier ones; the UI shows this as a `×N` badge on each open slot so the player can see which slot to fill first.
- **Battle unit derived stats** (`factories.createBattleUnit`):
  - `attack = baseAttack × weapon.attackMultiplier`
  - `attackSpeed = baseAttackSpeed × weapon.attackSpeedMultiplier`
  - `maxHealth = baseHealth + armor.healthBonus`
  - `attackRange = baseAttackReach + (weapon.attackRangeBonus ?? melee/rangedAttackRangeBonus)`
- **Enemy attack range** (`factories.createEnemy`): `baseAttackReach + (definition.attackRangeBonus ?? enemyAttackRangeBonus)`.
- **Attack interval** (`battleSystem.getAttackInterval`): `1 / attackSpeed` seconds between hits.
- **Effective attack range for combat check** (`battleSystem.getAttackRange`): `actor.attackRange + attackRangeTolerance` so units engage slightly before the exact edge.
- **Target stickiness** (`battleSystem.keepCurrentTarget`): keeps the current target while it is within `attackRange + targetLeashDistance` to avoid flicker.
- **Wave respawn** (`battleSystem.createWaveEnemies`): retreating waves respawn using `waveProgress.defeatedEnemyIndexesByWave` so only survivors return; a cleared wave's progress is dropped.
- **Enemy kill reward** (`battleSystem.awardEnemyGold`): when an enemy dies, an optional `goldReward` (from the wave definition, defaults to 0) is added to gold and a `resourceBurst` with `battlefield: { x, y }` is emitted so the UI flies a gold chip from the enemy's on-field position to the gold chip. Enemies without a `goldReward` grant nothing.

## Current Prototype Constraints

- Gold comes from two sources only: active mine workers during payout ticks, and a small passive trickle proportional to the number of unlocked mines.
- Deploying through the garrison purchases one weapon plus one armor choice per unit.
- Battle targeting is intentionally simplified: all allies focus enemies first, then the castle.
- Loss state is not terminal yet; if the frontline dies, the player can keep mining and deploy more units.
- Because data now loads through `fetch()`, the prototype should be opened through a local/static web server or GitHub Pages, not directly as `file://`.
