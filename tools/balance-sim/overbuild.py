"""Over-build capital-cost ceiling — the sink the coupled sim CANNOT model (it only builds LEAN
min-defense). A real player drowning in resources fills the finite grid and tiers it up; the
level-sum escalation (getFortressBuildingBuyCost) is supposed to cap that. This computes the actual
cumulative resource+crystal cost of a target maxed fortress and compares it to reward-aware lifetime
production, to answer: does the curve out-run income (no faceroll) or not?

Cost model (faithful to fortressSystem.getFortressBuildingBuyCost + mergeFortressBuildings):
  - typePower = Σ 2^(level-1) over placed buildings of a type == cumulative # of L1 BUYS of that type
    (merges conserve power). The k-th L1 buy costs base × factor^(k-1).
  - So resource cost to reach final typePower P for a type = base × Σ_{k=0}^{P-1} factor^k.
  - Merges to L4/L5 additionally cost crystalCostByLevel per created L4/L5 (CRYSTAL_MERGE_TYPES).
"""
import json
from pathlib import Path

data = Path(__file__).parent.parent.parent / "data"
BLD = json.load(open(data / "fortress-buildings.json", encoding="utf-8"))
BAL = json.load(open(data / "balance.json", encoding="utf-8"))
ESC = BAL["buildingCostEscalation"]
CRY = {int(k): v for k, v in BAL["merge"]["crystalCostByLevel"].items()}
# which types drag crystal on their L4/L5 merges (those whose L3->L4 upgradeCost lists crystal)
CRYSTAL_TYPES = {t for t, d in BLD.items()
                 for lv in d.get("levels", []) if "crystal" in (lv.get("upgradeCost") or {})}

def factor(t):
    return ESC.get(t, ESC.get("default", 1))

def type_cost(t, buildings):
    """buildings = list of target levels for this type, e.g. [5,5,4,4]. Returns dict of resource cost."""
    base = BLD[t]["buyCost"]
    P = sum(2 ** (lvl - 1) for lvl in buildings)      # total L1 buys needed
    f = factor(t)
    geom = P if f == 1 else (f ** P - 1) / (f - 1)    # Σ_{k=0}^{P-1} f^k
    cost = {r: amt * geom for r, amt in base.items()}
    # crystal on merges: each building of level L required (L-3) crystal-merge steps if crystal type
    if t in CRYSTAL_TYPES:
        cry = 0
        for lvl in buildings:
            for step in range(4, lvl + 1):            # merges that create an L4, L5, ...
                # number of level-`step` pieces created on the way to one level-`lvl` = 2^(lvl-step)
                cry += CRY.get(step, 0) * (2 ** (lvl - step))
        cost["crystal"] = cost.get("crystal", 0) + cry
    return cost, P

def total(config):
    agg = {}
    detail = []
    for t, lvls in config.items():
        c, P = type_cost(t, lvls)
        detail.append((t, lvls, P, c))
        for r, v in c.items():
            agg[r] = agg.get(r, 0) + v
    return agg, detail

# Tile budget: 5x7=35 - HQ(6) = 29 usable (obstacles removable for trivial gold).
FOOT = {t: len(d["footprint"]) for t, d in BLD.items()}

# Two target endgame fortresses that FIT ~29 tiles:
configs = {
    "MODERATE (2 deep types, mixed)": {
        "turret":   [4, 4, 3, 3],   # 4 tiles
        "barracks": [4, 3],         # 8 tiles
        "archery":  [4],            # 4 tiles
        "mageTower":[4],            # 4 tiles
        "stables":  [3],            # 4 tiles
        "wall":     [3, 3, 3, 2, 2] # 5 tiles  => 29
    },
    "MAXED (everything L4-L5)": {
        "turret":   [5, 5, 4, 4],   # 4 tiles
        "barracks": [4, 4],         # 8 tiles
        "archery":  [4],            # 4
        "mageTower":[4],            # 4
        "stables":  [4],            # 4
        "wall":     [4, 4, 3, 3, 3] # 5  => 29
    },
}

for name, cfg in configs.items():
    tiles = sum(FOOT[t] * len(lvls) for t, lvls in cfg.items())
    agg, detail = total(cfg)
    print(f"\n=== {name}  ({tiles} tiles) ===")
    for t, lvls, P, c in detail:
        cs = ", ".join(f"{r} {v:,.0f}" for r, v in c.items())
        print(f"  {t:9} lv{lvls} (P={P:>2} buys) -> {cs}")
    print(f"  TOTAL: " + ", ".join(f"{r} {v:,.0f}" for r, v in sorted(agg.items())))
    print(f"  SUM resources (excl crystal): {sum(v for r,v in agg.items() if r!='crystal'):,.0f}"
          f" | crystal {agg.get('crystal',0):,.0f}")
