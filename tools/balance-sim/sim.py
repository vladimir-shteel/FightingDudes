"""HONEST coupled simulator — single source of truth for the Fortress loop.

Supersedes calibrate.py's economy half (which staffed crystal at 0 → false 900s stalls, yet also
reported 50x overproduction — internally contradictory). This model is a faithful port of the LIVE
JS systems and instruments the mining<->battle dynamic the redesign is optimizing for.

What it ports exactly (against js/game/systems/*):
  - Production per collection = workerProductionByLevel[level] (a FIXED per-4s payout, NOT time-scaled)
    × slotMult × prodMult × yieldTrait × demandMult × shiftMult          (mineSystem.tickMineProduction)
  - Golden-trait gold = resourceAmount × golden*goldPerResourcePerPoint × goldMult
  - Roster soft-cap: buycost = floor(baseCost × exp^E), E = Σ 2^(level-1) over ALL workers
                                                                          (reserveSystem.getUnitBuyCost)
  - Merge: sum trait vectors + mergeBonus to dominant; caps at merge.maxLevel  (workerTraitSystem)
  - Battle production multiplier (CONFIG.productionMultipliers.battle) applies DURING battle only.
  - Battle shift: committed workers produce × rush(base + rush*perPoint) during battle (the bridge).
  - Combat win% + battle DURATION come from battle_sim (the faithful engine port).
  - Attrition/repair on losses, gold faucets (victory/kill/startBonus/golden), gold sinks
    (worker buy, mine/slot unlock).

Instruments (the dynamism the design cares about — priority #1 mining<->battle):
  - prep_rest  : seconds spent mining between waves (mining-screen time before a wave)
  - battle_s   : real battle duration (mining-screen stays LIVE via battle mult + shift)
  - shift_frac : % of a wave's resource income earned DURING battle (high = mining matters mid-fight)
  - restaff    : demand resource changed vs previous wave (pressure to move workers / switch screens)

Run: python sim.py           (baseline on current data)
"""
import random, math, statistics
from calibrate import (min_defense, N_WAVES, RES, BAL, MINE, WAVES_RAW,
                       WORKER_PROD, COLLECT, BASE_COST, EXP, MERGE_MAX,
                       SLOT_MULT, MAX_SLOTS, BUY, BLD, FOOT, HQ_TILES, TOP,
                       UNLOCK, GW, GH, specs_cost, winrate,
                       CRYSTAL_BY_LEVEL, CRYSTAL_MERGE_TYPES)
from battle_sim import Building, simulate

# --- trait / capstone knobs, read from balance.json (no synthetic numbers) ---
TR = BAL["workerTraits"]
LINES = TR["lines"]
YIELD_PP  = LINES["yield"]["resourceMultiplierPerPoint"]     # +production per Yield point
GOLDEN_PP = LINES["golden"]["goldPerResourcePerPoint"]       # production->gold per Golden point
RUSH_PP   = LINES["rush"]["battleMultiplierPerPoint"]        # +shift mult per Rush point
SHIFT_BASE = TR["battleShift"]["baseMultiplier"]             # committed-worker mult base
SHIFT_MAX_PER_MINE = TR["battleShift"]["maxCommitsPerMine"]
MERGE_BONUS = TR.get("mergeBonusPoints", 1)
DEMAND_MUL = BAL.get("waveDemand", {}).get("slotProductionMultiplier", 1.25)
BATTLE_MUL = BAL.get("productionMultipliers", {}).get("battle", 1.5)
START_GOLD = BAL.get("startingGold", 90)
START_RES = BAL.get("startingResources", {"wood": 110, "ore": 60})
REPAIR_RATE = BAL.get("attrition", {}).get("repairCostPerHpFractionOfBuyCost", 0.5)
REST_MULT = BAL.get("productionMultipliers", {}).get("rest", 1.0)   # weak passive trickle (harvest model)

MINE_UNLOCK = {RES.index(r["key"]): r.get("unlockWave", 1) for r in MINE["resourceTypes"] if r["key"] in RES}
MINE_GOLD   = {RES.index(r["key"]): r.get("buyCost", {}).get("gold", 0) for r in MINE["resourceTypes"] if r["key"] in RES}
SLOT_GOLD   = {RES.index(r["key"]): [c.get("gold", 0) for c in r.get("slotBuyCosts", [])]
               for r in MINE["resourceTypes"] if r["key"] in RES}
SLOT_UNLOCK = {RES.index(r["key"]): r.get("slotUnlockWaves", [])
               for r in MINE["resourceTypes"] if r["key"] in RES}
DEMAND_BY_WAVE = {i + 1: (RES.index(w["demandResource"]) if w.get("demandResource") in RES else None)
                  for i, w in enumerate(WAVES_RAW)}

TRAIT_KEYS = ["yield", "golden", "rush"]

