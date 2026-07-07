"""For each wave, test a ladder of realistic defenses -> win rate + resource cost.
Reveals the 'power needed' curve and whether the difficulty ramp matches the design target.
Buildings are now merge-upgraded (2 copies of Lv N → 1 copy of Lv N+1). Cost of Lv N = 2^(N-1) × buyCost.
Loops all 24 waves."""
import random, json
from pathlib import Path
from battle_sim import Building, simulate, WAVES

# Read building buy costs from data file
data_dir = Path(__file__).parent.parent.parent / "data"
with open(data_dir / "fortress-buildings.json", encoding="utf-8") as f:
    BLD_DATA = json.load(f)

BUY_COST = {t: dict(BLD_DATA[t].get("buyCost", {})) for t in BLD_DATA if t != "hq"}

def cost_of(specs):
    """Merge-based cost: Lv N of a building = 2^(N-1) copies bought at buyCost."""
    tot=dict(wood=0,ore=0,iron=0,crystal=0)
    for t,l,o in specs:
        multiplier = 2 ** (l - 1)
        for k,v in BUY_COST[t].items():
            tot[k] = tot.get(k, 0) + v * multiplier
    return tot

def winrate(specs, wave, seeds=15):
    wins=0; hqs=[]; times=[]
    for s in range(seeds):
        bs=[Building('hq',1,(1,5))]+[Building(t,l,o) for t,l,o in specs]
        r=simulate(bs, wave, random.Random(s*13+7))
        if r['result']=='victory': wins+=1
        hqs.append(r['hq']); times.append(r['time'])
    return wins/seeds, sum(hqs)/len(hqs), sum(times)/len(times)

# ladders of increasing investment (positions chosen to be sensible: spawners flanking, turrets center)
LADDER=[
 ("1 barracks",             [('barracks',1,(0,2))]),
 ("2 barracks",             [('barracks',1,(0,2)),('barracks',1,(3,2))]),
 ("2 barracks +wall",       [('barracks',1,(0,2)),('barracks',1,(3,2)),('wall',1,(2,0))]),
 ("2 brk +turret",          [('barracks',1,(0,2)),('barracks',1,(3,2)),('turret',1,(2,1))]),
 ("2 brkL2 +turret",        [('barracks',2,(0,2)),('barracks',2,(3,2)),('turret',1,(2,1))]),
 ("2 brkL2 +2turret",       [('barracks',2,(0,2)),('barracks',2,(3,2)),('turret',2,(1,1)),('turret',2,(3,1))]),
 ("3 brkL2 +2turret",       [('barracks',2,(0,2)),('barracks',2,(3,2)),('barracks',2,(0,0)),('turret',2,(2,1)),('turret',2,(4,1))]),
 ("3 brkL3 +2turretL3",     [('barracks',3,(0,2)),('barracks',3,(3,2)),('barracks',3,(0,0)),('turret',3,(2,1)),('turret',3,(4,1))]),
 ("4 brkL3 +3turretL3",     [('barracks',3,(0,2)),('barracks',3,(3,2)),('barracks',3,(0,0)),('barracks',3,(3,0)),('turret',3,(2,1)),('turret',3,(4,1)),('turret',3,(2,3))]),
 ("max stack",              [('barracks',3,(0,2)),('barracks',3,(3,2)),('barracks',3,(0,0)),('archery',2,(2,0)),('turret',3,(2,3)),('turret',3,(0,4)),('turret',3,(4,4)),('stables',2,(3,4))]),
]

for wave in range(1, len(WAVES) + 1):
    print(f"\n===== WAVE {wave} =====")
    print(f"  {'build':24} {'win%':>5} {'avgHQ':>6} {'avgT':>5}  cost(w/o/i/c)")
    for name,specs in LADDER:
        wr,hq,tm=winrate(specs,wave)
        c=cost_of(specs)
        cs=f"{c['wood']}/{c['ore']}/{c['iron']}/{c['crystal']}"
        flag=" <-- clears" if wr>=0.8 else (" ~risky" if wr>=0.4 else "")
        print(f"  {name:24} {wr*100:4.0f}% {hq:6.0f} {tm:4.0f}s  {cs}{flag}")
