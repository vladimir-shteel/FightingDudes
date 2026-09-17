// Headless balance harness — runs the REAL game engine (js/game/*) in Node and drives
// it with scripted strategies. No DOM: CONFIG is injected directly, only the tick
// functions and the public player-action APIs are used.
//
// Usage: node tools/balance-sim/headless.mjs [policy|all] [--quiet]
//   policies: passive | casual | balanced | economy | defense | smartAss

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const gameModule = (rel) => import(pathToFileURL(join(root, rel)).href);

// Inject config before importing game modules (config.js's initConfig needs fetch/localStorage).
const CONFIG_JSON = JSON.parse(readFileSync(join(root, "data", "config.json"), "utf8"));
const { CONFIG } = await gameModule("js/game/config.js");
Object.assign(CONFIG, CONFIG_JSON);

const { createInitialState } = await gameModule("js/game/state.js");
const { tickFortressBattle, startFortressBattle } = await gameModule("js/game/systems/fortressBattleSystem.js");
const { tickMineProduction } = await gameModule("js/game/systems/mineSystem.js");
const { tickUpgradeEffects } = await gameModule("js/game/systems/upgradeSystem.js");
const {
  buyFortressBuilding, mergeFortressBuildings, repairFortressBuilding,
  removeFortressObstacle, moveFortressBuilding, canPlaceFortressBuilding, getFortressRepairCost,
  findFortressPlacement, canMergeFortressBuildings,
} = await gameModule("js/game/systems/fortressSystem.js");
const { buyUnit, massMergeReserve, getUnitBuyCost } = await gameModule("js/game/systems/reserveSystem.js");
const { assignReserveUnitToMine, moveMineUnitToMineSlot } = await gameModule("js/game/systems/mineSystem.js");

const DT = 0.1;

// ---------------------------------------------------------------- helpers

function waveSummary(waveIndex) {
  const wave = CONFIG.fortressWaves[waveIndex];
  const w = waveIndex + 1;
  let ehp = 0, dps = 0, count = 0;
  for (const entry of wave.composition ?? []) {
    const base = CONFIG.fortressEnemies[entry.archetype];
    const hp = Math.round(base.hp * Math.pow(1 + CONFIG.combat.hpScalePerWave, w));
    const attack = Math.round(base.attack * Math.pow(1 + CONFIG.combat.attackScalePerWave, w));
    ehp += hp * entry.count;
    dps += (attack / base.cooldownSeconds) * entry.count;
    count += entry.count;
  }
  return { count, ehp, dps: Math.round(dps) };
}

function playerDps(state) {
  let dps = 0;
  for (const a of state.fortress.battle.allies) if (a.hp > 0) dps += a.attack / a.cooldownSeconds;
  for (const b of state.fortress.buildings) {
    if (b.hp <= 0 || b.type !== "turret") continue;
    const lvl = CONFIG.fortressBuildings.turret.levels[b.level - 1];
    dps += lvl.damage / lvl.cooldownSeconds;
  }
  return Math.round(dps * 10) / 10;
}