# ---------------------------------------------------------------------------
# CALIBRATION KNOBS — override defaults to sweep candidate balances WITHOUT editing data/*.json.
# Once a combo hits the targets, translate it back into the JSON (that's the deliverable).
#   prod_scale  : x on workerProductionByLevel (magnitude of mining)
#   battle_mul  : override productionMultipliers.battle (battle-time mining; reactive haul size)
#   shift_base  : override battleShift.baseMultiplier (committed-worker haul)
#   exp         : override unitBuyExponent (roster soft-cap; gold absorption)
#   cost_scale  : x on defense resource cost (the sink)
#   gold_scale  : x on wave gold faucets (victory+kill+startBonus)
# ---------------------------------------------------------------------------
CFG = dict(prod_scale=1.0, battle_mul=BATTLE_MUL, shift_base=SHIFT_BASE,
           exp=EXP, cost_scale=1.0, gold_scale=1.0, repair_scale=1.0, rest_mult=REST_MULT)

# Roster-depth pacing (the sim's PLAYER model, not game data). E_CAP = rising ceiling on total
# labour (E = Σ2^(lvl-1)). Tuned so roster reaches L5 ~w16-20 (capstones fire) without maxing at w1.
ECAP_BASE, ECAP_PER_WAVE, ECAP_MAX = 6, 1.8, 56

# ---------------------------------------------------------------------------
# Worker model (level + trait vector + optional capstone)
# ---------------------------------------------------------------------------
class Worker:
    __slots__ = ("level", "tr", "cap")
    def __init__(self, level=1, tr=None, cap=None):
        self.level = level
        self.tr = tr or {"yield": 0, "golden": 0, "rush": 0}
        self.cap = cap
    def E(self):
        return 2 ** (self.level - 1)
    def dominant(self):
        return max(TRAIT_KEYS, key=lambda k: (self.tr[k], -TRAIT_KEYS.index(k)))
    # --- multipliers (mirror workerTraitSystem) ---
    def yield_mult(self):
        m = 1 + self.tr["yield"] * YIELD_PP
        if self.cap == "yield-master": m *= 2.0
        elif self.cap == "foreman":    m *= 1.4
        return m
    def golden_conv(self):
        c = self.tr["golden"] * GOLDEN_PP
        if self.cap == "midas":   c += 0.25
        elif self.cap == "foreman": c += 0.08
        return c
    def rush_mult(self):
        r = CFG["shift_base"] + self.tr["rush"] * RUSH_PP
        if self.cap == "warmind": r += 2.0
        return r

def roll_worker():
    return Worker(1, {k: (1 if k == random.choice(TRAIT_KEYS) else 0) for k in TRAIT_KEYS})

def merge_two(a, b):
    tr = {k: a.tr[k] + b.tr[k] for k in TRAIT_KEYS}
    dom = max(TRAIT_KEYS, key=lambda k: (tr[k], -TRAIT_KEYS.index(k)))
    tr[dom] += MERGE_BONUS
    lvl = a.level + 1
    cap = None
    if lvl == MERGE_MAX:                        # auto-pick dominant-line capstone
        cap = {"yield": "yield-master", "golden": "midas", "rush": "warmind"}[dom]
    return Worker(lvl, tr, cap)

