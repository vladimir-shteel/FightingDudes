// Headless balance harness — runs the REAL game engine (js/game/*) in Node and drives
// it with scripted strategies. No DOM: CONFIG is injected directly, only the tick
// functions and the public player-action APIs are used.
//
// Usage: node tools/balance-sim/headless.mjs [policy|all] [--quiet]
//   policies: passive | balanced | economy | defense

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
    if (state.fortress.obstacleRemovalCost && state.resources.gold >= state.fortress.obstacleRemovalCost) {
      // free spot may not exist — clear one obstacle as a fallback (policies pay the gold)
      const blocked = state.fortress.field.find((t) => t.occupant === "obstacle");
      if (blocked) removeFortressObstacle(state, blocked.x, blocked.y);
    }
    spot = findFortressPlacement(state, type);
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
};

// ---------------------------------------------------------------- runner

function run(policyName, { maxSeconds = 3600, quiet = false } = {}) {
  // deterministic runs: seed the engine's Math.random (spawn jitter, obstacle layout, placement)
  let seed = [...policyName].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
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

  if (state.game.result === "loss") {
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

const arg = process.argv[2] ?? "all";
const quiet = process.argv.includes("--quiet");
const policies = arg === "all" ? ["passive", "casual", "economy", "defense", "balanced"] : [arg];
for (const name of policies) {
  const r = run(name, { quiet });
  console.log(report(r));
  console.log("-".repeat(100));
}