function tile(state, x, y) {
  return state.fortress.field.find((t) => t.x === x && t.y === y) ?? null;
}
function clearObstacleAt(state, x, y) {
  const t = tile(state, x, y);
  if (t?.occupant === "obstacle") return removeFortressObstacle(state, x, y).ok;
  return true;
}
// Score one candidate origin: how many obstacle tiles its own footprint needs cleared (cheap =
// good), and how many ALREADY-FREE tiles border that footprint (a high count means the spot sits
// on the edge of an existing clearing — cutting those 1-2 trees connects to space you already
// have, instead of carving a footprint-sized hole deep in unbroken forest). This is the "look for
// a couple of trees next to a big open pocket" read of how the real playtester scouts the map.
function scoreClearablePlacement(state, footprint, x, y) {
  const footprintKeys = new Set();
  let obstacleCount = 0;
  for (const [dx, dy] of footprint) {
    const t = tile(state, x + dx, y + dy);
    if (!t || (t.occupant && t.occupant !== "obstacle")) return null;
    if (t.occupant === "obstacle") obstacleCount += 1;
    footprintKeys.add(`${x + dx},${y + dy}`);
  }
  let freeNeighbors = 0;
  for (const key of footprintKeys) {
    const [fx, fy] = key.split(",").map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = fx + dx;
      const ny = fy + dy;
      if (footprintKeys.has(`${nx},${ny}`)) continue;
      const nt = tile(state, nx, ny);
      if (nt && !nt.occupant) freeNeighbors += 1;
    }
  }
  return { x, y, obstacleCount, freeNeighbors };
}
// Cheapest-to-clear origin, tie-broken toward the one bordering more already-free space, in a
// rectangular zone of the field (defaults to the whole field). Used both as `placeBuilding`'s
// last-resort fallback (whole field) and by policies that want a specific area of the map searched
// for the actual best spot on THIS game's tree layout, instead of a fixed list of coordinates.
function findClearablePlacement(state, type, zone = null) {
  const footprint = CONFIG.fortressBuildings[type].footprint;
  const maxX = Math.max(...state.fortress.field.map((t) => t.x));
  const maxY = Math.max(...state.fortress.field.map((t) => t.y));
  const xMin = zone?.xMin ?? 0, xMax = zone?.xMax ?? maxX;
  const yMin = zone?.yMin ?? 0, yMax = zone?.yMax ?? maxY;
  const candidates = [];
  for (let y = yMin; y <= yMax; y += 1) {
    for (let x = xMin; x <= xMax; x += 1) {
      const scored = scoreClearablePlacement(state, footprint, x, y);
      if (scored) candidates.push(scored);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.obstacleCount - b.obstacleCount || b.freeNeighbors - a.freeNeighbors);
  const top = candidates[0];
  const tied = candidates.filter((c) => c.obstacleCount === top.obstacleCount && c.freeNeighbors === top.freeNeighbors);
  return tied[Math.floor(Math.random() * tied.length)];
}
// Buy a building and move it to the desired origin (so scripted walls form a line).
// buyFortressBuilding puts the new copy "in hand" (unplacedBuildings — no auto-placement since
// the drag-n-drop commit); the sim places it via moveFortressBuilding like a player drop would.
// A spot is validated BEFORE paying, so resources are never spent on an unplaceable copy.
// origin=null → place at any free spot (real-game behavior when space is tight).
function placeBuilding(state, type, origin = null) {
  let spot = origin;
  if (spot) {
    const canAffordClear = CONFIG.fortressBuildings[type].footprint.every(
      ([x, y]) => tile(state, spot.x + x, spot.y + y)?.occupant !== "obstacle"
        || state.resources.gold >= state.fortress.obstacleRemovalCost
    );
    const cleared = canAffordClear
      && CONFIG.fortressBuildings[type].footprint.every(([x, y]) => clearObstacleAt(state, spot.x + x, spot.y + y));
    // The 60-65% tree-covered field means a fixed "curtain" coordinate is often sitting on an
    // obstacle the policy can't yet afford to clear. A real player would just build on the nearest
    // open tile instead of giving up — fall back to any free spot instead of failing outright.
    if (!cleared || !canPlaceFortressBuilding(state, type, spot)) {
      spot = findFortressPlacement(state, type);
      if (!spot) return null;
    }
  } else {
    spot = findFortressPlacement(state, type);
    if (!spot) {
      // No fully-clear footprint anywhere — look for the cheapest-to-clear spot (fewest obstacle
      // tiles in its footprint) instead of clearing one random obstacle tile and hoping it helps.
      // Without this, a policy that always passes spot=null (e.g. a delayed-merge ladder with no
      // fixed origin) can stall forever once the free tiles left don't happen to form a footprint,
      // even with plenty of gold sitting unspent.
      const candidate = findClearablePlacement(state, type);
      if (candidate) {
        const cleared = CONFIG.fortressBuildings[type].footprint
          .every(([x, y]) => clearObstacleAt(state, candidate.x + x, candidate.y + y));
        if (cleared) spot = candidate;
      }
    }
    if (!spot) return null;
  }
  const result = buyFortressBuilding(state, type);
  if (!result.ok) return null;
  const building = state.fortress.unplacedBuildings[state.fortress.unplacedBuildings.length - 1];
  if (!building) return null;
  const moved = moveFortressBuilding(state, building.id, spot);
  return moved.ok ? building : null;
}

// Get copies stuck "in hand" onto the field: merge onto a matching field building (the real
// game's drag-onto-building), else drop them on any free spot. Without this, ladder buys made
// while their target origin was occupied pile up in unplacedBuildings forever.
function absorbHandCopies(state, type) {
  const hand = (state.fortress.unplacedBuildings ?? []).filter((b) => b.type === type);
  for (const copy of hand) {
    const match = state.fortress.buildings.find(
      (b) => b.type === type && b.hp > 0 && b.level === copy.level && canMergeFortressBuildings(state, copy, b)
    );
    if (match && mergeFortressBuildings(state, copy.id, match.id).ok) continue;
    const spot = findFortressPlacement(state, type);
    if (spot) moveFortressBuilding(state, copy.id, spot);
  }
}

// Merge-only progression (the real game has no upgrade button: a L3 barracks is 8 L1 buys
// merged pairwise; merges into L4/L5 additionally cost 30/60 crystal — mergeFortressBuildings
// enforces the gate itself, so a blocked merge just returns false and the ladder waits).
function mergePairOfType(state, type) {
  const group = state.fortress.buildings
    .filter((b) => b.type === type && b.hp > 0 && b.level < CONFIG.fortressBuildings[type].levels.length)
    .sort((a, b) => a.level - b.level);
  for (let i = 0; i + 1 < group.length; i++) {
    if (group[i].level === group[i + 1].level) {
      return mergeFortressBuildings(state, group[i].id, group[i + 1].id).ok;
    }
  }
  return false;
}
// One ladder step per call: merge if a pair exists, else buy another L1 rung (affordability
// checked inside). Repeated calls walk the type up to `maxLevel`.
function ladderStep(state, type, maxLevel, origin = null) {
  if (mergePairOfType(state, type)) return true;
  const group = state.fortress.buildings.filter((b) => b.type === type && b.hp > 0);
  const top = group.reduce((m, b) => Math.max(m, b.level), 0);
  if (group.length > 0 && top >= maxLevel) return false;
  return Boolean(placeBuilding(state, type, origin));
}

function staffedCount(state) {
  return state.mines.reduce((n, mine) => n + mine.workerIds.filter(Boolean).length, 0);
}
function totalSlots(state) {
  const w = state.fortress.waveNumber;
  return state.mines.reduce((n, mine) => {
    const rt = CONFIG.mine.resourceTypes[mine.resourceIndex ?? state.mines.indexOf(mine)];
    const waves = rt.slotUnlockWaves.filter((u) => w >= u).length;
    return n + waves;
  }, 0);
}
function freeSlots(state) {
  const free = [];
  state.mines.forEach((mine) => {
    const rt = CONFIG.mine.resourceTypes[state.mines.indexOf(mine)];
    const unlocked = rt.slotUnlockWaves.filter((u) => state.fortress.waveNumber >= u).length;
    for (let i = 0; i < unlocked; i++) {
      if (!mine.workerIds[i]) free.push({ mine, slot: i, resource: rt.key });
    }
  });
  return free;
}
function manageWorkers(state, targetTotal) {
  const w = state.fortress.waveNumber;
  // buy
  while (staffedCount(state) + state.reserveUnits.length < targetTotal) {
    if (state.resources.gold < getUnitBuyCost(state)) break;
    if (!buyUnit(state).ok) break;
  }
  // assign (prefer highest-level workers first)
  const reserveSorted = [...state.reserveUnits].sort((a, b) => b.level - a.level);
  for (const slot of freeSlots(state)) {
    const unit = reserveSorted.shift();
    if (!unit) break;
    assignReserveUnitToMine(state, unit.id, slot.mine.id, slot.slot);
  }
  // merge in-mine pairs (same level, free), then reserve pairs
  for (const mine of state.mines) {
    for (let i = 0; i < mine.workerIds.length; i++) {
      for (let j = i + 1; j < mine.workerIds.length; j++) {
        if (mine.workerIds[i] && mine.workerIds[j] && mine.workerIds[i].level === mine.workerIds[j].level) {
          moveMineUnitToMineSlot(state, mine.id, j, mine.id, i);
        }
      }
    }
  }
  for (const mine of state.mines) {
    for (let j = 0; j < mine.workerIds.length; j++) {
      const mineUnit = mine.workerIds[j];
      if (!mineUnit) continue;
      const partner = state.reserveUnits.find((u) => u.level === mineUnit.level);
      if (partner) moveMineUnitToMineSlot(state, mine.id, j, mine.id, j); // no-op guard
    }
  }
  massMergeReserve(state);
  // re-assign anything left in reserve
  for (const slot of freeSlots(state)) {
    const unit = state.reserveUnits.sort((a, b) => b.level - a.level)[0];
    if (!unit) break;
    assignReserveUnitToMine(state, unit.id, slot.mine.id, slot.slot);
  }
}

function repairIfNeeded(state, othersFraction = 0.7) {
  const hq = state.fortress.buildings.find((b) => b.type === "hq");
  if (hq && hq.hp < hq.maxHp) repairFortressBuilding(state, hq.id);
  // destroyed buildings first (reviving a wall costs its full buyCost × level — the main attrition
  // sink), then damaged ones below the threshold
  for (const b of state.fortress.buildings) {
    if (b.type !== "hq" && b.hp <= 0) repairFortressBuilding(state, b.id);
  }
  for (const b of state.fortress.buildings) {
    if (b.type !== "hq" && b.hp > 0 && b.hp < b.maxHp * othersFraction) repairFortressBuilding(state, b.id);
  }
}

function aliveBuildings(state, type) {
  return state.fortress.buildings.filter((b) => b.type === type && b.hp > 0);
}

// ---- SmartAss helpers: encode the human build order described by the real playtester ----

// Merge-as-you-go toward `buildingCount` separate copies of `type` at `targetLevel`. Replaces an
// earlier "stockpile N copies, THEN merge" version: that one held every intermediate copy unmerged
// until the whole batch was ready, so it needed the full batch's worth of tiles all alive at once —
// traced via DEBUG_LADDER to a hard stall (barracks alive-count peaked at 4/6, `findClearablePlacement`
// returning null every time: the zone was geometrically full of never-merged L1s, not gold-starved).
// A merge frees its source building's tile immediately, so merging the moment a pair exists keeps
// peak simultaneous space to ~2-3 buildings regardless of the final target — matching a real
// playtest screenshot showing 2 separate L3 barracks (not "1 L3 + spare L1s") built with only 4
// walls in the same field.
function multiLadder(state, type, targetLevel, buildingCount, zone = null) {
  // Repair wrecks first — same reasoning as before: a dead copy's tile stays occupied until
  // repaired (only repair/move/demolish clears it), and repair is cheaper than a fresh buy anyway.
  const wrecks = state.fortress.buildings.filter((b) => b.type === type && b.hp <= 0);
  if (wrecks.length > 0) {
    const best = wrecks.reduce((a, b) => (b.level > a.level ? b : a));
    return repairFortressBuilding(state, best.id).ok;
  }

  const atTarget = aliveBuildings(state, type).filter((b) => b.level >= targetLevel).length;
  if (atTarget >= buildingCount) return false; // enough buildings already at the target level — done

  if (mergePairOfType(state, type)) return true; // always take a free merge before buying more
  const spot = zone ? findClearablePlacement(state, type, zone) : null;
  return Boolean(placeBuilding(state, type, spot));
}

// "3-4 стены, держу на L2, чиню по одной штуке только если ВСЕ они были убиты — не сразу как
// только можно. Бараки приоритетнее стен." Walls are a deliberate small curtain at a target level
// (not just reactive): build up to `targetCount`, merge pairs up to `maxLevel` once that count is
// reached. Repair is latched, not reactive per-wreck: only kicks in once the WHOLE curtain has
// wiped out at the same time, then rebuilds one wreck per tick until it's whole again (tracked via
// a flag on `state` since policies are otherwise stateless between ticks). Repair takes exclusive
// priority over buying fresh L1s while the curtain is down — found via trace: a merged L2 wreck
// costs 120 ore to repair (rate × buyCost60 × level2), but the "buy a new L1" branch ran every tick
// regardless and drained ore to a fresh 60-ore wall first, so the L2 repair never saw enough ore and
// the curtain sat at 0 alive for two whole waves despite 60+ ore banked.
function manageWalls(state, targetCount, zone, maxLevel = 2) {
  const allWalls = state.fortress.buildings.filter((b) => b.type === "wall");
  const wrecks = allWalls.filter((b) => b.hp <= 0);
  if (allWalls.length > 0 && wrecks.length === allWalls.length) state._wallCurtainDown = true;

  if (state._wallCurtainDown) {
    if (wrecks.length === 0) {
      state._wallCurtainDown = false; // fully rebuilt — go back to normal build/merge below
    } else {
      const cheapest = wrecks.reduce((a, b) => (b.level < a.level ? b : a)); // lowest level = lowest repair cost — get any wall back up fastest
      return repairFortressBuilding(state, cheapest.id).ok;
    }
  }

  const walls = aliveBuildings(state, "wall");
  const cost = CONFIG.fortressBuildings.wall.buyCost.ore ?? 0;
  if (walls.length < targetCount && state.resources.ore >= cost) {
    const spot = findClearablePlacement(state, "wall", zone);
    return Boolean(placeBuilding(state, "wall", spot));
  }
  const topLevel = walls.reduce((m, b) => Math.max(m, b.level), 0);
  if (topLevel < maxLevel) return mergePairOfType(state, "wall");
  return false;
}

// "Я перемещаю турель так, чтобы аура босса не могла её задеть, но она могла дотянуться до него."
// orcKing's aura has radius 1.6; turret range runs 1.8 (L1) to 2.6 (L5) — a real but sometimes
// narrow band exists (dist > auraRadius AND dist <= turretRange) where a turret snipes the boss for
// free. Fires only while an aura-mechanic boss is alive on the field; relocates the first turret
// caught inside the aura to the closest free tile in that safe band. Confirmed critical by a real
// playtest action log: "без турелей шансов практически 0" — and the log showed exactly this kind of
// mid-fight repositioning (3 "Building moved" events right around the wave-12 boss).
function kiteAuraBoss(state) {
  const auraBoss = state.fortress.battle?.enemies?.find((e) => e.hp > 0 && e.mechanic?.kind === "aura");
  if (!auraBoss) return false;
  const auraRadius = auraBoss.mechanic.radius ?? 0;

  for (const turret of aliveBuildings(state, "turret")) {
    const range = CONFIG.fortressBuildings.turret.levels[turret.level - 1]?.range ?? 0;
    const center = { x: turret.tiles[0].x + 0.5, y: turret.tiles[0].y + 0.5 };
    const dist = Math.hypot(center.x - auraBoss.x, center.y - auraBoss.y);
    if (dist > auraRadius) continue; // already safe, or already out of its own range — leave it

    const maxX = Math.max(...state.fortress.field.map((t) => t.x));
    const maxY = Math.max(...state.fortress.field.map((t) => t.y));
    let best = null;
    for (let y = 0; y <= maxY; y += 1) {
      for (let x = 0; x <= maxX; x += 1) {
        if (tile(state, x, y)?.occupant) continue; // a turret can't clear obstacles mid-move
        const d = Math.hypot(x + 0.5 - auraBoss.x, y + 0.5 - auraBoss.y);
        if (d > auraRadius && d <= range && (!best || d < best.d)) best = { x, y, d };
      }
    }
    if (best) return moveFortressBuilding(state, turret.id, { x: best.x, y: best.y }).ok;
  }
  return false;
}

function isBuildingUnlocked(state, type) {
  return state.fortress.waveNumber >= (CONFIG.fortressBuildings[type]?.unlockWave ?? 1);
}
function isResourceUnlocked(state, key) {
  const rt = CONFIG.mine.resourceTypes.find((r) => r.key === key);
  return rt ? state.fortress.waveNumber >= rt.unlockWave : false;
}
function nextFreeSpot(existing, spots) {
  const used = new Set(existing.map((b) => `${b.tiles[0].x},${b.tiles[0].y}`));
  return spots.find((s) => !used.has(`${s.x},${s.y}`)) ?? null;
}
// placeBuilding returns null when unaffordable/blocked, so every "try*" below is a polite
// attempt: the policy walks its priority list every tick and buys whatever it can afford,
// exactly like a player eyeballing their resource bars.
function tryPlace(state, type, origin = null) {
  return Boolean(placeBuilding(state, type, origin));
}

// ---------------------------------------------------------------- policies

const POLICIES = {
  passive() {},

  // Average human: no deliberate wall curtain (scattered blockers), few buildings,
  // short merge ladders, modest worker count. Emulates "plays fine, builds sloppy".
  casual(state) {
    const w = state.fortress.waveNumber;
    const R = state.resources;
    manageWorkers(state, Math.min(totalSlots(state), 2 + Math.floor(w / 5)) + 1);

    const walls = aliveBuildings(state, "wall");
    const wallSpots = [{ x: 6, y: 2 }, { x: 4, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 1 }];
    const wantedWalls = Math.min(1 + Math.floor(w / 8), 4);
    if (walls.length < wantedWalls && R.ore >= 60) {
      const spot = nextFreeSpot(walls, wallSpots);
      if (spot) placeBuilding(state, "wall", spot);
    }
    // sloppy players still grab a second garrison once wood piles up (a lone L1 barracks
    // fields a single warrior under the unit cap), but nothing systematic after that
    const barracks = aliveBuildings(state, "barracks");
    if (w >= 4 && barracks.length < 2) ladderStep(state, "barracks", 2, { x: 0, y: 0 });
    // turret ladder capped at L2 (two buys + one merge), archery single L1
    const turrets = aliveBuildings(state, "turret");
    if (w >= 5 && turrets.length < 2) ladderStep(state, "turret", 2, { x: 3, y: turrets.length === 0 ? 1 : 5 });
    if (w >= 3 && aliveBuildings(state, "archery").length < 1) tryPlace(state, "archery", { x: 2, y: 5 });

    if (state.fortress.stream.phase === "gap") repairIfNeeded(state, 0.5);
  },

  // Strong scripted play under the unit cap. Split by resource lane — ore buys the wall
  // curtain, wood buys unit throughput, gold buys workers — then walk the wood lane down a
  // build-order priority list every tick, buying whatever is affordable right now:
  // second garrison in the opening → merge ladders → turret (anti-armor) → late tech.
  balanced(state) {
    const w = state.fortress.waveNumber;
    const R = state.resources;
    manageWorkers(state, Math.min(totalSlots(state), 2 + Math.floor(w / 3)) + 1);

    // ore lane: wall curtain — only 2 walls until w8 so the turret (wood+ore) lands before
    // the first boss; second layer from w18
    const walls = aliveBuildings(state, "wall");
    const wallSpots = [0, 1, 2, 4, 5, 6].map((y) => ({ x: 5, y }))
      .concat(w >= 18 ? [0, 1, 2, 4, 5, 6].map((y) => ({ x: 4, y })) : []);
    const wantedWalls = Math.min(2 + Math.max(0, Math.floor((w - 6) / 2)) + (w >= 18 ? 6 : 0), 12);
    if (walls.length < wantedWalls && R.ore >= 60) {
      const spot = nextFreeSpot(walls, wallSpots);
      if (spot) placeBuilding(state, "wall", spot);
    }

    // wood lane, priority order (each step is affordability-gated inside):
    // 1. second garrison immediately — starting wood (130) covers its ~117 cost in wave 1,
    //    and under the unit cap doubling spawner count is the cheapest DPS double.
    ladderStep(state, "barracks", 3, { x: 0, y: 0 });
    // 2. archery ladder behind the curtain (L3 = 3 archers @ 2.6 range).
    if (w >= 3 && walls.length >= 2) ladderStep(state, "archery", 3, { x: 0, y: 5 });
    // 3. turret ladder — the only anti-armor source before stables/mage.
    const turrets = aliveBuildings(state, "turret");
    const turretSpots = w >= 18
      ? [{ x: 2, y: 3 }, { x: 1, y: 5 }, { x: 2, y: 0 }] // deeper once walls get chewed late
      : [{ x: 3, y: 1 }, { x: 3, y: 5 }, { x: 2, y: 0 }];
    if (w >= 5 && walls.length >= 1 && turrets.length < (w >= 26 ? 4 : 2)) {
      ladderStep(state, "turret", 5, turretSpots[turrets.length % turretSpots.length]);
    }
    // 4. late tech, single building each, then ladders for the capped squads.
    if (w >= 9 && aliveBuildings(state, "stables").length < 1) tryPlace(state, "stables", { x: 3, y: 4 });
    if (w >= 15) ladderStep(state, "stables", 2, { x: 3, y: 4 });
    if (w >= 11 && aliveBuildings(state, "mageTower").length < 1) tryPlace(state, "mageTower", { x: 3, y: 1 });
    if (w >= 17) ladderStep(state, "mageTower", 2, { x: 3, y: 1 });

    // late-game: convert surplus into more spawner buildings — under the cap, alive-unit
    // count = Σ levels of alive spawners, so building count is the throughput ceiling.
    const barracksAlive = aliveBuildings(state, "barracks").length;
    if (w >= 12 && R.wood > 1500 && barracksAlive < 8) ladderStep(state, "barracks", 3, null);
    const archeryAlive = aliveBuildings(state, "archery").length;
    if (w >= 12 && R.wood > 2500 && archeryAlive < 6) ladderStep(state, "archery", 3, null);
    if (w >= 14 && R.iron > 1200 && aliveBuildings(state, "stables").length < 3) {
      tryPlace(state, "stables", { x: 3, y: 4 });
    }

    // rich strong players repair mid-wave too, not only in gaps
    if (state.fortress.stream.phase === "gap" || (R.wood > 3000 && R.ore > 3000)) repairIfNeeded(state);
  },

  economy(state) {
    const w = state.fortress.waveNumber;
    manageWorkers(state, 99); // all-in workers
    const walls = aliveBuildings(state, "wall");
    if (walls.length < 2 && state.resources.ore >= 60) placeBuilding(state, "wall", { x: 5, y: 2 });
    // second garrison in the opening, ladder after — minimal defense otherwise
    if (w >= 3) ladderStep(state, "barracks", 3, { x: 0, y: 0 });
    if (state.fortress.stream.phase === "gap") repairIfNeeded(state);
  },

  defense(state) {
    const w = state.fortress.waveNumber;
    manageWorkers(state, Math.min(3, staffedCount(state) + state.reserveUnits.length + 1));
    // full curtain + second layer, turret ladder to L4 (one crystal gate), archery/barracks to L2
    const walls = aliveBuildings(state, "wall");
    const wallSpots = [0, 1, 2, 4, 5, 6].map((y) => ({ x: 5, y })).concat([0, 1, 2, 4, 5, 6].map((y) => ({ x: 4, y })));
    const wantedWalls = Math.min(2 + Math.floor(w / 4), 9);
    if (walls.length < wantedWalls && state.resources.ore >= 60) {
      const spot = nextFreeSpot(walls, wallSpots);
      if (spot) placeBuilding(state, "wall", spot);
    }
    const turrets = aliveBuildings(state, "turret");
    const turretSpots = [{ x: 3, y: 1 }, { x: 3, y: 5 }, { x: 2, y: 0 }];
    if (w >= 5 && turrets.length < 3) {
      ladderStep(state, "turret", 4, turretSpots[turrets.length % turretSpots.length]);
    }
    if (w >= 3) ladderStep(state, "archery", 2, { x: 0, y: 5 });
    if (w >= 4) ladderStep(state, "barracks", 2, { x: 0, y: 0 });
    if (state.fortress.stream.phase === "gap") repairIfNeeded(state);
  },

  // "SmartAss" — the real playtester's described build order, transcribed as closely as the
  // available sim actions allow (see the helper functions above for the reasoning behind each
  // piece). HQ sits at tiles x=0-1, y=2-4 on the 9x7 field (checked via a fresh state dump), so
  // "close to HQ" is the x=0-3 band, and "2-3 tiles in front of HQ" for the wall line is x=4.
  // Revised economic plan (corrected after a real playtest, see balance-changes.md): before wave
  // 12, the whole point is to STOCKPILE, not spend — full mine staffing eats gold, a single modest
  // barracks eats a little wood/space. This section used to guess the plan ("bank wood/ore, burst
  // turrets right at wave 12"); a real playtest action log (exported via the dev panel's new
  // "📋 Log" button — see actionLogger.js) replaced the guess with the actual build order:
  //   - workers bought in bursts (~8 at wave 1, ~8 more at wave 6), mass-merged each time
  //   - barracks: 6 total copies bought one at a time across waves 1-7, merged as pairs became
  //     available — NOT stockpiled — landing on 1×L3 (matches `multiLadder` below)
  //   - exactly ONE wall, bought wave 1, never merged or touched again
  //   - turrets start at WAVE 8, not wave 12 — bought and merged continuously, reaching L3+L2+fresh
  //     L1 by the time the wave-12 boss shows up. The player was explicit: "без турелей шансов
  //     практически 0" — turrets are not a wave-12 add-on, they're the actual plan.
  //   - 3 "Building moved" events right around wave 11-12: confirmed as manual kiting — repositioning
  //     a turret just outside the boss's aura radius while staying inside the turret's own range
  //     (orcKing aura radius 1.6 vs turret range 1.8-2.6 — a real, if sometimes narrow, safe band).
  //     `kiteAuraBoss` (see above) automates this.
  smartAss(state) {
    // Zones, not fixed coordinates: `findClearablePlacement` (see above) picks the actual cheapest
    // spot inside each zone on THIS game's real tree layout, preferring ones that border already-
    // open ground — the "scan the map for a couple of trees next to a big empty pocket" behavior.
    const innerZone = { xMin: 0, xMax: 3, yMin: 0, yMax: 6 }; // next to HQ — barracks, mage tower
    const wallZone = { xMin: 3, xMax: 4, yMin: 0, yMax: 6 }; // 2-3 tiles in front of HQ
    const turretZone = { xMin: 1, xMax: 4, yMin: 0, yMax: 6 };

    // 1. workers: fully staff every unlocked mine slot.
    manageWorkers(state, totalSlots(state));

    // 2. barracks: one building pushed to L3, merge-as-you-go — naturally leaves the earlier-bought
    // spares unmerged once the target is hit, matching the observed 1×L3 (+ spare L1s) outcome.
    multiLadder(state, "barracks", 3, 1, innerZone);

    // 3. walls: just ONE, bought once and left alone — not a ladder, not a curtain.
    if (aliveBuildings(state, "wall").length < 1 && state.resources.ore >= (CONFIG.fortressBuildings.wall.buyCost.ore ?? 0)) {
      placeBuilding(state, "wall", findClearablePlacement(state, "wall", wallZone));
    }

    // 4. mage tower — same merge-as-you-go treatment and inner zone as barracks, from unlock onward
    // (kept for completeness; the real playtest never built one either).
    if (isBuildingUnlocked(state, "mageTower")) {
      multiLadder(state, "mageTower", 3, 1, innerZone);
    }

    // 5. turrets — from wave 8 (not 12): the actual plan, not a last-minute burst. Bought and merged
    // on sight, since both damage AND range scale with level.
    if (state.fortress.waveNumber >= 8 && isBuildingUnlocked(state, "turret")) {
      const spot = findClearablePlacement(state, "turret", turretZone);
      ladderStep(state, "turret", 5, spot);
    }

    // 6. kite any turret caught inside a boss's aura back out to a safe sniping distance.
    kiteAuraBoss(state);
  },
};

// ---------------------------------------------------------------- runner

function run(policyName, { maxSeconds = 3600, quiet = false, seedSuffix = "" } = {}) {
  // deterministic runs: seed the engine's Math.random (spawn jitter, obstacle layout, placement)
  let seed = [...(policyName + seedSuffix)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const state = createInitialState();
  startFortressBattle(state);
  const policy = POLICIES[policyName];
  if (!policy) throw new Error(`Unknown policy: ${policyName}`);

  const logs = [];
  let lastWaveIndex = 0;
  let waveStart = { t: 0, hq: state.fortress.buildings[0].hp, kills: state.fortress.battle.enemiesDefeated, gold: state.resources.gold };
  const openLog = () => {
    const s = waveSummary(state.fortress.stream.currentWaveIndex);
    waveStart = { t: state.t, hq: state.fortress.buildings[0].hp, kills: state.fortress.battle.enemiesDefeated };
    logs.push({
      wave: state.fortress.waveNumber,
      ...s,
      playerDps: playerDps(state),
      allies: state.fortress.battle.allies.filter((a) => a.hp > 0).length,
      staffed: staffedCount(state),
    });
  };
  state.t = 0;

  let sincePolicy = 0;
  const debug = process.env.DEBUG_ACTIONS === "1";
  openLog();
  while (!state.game.isOver && state.t < maxSeconds) {
    if (sincePolicy >= 1) {
      sincePolicy = 0;
      const before = JSON.stringify({ g: Math.floor(state.resources.gold), w: Math.floor(state.resources.wood), o: Math.floor(state.resources.ore), b: state.fortress.buildings.length, u: state.fortress.unplacedBuildings?.length ?? 0 });
      policy(state);
      if (debug) {
        const after = JSON.stringify({ g: Math.floor(state.resources.gold), w: Math.floor(state.resources.wood), o: Math.floor(state.resources.ore), b: state.fortress.buildings.length, u: state.fortress.unplacedBuildings?.length ?? 0 });
        if (before !== after) console.log(`[t=${state.t.toFixed(0)}] ${before} -> ${after}`);
      }
    }
    sincePolicy += DT;
    tickMineProduction(state, DT);
    tickFortressBattle(state, DT);
    tickUpgradeEffects(state, DT);
    state.t += DT;
    if (state.fortress.stream.currentWaveIndex !== lastWaveIndex) {
      lastWaveIndex = state.fortress.stream.currentWaveIndex;
      const last = logs[logs.length - 1];
      last.tEnd = state.t;
      last.hqDamage = +(waveStart.hq - state.fortress.buildings[0].hp).toFixed(1);
      last.kills = state.fortress.battle.enemiesDefeated - waveStart.kills;
      last.goldEarned = state.fortress.battle.goldEarned;
      last.hqAfter = +state.fortress.buildings[0].hp.toFixed(1);
      last.res = { ...state.resources };
      openLog();
    }
  }
  const last = logs[logs.length - 1];
  last.tEnd = state.t;
  last.hqDamage = +(waveStart.hq - state.fortress.buildings[0].hp).toFixed(1);
  last.hqAfter = +state.fortress.buildings[0].hp.toFixed(1);
  logs.pop(); // drop the never-finished last wave

  if (state.game.result === "loss" && !quiet) {
    const alive = state.fortress.battle.enemies.map((e) => `${e.archetype}:${Math.round(e.hp)}`).join(",");
    const roster = state.fortress.buildings.map((b) => `${b.type}L${b.level}:${Math.round(b.hp)}`).join(",");
    console.log(`[death dump t=${state.t.toFixed(0)}] wave=${state.fortress.waveNumber} phase=${state.fortress.stream.phase} idx=${state.fortress.stream.currentWaveIndex} allies=${state.fortress.battle.allies.filter((a) => a.hp > 0).length}`);
    console.log(`  enemies=[${alive}]`);
    console.log(`  buildings=[${roster}]`);
  }

  // final building roster (alive only; the engine keeps destroyed buildings in the array as wrecks)
  const roster = {};
  let wrecks = 0;
  for (const b of state.fortress.buildings) {
    if (b.type === "hq") continue;
    if (b.hp <= 0) { wrecks += 1; continue; }
    const key = `${b.type}`;
    roster[key] ??= {};
    roster[key][`L${b.level}`] = (roster[key][`L${b.level}`] ?? 0) + 1;
  }

  return { state, logs, result: state.game.result ?? "timeout", t: state.t, policyName, roster, wrecks };
}

function fmt(n, d = 0) { return Number(n).toFixed(d); }

function report(run) {
  const { state, logs, result, t, policyName, roster, wrecks } = run;
  const rows = [];
  rows.push(`policy=${policyName} result=${result} at wave ${state.fortress.waveNumber} t=${fmt(t)}s kills=${state.fortress.battle.enemiesDefeated} goldEarned=${fmt(state.fortress.battle.goldEarned)}`);
  rows.push(`buildings@end: ${Object.entries(roster).map(([type, levels]) => `${type} {${Object.entries(levels).map(([l, n]) => `${l}x${n}`).join(", ")}}`).join("  ")}  | wrecks: ${wrecks}`);
  rows.push("wave | enemies | waveEHP | waveDPS | playerDPS@start | allies@start | staffed | dur(s) | HQdmg | HQafter | res(w/o/i/c)");
  for (const l of logs) {
    rows.push([
      l.wave, l.count, fmt(l.ehp), l.dps, l.playerDps, l.allies, l.staffed,
      fmt((l.tEnd ?? t) - (l.tStart ?? 0), 0), fmt(l.hqDamage ?? 0), fmt(l.hqAfter ?? ""),
      l.res ? `${fmt(l.res.wood)}/${fmt(l.res.ore)}/${fmt(l.res.iron)}/${fmt(l.res.crystal)}` : "",
    ].join(" | "));
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------- main

export { run, report, POLICIES, CONFIG_JSON };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = process.argv[2] ?? "all";
  const quiet = process.argv.includes("--quiet");
  const policies = arg === "all" ? ["passive", "casual", "economy", "defense", "balanced", "smartAss"] : [arg];
  for (const name of policies) {
    const r = run(name, { quiet });
    console.log(report(r));
    console.log("-".repeat(100));
  }
}
