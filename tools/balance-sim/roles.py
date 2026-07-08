"""RPS / risk-band harness — does combat reward the right MIX, or just raw DPS?

Runs a matrix of canonical DEFENSE BUILDS x canonical WAVE TYPES and prints the win% surface.
The design goal is a 2-D surface: no build wins every column, each wave-type has a clear best
answer, and the WRONG build for a wave clearly loses. A 1-D surface (one build wins everything)
means combat is a flat DPS threshold — the binary-combat problem.

All builds are packed onto the real 5x7 grid (minus HQ) at a fixed tier, all waves scale to the
same reference wave so builds are comparable. Reads everything from data/*.json via battle_sim +
calibrate (so armor/splash added there show up here automatically).

Run: python roles.py            (default reference wave 12, L3 builds)
     python roles.py 16 4        (reference wave 16, L4 builds)
"""
import sys, random, statistics
import battle_sim as B
from battle_sim import Building, simulate, WAVES
from calibrate import pack, TOP

SCALE_WAVE = int(sys.argv[1]) if len(sys.argv) > 1 else 12   # enemy stat-scaling reference
TIER       = int(sys.argv[2]) if len(sys.argv) > 2 else 3    # building tier for every build
SPAWN      = 0.7                                             # fixed arrival cadence for fairness
SEEDS      = 24

# Canonical wave archetypes — each isolates one threat axis (as a real, threatening wave), plus a
# mixed wave and a boss wave. Sized to pressure a single-axis build off its counter.
WAVE_TYPES = {
    "swarm":    [{"archetype": "grunt", "count": 22}, {"archetype": "runner", "count": 14}],
    "armored":  [{"archetype": "armored", "count": 9}, {"archetype": "grunt", "count": 3}],
    "skirmish": [{"archetype": "archerE", "count": 14}, {"archetype": "grunt", "count": 5}],
    "mixed":    [{"archetype": "grunt", "count": 12}, {"archetype": "runner", "count": 5},
                 {"archetype": "armored", "count": 4}, {"archetype": "archerE", "count": 3}],
    "boss":     [{"archetype": "breacher", "count": 1}, {"archetype": "armored", "count": 3},
                 {"archetype": "grunt", "count": 8}],
}

# Canonical defense builds — realistic front(walls/bodies)+backline, each LEANING on one role, at a
# comparable footprint. RPS lives in "which backline you put behind your front": burst vs armor/boss,
# AoE vs swarm, range vs skirmishers. Packed front-to-back on the 5x7 grid (minus HQ).
BUILD_SHOPPING = {
    "burst":    [("bigWall", 2), ("turret", 4), ("mine", 2)],        # anti-armor / boss (big hits)
    "aoe":      [("bigWall", 2), ("mageTower", 3), ("barracks", 1)],  # anti-swarm (splash)
    "bodies":   [("barracks", 3), ("stables", 1), ("archery", 2)],   # anti-swarm (wall of meat)
    "range":    [("wall", 2), ("archery", 3), ("turret", 2)],        # anti-skirmish / reach
    "balanced": [("bigWall", 1), ("turret", 2), ("mageTower", 1), ("barracks", 1), ("mine", 1)],
}


def build_specs(shopping):
    levels = {t: min(TIER, TOP[t]) for t in TOP}
    return pack(shopping, levels)


def run_case(specs, comp, seeds=SEEDS):
    """Win% of a build vs a synthetic composition, scaled to SCALE_WAVE."""
    saved = WAVES[SCALE_WAVE - 1]
    WAVES[SCALE_WAVE - 1] = dict(saved)
    WAVES[SCALE_WAVE - 1]["composition"] = comp
    WAVES[SCALE_WAVE - 1]["enemyCount"] = sum(c["count"] for c in comp)
    WAVES[SCALE_WAVE - 1]["spawn"] = SPAWN
    try:
        wins = 0
        for s in range(seeds):
            bs = [Building("hq", 1, (1, 5))] + [Building(t, l, o) for t, l, o in specs]
            if simulate(bs, SCALE_WAVE, random.Random(s * 13 + 7))["result"] == "victory":
                wins += 1
        return wins / seeds
    finally:
        WAVES[SCALE_WAVE - 1] = saved


def main():
    builds = {name: build_specs(sh) for name, sh in BUILD_SHOPPING.items()}
    cols = list(WAVE_TYPES)
    print(f"Reference wave {SCALE_WAVE} (enemy scaling), all builds tier L{TIER}, spawn {SPAWN}s, "
          f"{SEEDS} seeds.\n")
    # report how many tiles / buildings each build actually placed (grid capacity check)
    for name, specs in builds.items():
        counts = {}
        for t, _, _ in specs:
            counts[t] = counts.get(t, 0) + 1
        print(f"  {name:>8}: {', '.join(f'{c}x{t}' for t, c in counts.items())}")
    print()
    header = f"{'build':>8} | " + " ".join(f"{c:>8}" for c in cols) + " |   spread"
    print(header)
    print("-" * len(header))
    surface = {}
    for name, specs in builds.items():
        row = {c: run_case(specs, WAVE_TYPES[c]) for c in cols}
        surface[name] = row
        vals = list(row.values())
        spread = max(vals) - min(vals)
        cells = " ".join(f"{row[c]*100:>7.0f}%" for c in cols)
        print(f"{name:>8} | {cells} | {spread*100:>6.0f}%")
    print("-" * len(header))
    # per-column best build (the intended counter) and how dominated it is
    print("\nPer-wave best answer (counter) and worst (mis-build):")
    for c in cols:
        ranked = sorted(surface.items(), key=lambda kv: -kv[1][c])
        best_n, best_v = ranked[0][0], ranked[0][1][c]
        worst_n, worst_v = ranked[-1][0], ranked[-1][1][c]
        print(f"  {c:>8}: best {best_n:>8} {best_v*100:>3.0f}%  |  worst {worst_n:>8} {worst_v*100:>3.0f}%"
              f"   (gap {(best_v-worst_v)*100:>3.0f}%)")
    # RPS verdict: is there a build that wins everything? is the surface flat?
    print("\nVerdict:")
    for name, row in surface.items():
        if min(row.values()) >= 0.8:
            print(f"  ! {name} wins ALL wave types (>=80%) -> still 1-D DPS (no RPS pressure)")
    avg_spread = statistics.mean(max(r.values()) - min(r.values()) for r in surface.values())
    band_cells = sum(1 for r in surface.values() for v in r.values() if 0.25 <= v <= 0.85)
    total = len(surface) * len(cols)
    print(f"  avg per-build spread across wave-types: {avg_spread*100:.0f}%  "
          f"(higher = builds specialize)")
    print(f"  cells in contested 25-85% band: {band_cells}/{total}  "
          f"(higher = more 'right mix matters' pressure)")


if __name__ == "__main__":
    main()
