"""Clean economy-timing model: how long to afford each wave's minimum winning defense.
Balanced worker allocation across needed resources. Reveals mining-state stalls.
Ported 1:1 from js/game (24 waves, exponential worker cost, trait multipliers, merge-based building cost)."""
import math, json
from pathlib import Path

# Read production stats and balance parameters from data/
data_dir = Path(__file__).parent.parent.parent / "data"
with open(data_dir / "balance.json", encoding="utf-8") as f:
    balance_data = json.load(f)
with open(data_dir / "mine-levels.json", encoding="utf-8") as f:
    mine_data = json.load(f)
with open(data_dir / "fortress-waves.json", encoding="utf-8") as f:
    waves_data = json.load(f)

WORKER_PROD = {int(k): v for k, v in mine_data.get("workerProductionByLevel").items()}
COLLECT = mine_data.get("collectionIntervalSeconds", 4.0)
UNIT_BASE = balance_data.get("unitBuyBaseCost", 5)
UNIT_EXP = balance_data.get("unitBuyExponent", 1.05)
MERGE_MAX = balance_data.get("merge", {}).get("maxLevel", 5)
WORKER_TRAITS = balance_data.get("workerTraits", {})
TRAIT_YIELD_MUL = WORKER_TRAITS.get("lines", {}).get("yield", {}).get("resourceMultiplierPerPoint", 0.06)
TRAIT_GOLDEN_MUL = WORKER_TRAITS.get("lines", {}).get("golden", {}).get("goldPerResourcePerPoint", 0.006)
PRODUCTION_MULT_BATTLE = balance_data.get("productionMultipliers", {}).get("battle", 1.5)
WAVE_DEMAND_MULT = balance_data.get("waveDemand", {}).get("slotProductionMultiplier", 1.25)
STARTING_GOLD = balance_data.get("startingGold", 65)
STARTING_RES = balance_data.get("startingResources", {"wood": 70, "ore": 35})
N_WAVES = len(waves_data)

SLOT_MULT={1:[1],2:[1,1.1],3:[1,1.1,1.25],4:[1,1.1,1.25,1.45],5:[1,1.1,1.25,1.45,1.7]}

# Cumulative building investment target per wave.
# Buildings are now merge-upgraded: Lv N = 2^(N-1) copies of Lv1 buyCost, no resource-based upgrade.
# Approximate "min defense" ramp aligned with 24 waves: barracks/turret escalate, iron/crystal ramp with unlocks.
def _cum_defense_cost():
    # From difficulty.py ladder w1..w7 approximated for 24w; smoother growth
    curve = {}
    for w in range(1, N_WAVES + 1):
        # Rough shape: exponential-ish growth of building spend
        wood = int(90 * (1.16 ** (w - 1)))
        ore  = int(70 * (1.16 ** (w - 1))) if w >= 1 else 0
        iron = int(60 * (1.16 ** (w - 3))) if w >= 3 else 0
        cry  = int(45 * (1.16 ** (w - 8))) if w >= 8 else 0
        curve[w] = dict(wood=wood, ore=ore, iron=iron, crystal=cry)
    return curve

CUM_DEFENSE_COST = _cum_defense_cost()

def wave_reward_gold(w):
    """victoryGold + killGold*enemyCount, per wave data."""
    wave = waves_data[w - 1]
    victory = wave.get("victoryGold", 14 + 4 * w)
    kill = wave.get("killGold", 1) * wave.get("enemyCount", 0)
    return victory + kill

def early_start_bonus(w, prep_seconds):
    """Wave-config linear-decay bonus. Applied on starting wave w after prep seconds.
    Matches fortressBattleSystem.startFortressBattle: bonus × (remaining/window)."""
    wave = waves_data[w - 1]
    bonus = wave.get("startBonusGold", 0)
    window = wave.get("startBonusWindowSeconds", 0)
    if bonus <= 0 or window <= 0:
        return 0
    remaining = max(0, window - prep_seconds)
    fraction = remaining / window
    return round(bonus * fraction)

GOLD_PER_WAVE = {w: wave_reward_gold(w) for w in range(1, N_WAVES + 1)}

