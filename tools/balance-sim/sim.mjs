// Aggregate 1D battle simulation for Fortress (codex/fmfm-realtime).
// Mirrors the real systems: stream state machine, enemy/ally scaling, armor rule,
// mine production, worker/buy/upgrade/repair costs. Spatial layout is collapsed to
// one axis (enemies march right→left), which is enough to reason about balance curves.
//
// Usage: node tools/balance-sim/sim.mjs [policy] [--json]
//   policy: passive | balanced | economy | defense | all (default all)

import {
  CONFIG, FIELD_W, canAfford, spend, makeEnemyStats, makeAllyStats,
  buildingBuyCost, buildingUpgradeCost, buildingMaxHp, buildingRepairCost,
  mergeCrystalCost, workerBuyCost, maxWorkerLevel,
  mineSlots, slotsUnlockedAt, mineUnlockedAt, mineSlotMultiplier, workerProduction,
  damageAfterArmor, expandComposition, waveSummary,
} from "./lib.mjs";

const DT = 0.1;
const ENEMY_SPAWN_X = FIELD_W + 0.45;

// ------------------------------------------------------------------ entities

class Building {
  constructor(type, level, x, halfW) {
    this.type = type;
    this.level = level;
    this.x = x;
    this.halfW = halfW;
    this.hp = buildingMaxHp({ type, level });
    this.maxHp = this.hp;
    this.cooldownTimer = 0.5;
    this.width = CONFIG.fortressBuildings[type].footprint.reduce((m, [fx]) => Math.max(m, fx + 1), 1);
  }
  get alive() { return this.hp > 0; }
  get rightEdge() { return this.x + this.halfW; }
}

class Enemy {
  constructor(stats, x) {
    Object.assign(this, stats);
    this.x = x;
    this.attackTimer = 0;
    this.auraTimer = 0;
    this.summonTimer = stats.mechanic?.kind === "summon" ? stats.mechanic.intervalSeconds : 0;
    this.target = null;
  }
  get alive() { return this.hp > 0; }
}

class Ally {
  constructor(stats, x) {
    Object.assign(this, stats);
    this.x = x;
    this.attackTimer = 0;
  }
  get alive() { return this.hp > 0; }
}

// ------------------------------------------------------------------ simulation

class Sim {
  constructor(policyName, seed = 1) {
    this.policyName = policyName;
    this.res = { gold: CONFIG.startingGold, ...JSON.parse(JSON.stringify(CONFIG.startingResources)), iron: 0, crystal: 0 };
    // Starting layout mirrors createFortressState: HQ x0-1, barracks x2-3, wall x4.
    this.buildings = [
      new Building("hq", 1, 1.0, 1.0),
      new Building("barracks", 1, 3.0, 1.0),
      new Building("wall", 1, 4.5, 0.5),
    ];
    this.hq = this.buildings[0];
    this.allies = [];
    this.enemies = [];
    // mines: resourceKey -> { workers: [level|null per slot], progress[] }
    this.mines = {};
    for (const rt of CONFIG.mine.resourceTypes) {
      const n = rt.slotUnlockWaves.length;
      this.mines[rt.key] = { workers: Array(n).fill(null), progress: Array(n).fill(0), reservePool: [] };
    }
    this.reserveWorkers = []; // levels of unassigned workers
    this.obstaclesLeft = CONFIG.fortress?.obstacleCount ?? 10;
    this.nextObstacleCost = CONFIG.fortress?.obstacleRemovalBaseCost ?? 3;

    this.stream = { active: true, phase: "spawning", waveIndex: 0, gapTimer: 0 };
    this.waveNumber = 1;
    this.spawnQueue = expandComposition(CONFIG.fortressWaves[0]);
    this.spawnTimer = 0;

    this.t = 0;
    this.rngState = seed;
    this.gameOver = null; // "win" | "loss"
    // stats
    this.waveLog = [];
    this.waveStat = null;
    this.totalKills = 0;
    this.goldEarned = 0;
    this.goldSpentOnWorkers = 0;
    this.goldSpentOnObstacles = 0;
    this.workersBought = 0;
  }

