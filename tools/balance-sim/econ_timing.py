"""Clean economy-timing model: how long to afford each wave's minimum winning defense.
Balanced worker allocation across needed resources. Reveals mining-state stalls."""
import math

WORKER_PROD={1:6,2:13,3:28,4:60,5:126,6:255,7:510}
COLLECT=4.0
SLOT_MULT={1:[1],2:[1,1.1],3:[1,1.1,1.25],4:[1,1.1,1.25,1.45],5:[1,1.1,1.25,1.45,1.7]}
UNIT_BASE=5

# min winning INCREMENTAL defense per wave (cumulative resource spent to have this on the field)
# derived from difficulty.py ladder
CUM_DEFENSE_COST={  # wood, ore, iron, crystal spent cumulatively by end of prep for this wave
 1:dict(wood=300, ore=150, iron=0,   crystal=0),
 2:dict(wood=300, ore=570, iron=220, crystal=0),   # 2brk + 1 turret (iron)
 3:dict(wood=960, ore=2610,iron=1160,crystal=0),   # 2brkL2 + 2turret
 4:dict(wood=960, ore=2610,iron=1160,crystal=0),   # holds
 5:dict(wood=1440,ore=2875,iron=1160,crystal=0),   # 3brkL2 + 2turret
 6:dict(wood=3120,ore=5875,iron=2880,crystal=0),   # 3brkL3 + 2turretL3
 7:dict(wood=4160,ore=8500,iron=4240,crystal=0),   # 4brkL3 + 3turretL3
}
GOLD_PER_WAVE={1:24,2:34,3:54,4:72,5:106,6:138,7:208}

def buy_cost(n): return UNIT_BASE+n  # cost of (n+1)th worker, n already purchased

class Econ:
    def __init__(self):
        self.gold=65
        self.res=dict(wood=70,ore=35,iron=0,crystal=0)
        self.purchased=0
        self.merge_cap=5
        # mines: key -> dict(unlocked, slots, workers=list of levels)
        self.mines={k:dict(unlocked=(k in('wood','ore')), slots=1, workers=[]) for k in('wood','ore','iron','crystal')}
        self.reserve=[]
        self.t=0.0
        self.idle=0.0

    def total_slots(self, key): return self.mines[key]['slots']
    def prod(self, key):
        m=self.mines[key]
        if not m['unlocked']: return 0
        mult=SLOT_MULT[m['slots']]
        return sum(WORKER_PROD[lvl]/COLLECT*mult[i] for i,lvl in enumerate(sorted(m['workers'],reverse=True)))
    def all_prod(self): return {k:self.prod(k) for k in self.mines}
    def worker_count(self): return sum(len(m['workers']) for m in self.mines.values())+len(self.reserve)

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
    # unlock iron before wave2 defense, crystal never needed here; else +slot on most-needed unlocked mine
    if not e.mines['iron']['unlocked'] and wave>=1:
        e.mines['iron']['unlocked']=True; return "unlock iron"
    # +slot on the needed mine with fewest slots
    cand=[k for k in need_keys if e.mines[k]['unlocked'] and e.mines[k]['slots']<5]
    if cand:
        cand.sort(key=lambda k:e.mines[k]['slots'])
        e.mines[cand[0]]['slots']+=1; return f"+slot {cand[0]}->{e.mines[cand[0]]['slots']}"
    if e.merge_cap<7:
        e.merge_cap+=1; return f"merge cap {e.merge_cap}"
    return "discount"

e=Econ()
spent=dict(wood=0,ore=0,iron=0,crystal=0)
print(f"{'W':>2} {'prep(s)':>7} {'clock':>6} {'gold':>5} {'workers':>7} {'roster':>16} {'prod w/o/i/c':>16} {'need(cum)':>18}")
picks=[]
for wave in range(1,8):
    need=CUM_DEFENSE_COST[wave]
    need_keys=[k for k in ('wood','ore','iron','crystal') if need[k]>spent[k]]
    # grant gold from previous wave win already applied; give this wave's upcoming gold AFTER (kills happen in battle)
    # prep loop: mine until we have accumulated (need - spent) additional resources
    prep=0.0
    # first: buy/merge/allocate workers with current gold
    def manage():
        # spend gold on workers up to a sensible roster cap (total slots + small reserve buffer for merging)
        total_slots=sum(m['slots'] for m in e.mines.values() if m['unlocked'])
        while e.gold>=buy_cost(e.purchased):
            e.gold-=buy_cost(e.purchased); e.purchased+=1; e.reserve.append(1)
            e.merge_reserve()
            # stop if reserve big and slots full (avoid infinite hoard)
            if len(e.reserve)>total_slots+3: break
        e.merge_reserve()
        e.rebalance_workers(need_keys or list(e.mines))
    manage()
    while prep<600:
        p=e.all_prod()
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
    p=e.all_prod()
    print(f"{wave:>2} {prep:>7.0f} {e.t:>6.0f} {e.gold:>5.0f} {e.worker_count():>7} {rosters:>16} "
          f"{p['wood']:>4.0f}/{p['ore']:>3.0f}/{p['iron']:>3.0f}/{p['crystal']:>2.0f} "
          f"{need['wood']}/{need['ore']}/{need['iron']}/{need['crystal']:>2}")
    # win the wave -> gold in
    e.gold+=GOLD_PER_WAVE[wave]
    pk=upgrade_pick(e, wave, need_keys or ['ore'])
    picks.append(f"W{wave}: {pk}")

print("\nUpgrade picks:", "; ".join(picks))
print(f"Total clock: {e.t:.0f}s = {e.t/60:.1f} min")