# --- Attrition + repair sink (matches fortressBattleSystem.finishBattle + repairFortressBuilding) ---
ATTR = balance_data.get("attrition", {})
FLOOR_PER_DEFEAT = ATTR.get("floorPerDefeat", 0.2)
POST_DEFEAT_HP = ATTR.get("postDefeatHpFraction", 0.4)
REPAIR_RATE = ATTR.get("repairCostPerHpFractionOfBuyCost", 0.02)

# DEFEAT_WAVES: set of wave numbers where the sim assumes the player loses.
# Default: empty (baseline "always win"). Override at run time.
DEFEAT_WAVES = set()

def repair_cost_after_defeat(building_key, buy_cost, damage_floor_prev, damage_floor_now):
    """After a defeat, the destroyed building starts next wave at hp = maxHp × max(0, post − floor_now).
    Repairing it back to full costs (maxHp − hp) × repairRate × buyCost per resource — i.e. the
    missing-HP fraction 1 − max(0, post − floor_now) times the sunk cost of the building.
    Assumes maxHp normalization; we track fractions since buyCost is the reference."""
    missing_frac = 1 - max(0, POST_DEFEAT_HP - damage_floor_now)
    return {k: int(round(v * REPAIR_RATE * missing_frac * 1)) for k, v in buy_cost.items()}

def base_equiv(level):
    """Contribution to E in the exponential cost formula: E = sum 2^(level-1) over all workers."""
    return 2 ** (level - 1)

class Econ:
    def __init__(self):
        self.gold=STARTING_GOLD
        self.res=dict(wood=STARTING_RES.get("wood",0),ore=STARTING_RES.get("ore",0),iron=0,crystal=0)
        self.merge_cap=MERGE_MAX
        # mines: key -> dict(unlocked, slots, workers=list of levels)
        self.mines={k:dict(unlocked=(k in('wood','ore')), slots=1, workers=[]) for k in('wood','ore','iron','crystal')}
        self.reserve=[]
        self.t=0.0
        self.idle=0.0

    def all_workers(self):
        for m in self.mines.values():
            for w in m['workers']: yield w
        for w in self.reserve: yield w

    def buy_cost(self):
        """cost = max(1, floor(base * exp^E)), E = sum 2^(lvl-1) over all workers (matches reserveSystem.getUnitBuyCost)."""
        E = sum(base_equiv(w) for w in self.all_workers())
        return max(1, math.floor(UNIT_BASE * (UNIT_EXP ** E)))

    def total_slots(self, key): return self.mines[key]['slots']
    def prod(self, key, wave=None):
        m=self.mines[key]
        if not m['unlocked']: return 0
        mult=SLOT_MULT[m['slots']]
        # Wave-demand: matching resource → every slot gets ×WAVE_DEMAND_MULT.
        demand_key = waves_data[wave - 1].get("demandResource") if (wave and 1 <= wave <= N_WAVES) else None
        demand_mul = WAVE_DEMAND_MULT if demand_key == key else 1.0
        # Trait yield mul: each worker averages ~level trait points on dominant line after merges → 1 + level * YIELD_MUL.
        # (Approximation: mergeWorkerTraitVectors sums vectors + bonus, dominant line grows ~geometrically with level.)
        return sum(
            (WORKER_PROD[lvl]/COLLECT) * mult[i] * (1 + lvl * TRAIT_YIELD_MUL) * demand_mul
            for i,lvl in enumerate(sorted(m['workers'],reverse=True))
        )
    def all_prod(self, wave=None): return {k:self.prod(k, wave) for k in self.mines}
    def worker_count(self): return sum(len(m['workers']) for m in self.mines.values())+len(self.reserve)
    def purchased_count(self): return self.worker_count()  # for print compat

    def merge_reserve(self):
        ch=True
        while ch:
            ch=False; self.reserve.sort()
            for i in range(len(self.reserve)-1):
                if self.reserve[i]==self.reserve[i+1] and self.reserve[i]<self.merge_cap:
                    lv=self.reserve[i]+1; del self.reserve[i:i+2]; self.reserve.append(lv); ch=True; break

    def rebalance_workers(self, need_keys):
        """Pull all workers to reserve, then re-slot to feed the needed resources evenly by slot value."""
        pool=list(self.reserve)
        for m in self.mines.values():
            pool+=m['workers']; m['workers']=[]
        pool.sort(reverse=True)
        # build list of (mineKey, slotMult) targets for unlocked mines that we need, round-robin
        targets=[]
        keys=[k for k in need_keys if self.mines[k]['unlocked']] or [k for k in self.mines if self.mines[k]['unlocked']]
        for k in keys:
            m=self.mines[k]
            for i in range(m['slots']):
                targets.append((k, SLOT_MULT[m['slots']][i]))
        targets.sort(key=lambda x:-x[1])
        self.reserve=[]
        ti=0
        for w in pool:
            if ti<len(targets):
                self.mines[targets[ti][0]]['workers'].append(w); ti+=1
            else:
                self.reserve.append(w)

