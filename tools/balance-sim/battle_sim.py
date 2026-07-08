"""Faithful port of the FightingDudes fortress battle engine for balance analysis.
Data: Synced with fortress-enemies.json, fortress-waves.json (24 waves with composition).

Fidelity notes (kept honest against js/game/systems/fortressBattleSystem.js):
- Boss mechanics (aura, summon, breach) ARE implemented (tick_boss_mechanic + inline breach).
- Spawn order is a deterministic round-robin (matches expandComposition), NOT a shuffle.
- damage_mult / defense_mult hooks mirror getFortressDamageMultiplier / getFortressDefenseMultiplier
  (temp reward cards + Skirmisher capstone). Default 1.0 for a clean baseline.
- NOT modelled (opt-in, safe to skip for a baseline): building actives (overcharge/spawnSquad/
  volley/frost/shield) and the shield damage-reduction they grant.
"""
import math, random, heapq, json
from pathlib import Path

W, H = 5, 7
REPATH = 0.4
WAYPOINT_ARRIVAL = 0.18
COLL_R = 0.18
PUSH = 1.0

# --- config from data/ ---
# Read from fortress-enemies.json if available; fallback to hardcoded.
try:
    data_dir = Path(__file__).parent.parent.parent / "data"
    with open(data_dir / "fortress-enemies.json", encoding="utf-8") as f:
        ENEMIES_DATA = json.load(f)
    with open(data_dir / "balance.json", encoding="utf-8") as f:
        _BALANCE = json.load(f)
except:
    _BALANCE = {}
    ENEMIES_DATA = {
        "grunt":   dict(hp=28, attack=10, cd=0.8, rng=0.42, spd=0.95),
        "runner":  dict(hp=18, attack=6, cd=0.7, rng=0.42, spd=1.55),
        "armored": dict(hp=75, attack=13, cd=1.1, rng=0.42, spd=0.7),
        "archerE": dict(hp=22, attack=9, cd=1.4, rng=2.4, spd=0.9),
        "orcKing": dict(hp=420, attack=18, cd=1.1, rng=0.5, spd=0.65),
        "necromancer": dict(hp=320, attack=12, cd=1.4, rng=2.0, spd=0.7),
        "breacher": dict(hp=560, attack=26, cd=1.3, rng=0.45, spd=0.55),
    }

# --- wave-scaling knobs (multiplicative: PRESERVES archetype identity across waves, unlike the old
# additive +5(w-1)+0.35(w-1)^2 which added a flat HP slab to every archetype and erased the swarm/
# tank distinction late). READ FROM data/balance.json.combat so the sim can never silently desync
# from the live game (fallbacks = the values as of the RPS combat pass). ---
_COMBAT = _BALANCE.get("combat", {}) if isinstance(_BALANCE, dict) else {}
HP_SCALE_PER_WAVE  = _COMBAT.get("hpScalePerWave", 0.14)    # hp  *= 1 + this*(w-1)
ATK_SCALE_PER_WAVE = _COMBAT.get("attackScalePerWave", 0.06)  # atk *= 1 + this*(w-1)
# Armor scales MULTIPLICATIVELY (like hp) so it tracks enemy toughness AND the tier-growth of the
# big-hit sources (turret/mine ~2x per tier). Flat scaling let high-tier turrets outpace armor and
# pierce everything late (combat went 1-D again). Multiplicative keeps chip bouncing at every wave.
ARMOR_SCALE_PER_WAVE = _COMBAT.get("armorScalePerWave", 0.10)  # armor *= 1 + this*(w-1)  (only archetypes WITH armor)

def make_enemy_stats(archetype_key, wave=1):
    """Get enemy stats, applying multiplicative wave scaling (identity-preserving)."""
    base = ENEMIES_DATA.get(archetype_key, ENEMIES_DATA.get("grunt"))
    hp = base.get("hp", 28)
    attack = base.get("attack", 10)
    cd = base.get("cooldownSeconds", 0.8)
    rng = base.get("rangeTiles", 0.42)
    spd = base.get("speedTilesPerSecond", 0.95)
    armor = base.get("armor", 0)
    wb = wave - 1
    hp = round(hp * (1 + HP_SCALE_PER_WAVE * wb))
    attack = round(attack * (1 + ATK_SCALE_PER_WAVE * wb))
    armor = round(armor * (1 + ARMOR_SCALE_PER_WAVE * wb)) if armor > 0 else 0
    return dict(hp=hp, attack=attack, cd=cd, rng=rng, spd=spd, armor=armor, archetype=archetype_key)

