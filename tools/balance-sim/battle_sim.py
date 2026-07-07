"""Faithful port of the FightingDudes fortress battle engine for balance analysis."""
import math, random, heapq

W, H = 5, 7
REPATH = 0.4
WAYPOINT_ARRIVAL = 0.18
COLL_R = 0.18
PUSH = 1.0

# --- config from data/ ---
FUNITS = {
  "warrior": dict(hp=42, attack=8, cd=0.75, rng=0.5, spd=1.45),
  "archer":  dict(hp=24, attack=7, cd=1.2, rng=2.6, spd=1.2),
  "rider":   dict(hp=58, attack=12, cd=1.1, rng=0.45, spd=1.9),
  "mage":    dict(hp=18, attack=10, cd=1.0, rng=2.4, spd=1.15),
  "enemy":   dict(hp=28, attack=10, cd=0.8, rng=0.42, spd=0.95),
}

# building levels: for spawners -> unit+cd ; turret -> damage+cd ; mine -> damage
BUILD = {
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

WAVES = [
  dict(enemyCount=4, spawn=1.15, killGold=3, victoryGold=12),
  dict(enemyCount=6, spawn=1.0, killGold=3, victoryGold=16),
  dict(enemyCount=8, spawn=0.9, killGold=4, victoryGold=22),
  dict(enemyCount=11, spawn=0.8, killGold=4, victoryGold=28),
  dict(enemyCount=14, spawn=0.7, killGold=5, victoryGold=36),
  dict(enemyCount=18, spawn=0.65, killGold=5, victoryGold=48),
  dict(enemyCount=24, spawn=0.55, killGold=6, victoryGold=64),
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

def make_enemy(wave, rng):
    base=FUNITS['enemy']; wb=max(0,wave-1)
    hp=base['hp']+wb*3
    return dict(id=f"e{rng.random()}", hp=hp, maxHp=hp, attack=base['attack']+wb//3,
                cd=base['cd'], at=0, rng=base['rng'], spd=base['spd'],
                x=rng.random()*(W-0.5)+0.25, y=-0.45, path=None, ptimer=0, ptid=None, ctid=None)

def make_ally(utype, origin):
    b=FUNITS[utype]
    return dict(id=f"a{random.random()}", type=utype, hp=b['hp'], maxHp=b['hp'], attack=b['attack'],
                cd=b['cd'], at=0, rng=b['rng'], spd=b['spd'], x=origin['x'], y=origin['y'],
                path=None, ptimer=0, ptid=None)

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

def follow_path(a, dt):
    if not a['path']: return False
    wp=a['path'][0]
    moveToward(a, wp[0], wp[1], dt)
    if math.hypot(a['x']-wp[0], a['y']-wp[1])<=WAYPOINT_ARRIVAL:
        a['path'].pop(0)
    return True

def simulate(buildings, wave_num, rng, max_time=90.0, dt=0.1):
    """buildings: list of Building. Returns dict result."""
    wave=WAVES[wave_num-1]
    enemies=[]; allies=[]; projectiles=[]
    for b in buildings: b.hp=b.maxHp; b.cd=0.5
    to_spawn=wave['enemyCount']; spawn_timer=0.0
    gold=0; killed=0
    t=0.0
    hq=next(b for b in buildings if b.type=='hq')
    while t<max_time:
        t+=dt
        # spawns
        if to_spawn>0:
            spawn_timer-=dt
            if spawn_timer<=0:
                enemies.append(make_enemy(wave_num,rng)); to_spawn-=1; spawn_timer=wave['spawn']
        # building actions
        for b in buildings:
            if b.hp<=0: continue
            lv=BUILD[b.type]['levels'][b.level-1]
            c=b.center()
            if 'unit' in lv:
                b.cd-=dt
                if b.cd<=0:
                    allies.append(make_ally(lv['unit'], {'x':c['x'],'y':max(0,c['y']-0.65)}))
                    b.cd=lv['cd']
            if b.type=='turret' and 'damage' in lv:
                b.cd-=dt
                if b.cd<=0:
                    live=[e for e in enemies if e['hp']>0]
                    n=nearest(c, live)
                    if n and n[1]<=3.2:
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
                    at[0]['hp']=max(0,at[0]['hp']-e['attack']); e['at']=e['cd']
                continue
            # trap mines
            for b in buildings:
                if b.type!='mine' or b.hp<=0: continue
                lv=BUILD['mine']['levels'][b.level-1]
                if edge_dist(e,b)<=0.55:
                    e['hp']-=lv['damage']; b.hp=0
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
                    bestb.hp=max(0,bestb.hp-e['attack']); e['at']=e['cd']
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
                    projectiles.append(dict(tid=tgt[0]['id'],dmg=a['attack'],x=a['x'],y=a['y'],spd=5.5,done=False,target=tgt[0]))
                else:
                    tgt[0]['hp']-=a['attack']
                a['at']=a['cd']
        # projectiles
        for p in projectiles:
            tg=p['target']
            if tg['hp']<=0: p['done']=True; continue
            if dist(p,tg)<=0.14:
                tg['hp']-=p['dmg']; p['done']=True; continue
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
                        allies_alive=len(allies))
        if to_spawn<=0 and len(enemies)==0:
            gold+=wave['victoryGold']
            return dict(result='victory', time=t, gold=gold, killed=killed, hq=hq.hp,
                        allies_alive=len(allies))
    # timeout -> treat as stalemate (enemies remain). Count as defeat-ish.
    return dict(result='timeout', time=t, gold=gold, killed=killed, hq=hq.hp,
                allies_alive=len([a for a in allies if a['hp']>0]),
                enemies_left=len([e for e in enemies if e['hp']>0]))