# ---------------------------------------------------------------------------
# Economy (faithful production + gold flow)
# ---------------------------------------------------------------------------
class Econ:
    def __init__(self):
        self.gold = START_GOLD
        self.res = [START_RES.get("wood", 0), START_RES.get("ore", 0), 0, 0]
        self.unlocked = [True, True, False, False]
        self.slots = [1, 1, 0, 0]                       # purchased slot count per mine
        self.workers = [[], [], [], []]                 # staffed workers per mine
        self.reserve = []

    def all_workers(self):
        return [w for k in range(4) for w in self.workers[k]] + self.reserve

    def E_total(self):
        return sum(w.E() for w in self.all_workers())

    def buycost(self):
        return max(1, math.floor(BASE_COST * CFG["exp"] ** self.E_total()))

    def total_slots(self):
        return sum(self.slots[k] for k in range(4) if self.unlocked[k])

    def pool_to_reserve(self):
        """Bring EVERY worker (mines + reserve) back into one pool. The live game lets you merge
        freely across mines and reserve (mergeReserveUnitIntoMineUnit, mine-to-mine drag), so the
        merge search must see the whole roster — not just reserve. Without this, two L4s sitting in
        different mines never combine and the roster caps at L4 (capstones dead)."""
        self.reserve = self.all_workers()
        for k in range(4):
            self.workers[k] = []

    def mass_merge_reserve(self):
        changed = True
        while changed:
            changed = False
            self.reserve.sort(key=lambda w: w.level)
            for i in range(len(self.reserve) - 1):
                a, b = self.reserve[i], self.reserve[i + 1]
                if a.level == b.level and a.level < MERGE_MAX:
                    merged = merge_two(a, b)
                    del self.reserve[i:i + 2]
                    self.reserve.append(merged)
                    changed = True
                    break

    def coverage_merge(self, min_keep):
        """Merge only the SURPLUS beyond `min_keep` bodies (enough to staff every slot), preferring the
        HIGHEST mergeable pair so a few workers climb to L5 (capstones) while low-level bodies stay for
        coverage. Mass-merging everyone (old policy) collapsed the roster to 2-4 super-workers that
        can't be in 4 mines at once -> structural resource stalls. This keeps coverage AND builds height."""
        while len(self.reserve) > min_keep:
            by_level = {}
            for i, w in enumerate(self.reserve):
                if w.level < MERGE_MAX:
                    by_level.setdefault(w.level, []).append(i)
            pairs = [lvl for lvl, idxs in by_level.items() if len(idxs) >= 2]
            if not pairs:
                break
            idxs = by_level[max(pairs)]                        # highest mergeable pair -> build height
            merged = merge_two(self.reserve[idxs[0]], self.reserve[idxs[1]])
            for i in sorted(idxs[:2], reverse=True):
                del self.reserve[i]
            self.reserve.append(merged)

    def staff(self, demand_k, need_ks=None):
        """Pull everyone into a pool, then staff. A realistic player NEVER leaves a mine that owes
        resources this wave empty, so we do COVERAGE-FIRST: one worker on each mine that has pending
        cost (need_ks), then fill remaining slots best-first with a demand-mine bias. Prevents the
        false 900s stall where a needed mine was starved to feed the demand mine."""
        pool = self.all_workers()
        for k in range(4):
            self.workers[k] = []
        self.reserve = []
        pool.sort(key=lambda w: w.level, reverse=True)
        need_ks = [k for k in (need_ks or []) if self.unlocked[k] and self.slots[k] > 0]
        # 1) guarantee one worker on each needed mine (and the demand mine)
        cover = list(dict.fromkeys(([demand_k] if (demand_k is not None and self.unlocked[demand_k] and self.slots[demand_k] > 0) else []) + need_ks))
        for k in cover:
            if pool:
                self.workers[k].append(pool.pop(0))
        # 2) fill remaining purchased slots best-first, demand mine prioritized
        slots = []
        for k in range(4):
            if not self.unlocked[k]:
                continue
            mult = SLOT_MULT[self.slots[k]] if self.slots[k] in SLOT_MULT else SLOT_MULT[min(SLOT_MULT)]
            for s in range(len(self.workers[k]), self.slots[k]):
                pr = mult[s] + (10 if k == demand_k else 0)
                slots.append((pr, k))
        slots.sort(key=lambda x: -x[0])
        for _, k in slots:
            if pool:
                self.workers[k].append(pool.pop(0))
        self.reserve = pool

    def prod_rates(self, wave, battle=False, committed=None):
        """Per-second (resource, gold) rates per mine. committed: set of (k, idx) worker slots on shift.
        Faithful to mineSystem.tickMineProduction (per-collection payout / COLLECT = per-second)."""
        committed = committed or set()
        dk = DEMAND_BY_WAVE.get(wave)
        res_rate = [0.0, 0.0, 0.0, 0.0]
        gold_rate = 0.0
        # No blanket battle multiplier (removed as leftover scaffolding). During battle, non-committed
        # workers mine at normal rate; only committed shift workers get the rush boost (sm below).
        prod_mult = CFG["prod_scale"]                                            # perm resourceMult=1 in baseline
        for k in range(4):
            if not self.unlocked[k]:
                continue
            mult = SLOT_MULT[self.slots[k]] if self.slots[k] in SLOT_MULT else SLOT_MULT[min(SLOT_MULT)]
            ws = sorted(self.workers[k], key=lambda w: w.level, reverse=True)
            for i, w in enumerate(ws):
                base = WORKER_PROD[w.level] / COLLECT * mult[i] if i < len(mult) else WORKER_PROD[w.level] / COLLECT * mult[-1]
                dm = DEMAND_MUL if k == dk else 1.0
                # Harvest model (§12d): committed shift workers spike (rush_mult); everyone else — at
                # rest OR non-committed during battle — mines the WEAK passive trickle (rest_mult<1).
                # Emphasis moves to Shift; rest stays non-zero to top up shortfalls.
                factor = w.rush_mult() if (battle and (k, i) in committed) else CFG["rest_mult"]
                r = base * prod_mult * w.yield_mult() * dm * factor
                res_rate[k] += r
                gold_rate += r * w.golden_conv()             # golden trickle
        return res_rate, gold_rate

    def pick_shift(self):
        """Commit up to SHIFT_MAX_PER_MINE staffed workers per mine (best-first). Returns the set of
        (k, idx) committed. Rest-gating is approximated as 'always available' -> an UPPER BOUND on the
        shift haul (the design's aspirational risk/reward ceiling)."""
        committed = set()
        for k in range(4):
            ws = sorted(range(len(self.workers[k])), key=lambda i: self.workers[k][i].level, reverse=True)
            for i in ws[:SHIFT_MAX_PER_MINE]:
                committed.add((k, i))
        return committed

