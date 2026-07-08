"""COUPLED calibration model — single source of truth tying real combat cost to real production.

Why this exists: difficulty.py used a shallow ladder (false "wall"); econ_timing.py used a synthetic
demand curve missing COST_SCALE (12x under-demand); pacing_v2.py used a synthetic cost curve divorced
from the building JSON. None reflected the real coupled game. This one does:

  1. COMBAT: for each wave, find the minimum defense (4 barracks + N turrets, best tier available) that
     clears at a target win rate — straight from battle_sim (the faithful engine port). Buildings persist
     between waves, so cumulative owned defense = running max; you only PAY when the requirement rises.
  2. ECONOMY: faithful worker/slot/merge/trait/gold model (same as pacing_v2's E), buying workers from
     gold (wave rewards) and mining resources to afford the defense increment.
  3. PREP: seconds mined per wave to cover the real incremental building cost at current production.

Reads all numbers from data/*.json — no synthetic curves. Run: python calibrate.py
"""
import random, json, math
from pathlib import Path
from battle_sim import Building, simulate, WAVES

data_dir = Path(__file__).parent.parent.parent / "data"
BLD = json.load(open(data_dir / "fortress-buildings.json", encoding="utf-8"))
BAL = json.load(open(data_dir / "balance.json", encoding="utf-8"))
MINE = json.load(open(data_dir / "mine-levels.json", encoding="utf-8"))
WAVES_RAW = json.load(open(data_dir / "fortress-waves.json", encoding="utf-8"))

BUY = {t: BLD[t].get("buyCost", {}) for t in BLD}
# Same-type over-build escalation (mirrors fortressSystem.getFortressBuildingBuyCost): the i-th building
# of a TYPE costs buyCost x factor^(count already owned). See specs_cost for the port + its approximation.
ESC = BAL.get("buildingCostEscalation", {})
N_WAVES = len(WAVES)
RES = ["wood", "ore", "iron", "crystal"]

# ---------------------------------------------------------------------------
# 1. COMBAT: minimum defense per wave via a realistic, monotonic cost ladder
# ---------------------------------------------------------------------------
# Realistic MIXED defense: spawners (barracks/archery/mageTower/stables) + turrets + walls + trap
# mines, packed onto the real 5x7 grid (minus HQ). Escalating fortresses (cost-ascending); per wave
# we pick the cheapest that clears. This captures the cheapest real DPS (spawners), the wood sink
# (walls), the crystal sink (mageTower/mines), and the grid capacity limit — none of which a
# turret-only model sees.
TOP = {t: len(BLD[t]["levels"]) for t in BLD}
FOOT = {t: [tuple(p) for p in BLD[t].get("footprint", [[0, 0]])] for t in BLD}
GW, GH = 5, 7
HQ_TILES = set((1 + dx, 5 + dy) for dx, dy in FOOT["hq"])
UNLOCK = {t: BLD[t].get("unlockWave", 1) for t in BLD}

def pack(shopping, levels):
    """Greedily place a shopping list [(type, count), ...] front-to-back onto free grid tiles.
    Buildings that don't fit are dropped (models grid capacity). Returns battle specs."""
    occ = set(HQ_TILES)
    specs = []
    for t, cnt in shopping:
        placed = 0
        for y in range(GH):
            for x in range(GW):
                if placed >= cnt:
                    break
                tiles = [(x + dx, y + dy) for dx, dy in FOOT[t]]
                if all(0 <= tx < GW and 0 <= ty < GH and (tx, ty) not in occ for tx, ty in tiles):
                    occ.update(tiles)
                    specs.append((t, levels.get(t, 1), (x, y)))
                    placed += 1
            if placed >= cnt:
                break
    return specs

