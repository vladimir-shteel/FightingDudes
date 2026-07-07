"""Pacing proposal: 24 waves, exponential unit cost (soft-cap on labor), gold ONLY from battle.
Goal: prep (mining downtime) per wave in a healthy ~40-75s band, total loop ~20-30 min.
Data synced with data/balance.json, fortress-waves.json (24 waves, boss waves 5/10/15/20)."""
import math, json
from pathlib import Path

# Read production stats and balance parameters
try:
    data_dir = Path(__file__).parent.parent.parent / "data"
    with open(data_dir / "balance.json", encoding="utf-8") as f:
        balance_data = json.load(f)
    with open(data_dir / "mine-levels.json", encoding="utf-8") as f:
        mine_data = json.load(f)
    with open(data_dir / "fortress-waves.json", encoding="utf-8") as f:
        waves_data = json.load(f)

    WORKER_PROD = {int(k): v for k, v in mine_data.get("workerProductionByLevel", {1:6,2:13,3:28,4:60,5:126,6:255,7:510}).items()}
    COLLECT = mine_data.get("collectionIntervalSeconds", 4.0)
    BASE = balance_data.get("unitBuyBaseCost", 5)
    EXP = balance_data.get("unitBuyExponent", 1.05)
    N_WAVES = len(waves_data)
    TRAIT_YIELD_MUL = balance_data.get("workerTraits", {}).get("lines", {}).get("yield", {}).get("resourceMultiplierPerPoint", 0.06)
    PRODUCTION_MULT_BATTLE = balance_data.get("productionMultipliers", {}).get("battle", 1.5)
    WAVE_DEMAND_MULT = balance_data.get("waveDemand", {}).get("slotProductionMultiplier", 1.25)
    TRAIT_GOLDEN_MUL = balance_data.get("workerTraits", {}).get("lines", {}).get("golden", {}).get("goldPerResourcePerPoint", 0.006)
    # Map resource key → mine index used throughout this sim (0=wood, 1=ore, 2=iron, 3=crystal).
    RES_KEYS = ["wood", "ore", "iron", "crystal"]
    DEMAND_BY_WAVE = {i + 1: RES_KEYS.index(w["demandResource"]) if w.get("demandResource") in RES_KEYS else None
                     for i, w in enumerate(waves_data)}
except:
    WORKER_PROD={1:6,2:13,3:28,4:60,5:126,6:255,7:510}
    COLLECT=4.0
    BASE=5; EXP=1.05
    N_WAVES=24
    TRAIT_YIELD_MUL = 0.06
    PRODUCTION_MULT_BATTLE = 1.5
    WAVE_DEMAND_MULT = 1.25
    TRAIT_GOLDEN_MUL = 0.006
    DEMAND_BY_WAVE = {}

SLOT_MULT={1:[1],2:[1,1.1],3:[1,1.1,1.25],4:[1,1.1,1.25,1.45],5:[1,1.1,1.25,1.45,1.7]}

def base_equiv(level): return 2**(level-1)

class E:
    def __init__(self):
        self.gold=65; self.res=[70,35,0,0]
        self.unlocked=[True,True,False,False]; self.slots=[1,1,1,1]; self.workers=[[],[],[],[]]
        self.reserve=[]
        # Merge cap is a HARD ceiling in the game (balance.json merge.maxLevel = 5).
        # There's no in-game path to raise it; keep the sim faithful.
        self.merge_cap = balance_data.get("merge", {}).get("maxLevel", 5) if 'balance_data' in globals() else 5
    def E_owned(self):
        return sum(base_equiv(w) for k in range(4) for w in self.workers[k]) + sum(base_equiv(w) for w in self.reserve)
    def buycost(self): return max(1, math.floor(BASE * EXP**self.E_owned()))
    def prod(self, wave=None):
        out=[0,0,0,0]
        demand_k = DEMAND_BY_WAVE.get(wave) if wave is not None else None
        for k in range(4):
            if not self.unlocked[k]: continue
            m=SLOT_MULT[self.slots[k]]
            # Wave-demand bonus applies to every slot of the highlighted mine.
            demand_mul = WAVE_DEMAND_MULT if demand_k == k else 1.0
            for i,lvl in enumerate(sorted(self.workers[k],reverse=True)):
                # Approximate trait yield mul: dominant line accumulates ~level pts on avg after merges.
                trait_mul = 1 + lvl * TRAIT_YIELD_MUL
                out[k]+=WORKER_PROD[lvl]/COLLECT*m[i]*trait_mul*demand_mul
        return out
    def merge(self):
        ch=True
        while ch:
            ch=False; self.reserve.sort()
            for i in range(len(self.reserve)-1):
                if self.reserve[i]==self.reserve[i+1] and self.reserve[i]<self.merge_cap:
                    lv=self.reserve[i]+1; del self.reserve[i:i+2]; self.reserve.append(lv); ch=True; break
    def rebalance(self, needk):
        pool=list(self.reserve)
        for k in range(4): pool+=self.workers[k]; self.workers[k]=[]
        pool.sort(reverse=True)
        keys=[k for k in needk if self.unlocked[k]] or [k for k in range(4) if self.unlocked[k]]
        self.reserve=[]
        # pass 1: guarantee one worker on each needed mine (a real player staffs new mines)
        for k in keys:
            if pool: self.workers[k].append(pool.pop(0))
        # pass 2: fill remaining slots by descending slot value
        tg=[]
        for k in keys:
            for s in range(len(self.workers[k]), self.slots[k]): tg.append((k,SLOT_MULT[self.slots[k]][s]))
        tg.sort(key=lambda x:-x[1]); ti=0
        for w in pool:
            if ti<len(tg): self.workers[tg[ti][0]].append(w); ti+=1
            else: self.reserve.append(w)
    def total_slots(self): return sum(self.slots[k] for k in range(4) if self.unlocked[k])