# ---------------------------------------------------------------------------
# Combat: min defense per wave (cached) + battle duration
# ---------------------------------------------------------------------------
def battle_profile(specs, wave, seeds=16):
    """Return (winrate, median_win_time, median_loss_time, median_victory_bld_loss) for a defense.
    bld_loss = fraction of building HP lost on a WIN -> the per-wave repair sink under attrition."""
    wins, wt, lt, wloss = 0, [], [], []
    for s in range(seeds):
        bs = [Building("hq", 1, (1, 5))] + [Building(t, l, o) for t, l, o in specs]
        r = simulate(bs, wave, random.Random(s * 13 + 7))
        if r["result"] == "victory":
            wins += 1; wt.append(r["time"]); wloss.append(r.get("bld_loss", 0.0))
        else:
            lt.append(r["time"])
    wr = wins / seeds
    return (wr, (statistics.median(wt) if wt else 90.0), (statistics.median(lt) if lt else 60.0),
            (statistics.median(wloss) if wloss else 0.0))

# ---------------------------------------------------------------------------
# Coupled run
# ---------------------------------------------------------------------------
# Grow a spine of real defense (spawners + turret + walls + mage); trap mine is a niche add-on and
# bigWall is redundant with wall for the packer, so keep them out of the default greedy add set (they
# were what the plateau-stuck hill-climb spammed as "cheapest").
# The oracle finds the minimum DPS defense that clears each wave. Walls are a placement-dependent
# funnel / HP sponge the battle port barely models (they only matter if they FUNNEL the A* path), and
# in a greedy climb they just game the small HQ-survival term (cheap HP, zero kills) -> wall carpet at
# 0% win. So exclude walls from growth; the DPS spine (spawners + turret) is what actually clears.
DEF_TYPES = ["barracks", "archery", "turret", "stables", "mageTower"]
# Per-type count caps (realistic: a player fields a FEW of each and MERGES them up — the tier curve is
# where power AND cost live). Once a type is at cap, the only way to add power is a tier merge, which
# forces the grower up the (expensive) tier ladder instead of carpeting the grid with weak L1s. Turret
# is 1-tile and the anti-armor answer, so it gets the most room to climb to L5.
TYPE_CAP = {"barracks": 3, "archery": 3, "turret": 6, "stables": 2, "mageTower": 2}
_HQ_MAXHP = Building("hq", 1, (1, 5)).maxHp

def _wave_enemy_count(wave):
    comp = WAVES_RAW[wave - 1].get("composition", [])
    return max(1, sum(c.get("count", 0) for c in comp))

def battle_metrics(specs, wave, seeds=8):
    """(winrate, progress). progress is a CONTINUOUS strength signal dominated by KILL-fraction (a win
    requires killing the whole wave), with only a tiny HQ-survival tiebreaker — otherwise the grower
    games it by carpeting cheap WALLS (pure HP raises HQ-survival without killing anything -> 0% win
    but 'progress' rises). Kill-weighting steers growth into DPS (spawner/turret tiers), which is what
    actually clears late waves. Lets the grower climb even where winrate is flat at 0%."""
    tot_enemies = _wave_enemy_count(wave)
    wins = 0; prog = 0.0
    for s in range(seeds):
        bs = [Building("hq", 1, (1, 5))] + [Building(t, l, o) for t, l, o in specs]
        r = simulate(bs, wave, random.Random(s * 13 + 7))
        if r["result"] == "victory":
            wins += 1
        kf = min(1.0, r.get("killed", 0) / tot_enemies)
        hf = max(0.0, min(1.0, r.get("hq", 0) / _HQ_MAXHP))
        prog += 0.92 * kf + 0.08 * hf
    return wins / seeds, prog / seeds

def _free_origin(placed, t):
    """First grid cell (front-to-back) where a footprint-`t` building fits, given HQ + placed."""
    occ = set(HQ_TILES)
    for pt, pl, (ox, oy) in placed:
        for dx, dy in FOOT[pt]:
            occ.add((ox + dx, oy + dy))
    for y in range(GH):
        for x in range(GW):
            tiles = [(x + dx, y + dy) for dx, dy in FOOT[t]]
            if all(0 <= tx < GW and 0 <= ty < GH and (tx, ty) not in occ for tx, ty in tiles):
                return (x, y)
    return None

