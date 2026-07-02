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
- `js/game/ui.js` is the DOM renderer and interaction layer. It does not contain balance constants.

## Runtime Model

- `reserveUnits` contains units that can be merged or assigned to a mine.
- `mines` stores its own worker slots, current level, and upgrade progression.
- `battleUnits` contains deployed units only. Units moved here cannot return.
- `enemies` is the current active wave on the battlefield.
- `castle` stores enemy castle health and is the final battle objective.
- The battlefield now uses lane-based positions:
  - allies spawn on the left and move right
  - enemies spawn near the castle on the right and move left
  - units queue behind allies in their lane and stop when enemies block the path
- `resources` currently has two currencies:
  - `gold` for buying fresh units
  - `ore` for mine progression and battle gear

## Main Systems

- `reserveSystem`
  - Buys new units
  - Merges matching reserve units
  - Supports recursive mass merge
- `mineSystem`
  - Upgrades mines
  - Assigns and returns workers
  - Produces ore every tick based on worker level and slot multiplier
- `garrisonSystem`
  - Pulls a unit from reserve or mine
  - Spends ore on selected gear
  - Converts the unit into an irreversible battle unit
- `battleSystem`
  - Grants passive gold income
  - Manages wave cooldowns and wave spawning
  - Updates lane movement and spacing between units
  - Makes allied units march left-to-right toward the castle
  - Makes enemies march from the castle side toward the player line
  - Runs contact-based attacks when units meet in a lane
  - Returns to castle damage after the last wave is gone

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
  - Explicit stats per unit level instead of formulas in code.
- `data/mine-levels.json`
  - Explicit slot counts, upgrade costs and production multipliers per mine level.
- `data/equipment.json`
  - Deploy gear definitions and combat modifiers.
- `data/waves.json`
  - Enemy wave compositions in order.

## Current Prototype Constraints

- Unit buying uses passive gold income to keep the loop active.
- Deploying through the garrison purchases one selected equipment type per unit.
- Battle targeting is intentionally simplified: all allies focus enemies first, then the castle.
- Loss state is not terminal yet; if the frontline dies, the player can keep mining and deploy more units.
- Because data now loads through `fetch()`, the prototype should be opened through a local/static web server or GitHub Pages, not directly as `file://`.
