"""For each wave, test a ladder of realistic defenses -> win rate + resource cost.
Reveals the 'power needed' curve and whether the difficulty ramp matches the design target."""
import random
from battle_sim import Building, simulate

BUY_COST=dict(
 barracks=dict(wood=150,ore=75), archery=dict(wood=360,ore=180),
 turret=dict(ore=420,iron=220), stables=dict(wood=520,iron=260),
 mageTower=dict(ore=560,crystal=260), wall=dict(wood=90), bigWall=dict(wood=420,ore=220),
 mine=dict(iron=160),
)
UP_COST=dict(
 barracks=[dict(wood=330,ore=190),dict(wood=560,ore=360,iron=160)],
 turret=[dict(ore=620,iron=360),dict(ore=960,iron=620)],
 archery=[dict(wood=640,ore=260,crystal=180),dict(wood=980,crystal=520)],
 stables=[dict(wood=780,iron=460),dict(wood=1080,iron=720,crystal=240)],
 mageTower=[dict(ore=820,crystal=460),dict(ore=1160,crystal=760)],
)

def cost_of(specs):
    tot=dict(wood=0,ore=0,iron=0,crystal=0)
    for t,l,o in specs:
        for k,v in BUY_COST[t].items(): tot[k]+=v
        for lvl in range(1,l):
            for k,v in UP_COST[t][lvl-1].items(): tot[k]+=v
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

for wave in range(1,8):
    print(f"\n===== WAVE {wave} =====")
    print(f"  {'build':24} {'win%':>5} {'avgHQ':>6} {'avgT':>5}  cost(w/o/i/c)")
    for name,specs in LADDER:
        wr,hq,tm=winrate(specs,wave)
        c=cost_of(specs)
        cs=f"{c['wood']}/{c['ore']}/{c['iron']}/{c['crystal']}"
        flag=" <-- clears" if wr>=0.8 else (" ~risky" if wr>=0.4 else "")
        print(f"  {name:24} {wr*100:4.0f}% {hq:6.0f} {tm:4.0f}s  {cs}{flag}")