  rng() { // deterministic LCG
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  get wave() { return CONFIG.fortressWaves[this.stream.waveIndex]; }
  get demandResource() { return this.wave?.demandResource ?? null; }

  totalWorkerPower() {
    let p = 0;
    for (const mine of Object.values(this.mines)) for (const w of mine.workers) if (w) p += 2 ** (w - 1);
    for (const w of this.reserveWorkers) p += 2 ** (w - 1);
    return p;
  }
  staffedCount() {
    let n = 0;
    for (const mine of Object.values(this.mines)) for (const w of mine.workers) if (w) n += 1;
    return n;
  }
  freeSlots() {
    const free = [];
    for (const rt of CONFIG.mine.resourceTypes) {
      if (!mineUnlockedAt(rt.key, this.waveNumber)) continue;
      const unlocked = slotsUnlockedAt(rt.key, this.waveNumber);
      const mine = this.mines[rt.key];
      for (let i = 0; i < unlocked; i++) if (!mine.workers[i]) free.push({ resource: rt.key, slot: i });
    }
    return free;
  }

  // ----- policy-facing actions (mirror real costs) -----
  buyWorker() {
    const cost = workerBuyCost(this.totalWorkerPower());
    if (this.res.gold < cost) return false;
    this.res.gold -= cost;
    this.goldSpentOnWorkers += cost;
    this.workersBought += 1;
    this.reserveWorkers.push(1);
    return true;
  }
  assignWorkers() { // fill free slots with reserve workers (highest level first)
    this.reserveWorkers.sort((a, b) => b - a);
    for (const slot of this.freeSlots()) {
      const lvl = this.reserveWorkers.shift();
      if (lvl === undefined) break;
      this.mines[slot.resource].workers[slot.slot] = lvl;
    }
  }
  mergeWorkers() { // pair same-level workers (mirrors free worker merging)
    const cap = maxWorkerLevel(this.waveNumber);
    const pool = [...this.reserveWorkers];
    for (const mine of Object.values(this.mines)) {
      mine.workers.forEach((w, i) => { if (w) pool.push({ level: w, mine, i }); });
    }
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let a = 0; a < pool.length; a++) {
        for (let b = a + 1; b < pool.length; b++) {
          const la = pool[a].level ?? pool[a];
          const lb = pool[b].level ?? pool[b];
          if (la === lb && la < cap) {
            const mergedLevel = la + 1;
            // remove both, add merged to reserve
            const removeA = pool[a];
            const removeB = pool[b];
            pool.splice(b, 1); pool.splice(a, 1);
            if (removeA.mine) removeA.mine.workers[removeA.i] = null;
            if (removeB.mine) removeB.mine.workers[removeB.i] = null;
            this.reserveWorkers.push(mergedLevel);
            pool.push(mergedLevel);
            merged = true;
            break outer;
          }
        }
      }
    }
    this.assignWorkers();
  }
  clearObstacles(n) {
    for (let i = 0; i < n; i++) {
      if (this.obstaclesLeft <= 0) return i;
      if (this.res.gold < this.nextObstacleCost) return i;
      this.res.gold -= this.nextObstacleCost;
      this.goldSpentOnObstacles += this.nextObstacleCost;
      this.nextObstacleCost += CONFIG.fortress?.obstacleRemovalCostStep ?? 1;
      this.obstaclesLeft -= 1;
    }
    return n;
  }
  buyBuilding(type, x) {
    const def = CONFIG.fortressBuildings[type];
    if (this.waveNumber < (def.unlockWave ?? 1) && !def.unlockedByDefault) return false;
    const cost = buildingBuyCost(this.buildings, type);
    if (!canAfford(this.res, cost)) return false;
    const width = def.footprint.reduce((m, [fx]) => Math.max(m, fx + 1), 1);
    // ~20% of free tiles hold obstacles → expected clears to open `width` tiles
    const clears = Math.min(this.obstaclesLeft, Math.ceil(width * 0.2));
    if (this.res.gold < this.nextObstacleCost * clears) return false;
    spend(this.res, cost);
    this.clearObstacles(clears);
    const halfW = { hq: 1, wall: 0.5, bigWall: 1.5, barracks: 1, archery: 1.5, turret: 0.5, stables: 1, mageTower: 1, mine: 0.5 }[type] ?? 0.5;
    this.buildings.push(new Building(type, 1, x, halfW));
    return true;
  }
  upgradeBuilding(b) {
    const cost = buildingUpgradeCost(b);
    if (!cost || !canAfford(this.res, cost)) return false;
    spend(this.res, cost);
    b.level += 1;
    b.maxHp = buildingMaxHp(b);
    b.hp = b.maxHp; // upgrading heals to full (mirrors upgradeFortressBuilding)
    return true;
  }
  mergeBuildings(a, b) { // same type & level → level+1
    if (a.type !== b.type || a.level !== b.level || !a.alive || !b.alive) return false;
    const nextLevel = a.level + 1;
    if (!CONFIG.fortressBuildings[a.type].levels[nextLevel - 1]) return false;
    const crystal = mergeCrystalCost(a.type, nextLevel);
    if (crystal > 0 && !canAfford(this.res, { crystal })) return false;
    if (crystal > 0) spend(this.res, { crystal });
    b.level += 1;
    b.maxHp = buildingMaxHp(b);
    b.hp = b.maxHp;
    this.buildings.splice(this.buildings.indexOf(a), 1);
    return true;
  }
  repairBuilding(b) {
    const cost = buildingRepairCost(b);
    if (!Object.keys(cost).length || !canAfford(this.res, cost)) return false;
    spend(this.res, cost);
    b.hp = b.maxHp;
    return true;
  }

  // ----- production (mirror tickMineProduction) -----
  tickProduction(dt) {
    const interval = CONFIG.mine.collectionIntervalSeconds;
    for (const rt of CONFIG.mine.resourceTypes) {
      const mine = this.mines[rt.key];
      if (!mineUnlockedAt(rt.key, this.waveNumber)) continue;
      for (let i = 0; i < mine.workers.length; i++) {
        if (i >= slotsUnlockedAt(rt.key, this.waveNumber)) continue;
        const lvl = mine.workers[i];
        if (!lvl) continue;
        mine.progress[i] += dt;
        if (mine.progress[i] < interval) continue;
        mine.progress[i] = 0;
        const slotMult = mineSlotMultiplier(rt.key, i);
        const demandMult = rt.key === this.demandResource ? (CONFIG.waveDemand?.slotProductionMultiplier ?? 1) : 1;
        this.res[rt.key] += workerProduction(lvl) * slotMult * demandMult;
      }
    }
  }

  // ----- stream machine (mirror tickFortressBattle) -----
  tickStream(dt) {
    const s = this.stream;
    if (this.spawnQueue.length > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        const archetype = this.spawnQueue.shift();
        this.enemies.push(new Enemy(makeEnemyStats(archetype, this.waveNumber), ENEMY_SPAWN_X));
        this.spawnTimer = this.wave.spawnIntervalSeconds;
        if (this.waveStat) this.waveStat.spawnedAt[this.waveStat.spawnedAt.length - 1] = this.t;
      }
    }
    const queueEmpty = this.spawnQueue.length === 0;
    if (s.phase === "spawning" && queueEmpty) {
      if (this.wave.waitForClear) s.phase = "waitClear";
      else { s.phase = "gap"; s.gapTimer = this.wave.gapSeconds ?? CONFIG.waveGapSeconds ?? 8; }
    }
    if (s.phase === "waitClear" && this.enemies.length === 0) {
      s.phase = "gap";
      s.gapTimer = this.wave.gapSeconds ?? CONFIG.waveGapSeconds ?? 8;
    }
    if (s.phase === "gap") {
      s.gapTimer -= dt;
      if (s.gapTimer <= 0) this.advanceWave();
    }
  }
  advanceWave() {
    const next = this.stream.waveIndex + 1;
    if (next >= CONFIG.fortressWaves.length) {
      this.stream.phase = "done";
      return;
    }
    this.closeWaveLog();
    this.stream.waveIndex = next;
    this.stream.phase = "spawning";
    this.waveNumber = next + 1;
    this.spawnQueue = expandComposition(this.wave);
    this.spawnTimer = 0;
    this.openWaveLog();
  }
  openWaveLog() {
    this.waveStat = {
      wave: this.waveNumber, demand: this.demandResource,
      boss: !!this.wave.isBoss,
      enemyEhp: 0, enemyDps: 0, count: this.spawnQueue.length,
      tStart: this.t, tEnd: null, spawnedAt: [],
      hqAtStart: this.hq.hp, kills: 0, goldEarned: 0,
      alliesAtStart: this.allies.filter(a => a.alive).length,
      playerDps: this.estimatePlayerDps(),
    };
    const w = this.waveNumber;
    for (const entry of this.wave.composition ?? []) {
      const st = makeEnemyStats(entry.archetype, w);
      this.waveStat.enemyEhp += st.hp * entry.count;
      this.waveStat.enemyDps += (st.attack / st.cooldownSeconds) * entry.count;
    }
  }
  closeWaveLog() {
    if (!this.waveStat) return;
    this.waveStat.tEnd = this.t;
    this.waveStat.hqAtEnd = this.hq.hp;
    this.waveStat.hqDamage = this.waveStat.hqAtStart - this.hq.hp;
    this.waveLog.push(this.waveStat);
    this.waveStat = null;
  }
  estimatePlayerDps() {
    let dps = 0;
    for (const a of this.allies) if (a.alive) dps += a.attack / a.cooldownSeconds;
    for (const b of this.buildings) {
      if (!b.alive || b.type !== "turret") continue;
      const lvl = CONFIG.fortressBuildings.turret.levels[b.level - 1];
      dps += lvl.damage / lvl.cooldownSeconds;
    }
    return Math.round(dps * 10) / 10;
  }

  // ----- combat -----
  tickCombat(dt) {
    const buildings = this.buildings.filter(b => b.alive);
    const allies = this.allies.filter(a => a.alive);
    const enemies = this.enemies.filter(e => e.alive);

    // spawner buildings produce allies
    for (const b of buildings) {
      const lvl = CONFIG.fortressBuildings[b.type].levels[b.level - 1];
      if (!lvl.unit) continue;
      b.cooldownTimer -= dt;
      if (b.cooldownTimer <= 0) {
        this.allies.push(new Ally(makeAllyStats(lvl.unit, b.level), b.x + 0.65));
        b.cooldownTimer = lvl.cooldownSeconds;
      }
    }
    // turrets fire (discrete shots → armor applies per hit)
    for (const b of buildings) {
      if (b.type !== "turret") continue;
      const lvl = CONFIG.fortressBuildings.turret.levels[b.level - 1];
      b.cooldownTimer -= dt;
      if (b.cooldownTimer > 0) continue;
      const front = enemies.filter(e => e.alive && e.x - b.x <= lvl.range).sort((x, y) => y.x - x.x)[0];
      if (front) {
        front.hp -= damageAfterArmor(lvl.damage, front.armor);
        b.cooldownTimer = lvl.cooldownSeconds;
      }
    }
    // allies: target frontmost enemy, discrete attacks, melee walk up
    for (const a of allies) {
      const front = enemies.filter(e => e.alive).sort((x, y) => y.x - x.x)[0];
      if (!front) continue;
      a.attackTimer -= dt;
      if (Math.abs(front.x - a.x) <= a.range) {
        if (a.attackTimer <= 0) {
          a.attackTimer = a.cooldownSeconds;
          if (a.splashRadius > 0) {
            for (const e of enemies) if (e.alive && Math.abs(e.x - front.x) <= a.splashRadius) e.hp -= damageAfterArmor(a.attack, e.armor);
          } else {
            front.hp -= damageAfterArmor(a.attack, front.armor);
          }
        }
      } else if (a.attackTimer <= 0) {
        // walking; attack timer stays clamped at 0
        a.x = Math.min(front.x - a.range, a.x + a.speed * dt);
      }
      if (a.attackTimer < 0) a.attackTimer = 0;
    }
    // enemies: fight allies in reach, else chew the frontmost building
    for (const e of enemies) {
      if (!e.alive) continue;
      e.attackTimer -= dt;
      if (e.attackTimer > 0) continue;
      // nearest ally within range+buffer
      let target = null, best = Infinity;
      for (const a of allies) {
        const d = Math.abs(e.x - a.x);
        if (d <= e.range + 0.12 && d < best) { best = d; target = a; }
      }
      if (target) {
        target.hp -= e.attack;
        e.attackTimer = e.cooldownSeconds;
        continue;
      }
      // frontmost building (highest right edge ≤ enemy reach)
      let bld = null, bBest = -Infinity;
      for (const b of buildings) {
        if (b.rightEdge > e.x + 0.2) continue;
        if (b.rightEdge > bBest) { bBest = b.rightEdge; bld = b; }
      }
      if (bld && e.x - bld.rightEdge <= 0.7) {
        const breach = e.mechanic?.kind === "breach" ? e.mechanic.damageMultVsBuildings : 1;
        bld.hp -= e.attack * breach;
        e.attackTimer = e.cooldownSeconds;
        continue;
      }
      if (e.attackTimer < 0) e.attackTimer = 0;
      // move left toward the frontmost building
      const goal = bld ? bld.rightEdge + 0.2 : 0;
      e.x = Math.max(goal, e.x - e.speed * dt);
    }
    // boss mechanics
    for (const e of enemies) {
      if (!e.alive || !e.mechanic) continue;
      if (e.mechanic.kind === "aura") {
        e.auraTimer += dt;
        if (e.auraTimer < (CONFIG.combatEngine?.bossAuraTickSeconds ?? 1)) continue;
        e.auraTimer -= 1;
        for (const a of allies) if (a.alive && Math.abs(a.x - e.x) <= e.mechanic.radius) a.hp -= e.mechanic.damagePerSecond;
        const b = buildings.filter(b => b.alive && Math.abs(b.x - e.x) - b.halfW <= e.mechanic.radius)
          .sort((x, y) => y.x - x.x)[0];
        if (b) b.hp -= e.mechanic.damagePerSecond;
      } else if (e.mechanic.kind === "summon") {
        e.summonTimer -= dt;
        if (e.summonTimer <= 0) {
          e.summonTimer = e.mechanic.intervalSeconds;
          this.enemies.push(new Enemy(makeEnemyStats(e.mechanic.archetype, this.waveNumber), e.x + 0.4));
        }
      }
    }
    // deaths & kill gold
    for (const e of this.enemies) {
      if (e.alive || e.counted) continue;
      e.counted = true;
      this.totalKills += 1;
      const gold = (this.wave?.killGold ?? 0);
      this.res.gold += gold;
      this.goldEarned += gold;
      if (this.waveStat) this.waveStat.kills += 1;
    }
    this.enemies = this.enemies.filter(e => e.alive);
    this.allies = this.allies.filter(a => a.alive);
    this.buildings = this.buildings.filter(b => b.alive || b.type === "hq");
    if (!this.hq.alive) {
      this.gameOver = "loss";
      this.closeWaveLog();
    }
  }

  step(dt) {
    this.t += dt;
    this.tickProduction(dt);
    this.tickStream(dt);
    this.tickCombat(dt);
    if (this.stream.phase === "done" && this.enemies.length === 0 && !this.gameOver) {
      this.gameOver = "win";
      this.closeWaveLog();
    }
  }

  run(maxTime = 4000) {
    this.openWaveLog();
    let sincePolicy = 0;
    while (!this.gameOver && this.t < maxTime) {
      if (sincePolicy >= 1) { sincePolicy = 0; POLICIES[this.policyName](this); }
      sincePolicy += DT;
      this.step(DT);
    }
    if (!this.gameOver) { this.gameOver = "timeout"; this.closeWaveLog(); }
    return this;
  }
}