_REQ_CACHE = None
def compute_req(thresh=0.55, seeds=8):
    """Persistent-fortress oracle. Grow ONE base incrementally across waves — each step either ADDS a
    unlocked building (cost = buyCost) or MERGES a same-type/level pair up a tier (resource copies were
    already paid as ADDs, so the merge marginal is only the crystal step) — choosing the move with the
    best win%-gain per cost until the wave clears `thresh`. Buildings persist, so cumulative cost rises
    SMOOTHLY. This replaces the old fixed-ladder + rigid tier_cap min_defense, whose whole-fortress tier
    jumps produced the 900s prep 'stalls' that were pure model artifacts (memory: overstated tier-jumps).
    Cached across sweeps."""
    global _REQ_CACHE
    if _REQ_CACHE is not None:
        return _REQ_CACHE
    print("Growing persistent fortress + battle timing per wave (battle_sim)...", flush=True)
    placed = []                                   # (type, level, origin), persists across waves
    cum = dict(wood=0, ore=0, iron=0, crystal=0)  # cumulative resource cost of the fortress
    req = {}
    for wave in range(1, N_WAVES + 1):
        guard = 0
        wr, base_prog = battle_metrics(placed, wave, seeds)
        while wr < thresh and guard < 45:
            guard += 1
            cands = []          # (progress, cost_sum, kind, payload, cost_dict)
            # ADD: one new L1 of each unlocked spine type that still fits the grid AND is under its cap
            for t in DEF_TYPES:
                if wave < UNLOCK.get(t, 1):
                    continue
                if sum(1 for pt, _, _ in placed if pt == t) >= TYPE_CAP.get(t, 99):
                    continue
                origin = _free_origin(placed, t)
                if origin is None:
                    continue
                cost = {k: v for k, v in BUY.get(t, {}).items() if k in RES}
                _, p = battle_metrics(placed + [(t, 1, origin)], wave, seeds)
                cands.append((p, max(1, sum(cost.values())), "add", (t, origin), cost))
            # MERGE: any same-type/level pair -> next tier (copies already paid; pay only crystal step).
            # Gate the reachable tier by wave: merging up 2^(l) copies takes time/gold/space, so a real
            # base can't teleport to L5 by wave 5. Ceiling rises ~1 tier / 4 waves -> L5 reachable ~w16
            # (matches the roster's L5 arrival). Without this the grower drags crystal/iron in far too
            # early (turret L4/L5 merges) and manufactures resource-introduction stalls.
            max_tier = min(5, 1 + wave // 4)
            groups = {}
            for i, (t, l, o) in enumerate(placed):
                groups.setdefault((t, l), []).append(i)
            for (t, l), idxs in groups.items():
                if len(idxs) >= 2 and l < TOP[t] and l + 1 <= max_tier:
                    i, j = idxs[0], idxs[1]
                    trial = [b for k, b in enumerate(placed) if k not in (i, j)]
                    trial.append((t, l + 1, placed[i][2]))
                    crystal = CRYSTAL_BY_LEVEL.get(l + 1, 0) if t in CRYSTAL_MERGE_TYPES else 0
                    cost = {"crystal": crystal} if crystal else {}
                    _, p = battle_metrics(trial, wave, seeds)
                    # give merges a small cost floor so an equal-progress merge doesn't outrank a build
                    cands.append((p, max(4, crystal), "merge", (i, j, t, l), cost))
            if not cands:
                break
            # climb on progress-gain per unit cost; a tiny epsilon keeps net-zero moves from being taken
            best = max(cands, key=lambda c: (c[0] - base_prog) / c[1])
            if best[0] <= base_prog + 1e-4:        # plateau -> BUILD TIER (never give up): the winning
                merges = [c for c in cands if c[2] == "merge"]     # fortresses are all higher-tier, so
                best = min(merges, key=lambda c: c[1]) if merges \
                    else min(cands, key=lambda c: c[1])            # merge up; else cheapest add toward a pair
            _, _, kind, payload, cost = best
            if kind == "add":
                t, origin = payload
                placed.append((t, 1, origin))
            else:
                i, j, t, l = payload
                origin = placed[i][2]                          # keep the merged pair's front cell
                placed = [b for k, b in enumerate(placed) if k not in (i, j)]
                placed.append((t, l + 1, origin))
            for k in RES:
                cum[k] += cost.get(k, 0)
            wr, base_prog = battle_metrics(placed, wave, seeds)
        pwr, wt, lt, wloss = battle_profile(placed, wave)
        rbasis = [0.0, 0.0, 0.0, 0.0]
        for t, lv, _ in placed:
            if t in ("hq", "mine"):
                continue
            for k in range(4):
                rbasis[k] += BUY.get(t, {}).get(RES[k], 0) * lv
        req[wave] = dict(specs=[b for b in placed], wr=pwr, cost=dict(cum),
                         nt=sum(1 for t, _, _ in placed if t == "turret"),
                         tl=max([l for _, l, _ in placed], default=1),
                         wt=wt, lt=lt, bld_loss=wloss, repair_basis=rbasis)
    _REQ_CACHE = req
    return req

def run(verbose=True, seed=0):
    random.seed(seed)
    req = compute_req()
    e = Econ()
    spent = [0, 0, 0, 0]         # cumulative resources sunk into owned defense (running max)
    produced = [0.0, 0, 0, 0]
    rows = []
    clock = 0.0
    prev_dk = None
    for wave in range(1, N_WAVES + 1):
        # unlocks at wave start (mines are a GOLD purchase; auto-buy when affordable & unlocked)
        for k in range(4):
            if wave >= MINE_UNLOCK.get(k, 1) and not e.unlocked[k] and e.gold >= MINE_GOLD.get(k, 0):
                e.gold -= MINE_GOLD.get(k, 0); e.unlocked[k] = True; e.slots[k] = max(1, e.slots[k])
        # slot unlocks available this wave -> buy the cheapest needed with gold
        for k in range(4):
            if not e.unlocked[k]:
                continue
            uw = SLOT_UNLOCK.get(k, [])
            while (e.slots[k] < MAX_SLOTS and e.slots[k] < len(uw)
                   and wave >= uw[e.slots[k]] and e.gold >= (SLOT_GOLD.get(k, [0]*9)[e.slots[k]] if e.slots[k] < len(SLOT_GOLD.get(k, [])) else 1e9)):
                e.gold -= SLOT_GOLD[k][e.slots[k]]; e.slots[k] += 1

        info = req[wave]
        dk = DEMAND_BY_WAVE.get(wave)

        # Defense requirement. A smart player BANKS toward upcoming spikes (bosses/tier jumps) instead
        # of paying a doubling cost from zero in one wave. So: build THIS wave's requirement now, and
        # pre-save ~1/HORIZON of the gap to the horizon's PEAK cost each wave (spreads the spike).
        HORIZON = 4
        now_req = [req[wave]["cost"][RES[k]] * CFG["cost_scale"] if e.unlocked[k] else 0 for k in range(4)]
        need = [max(spent[k], now_req[k]) for k in range(4)]
        inc = [max(0, need[k] - spent[k]) for k in range(4)]                       # must BUILD this wave
        peak = [0, 0, 0, 0]
        for w2 in range(wave, min(N_WAVES, wave + HORIZON) + 1):
            for k in range(4):
                if e.unlocked[k]:
                    peak[k] = max(peak[k], req[w2]["cost"][RES[k]] * CFG["cost_scale"])
        presave = [max(0.0, (peak[k] - need[k]) / HORIZON) for k in range(4)]      # bank a slice for the future

        # SINK SPLIT (the mining<->battle bridge): REST funds NEW defense (investment); BATTLE income
        # funds repair on losses (reactive, consumed on the spot -> does NOT pre-fill next build).
        wr = info["wr"]
        attempts = 1 if wr >= 0.999 else min(5, max(1, round(1 / max(0.2, wr))))
        defeats = attempts - 1
        OVERHEAD = 1.1
        owned = [spent[k] + inc[k] for k in range(4)]
        # ATTRITION REPAIR (steady per-wave sink; the fix for bimodal prep): victory no longer heals
        # free, so every wave you repair the HP chewed off this fight. bld_loss scales with difficulty
        # (hard waves damage more) -> mining matters EVERY wave, and couples to combat. Repair basis =
        # owned resource investment x missing-HP fraction x rate (mirrors live repair cost).
        bld_loss = info.get("bld_loss", 0.0)
        rbasis = info.get("repair_basis", [0, 0, 0, 0])
        repair_now = [bld_loss * rbasis[k] * REPAIR_RATE * CFG.get("repair_scale", 1.0) for k in range(4)]
        build_cost = [inc[k] * (1 + OVERHEAD) + repair_now[k] for k in range(4)]  # REST sink (build+repair)
        rest_target = [build_cost[k] + presave[k] for k in range(4)]              # + bank a slice ahead
        repair_per_defeat = [owned[k] * 0.5 * 0.7 * REPAIR_RATE for k in range(4)]  # extra sink / loss

        # BUY/MERGE POLICY. Pool the whole roster first so merges can climb across mines+reserve
        # (matches the live cross-pool merge). Then buy while gold allows, limited by a WAVE-RISING
        # labour ceiling E_CAP (not a hard worker count): the EXP buy cost is the real soft-cap, and
        # E_CAP just PACES depth so the roster reaches L5 mid-late game instead of maxing at wave 1
        # (or never, as under the old total_slots()+2 count cap). Reaching L5 needs 16 base-workers
        # concentrated (two L4s), so E_CAP must exceed 16 for capstones to ever fire.
        e.pool_to_reserve()
        E_CAP = min(ECAP_MAX, ECAP_BASE + ECAP_PER_WAVE * wave)
        while e.gold >= e.buycost() and e.E_total() < E_CAP:
            e.gold -= e.buycost(); e.reserve.append(roll_worker())
        # keep enough bodies to staff every purchased slot (+1 buffer); merge only the surplus up
        e.coverage_merge(min_keep=max(2, e.total_slots() + 1))
        e.staff(dk, need_ks=[k for k in range(4) if build_cost[k] > 0 or presave[k] > 0
                             or (defeats and repair_per_defeat[k] > 0)])

        # --- REST phase: mine until the NEW defense increment is affordable ---
        rr, gr = e.prod_rates(wave, battle=False)
        prep = 0.0
        rest_res = [0.0, 0, 0, 0]
        MAX_PREP = 300                                  # a real bounded stall ceiling (not the old 900)
        while prep < MAX_PREP:
            for k in range(4):
                e.res[k] += rr[k]; produced[k] += rr[k]; rest_res[k] += rr[k]
            e.gold += gr
            prep += 1; clock += 1
            built = all(e.res[k] >= build_cost[k] for k in range(4))
            banked = all(e.res[k] >= rest_target[k] for k in range(4))
            # Always achieve this wave's build; bank presave only best-effort (time-boxed) so slow
            # production never STALLS on optional banking — it just pays more at the spike.
            if built and (banked or prep >= 45):
                break
            if any(build_cost[k] > e.res[k] and rr[k] <= 1e-9 for k in range(4)):
                # a NEEDED resource has zero production (roster too small to staff it): a genuine hard
                # stall. Jump to the ceiling ADVANCING THE CLOCK (the old code set prep=900 without
                # advancing clock -> poisoned every prep average). Report flags it as a stall.
                clock += (MAX_PREP - prep); prep = MAX_PREP
                break
        for k in range(4):
            e.res[k] = max(0, e.res[k] - build_cost[k])    # spend build; presave stays banked (carryover)
            spent[k] = need[k]

        # --- BATTLE phase: mining stays live; repair on each defeat drains the battle haul ---
        committed = e.pick_shift()
        br, bg = e.prod_rates(wave, battle=True, committed=committed)
        br_ns, _ = e.prod_rates(wave, battle=True, committed=set())               # counterfactual: no shift
        shift_gain = (sum(br) - sum(br_ns)) / sum(br_ns) if sum(br_ns) > 0 else 0
        battle_res = [0.0, 0, 0, 0]
        battle_time = 0.0
        for a in range(attempts):
            dur = info["wt"] if a == attempts - 1 else info["lt"]
            for _ in range(int(dur)):
                for k in range(4):
                    e.res[k] += br[k]; produced[k] += br[k]; battle_res[k] += br[k]
                e.gold += bg
            battle_time += dur; clock += dur
            if a < attempts - 1:                                                  # a defeat -> repair now
                for k in range(4):
                    e.res[k] = max(0, e.res[k] - repair_per_defeat[k])
        # gold faucets
        wc = WAVES_RAW[wave - 1]
        gs = CFG["gold_scale"]
        e.gold += wc.get("victoryGold", 14 + 4 * wave) * gs
        e.gold += wc.get("killGold", 1) * wc.get("enemyCount", 0) * gs
        g = wc.get("startBonusGold", 0); win = wc.get("startBonusWindowSeconds", 0)
        if g > 0 and win > 0:
            e.gold += round(g * max(0, win - prep) / win) * gs

        # metrics
        tot_income = sum(rest_res) + sum(battle_res)
        shift_frac = sum(battle_res) / tot_income if tot_income > 0 else 0
        restaff = (dk is not None and dk != prev_dk)
        prev_dk = dk
        roster = sorted([w.level for w in e.all_workers()], reverse=True)
        rows.append(dict(w=wave, prep=prep, battle=battle_time, clock=clock, wr=wr, nt=info["nt"],
                         buy=e.buycost(), nwk=len(roster), roster=roster, dk=dk, restaff=restaff,
                         shift_frac=shift_frac, shift_gain=shift_gain, gold=e.gold,
                         prod=[round(x) for x in e.prod_rates(wave)[0]], attempts=attempts,
                         boss=wc.get("isBoss", False)))

    if verbose:
        _report(rows, spent, produced, clock)
    return rows

def _report(rows, spent, produced, clock):
    dnames = ["wood", "ore", "iron", "crys"]
    print(f"\n{'W':>2} {'prep':>5} {'batl':>5} {'clk':>6} {'win%':>5} {'buy$':>5} {'#wk':>3} "
          f"{'demand':>6} {'shift%':>6} {'gold':>6} {'roster':>20}")
    for r in rows:
        boss = "B" if r["boss"] else " "
        stall = "<<STALL" if r["prep"] > 120 else ("<triv" if r["prep"] < 8 else "")
        rs = "*" if r["restaff"] else " "
        dn = dnames[r["dk"]] if r["dk"] is not None else "-"
        ros = "+".join(f"L{x}" for x in r["roster"][:8])
        print(f"{r['w']:>2}{boss} {r['prep']:>4.0f} {r['battle']:>5.0f} {r['clock']:>6.0f} "
              f"{r['wr']*100:>4.0f}% {r['buy']:>5} {r['nwk']:>3} {dn:>5}{rs} {r['shift_frac']*100:>5.0f}% "
              f"{r['gold']:>6.0f} {ros:>20} {stall}")
    preps = [r["prep"] for r in rows]
    battles = [r["battle"] for r in rows]
    stalls = sum(1 for p in preps if p > 120)
    triv = sum(1 for p in preps if p < 8)
    bands = sum(1 for r in rows if 0.40 <= r["wr"] <= 0.75)
    restaffs = sum(1 for r in rows if r["restaff"])
    avg_shift = statistics.mean(r["shift_frac"] for r in rows)
    avg_gain = statistics.mean(r["shift_gain"] for r in rows)
    hard = [r for r in rows if r["wr"] <= 0.80]
    hard_prep = statistics.mean(r["prep"] for r in hard) if hard else 0
    print(f"\nLOOP: total {clock/60:.1f} min | prep {sum(preps)/60:.1f}m (band {min(preps):.0f}-{max(preps):.0f}s, "
          f"avg {statistics.mean(preps):.0f}s) | battle {sum(battles)/60:.1f}m")
    print(f"PACING: stalls>120s: {stalls} | trivial<8s: {triv} | hard-wave(<=80%) avg prep {hard_prep:.0f}s | prep/battle {sum(preps)/max(1,sum(battles)):.1f}")
    print(f"DIFFICULTY: {bands}/{N_WAVES} waves in 40-75% retry-band at min defense")
    print(f"DYNAMICS: battle-haul {avg_shift*100:.0f}% of income | shift boost +{avg_gain*100:.0f}% (counterfactual) | re-staff {restaffs}/{N_WAVES}")
    tp = sum(produced); ts = sum(spent)
    print(f"ECONOMY: produced {[round(x) for x in produced]} (sum {tp:.0f}) | defense spent {[round(x) for x in spent]} "
          f"(sum {ts:.0f}) | spend/prod {ts/max(1,tp)*100:.0f}%")

def summary(rows, clock):
    preps = [r["prep"] for r in rows]
    battles = [r["battle"] for r in rows]
    return dict(
        mins=clock / 60,
        prep_avg=statistics.mean(preps),
        prep_min=min(preps), prep_max=max(preps),
        stalls=sum(1 for p in preps if p > 120),
        triv=sum(1 for p in preps if p < 8),
        band=sum(1 for r in rows if 0.40 <= r["wr"] <= 0.75),
        maxlvl=max((max(r["roster"]) if r["roster"] else 0) for r in rows),
        endgold=rows[-1]["gold"],
        pb=sum(preps) / max(1, sum(battles)),
    )

def sweep():
    """Coarse grid over the calibration knobs. Prints one line per combo; pick the winner then
    translate to JSON. Targets: prep_avg ~25s, triv 0, stalls 0, maxlvl 5 (capstones fire),
    endgold modest (not runaway), band high."""
    compute_req()
    base = dict(CFG)
    print(f"\n{'prod':>5} {'shft':>5} {'exp':>5} {'cost':>5} {'gold':>5} | "
          f"{'min':>5} {'prepAvg':>7} {'band':>5} {'triv':>4} {'stall':>5} {'maxL':>4} {'endG':>6} {'p/b':>4}")
    grid = []
    for prod in [0.3, 0.45, 0.6]:
        for cost in [2.0, 3.0, 4.0]:
            for exp in [1.08, 1.11]:
                grid.append(dict(prod_scale=prod, cost_scale=cost, exp=exp,
                                 shift_base=1.75, gold_scale=0.8))
    for g in grid:
        CFG.update(base); CFG.update(g)
        rows = run(verbose=False, seed=1)
        s = summary(rows, rows[-1]["clock"])
        print(f"{g['prod_scale']:>5} {g['shift_base']:>5} {g['exp']:>5} "
              f"{g['cost_scale']:>5} {g['gold_scale']:>5} | {s['mins']:>5.1f} {s['prep_avg']:>7.0f} "
              f"{s['band']:>5} {s['triv']:>4} {s['stalls']:>5} {s['maxlvl']:>4} {s['endgold']:>6.0f} {s['pb']:>4.1f}")
    CFG.update(base)

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "sweep":
        sweep()
    else:
        run()