def upgrade_pick(e, wave, need_keys):
    # Unlock iron/crystal ahead of demand; then +slot on most-needed unlocked mine.
    if not e.mines['iron']['unlocked'] and wave>=1:
        e.mines['iron']['unlocked']=True; return "unlock iron"
    if not e.mines['crystal']['unlocked'] and wave>=6:
        e.mines['crystal']['unlocked']=True; return "unlock crystal"
    cand=[k for k in need_keys if e.mines[k]['unlocked'] and e.mines[k]['slots']<5]
    if cand:
        cand.sort(key=lambda k:e.mines[k]['slots'])
        e.mines[cand[0]]['slots']+=1; return f"+slot {cand[0]}->{e.mines[cand[0]]['slots']}"
    return "discount"

e=Econ()
spent=dict(wood=0,ore=0,iron=0,crystal=0)
print(f"{'W':>2} {'prep(s)':>7} {'clock':>6} {'gold':>5} {'buy$':>5} {'workers':>7} {'roster':>20} {'prod w/o/i/c':>16} {'need(cum)':>18}")
picks=[]
for wave in range(1, N_WAVES + 1):
    need=CUM_DEFENSE_COST[wave]
    need_keys=[k for k in ('wood','ore','iron','crystal') if need[k]>spent[k]]
    prep=0.0
    def manage():
        # buy up to soft cap (exponential cost curbs runaway)
        total_slots=sum(m['slots'] for m in e.mines.values() if m['unlocked'])
        while e.gold>=e.buy_cost():
            e.gold-=e.buy_cost(); e.reserve.append(1)
            e.merge_reserve()
            if len(e.reserve)>total_slots+2: break
        e.merge_reserve()
        e.rebalance_workers(need_keys or list(e.mines))
    manage()
    while prep<600:
        p=e.all_prod(wave)
        for k in ('wood','ore','iron','crystal'):
            e.res[k]+=p[k]*1.0
        prep+=1.0; e.t+=1.0
        # check if cumulative target met (spent + current stock covers need)
        if all(e.res[k]>=(need[k]-spent[k]) for k in need):
            break
        # occasionally re-manage (idle gold does nothing here since gold only from waves)
    # pay for the defense increment
    for k in need:
        inc=need[k]-spent[k]
        if inc>0: e.res[k]-=inc; spent[k]+=inc
    roster=sorted([w for m in e.mines.values() for w in m['workers']],reverse=True)
    rosters="+".join(f"L{x}" for x in roster) or "-"
    p=e.all_prod(wave)
    print(f"{wave:>2} {prep:>7.0f} {e.t:>6.0f} {e.gold:>5.0f} {e.buy_cost():>5.0f} {e.worker_count():>7} {rosters:>20} "
          f"{p['wood']:>4.0f}/{p['ore']:>3.0f}/{p['iron']:>3.0f}/{p['crystal']:>2.0f} "
          f"{need['wood']}/{need['ore']}/{need['iron']}/{need['crystal']:>2}")
    # Early-start bonus: credited when the wave starts (i.e., after prep, before victory reward).
    e.gold += early_start_bonus(wave, prep)
    # win the wave -> gold in
    e.gold+=GOLD_PER_WAVE[wave]
    pk=upgrade_pick(e, wave, need_keys or ['ore'])
    picks.append(f"W{wave}: {pk}")

print("\nUpgrade picks:", "; ".join(picks))
print(f"Total clock: {e.t:.0f}s = {e.t/60:.1f} min")