def run(reward_fn, cost_fn, target_prep=55, verbose=True):
    e=E(); t=0; preps=[]; rows=[]
    spent=[0,0,0,0]
    for wave in range(1,N_WAVES+1):
        need=cost_fn(wave)  # cumulative resource investment target by this wave
        needk=[k for k in range(4) if need[k]>spent[k]]
        # buy workers up to soft-cap: keep buying while affordable and there's a home / merge value
        while e.gold>=e.buycost():
            e.gold-=e.buycost(); e.reserve.append(1); e.merge()
            if len(e.reserve)>e.total_slots()+2: break
        e.merge(); e.rebalance(needk or [0,1])
        prep=0
        while prep<600:
            p=e.prod(wave)
            for k in range(4): e.res[k]+=p[k]
            # Golden trait: ~1/3 of workers end up Golden-dominant; their share of production
            # becomes gold (goldPerResourcePerPoint × avg level ~2). Drops the old "gold ONLY from
            # battle" assumption without pretending the whole roster is Golden.
            e.gold += sum(p) * TRAIT_GOLDEN_MUL * (1.0 / 3.0) * 2.0
            prep+=1; t+=1
            if all(e.res[k]>=need[k]-spent[k] for k in range(4)): break
        for k in range(4):
            inc=need[k]-spent[k]
            if inc>0: e.res[k]-=inc; spent[k]=need[k]
        preps.append(prep)
        roster=sorted([w for k in range(4) for w in e.workers[k]],reverse=True)
        rows.append((wave, prep, round(t), e.buycost(), "+".join(f"L{x}" for x in roster) or "-",
                     [round(x) for x in e.prod(wave)]))
        # Early-start bonus: wave-config linear decay from startBonusGold at t=window down to 0.
        try:
            wcfg = waves_data[wave - 1]
            eb_gold = wcfg.get("startBonusGold", 0)
            eb_win = wcfg.get("startBonusWindowSeconds", 0)
            if eb_gold > 0 and eb_win > 0:
                remaining = max(0, eb_win - prep)
                e.gold += round(eb_gold * remaining / eb_win)
        except:
            pass
        e.gold+=reward_fn(wave)
        # unlock mines AHEAD of demand so workers can pre-stock (iron needed@5, crystal@10)
        if not e.unlocked[2] and wave>=3: e.unlocked[2]=True
        elif not e.unlocked[3] and wave>=8: e.unlocked[3]=True
        else:
            cand=[k for k in (needk or [1]) if e.unlocked[k] and e.slots[k]<5]
            if cand: cand.sort(key=lambda k:e.slots[k]); e.slots[cand[0]]+=1
            # merge_cap stays pinned — no in-game path to lift it.
    if verbose:
        print(f"{'W':>2} {'prep':>4} {'clock':>5} {'buy$':>4} {'roster':>18} {'prod w/o/i/c':>16}")
        for wave,prep,t2,bc,ros,pr in rows:
            boss=" [BOSS]" if wave%5==0 else ""
            print(f"{wave:>2} {prep:>4} {t2:>5} {bc:>4} {ros:>18} {pr[0]:>4}/{pr[1]:>3}/{pr[2]:>3}/{pr[3]:>2}{boss}")
        print(f"total clock {t}s = {t/60:.1f} min | prep band {min(preps)}-{max(preps)}s | avg prep {sum(preps)/len(preps):.0f}s")
    return t, preps

# --- TUNABLE CANDIDATE PARAMETERS (pre-calibration, will be re-tuned after miner traits) ---
# reward: gold ONLY from battle; smaller per wave but 20 waves, gentle growth.
def reward(w): return 14 + w*4          # W1=18 ... W20=94 ; cumulative ~1120
# COST_SCALE tunes the whole building-cost curve against production capacity.
#   too low  -> prep ~3s (no management),  too high -> multi-minute stalls.
# From the S-sweep below, S=12 gives a healthy loop (~14min, prep 10-115s, 0 stalls).
COST_SCALE = 12
# cumulative building investment target. NEW resources ramp gently from their demand-wave,
# and their mine is unlocked ~2 waves earlier so workers pre-stock (no introduction cliff).
def cost(w):
    def ramp(scale, start, g=1.16):
        return 0 if w<start else scale*COST_SCALE*(g**(w-start))
    wood = ramp(90, 1)
    ore  = ramp(70, 2)
    iron = ramp(60, 5)      # mine unlocked @3, demanded @5
    cry  = ramp(45, 10)     # mine unlocked @8, demanded @10
    return [wood, ore, iron, cry]

if __name__ == "__main__":
    print("="*74)
    print(f"S-SWEEP (find COST_SCALE that keeps prep in a healthy ~40-60s band):")
    print("="*74)
    for S in [6, 8, 10, 12, 14]:
        def cost_s(w, S=S):
            def ramp(sc, st, g=1.16): return 0 if w<st else sc*S*(g**(w-st))
            return [ramp(90,1), ramp(70,2), ramp(60,5), ramp(45,10)]
        t, preps = run(reward, cost_s, verbose=False)
        stalls = sum(1 for p in preps if p > 120)
        print(f"  S={S:>2}: total {t/60:4.1f}min | avg prep {sum(preps)/len(preps):4.0f}s "
              f"| band {min(preps)}-{max(preps)}s | stalls>2min: {stalls}")
    print("\n" + "="*74)
    print(f"DETAILED RUN at recommended COST_SCALE={COST_SCALE}")
    print(f"({N_WAVES} waves, exp unit cost {EXP}, gold-only-from-battle, boss every 5)")
    print("="*74)
    run(reward, cost)