# Prefer data/fortress-units.json (picks up splashRadius etc.); fall back to frozen constants.
_FUNITS_FALLBACK = {
  "warrior": dict(hp=42, attack=8, cd=0.75, rng=0.5, spd=1.45, splash=0.0),
  "archer":  dict(hp=24, attack=7, cd=1.2, rng=2.6, spd=1.2, splash=0.0),
  "rider":   dict(hp=58, attack=12, cd=1.1, rng=0.45, spd=1.9, splash=0.0),
  "mage":    dict(hp=18, attack=10, cd=1.0, rng=2.4, spd=1.15, splash=1.0),
}
def _load_units():
    try:
        with open(data_dir / "fortress-units.json", encoding="utf-8") as f:
            raw = json.load(f)
        return {t: dict(hp=u["hp"], attack=u["attack"], cd=u["cooldownSeconds"],
                        rng=u["rangeTiles"], spd=u["speedTilesPerSecond"],
                        splash=u.get("splashRadius", 0.0)) for t, u in raw.items()}
    except Exception:
        return _FUNITS_FALLBACK
FUNITS = _load_units()

# Armor rule: effective = max(dmg*ARMOR_MIN_FRACTION, dmg - armor). The fractional floor (not a flat
# 1) is what makes armor a REAL lever: many-small-hits bounce down to 15% vs a heavy target, so burst
# (few big hits) is the efficient answer — yet nothing is fully immune (soft counter, no softlock).
ARMOR_MIN_FRACTION = _COMBAT.get("armorMinFraction", 0.15)
def hurt_enemy(e, dmg):
    armor = e.get('armor', 0)
    e['hp'] -= max(dmg * ARMOR_MIN_FRACTION, dmg - armor)

# Prefer data/fortress-buildings.json — fallback to the frozen constants below if the file is missing.
_BUILD_FALLBACK = {
  "hq":      dict(footprint=[(0,0),(1,0),(2,0),(0,1),(1,1),(2,1)], levels=[dict(hp=420)]),
  "wall":    dict(footprint=[(0,0)], levels=[dict(hp=65),dict(hp=135),dict(hp=260)]),
  "bigWall": dict(footprint=[(0,0),(1,0),(2,0)], levels=[dict(hp=140),dict(hp=260),dict(hp=440)]),
  "barracks":dict(footprint=[(0,0),(1,0),(0,1),(1,1)], levels=[dict(hp=70,cd=7,unit="warrior"),dict(hp=80,cd=5.5,unit="warrior"),dict(hp=80,cd=4,unit="warrior")]),
  "archery": dict(footprint=[(0,0),(1,0),(2,0),(1,1)], levels=[dict(hp=60,cd=9,unit="archer"),dict(hp=70,cd=7.5,unit="archer"),dict(hp=70,cd=6,unit="archer")]),
  "turret":  dict(footprint=[(0,0)], levels=[dict(hp=55,damage=10,cd=1.25),dict(hp=65,damage=17,cd=1.05),dict(hp=70,damage=26,cd=0.9)]),
  "stables": dict(footprint=[(0,0),(0,1),(0,2),(1,2)], levels=[dict(hp=75,cd=9,unit="rider"),dict(hp=80,cd=7.5,unit="rider"),dict(hp=80,cd=6,unit="rider")]),
  "mageTower":dict(footprint=[(0,0),(1,0),(0,1),(1,1)], levels=[dict(hp=55,cd=10,unit="mage"),dict(hp=65,cd=8,unit="mage"),dict(hp=70,cd=6,unit="mage")]),
  "mine":    dict(footprint=[(0,0)], levels=[dict(hp=1,damage=32),dict(hp=1,damage=54),dict(hp=1,damage=85)]),
}