// ------------------------------------------------------------------ policies

function doRepairs(sim, hqFraction = 1, otherFraction = 0.7) {
  if (sim.hq.hp < sim.hq.maxHp * hqFraction) sim.repairBuilding(sim.hq);
  for (const b of sim.buildings) {
    if (b.type !== "hq" && b.hp < b.maxHp * otherFraction) sim.repairBuilding(b);
  }
}

const POLICIES = {
  passive: () => {},

  balanced(sim) {
    const w = sim.waveNumber;
    const R = sim.res;
    // 1. Workers & merges (keep growing economy)
    const totalSlots = CONFIG.mine.resourceTypes.reduce((s, rt) => s + (mineUnlockedAt(rt.key, w) ? slotsUnlockedAt(rt.key, w) : 0), 0);
    const targetStaffed = Math.min(totalSlots, 2 + Math.floor(w / 3));
    while (sim.staffedCount() + sim.reserveWorkers.length < targetStaffed + 2 && sim.res.gold >= workerBuyCost(sim.totalWorkerPower()) + 2) {
      if (!sim.buyWorker()) break;
    }
    sim.assignWorkers();
    sim.mergeWorkers();
    // 2. Defense build order (priority list)
    const walls = sim.buildings.filter(b => b.type === "wall");
    const turrets = sim.buildings.filter(b => b.type === "turret");
    const barracks = sim.buildings.find(b => b.type === "barracks");
    const archery = sim.buildings.find(b => b.type === "archery");
    const wallTarget = Math.min(2 + Math.floor(w / 5), 6);
    const turretTarget = w >= 5 ? Math.min(1 + Math.floor((w - 5) / 8), 3) : 0;
    const wantWall = walls.length < wallTarget;
    const wantTurret = turrets.length < turretTarget;
    // priority: barracks L2 early → wall#2 → archery → turret → upgrades → more walls
    if (w >= 1 && barracks && barracks.level === 1 && R.wood >= 100) sim.upgradeBuilding(barracks);
    if (w >= 2 && wantWall && R.ore >= 60) sim.buyBuilding("wall", 6.5 - walls.length * 0.9);
    if (w >= 3 && !archery && R.wood >= 70 && R.ore >= 35) sim.buyBuilding("archery", 2.5);
    if (w >= 5 && wantTurret && R.wood >= 80 && R.ore >= 50) sim.buyBuilding("turret", 3.5 + turrets.length * 0.7);
    if (w >= 6 && turrets[0] && turrets[0].level < 3) sim.upgradeBuilding(turrets[0]);
    if (w >= 8 && archery && archery.level < 3) sim.upgradeBuilding(archery);
    if (w >= 9 && w < 12 && !sim.buildings.some(b => b.type === "stables") && R.iron >= 60 && R.wood >= 80) sim.buyBuilding("stables", 2.5);
    if (w >= 10 && barracks && barracks.level < 4) sim.upgradeBuilding(barracks);
    if (w >= 11 && w < 13 && !sim.buildings.some(b => b.type === "mageTower") && R.ore >= 85 && R.crystal >= 45) sim.buyBuilding("mageTower", 2.5);
    if (w >= 12 && turrets[1] && turrets[1].level < 3) sim.upgradeBuilding(turrets[1]);
    if (w >= 14 && wantTurret && R.wood >= 160 && R.ore >= 100) sim.buyBuilding("turret", 3.5 + turrets.length * 0.7);
    if (w >= 16 && archery && archery.level < 4) sim.upgradeBuilding(archery);
    if (w >= 18 && turrets[0] && turrets[0].level < 5) sim.upgradeBuilding(turrets[0]);
    if (w >= 20 && turrets[1] && turrets[1].level < 5) sim.upgradeBuilding(turrets[1]);
    if (w >= 22 && barracks && barracks.level < 5) sim.upgradeBuilding(barracks);
    // building merges (free power: two same-level same-type → next level, crystal-gated at L4/L5)
    for (const type of ["turret", "barracks", "archery"]) {
      const group = sim.buildings.filter(b => b.type === type);
      for (let i = 0; i + 1 < group.length; i += 2) sim.mergeBuildings(group[i], group[i + 1]);
    }
    // 3. Repairs between waves
    if (sim.stream.phase === "gap") doRepairs(sim);
  },

  economy(sim) {
    const w = sim.waveNumber;
    // all-in on workers, minimal defense
    while (sim.res.gold >= workerBuyCost(sim.totalWorkerPower())) { if (!sim.buyWorker()) break; }
    sim.assignWorkers();
    sim.mergeWorkers();
    const barracks = sim.buildings.find(b => b.type === "barracks");
    if (barracks && barracks.level < 4 && sim.res.wood >= 100) sim.upgradeBuilding(barracks);
    const walls = sim.buildings.filter(b => b.type === "wall");
    if (walls.length < 2 && sim.res.ore >= 60) sim.buyBuilding("wall", 6.5);
    if (sim.stream.phase === "gap") doRepairs(sim);
  },

  defense(sim) {
    const w = sim.waveNumber;
    // workers capped at 3, everything else into defense
    const need = Math.min(3, sim.staffedCount() + sim.reserveWorkers.length + 1);
    while (sim.staffedCount() + sim.reserveWorkers.length < need && sim.res.gold >= workerBuyCost(sim.totalWorkerPower())) {
      if (!sim.buyWorker()) break;
    }
    sim.assignWorkers();
    sim.mergeWorkers();
    const walls = sim.buildings.filter(b => b.type === "wall");
    const turrets = sim.buildings.filter(b => b.type === "turret");
    const archery = sim.buildings.find(b => b.type === "archery");
    if (walls.length < Math.min(2 + Math.floor(w / 4), 8) && sim.res.ore >= 60) sim.buyBuilding("wall", 6.5 - walls.length * 0.9);
    if (w >= 3 && !archery && R_(sim, "wood", 70) && R_(sim, "ore", 35)) sim.buyBuilding("archery", 2.5);
    if (w >= 5 && turrets.length < 3 && R_(sim, "wood", 80) && R_(sim, "ore", 50)) sim.buyBuilding("turret", 3.5 + turrets.length * 0.7);
    for (const t of turrets) if (t.level < 5) { if (sim.upgradeBuilding(t)) break; }
    if (archery && archery.level < 4) sim.upgradeBuilding(archery);
    const barracks = sim.buildings.find(b => b.type === "barracks");
    if (barracks && barracks.level < 4) sim.upgradeBuilding(barracks);
    if (sim.stream.phase === "gap") doRepairs(sim);
  },
};
function R_(sim, key, amount) { return sim.res[key] >= amount; }