# Escalating realistic fortresses (shopping lists), cost-ascending. Sized to fit ~29 free tiles.
FORTRESSES = [
    [("barracks", 2)],
    [("barracks", 2), ("archery", 1)],
    [("barracks", 2), ("archery", 1), ("turret", 2)],
    [("barracks", 3), ("archery", 2), ("turret", 2), ("wall", 2)],
    [("barracks", 3), ("archery", 2), ("turret", 3), ("mageTower", 1), ("wall", 2)],
    [("barracks", 3), ("archery", 2), ("turret", 4), ("mageTower", 1), ("mine", 2), ("wall", 2)],
    [("barracks", 3), ("archery", 3), ("turret", 5), ("mageTower", 1), ("mine", 2), ("wall", 2)],
    [("barracks", 2), ("archery", 3), ("turret", 7), ("mageTower", 1), ("mine", 3), ("wall", 2)],
]

CRYSTAL_MERGE_TYPES = {"barracks", "archery", "turret", "stables", "mageTower"}
CRYSTAL_BY_LEVEL = {int(k): v for k, v in BAL.get("merge", {}).get("crystalCostByLevel", {}).items()}

def merge_cost(t, level):
    # Copies (buyCost x 2^(level-1)) + crystal spent on high-tier merge steps. To field ONE building
    # at `level` you perform 2^(level-j) merges that produce level j (j=2..level); combat types pay
    # crystalCostByLevel[j] on each. Mirrors fortressSystem.getMergeCrystalCost.
    cost = {k: v * (2 ** (level - 1)) for k, v in BUY[t].items()}
    if t in CRYSTAL_MERGE_TYPES:
        crystal = sum((2 ** (level - j)) * CRYSTAL_BY_LEVEL.get(j, 0) for j in range(2, level + 1))
        if crystal > 0:
            cost["crystal"] = cost.get("crystal", 0) + crystal
    return cost

def specs_cost(specs):
    # Applies the same-type over-build escalation per LINE: the i-th separate building of a type pays
    # merge_cost x factor^i (i = how many of that type were costed before it). APPROXIMATION: the live
    # game escalates by the same-type count AT EACH base-copy purchase, so count fluctuates as you buy+
    # merge; this per-line model captures the dominant width penalty (multiple separate lines cost
    # progressively more) but slightly UNDER-states a single tall building (which briefly holds 2 bodies
    # pre-merge). Faithful enough for cost ranking; revisit if width-vs-height strategy needs finer sim.
    tot = dict(wood=0, ore=0, iron=0, crystal=0)
    seen = {}
    for t, l, o in specs:
        i = seen.get(t, 0)
        factor = (ESC.get(t, ESC.get("default", 1.0))) ** i
        for k, v in merge_cost(t, l).items():
            tot[k] = tot.get(k, 0) + v * factor
        seen[t] = i + 1
    return tot

def winrate(specs, wave, seeds=12):
    w = 0
    for s in range(seeds):
        bs = [Building("hq", 1, (1, 5))] + [Building(t, l, o) for t, l, o in specs]
        if simulate(bs, wave, random.Random(s * 13 + 7))["result"] == "victory":
            w += 1
    return w / seeds