def _load_buildings():
    try:
        with open(data_dir / "fortress-buildings.json", encoding="utf-8") as f:
            raw = json.load(f)
        out = {}
        for t, spec in raw.items():
            footprint = [tuple(p) for p in spec.get("footprint", [[0, 0]])]
            levels = []
            for lv in spec.get("levels", []):
                entry = {"hp": lv.get("hp", 1)}
                if "cooldownSeconds" in lv:
                    entry["cd"] = lv["cooldownSeconds"]
                if "damage" in lv:
                    entry["damage"] = lv["damage"]
                if "unit" in lv:
                    entry["unit"] = lv["unit"]
                levels.append(entry)
            out[t] = dict(footprint=footprint, levels=levels)
        return out
    except Exception:
        return _BUILD_FALLBACK

BUILD = _load_buildings()

# Read fortress-waves.json for 24-wave structure with composition
try:
    with open(data_dir / "fortress-waves.json", encoding="utf-8") as f:
        WAVES_RAW = json.load(f)
    WAVES = []
    for wave_data in WAVES_RAW:
        # Normalize: composition expanded to enemyCount if missing
        composition = wave_data.get("composition", [])
        if not composition and "enemyCount" in wave_data:
            composition = [{"archetype": "grunt", "count": wave_data["enemyCount"]}]
        WAVES.append(dict(
            enemyCount=wave_data.get("enemyCount", sum(c["count"] for c in composition)),
            spawn=wave_data.get("spawnIntervalSeconds", 1.0),
            killGold=wave_data.get("killGold", 1),
            victoryGold=wave_data.get("victoryGold", 18),
            composition=composition,
            isBoss=wave_data.get("isBoss", False),
        ))
except:
    # Fallback: 7 classic waves (old data)
    WAVES = [
      dict(enemyCount=4, spawn=1.15, killGold=3, victoryGold=12, composition=[{"archetype":"grunt","count":4}]),
      dict(enemyCount=6, spawn=1.0, killGold=3, victoryGold=16, composition=[{"archetype":"grunt","count":6}]),
      dict(enemyCount=8, spawn=0.9, killGold=4, victoryGold=22, composition=[{"archetype":"grunt","count":8}]),
      dict(enemyCount=11, spawn=0.8, killGold=4, victoryGold=28, composition=[{"archetype":"grunt","count":11}]),
      dict(enemyCount=14, spawn=0.7, killGold=5, victoryGold=36, composition=[{"archetype":"grunt","count":14}]),
      dict(enemyCount=18, spawn=0.65, killGold=5, victoryGold=48, composition=[{"archetype":"grunt","count":18}]),
      dict(enemyCount=24, spawn=0.55, killGold=6, victoryGold=64, composition=[{"archetype":"grunt","count":24}]),
    ]

def dist(a,b): return math.hypot(a['x']-b['x'], a['y']-b['y'])

def astar(start, goal, blocked):
    sx, sy = round(start[0]), round(start[1])
    gx, gy = round(goal[0]), round(goal[1])
    if (sx,sy)==(gx,gy): return [(sx,sy)]
    def h(x,y): return abs(x-gx)+abs(y-gy)
    openh = [(h(sx,sy),0,(sx,sy))]
    came = {}; g = {(sx,sy):0}
    while openh:
        f,gc,cur = heapq.heappop(openh)
        if cur==(gx,gy):
            path=[cur]
            while cur in came:
                cur=came[cur]; path.append(cur)
            return path[::-1]
        if gc>g.get(cur,1e9): continue
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx,ny=cur[0]+dx,cur[1]+dy
            if not (0<=nx<W and 0<=ny<H): continue
            isgoal = (nx,ny)==(gx,gy)
            if not isgoal and (nx,ny) in blocked: continue
            t=g[cur]+1
            if t<g.get((nx,ny),1e9):
                came[(nx,ny)]=cur; g[(nx,ny)]=t
                heapq.heappush(openh,(t+h(nx,ny),t,(nx,ny)))
    return None

class Building:
    _n=0
    def __init__(self, btype, level, origin):
        Building._n+=1; self.id=f"b{Building._n}"
        self.type=btype; self.level=level
        fp=BUILD[btype]['footprint']
        self.tiles=[(origin[0]+dx,origin[1]+dy) for dx,dy in fp]
        lv=BUILD[btype]['levels'][level-1]
        self.hp=lv['hp']; self.maxHp=lv['hp']; self.cd=0.5
        # Attrition state — 0 by default, may be pre-set by callers to simulate defeat-carry-over.
        self.damageFloor = 0
    def center(self):
        xs=[t[0] for t in self.tiles]; ys=[t[1] for t in self.tiles]
        return {'x':(min(xs)+max(xs)+1)/2,'y':(min(ys)+max(ys)+1)/2}