// ------------------------------------------------------------------ reporting

function fmt(n, d = 0) { return Number(n).toFixed(d); }

function report(sim) {
  const rows = [];
  rows.push(`policy=${sim.policyName} result=${sim.gameOver} at wave ${sim.waveNumber} t=${fmt(sim.t)}s kills=${sim.totalKills}`);
  rows.push(`gold earned=${fmt(sim.goldEarned)} workers bought=${sim.workersBought} gold→workers=${fmt(sim.goldSpentOnWorkers)} gold→obstacles=${fmt(sim.goldSpentOnObstacles)} obstacles left=${sim.obstaclesLeft}`);
  rows.push("wave | demand | enemies | waveEHP | waveDPS | playerDPS@start | allies@start | dur(s) | HQ dmg | HQ HP after | kills | gold@end");
  let prevGold = null;
  for (const l of sim.waveLog) {
    rows.push([
      l.wave, l.demand ?? "-", l.count, fmt(l.enemyEhp), fmt(l.enemyDps), fmt(l.playerDps, 1),
      l.alliesAtStart, fmt((l.tEnd ?? sim.t) - l.tStart, 1), fmt(l.hqDamage, 0), fmt(l.hqAtEnd ?? 0, 0),
      l.kills, "",
    ].join(" | "));
    prevGold = null;
  }
  return rows.join("\n");
}

function staticCurves() {
  const out = ["=== static wave pressure (hit size = turret L2 22 dmg) ==="];
  out.push("wave | count | rawEHP | effEHP@22 | effEHP@8(warrior) | effEHP@40(turretL3) | enemyDPS | composition");
  for (let i = 0; i < CONFIG.fortressWaves.length; i++) {
    const s = waveSummary(i, 22);
    const s8 = waveSummary(i, 8);
    const s40 = waveSummary(i, 40);
    out.push([
      s.wave, s.count, s.ehpRaw, s.ehp, s8.ehp, s40.ehp, s.dps,
      Object.entries(s.byType).map(([k, v]) => `${k}x${v}`).join(" "),
    ].join(" | "));
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ main

const arg = process.argv[2] ?? "all";
const want = arg === "all" ? ["passive", "economy", "defense", "balanced"] : [arg];
console.log(staticCurves());
for (const name of want) {
  console.log("\n" + "=".repeat(100));
  console.log(report(new Sim(name).run()));
}