def tier_cap(wave):
    """Gradual merge-up: you can't field L5 buildings at wave 5. Cap the tier by wave so the model
    pays the merge-up cost spread across waves."""
    return max(1, min(5, 1 + (wave - 1) // 4))   # L1 w1-4, L2 w5-8, L3 w9-12, L4 w13-16, L5 w17+

def min_defense(wave, thresh=0.55):
    """Cheapest escalating fortress (at the wave's tier cap, unlocked buildings only) that clears
    >= threshold. Returns (specs, winrate, cost, turret_count, turret_tier)."""
    cap = tier_cap(wave)
    levels = {t: min(cap, TOP[t]) for t in BLD}
    best = None
    for shopping in FORTRESSES:
        avail = [(t, c) for t, c in shopping if wave >= UNLOCK.get(t, 1)]
        specs = pack(avail, levels)
        wr = winrate(specs, wave)
        nt = sum(1 for t, _, _ in specs if t == "turret")
        best = (specs, wr, specs_cost(specs), nt, levels.get("turret", 1))
        if wr >= thresh:
            return best
    return best  # nothing cleared → strongest fortress

# ---------------------------------------------------------------------------
# 2. ECONOMY: faithful production model (mirrors pacing_v2.E)
# ---------------------------------------------------------------------------
WORKER_PROD = {int(k): v for k, v in MINE["workerProductionByLevel"].items()}
COLLECT = MINE.get("collectionIntervalSeconds", 4.0)
BASE_COST = BAL.get("unitBuyBaseCost", 5)
EXP = BAL.get("unitBuyExponent", 1.05)
MERGE_MAX = BAL.get("merge", {}).get("maxLevel", 5)
YIELD_MUL = BAL["workerTraits"]["lines"]["yield"]["resourceMultiplierPerPoint"]
GOLDEN_MUL = BAL["workerTraits"]["lines"]["golden"]["goldPerResourcePerPoint"]
DEMAND_MUL = BAL.get("waveDemand", {}).get("slotProductionMultiplier", 1.25)
START_GOLD = BAL.get("startingGold", 65)
START_RES = BAL.get("startingResources", {"wood": 70, "ore": 35})
# Slot production multipliers + max slots read from mine-levels.json (kept in sync with the game).
SLOT_MULT = {lv["slots"]: lv["slotProductionMultipliers"] for lv in MINE["levels"]}
MAX_SLOTS = max(SLOT_MULT)
DEMAND_BY_WAVE = {i + 1: (RES.index(w["demandResource"]) if w.get("demandResource") in RES else None)
                  for i, w in enumerate(WAVES_RAW)}

def base_equiv(level):
    return 2 ** (level - 1)

class Econ:
    def __init__(self):
        self.gold = START_GOLD
        self.res = [START_RES.get("wood", 0), START_RES.get("ore", 0), 0, 0]
        self.unlocked = [True, True, False, False]
        self.slots = [1, 1, 1, 1]
        self.workers = [[], [], [], []]
        self.reserve = []
        self.merge_cap = MERGE_MAX

    def E_owned(self):
        return sum(base_equiv(w) for k in range(4) for w in self.workers[k]) + sum(base_equiv(w) for w in self.reserve)

    def buycost(self):
        return max(1, math.floor(BASE_COST * EXP ** self.E_owned()))

    def prod(self, wave=None):
        out = [0, 0, 0, 0]
        dk = DEMAND_BY_WAVE.get(wave) if wave else None
        for k in range(4):
            if not self.unlocked[k]:
                continue
            m = SLOT_MULT[self.slots[k]]
            dm = DEMAND_MUL if dk == k else 1.0
            for i, lvl in enumerate(sorted(self.workers[k], reverse=True)):
                out[k] += WORKER_PROD[lvl] / COLLECT * m[i] * (1 + lvl * YIELD_MUL) * dm
        return out

    def merge(self):
        ch = True
        while ch:
            ch = False
            self.reserve.sort()
            for i in range(len(self.reserve) - 1):
                if self.reserve[i] == self.reserve[i + 1] and self.reserve[i] < self.merge_cap:
                    lv = self.reserve[i] + 1
                    del self.reserve[i:i + 2]
                    self.reserve.append(lv)
                    ch = True
                    break

    def total_slots(self):
        return sum(self.slots[k] for k in range(4) if self.unlocked[k])

    def rebalance(self, needk):
        pool = list(self.reserve)
        for k in range(4):
            pool += self.workers[k]
            self.workers[k] = []
        pool.sort(reverse=True)
        keys = [k for k in needk if self.unlocked[k]] or [k for k in range(4) if self.unlocked[k]]
        self.reserve = []
        for k in keys:  # staff each needed mine
            if pool:
                self.workers[k].append(pool.pop(0))
        tg = []
        for k in keys:
            for s in range(len(self.workers[k]), self.slots[k]):
                tg.append((k, SLOT_MULT[self.slots[k]][s]))
        tg.sort(key=lambda x: -x[1])
        ti = 0
        for w in pool:
            if ti < len(tg):
                self.workers[tg[ti][0]].append(w)
                ti += 1
            else:
                self.reserve.append(w)

def wave_gold(w):
    wc = WAVES_RAW[w - 1]
    return wc.get("victoryGold", 14 + 4 * w) + wc.get("killGold", 1) * wc.get("enemyCount", 0)

def start_bonus(w, prep):
    wc = WAVES_RAW[w - 1]
    g = wc.get("startBonusGold", 0)
    win = wc.get("startBonusWindowSeconds", 0)
    if g <= 0 or win <= 0:
        return 0
    return round(g * max(0, win - prep) / win)

# ---------------------------------------------------------------------------
# 3. RUN: couple them
# ---------------------------------------------------------------------------
def run(verbose=True):
    # Pre-compute combat requirement per wave (cached; independent of economy).
    print("Computing min-defense per wave (battle_sim)...", flush=True)
    req = {}
    for w in range(1, N_WAVES + 1):
        specs, wr, cost, nt, tl = min_defense(w)
        req[w] = dict(wr=wr, cost=cost, nt=nt, tl=tl)

    # Mine unlock waves from data (players can staff a mine from its unlockWave — 1 wave of pre-stock
    # before the first building demands that resource).
    unlock_wave = {RES.index(r["key"]): r.get("unlockWave", 1)
                   for r in MINE["resourceTypes"] if r["key"] in RES}

    e = Econ()
    spent = [0, 0, 0, 0]     # cumulative resources sunk into defense (running max, buildings persist)
    produced = [0, 0, 0, 0]  # cumulative resources mined over the whole run
    t = 0
    preps = []
    rows = []
    LOOKAHEAD = 1  # pre-build one wave ahead (aggressive pre-building starves the tiny opening economy)
    for wave in range(1, N_WAVES + 1):
        # apply data-driven mine unlocks at the START of the wave (so workers can pre-stock)
        for k in range(4):
            if wave >= unlock_wave.get(k, 1):
                e.unlocked[k] = True
        info = req[wave]
        wr, cost, nt, tl = info["wr"], info["cost"], info["nt"], info["tl"]
        # target defense = the heaviest requirement within the lookahead window (pre-build ahead),
        # but never demand a resource whose mine isn't unlocked yet (can't pre-build what you can't mine).
        target = dict(wood=0, ore=0, iron=0, crystal=0)
        for w2 in range(wave, min(N_WAVES, wave + LOOKAHEAD) + 1):
            for k in RES:
                if e.unlocked[RES.index(k)]:
                    target[k] = max(target[k], req[w2]["cost"][k])
        # cumulative owned defense = elementwise max of what we've paid and the windowed target
        need = [max(spent[k], target[RES[k]]) for k in range(4)]
        needk = [k for k in range(4) if need[k] > spent[k]]

        # buy workers from gold up to soft cap
        while e.gold >= e.buycost():
            e.gold -= e.buycost()
            e.reserve.append(1)
            e.merge()
            if len(e.reserve) > e.total_slots() + 2:
                break
        e.merge()
        e.rebalance(needk or [0, 1])

        # --- recurring per-wave sinks beyond the raw spine (fill valleys; scale with difficulty) ---
        # OVERHEAD: walls / support buildings (archery, stables, mageTower, mines) / mid-tier upgrades
        # that a real player buys alongside the barracks+turret spine. Applied to the increment.
        # REPAIR: retries → attrition → repair. expected_defeats grows as win% drops (bosses cost more).
        # ACTIVES: endgame only (L5 buildings), small per-battle resource burn.
        OVERHEAD = 1.1
        REPAIR_RATE = BAL.get("attrition", {}).get("repairCostPerHpFractionOfBuyCost", 0.5)
        exp_defeats = min(2.5, (1 - wr) / max(0.2, wr))
        repair_share = exp_defeats * 0.5 * 0.7   # ~half the defense destroyed, ~0.7 missing per defeat
        active_frac = 0.06 * max(0, tl - 3) * nt   # L4/L5 turrets → some active burn
        inc = [max(0, need[k] - spent[k]) for k in range(4)]
        pay = [inc[k] * (1 + OVERHEAD)
               + (spent[k] + inc[k]) * repair_share * REPAIR_RATE
               + (spent[k] + inc[k]) * active_frac
               for k in range(4)]

        prep = 0
        while prep < 900:
            p = e.prod(wave)
            for k in range(4):
                e.res[k] += p[k]
                produced[k] += p[k]
            e.gold += sum(p) * GOLDEN_MUL * (1.0 / 3.0) * 2.0   # golden-trait trickle
            prep += 1
            t += 1
            if all(e.res[k] >= pay[k] for k in range(4)):
                break
        for k in range(4):
            e.res[k] -= pay[k]
            spent[k] = need[k]     # cumulative defense (repair/overhead are consumed, not owned)
        preps.append(prep)
        roster = sorted([w for k in range(4) for w in e.workers[k]], reverse=True)
        rows.append((wave, prep, t, nt, wr, e.buycost(), len(roster),
                     "+".join(f"L{x}" for x in roster) or "-", [round(x) for x in e.prod(wave)]))

        e.gold += start_bonus(wave, prep)
        e.gold += wave_gold(wave)
        # +slot on the most-needed unlocked mine (one upgrade pick per wave)
        cand = [k for k in (needk or [1]) if e.unlocked[k] and e.slots[k] < MAX_SLOTS]
        if cand:
            cand.sort(key=lambda k: e.slots[k])
            e.slots[cand[0]] += 1

    if verbose:
        print(f"\n{'W':>2} {'prep':>5} {'clock':>6} {'turr':>4} {'win%':>5} {'buy$':>5} {'#wk':>3} "
              f"{'roster':>22} {'prod w/o/i/c':>16}")
        for wave, prep, tc, nt, wr, bc, nw, ros, pr in rows:
            boss = " BOSS" if WAVES_RAW[wave - 1].get("isBoss") else ""
            stall = " <<STALL" if prep > 120 else (" <triv" if prep < 8 else "")
            print(f"{wave:>2} {prep:>5} {tc:>6} {nt:>4} {wr*100:>4.0f}% {bc:>5} {nw:>3} "
                  f"{ros:>22} {pr[0]:>4}/{pr[1]:>3}/{pr[2]:>3}/{pr[3]:>2}{boss}{stall}")
        stalls = sum(1 for p in preps if p > 120)
        triv = sum(1 for p in preps if p < 8)
        print(f"\ntotal {t}s = {t/60:.1f} min | prep band {min(preps)}-{max(preps)}s | avg {sum(preps)/len(preps):.0f}s "
              f"| stalls>120s: {stalls} | trivial<8s: {triv}")
        # difficulty band health
        bands = sum(1 for _, _, _, _, wr, _, _, _, _ in rows if 0.4 <= wr <= 0.75)
        print(f"difficulty: {bands}/{N_WAVES} waves in 40-75% retry-band at min defense")
        # economy: cost vs production (target ~1.3-1.5x defense/production is NOT the frame here —
        # defense is a subset of spend; report both so we can see headroom)
        tot_spent = sum(spent); tot_prod = sum(produced)
        print(f"economy: defense cost {[round(x) for x in spent]} (sum {tot_spent:.0f}) | "
              f"produced {[round(x) for x in produced]} (sum {tot_prod:.0f}) | "
              f"defense/production = {tot_spent/max(1,tot_prod)*100:.0f}%")
    return preps, rows

if __name__ == "__main__":
    run()