def edge_dist(actor, building):
    best=1e9
    for tx,ty in building.tiles:
        d=math.hypot(actor['x']-(tx+0.5), actor['y']-(ty+0.5))
        best=min(best,d)
    return best

def goal_tile(building):
    best=None
    for tx,ty in building.tiles:
        if best is None or ty<best[1] or (ty==best[1] and tx<best[0]):
            best=(tx,ty)
    return best

def blocked_set(buildings, ignore_id):
    s=set()
    for b in buildings:
        if b.hp<=0 or b.type=='mine' or b.id==ignore_id: continue
        for t in b.tiles: s.add(t)
    return s

def building_at_tile(buildings, tile):
    for b in buildings:
        if b.hp>0 and tile in b.tiles: return b
    return None

def make_enemy(wave, rng, archetype="grunt"):
    """Create an enemy with wave scaling and any boss mechanic descriptor."""
    base = make_enemy_stats(archetype, wave)
    # Mechanic is carried through so tick_boss can act on it (aura/summon/breach).
    raw = ENEMIES_DATA.get(archetype, {})
    mechanic = raw.get("mechanic")
    summon_timer = mechanic.get("intervalSeconds", 0) if mechanic and mechanic.get("kind") == "summon" else 0
    return dict(id=f"e{rng.random()}", hp=base['hp'], maxHp=base['hp'], attack=base['attack'],
                cd=base['cd'], at=0, rng=base['rng'], spd=base['spd'], armor=base['armor'], archetype=archetype,
                mechanic=mechanic, auraTimer=0, summonTimer=summon_timer,
                x=rng.random()*(W-0.5)+0.25, y=-0.45, path=None, ptimer=0, ptid=None, ctid=None)

# Spawned-unit power scales with the SPAWNER building's tier (was frozen: only cooldown scaled, so
# spawner units fell behind turret point-damage late-game). This is the spawner's merge payoff and
# keeps mage splash / warrior bodies relevant vs multiplicatively-scaled enemy HP.
UNIT_ATK_PER_LEVEL = _COMBAT.get("unitAttackPerLevel", 0.35)   # attack *= 1 + this*(level-1); L3=x1.7 L5=x2.4
UNIT_HP_PER_LEVEL  = _COMBAT.get("unitHpPerLevel", 0.20)        # hp     *= 1 + this*(level-1)

def make_ally(utype, origin, level=1):
    b=FUNITS[utype]
    atk = b['attack'] * (1 + UNIT_ATK_PER_LEVEL * (level - 1))
    hp  = b['hp'] * (1 + UNIT_HP_PER_LEVEL * (level - 1))
    return dict(id=f"a{random.random()}", type=utype, hp=hp, maxHp=hp, attack=atk,
                cd=b['cd'], at=0, rng=b['rng'], spd=b['spd'], splash=b.get('splash', 0.0),
                x=origin['x'], y=origin['y'], path=None, ptimer=0, ptid=None)

def moveToward(actor, tx, ty, dt):
    dx=tx-actor['x']; dy=ty-actor['y']; d=math.hypot(dx,dy)
    if d<=0.001: return
    step=min(d, actor['spd']*dt)
    actor['x']+=dx/d*step; actor['y']+=dy/d*step

def nearest(src, items):
    best=None; bd=1e18
    for it in items:
        d=dist(src,it)
        if d<bd: best=it; bd=d
    return (best,bd) if best else None

def tick_boss_mechanic(e, dt, enemies, allies, buildings, wave_num, rng):
    """Port of fortressBattleSystem.tickBossMechanic. Aura ticks once/sec; summon spawns on interval.
    Breach is handled inline at the attack site (multiplier vs buildings)."""
    m = e.get('mechanic')
    if not m or e['hp'] <= 0:
        return
    kind = m.get("kind")
    if kind == "aura":
        e['auraTimer'] = e.get('auraTimer', 0) + dt
        if e['auraTimer'] < 1:
            return
        e['auraTimer'] -= 1
        dmg = m.get("damagePerSecond", 0)
        rad = m.get("radius", 0)
        for a in allies:
            if a['hp'] <= 0:
                continue
            if math.hypot(a['x']-e['x'], a['y']-e['y']) <= rad:
                a['hp'] = max(0, a['hp'] - dmg)
        for b in buildings:
            if b.hp <= 0:
                continue
            if edge_dist(e, b) <= rad:
                b.hp = max(0, b.hp - dmg)
    elif kind == "summon":
        e['summonTimer'] = e.get('summonTimer', m.get("intervalSeconds", 6)) - dt
        if e['summonTimer'] <= 0:
            spawn = make_enemy(wave_num, rng, m.get("archetype", "grunt"))
            spawn['x'] = e['x'] + 0.4
            spawn['y'] = e['y'] + 0.2
            enemies.append(spawn)
            e['summonTimer'] = m.get("intervalSeconds", 6)

def follow_path(a, dt):
    if not a['path']: return False
    wp=a['path'][0]
    moveToward(a, wp[0], wp[1], dt)
    if math.hypot(a['x']-wp[0], a['y']-wp[1])<=WAYPOINT_ARRIVAL:
        a['path'].pop(0)
    return True

def simulate(buildings, wave_num, rng, max_time=90.0, dt=0.1, damage_mult=1.0, defense_mult=1.0):
    """buildings: list of Building. Returns dict result.

    damage_mult scales ally/turret/projectile damage (temp War Drums card + Skirmisher capstone).
    defense_mult divides incoming enemy damage (temp Shield Wall card). Both default 1.0."""
    wave=WAVES[wave_num-1]
    enemies=[]; allies=[]; projectiles=[]
    # Attrition: if a building carries a damageFloor (from prior defeats), it starts the wave
    # at hp = maxHp × max(0, postDefeatHpFraction − damageFloor). Otherwise full HP. Matches
    # fortressBattleSystem.finishBattle('defeat') persisted state applied on next battle start.
    attrition = _BALANCE.get("attrition", {})
    post_defeat = attrition.get("postDefeatHpFraction", 0.4)
    for b in buildings:
        floor = getattr(b, "damageFloor", 0)
        if floor > 0:
            b.hp = max(1, int(b.maxHp * max(0, post_defeat - floor)))
        else:
            b.hp = b.maxHp
        b.cd = 0.5
    # Expand composition into a spawn queue via round-robin interleave — matches
    # fortressBattleSystem.expandComposition exactly (NOT a shuffle). Order is deterministic;
    # per-run variance comes from enemy start-x (rng) and collision jitter.
    groups = [[comp.get("archetype", "grunt"), comp.get("count", 1)] for comp in wave.get("composition", [])]
    spawn_queue = []
    any_remaining = any(g[1] > 0 for g in groups)
    while any_remaining:
        any_remaining = False
        for g in groups:
            if g[1] > 0:
                spawn_queue.append(g[0]); g[1] -= 1
                if g[1] > 0:
                    any_remaining = True
    # Wave-aware time budget: never time out before every enemy has spawned + a combat tail.
    max_time = max(max_time, len(spawn_queue) * wave['spawn'] + 60)
    spawn_idx = 0; spawn_timer = 0.0
    gold=0; killed=0
    t=0.0
    hq=next(b for b in buildings if b.type=='hq')
    while t<max_time:
        t+=dt
        # spawns
        if spawn_idx < len(spawn_queue):
            spawn_timer-=dt
            if spawn_timer<=0:
                archetype = spawn_queue[spawn_idx]
                enemies.append(make_enemy(wave_num, rng, archetype))
                spawn_idx += 1
                spawn_timer = wave['spawn']
        # building actions
        for b in buildings:
            if b.hp<=0: continue
            lv=BUILD[b.type]['levels'][b.level-1]
            c=b.center()
            if 'unit' in lv:
                b.cd-=dt
                if b.cd<=0:
                    allies.append(make_ally(lv['unit'], {'x':c['x'],'y':max(0,c['y']-0.65)}, b.level))
                    b.cd=lv['cd']
            if b.type=='turret' and 'damage' in lv:
                b.cd-=dt
                if b.cd<=0:
                    live=[e for e in enemies if e['hp']>0]
                    n=nearest(c, live)
                    if n and n[1]<=lv.get('range', 3.2):     # data-driven, tier-scaled turret range
                        projectiles.append(dict(tid=n[0]['id'], dmg=lv['damage'], x=c['x'],y=c['y'],spd=5.5,done=False,target=n[0]))
                        b.cd=lv['cd']
        # enemies
        for e in enemies:
            if e['hp']<=0: e['path']=None; continue
            live_allies=[a for a in allies if a['hp']>0]
            at=nearest(e, live_allies)
            if at and at[1]<=e['rng']+0.12:
                e['at']-=dt
                if e['at']<=0:
                    at[0]['hp']=max(0,at[0]['hp']-e['attack']/defense_mult); e['at']=e['cd']
                continue
            # trap mines
            for b in buildings:
                if b.type!='mine' or b.hp<=0: continue
                lv=BUILD['mine']['levels'][b.level-1]
                if edge_dist(e,b)<=0.55:
                    hurt_enemy(e, lv['damage']*damage_mult); b.hp=0
            attackable=[b for b in buildings if b.hp>0 and b.type!='mine']
            bestb=None; bestd=1e9
            for b in attackable:
                d=edge_dist(e,b)
                if d<bestd: bestd=d; bestb=b
            if not bestb: e['path']=None; e['ctid']=None; continue
            e['ctid']=bestb.id
            if bestd<=0.7:
                e['path']=None
                e['at']-=dt
                if e['at']<=0:
                    # Breacher multiplies damage vs buildings (matches inline breachMult in fortressBattleSystem.tickEnemies).
                    mech = e.get('mechanic')
                    breach_mult = mech.get("damageMultVsBuildings", 1) if mech and mech.get("kind") == "breach" else 1
                    bestb.hp=max(0,bestb.hp-e['attack']*breach_mult/defense_mult); e['at']=e['cd']
                continue
            # path
            e['ptimer']-=dt
            need = (not e['path']) or e['ptimer']<=0 or e['ptid']!=e['ctid']
            if need:
                blocked=blocked_set(buildings, bestb.id)
                start=(min(max(round(e['x']),0),W-1), min(max(round(e['y']),0),H-1))
                gt=goal_tile(bestb)
                tp=astar(start, gt, blocked)
                if tp:
                    e['path']=[(tx+0.5,ty+0.5) for tx,ty in tp[1:]]
                    e['ptid']=e['ctid']; e['ptimer']=REPATH
                else:
                    e['path']=None; e['ptid']=e['ctid']
            if not follow_path(e, dt):
                # fallback straight line
                ct=min(bestb.tiles, key=lambda tt: math.hypot(e['x']-(tt[0]+0.5),e['y']-(tt[1]+0.5)))
                moveToward(e, ct[0]+0.5, ct[1]+0.5, dt)
        # allies
        for a in allies:
            if a['hp']<=0: continue
            live=[e for e in enemies if e['hp']>0]
            tgt=nearest(a, live)
            if not tgt: a['path']=None; a['ptid']=None; continue
            if tgt[1]>a['rng']:
                # path
                a['ptimer']-=dt
                start=(min(max(math.floor(a['x']),0),W-1), min(max(math.floor(a['y']),0),H-1))
                curb=building_at_tile(buildings, start)
                need=(not a['path']) or a['ptimer']<=0 or a['ptid']!=tgt[0]['id']
                if need:
                    blocked=blocked_set(buildings, curb.id if curb else None)
                    gt=(min(max(math.floor(tgt[0]['x']),0),W-1), min(max(math.floor(tgt[0]['y']),0),H-1))
                    tp=astar(start, gt, blocked)
                    if tp:
                        a['path']=[(tx+0.5,ty+0.5) for tx,ty in tp[1:]]; a['ptid']=tgt[0]['id']; a['ptimer']=REPATH
                    else:
                        a['path']=None; a['ptid']=tgt[0]['id']
                if not follow_path(a, dt):
                    moveToward(a, tgt[0]['x'], tgt[0]['y'], dt)
                continue
            a['path']=None
            a['at']-=dt
            if a['at']<=0:
                if a['rng']>0.8:
                    projectiles.append(dict(tid=tgt[0]['id'],dmg=a['attack'],x=a['x'],y=a['y'],spd=5.5,
                                            done=False,target=tgt[0],splash=a.get('splash',0.0)))
                else:
                    hurt_enemy(tgt[0], a['attack']*damage_mult)
                a['at']=a['cd']
        # boss mechanics (aura / summon). Breach is handled inline in the enemy attack branch.
        for e in enemies:
            tick_boss_mechanic(e, dt, enemies, allies, buildings, wave_num, rng)
        # projectiles
        for p in projectiles:
            tg=p['target']
            if tg['hp']<=0: p['done']=True; continue
            if dist(p,tg)<=0.14:
                dmg=p['dmg']*damage_mult
                splash=p.get('splash',0.0)
                if splash>0:
                    # AoE: every live enemy within splash of impact takes the hit (armor applies per enemy).
                    for e in enemies:
                        if e['hp']>0 and math.hypot(e['x']-tg['x'], e['y']-tg['y'])<=splash:
                            hurt_enemy(e, dmg)
                else:
                    hurt_enemy(tg, dmg)
                p['done']=True; continue
            moveToward(p, tg['x'], tg['y'], dt)
        projectiles=[p for p in projectiles if not p['done']]
        # collisions
        actors=[e for e in enemies if e['hp']>0]+[a for a in allies if a['hp']>0]
        md=COLL_R*2
        for i in range(len(actors)):
            for j in range(i+1,len(actors)):
                A=actors[i]; B=actors[j]
                dx=B['x']-A['x']; dy=B['y']-A['y']; d=math.hypot(dx,dy)
                if d>=md: continue
                if d<0.0001: B['x']+=0.02; continue
                ov=md-d; pu=ov/2*PUSH; nx=dx/d; ny=dy/d
                A['x']-=nx*pu; A['y']-=ny*pu; B['x']+=nx*pu; B['y']+=ny*pu
        for a in actors: a['x']=min(max(a['x'],-0.4),W-0.6)
        # kill gold + cleanup
        for e in enemies:
            if e['hp']<=0:
                gold+=wave['killGold']; killed+=1
        before=len(enemies)
        enemies=[e for e in enemies if e['hp']>0]
        allies=[a for a in allies if a['hp']>0]
        # end conditions
        if hq.hp<=0:
            return dict(result='defeat', time=t, gold=gold, killed=killed, hq=0,
                        allies_alive=len(allies), bld_loss=building_loss_fraction(buildings))
        if spawn_idx>=len(spawn_queue) and len(enemies)==0:
            gold+=wave['victoryGold']
            return dict(result='victory', time=t, gold=gold, killed=killed, hq=hq.hp,
                        allies_alive=len(allies), bld_loss=building_loss_fraction(buildings))
    # timeout -> treat as stalemate (enemies remain). Count as defeat-ish.
    return dict(result='timeout', time=t, gold=gold, killed=killed, hq=hq.hp,
                allies_alive=len([a for a in allies if a['hp']>0]),
                enemies_left=len([e for e in enemies if e['hp']>0]),
                bld_loss=building_loss_fraction(buildings))

def building_loss_fraction(buildings):
    """Fraction of defensive-building HP lost by battle end (excl. HQ and one-shot mines). This is the
    per-wave REPAIR sink under attrition (victory no longer heals free) — harder waves chew more HP
    -> more repair -> more mining. Mirrors the live repair cost basis (missing HP fraction)."""
    tot = 0.0; lost = 0.0
    for b in buildings:
        if b.type in ('hq', 'mine'):
            continue
        tot += b.maxHp
        lost += max(0, b.maxHp - max(0, b.hp))
    return (lost / tot) if tot > 0 else 0.0

# Boss mechanics implemented above:
# - orcKing aura: tick_boss_mechanic(kind="aura") — 1Hz DPS to allies/buildings in radius.
# - necromancer summon: tick_boss_mechanic(kind="summon") — spawn near boss on interval.
# - breacher: inline in enemy attack branch — attack × damageMultVsBuildings vs buildings.
#
# NOT implemented (deferred until late-game calibration):
# - Building actives (turret overcharge, barracks spawnSquad, archery volley, mageTower frost,
#   wall/bigWall shield). Requires per-building activeCooldown/activeBoost/shieldRemaining state
#   and a firing policy in the sim loop.
# - Building shieldRemaining × shieldReduction on incoming damage. Trigger source is the shield
#   active above — safe to skip while the active is skipped.
# See PARAMS.md → "Аудит sim ↔ игра" → SIM 10 for the queue.
