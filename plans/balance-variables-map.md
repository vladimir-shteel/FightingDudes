# Balance Variables Map — Fortress Mode

**Purpose.** A complete inventory of *every* variable that moves the balance, where it lives, what it
controls, and how it couples to the rest. Built 2026-07-07 after a session that kept discovering
knobs and interactions we'd missed at the start. Read this before tuning so you don't (a) rebuild
context from zero, (b) tune one number blind to its couplings, or (c) trust a sim that silently
ignores half the sinks.

**Status legend for sim coverage:** ✅ modelled in `tools/balance-sim/calibrate.py` · 🟡 approximated ·
❌ not modelled · 💤 present but disabled (value 0).

> ⚠️ Numbers below are the **structure + current-as-of-this-session values**. Several are actively
> being calibrated (production curve, building costs, enemy scaling). Treat the *variable list and
> couplings* as durable; treat *specific numbers* as in-flux. Final numbers live in `data/*.json`.

---

## 1. Mental model — two currency loops, many sinks

```
   BATTLE ──win──▶ GOLD ──buy/merge──▶ WORKERS ─┐
     ▲   \                                      │
     │    \─shift haul (×2-5 during battle)   mine
  defends                                       ▼
  fortress ◀─build/upgrade/repair── RESOURCES ◀─┘
                    │  (wood/ore/iron/crystal)
                    └── also drained by: repair, building actives, mine/slot unlocks(gold), reward cards
```

- **Gold** ← battle only (victoryGold + killGold + early-start bonus) + Golden-trait trickle + reward
  cards. Gold → workers (buy + implicit via merge), mine unlock, slot unlock, active costs are *resources* not gold.
- **Resources** (wood/ore/iron/crystal) ← mines only. Resources → build + merge-upgrade + **repair** +
  **building actives** + obstacle removal. **Resources have NO other source** → total production must
  ≈ total of ALL these sinks, not just building cost. (This was the #1 thing the sim missed.)
- The two loops gate each other: no battle → no gold → no workers → no resources → no defense → lose.

---

## 2. Full variable inventory

### A. Global economy — `data/balance.json` (top level)
| Var | Now | Controls | Coupling / notes | Sim |
|---|---|---|---|---|
| `tickRateMs` | 100 | sim step | not a balance knob | — |
| `startingGold` | 90 | opening workers | too low → slow start stall; buys ~first workers | ✅ |
| `startingResources` {wood,ore} | 110/60 | opening builds | buffers wave-1 building cost | ✅ |
| `startingOre` | 0 | legacy override | dead (0) | 💤 |
| `passiveGoldPerSecond` | 0 | flat gold trickle | disabled lever; Golden capstone revives it | 💤 |
| `passiveGoldPerSecondPerUnlockedMine` | 0 | gold from mines | **deferred, kept as knob** | 💤 |
| `unitBuyBaseCost` | 5 | worker price base | `cost=floor(base×exp^E)` | ✅ |
| `unitBuyExponent` | 1.05 | roster soft-cap | **E=Σ2^(lvl-1)**; merge does NOT lower E → caps total labour ~8-10 workers; higher exp = smaller roster = less production | ✅ |
| `productionMultipliers.rest` | 1 | idle mining | trivial | ✅ |
| `productionMultipliers.battle` | 1.5 | mining DURING battle | base for shift; battle-time haul earmarked for repair/actives | 🟡 (prep only) |
| `merge.maxLevel` | 5 | worker + (nominally) building cap | **building cap is really data-driven (levels.length), NOT this** | ✅ workers |
| `goldIcon` | 🪙 | cosmetic | — | — |

### B. Worker purchase / roster — `reserveSystem.js` + balance
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| buy cost formula | `floor(5×1.05^E)` | roster size | E=Σ2^(lvl-1) over reserve+mines; **the roster soft-cap that limits total production** | ✅ |
| `economy.workerBuyDiscount` | 1 | reward/temp discount | reward-card lever (unused set) | ❌ |
| `economy.workerStartLevel` | 1 | bought worker level | reward lever | ❌ |
| worker power `2^(lvl-1)` | — | E contribution | merging 2×L_n → 1×L_(n+1) keeps E flat (8+8→16… wait: 2·2^(n-1)=2^n = new; **E unchanged**) → merge = free concentration | ✅ |

### C. Mine production / slots — `data/mine-levels.json`
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| `workerProductionByLevel` | 5/12/28/64/145/320/700 (per 4s) | raw output per worker level | **steep by level = merge payoff on the mining side**; global production magnitude | ✅ |
| `collectionIntervalSeconds` | 4 | payout cadence | divides production | ✅ |
| `levels[].slots` | 1/2/3 | slots per mine level | **SCARCITY FOUNDATION** — few slots forces merge, caps production; too few starves 4 resources vs ~8 workers | ✅ |
| `levels[].slotProductionMultipliers` | [1],[1,1.15],[1,1.15,1.35] | per-slot yield ramp | rewards filling deeper slots | ✅ |
| per-resource `unlockWave` | wood/ore 1, iron 2, crystal 4 | when mine buyable | **resource-introduction cliff** if a building needs the resource before mine ramps | ✅ |
| per-resource `buyCost.gold` | iron 22, crystal 30 | mine unlock price | gold sink | 🟡 |
| `slotUnlockWaves` | wood/ore [1,3,8], iron [2,6,12], crystal [4,10,16] | slot gating | paces production growth | 🟡 |
| `slotBuyCosts.gold` | ~22-110 rising | slot price | gold sink; scarcity via price | 🟡 |
| `baseProductionPerSecond` | 0 | flat mine output | disabled | 💤 |
| `goldPerSecondPerWorkerLevel` | 0 | gold from mining | disabled; Golden trait is the live path | 💤 |

### D. Worker traits + capstones — `balance.workerTraits` + `workerTraitSystem.js`
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| `mergeBonusPoints` | 1 | +pts to dominant line on merge | merge PATH shapes trait vector | ❌ |
| lines.yield.resourceMultiplierPerPoint | 0.06 | +production per Yield pt | compounds with production | 🟡 (approx `1+lvl×0.06`) |
| lines.golden.goldPerResourcePerPoint | 0.006 | production→gold trickle | **the earned gold-from-mining path** | 🟡 (approx) |
| lines.rush.battleMultiplierPerPoint | 0.08 | shift multiplier per Rush pt | feeds battle-shift haul | ❌ |
| lines.*.rollWeight | 1/1/1 | trait roll odds | which line workers tend toward | ❌ |
| capstones (8: yieldMul, demandMul, goldenConversion, passiveGold, rushBonus, battleDamageBonus, foreman, warlord) | see json | end-game worker perks | Golden `midas`/`trickle` = gold; hybrids need 2nd line ≥60% dominant | ❌ |
| capstone pick rule | 2nd≥60%×dominant → hybrid offered | which capstones available | `pickCapstoneCandidates` | ❌ |

### E. Battle shift — `balance.workerTraits.battleShift` + `mineSystem.js`
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| `battleShift.baseMultiplier` | 1.75 | production ×during battle when committed | risk/reward haul; **earmarked for repair/actives** | ❌ |
| `battleShift.maxCommitsPerMine` | 2 | how many workers you can lock | caps haul | ❌ |
| rest/refresh lifecycle | on victory (see [[shift-refresh-on-victory]]) | when rest consumed/granted | committed workers locked mid-battle | ❌ |

### F. Wave demand signal — `waves[].demandResource` + `balance.waveDemand`
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| `waveDemand.slotProductionMultiplier` | 1.25 | ×production on highlighted mine | **unified demand signal** — each wave one resource is boosted → move best workers there | 🟡 |
| `waves[].demandResource` | per wave (manual) | which resource highlighted | intended to align with the wave's dominant building need; currently NOT auto-linked to archetypes | 🟡 |

### G. Buildings: stats, tiers, merge, costs — `data/fortress-buildings.json` + `fortressSystem.js`
Types: hq, wall, bigWall, barracks, archery, turret, stables, mageTower, mine(trap). Each has:
| Var | Controls | Coupling | Sim |
|---|---|---|---|
| `buyCost` {res} | initial placement price + **merge cost = buyCost×2^(lvl-1)** | THE resource sink; resource MIX drives which mine matters (turret ore/iron, barracks wood/ore, walls wood, mageTower ore/crystal) | ✅ (spine: barracks/turret; now also archery/mage/wall/mine via mixed model) |
| `unlockWave` | when buildable | archery 3, turret 3, stables 4, mageTower 5, mine 3; **must precede the wave that needs it or stall** | ✅ |
| `footprint` | grid tiles | **5×7=35 tiles − HQ(6) = 29 free → hard cap on total defense**; multi-tile spawners compete for space | ✅ (grid packer) |
| `levels[].hp` | building durability | attrition/repair base; walls = pure HP sponge (only matters if it FUNNELS path) | ✅ |
| `levels[].damage` (turret/mine) | point DPS | turret dps ~×2/level = merge payoff | ✅ |
| `levels[].cooldownSeconds` (turret + spawners) | fire/spawn rate | spawner throughput = **dominant DPS source** (2 spawners flip a wave 5%→100%) | ✅ |
| `levels[].unit` (spawners) | which ally spawned | barracks=warrior, archery=archer, stables=rider, mageTower=mage | ✅ |
| `levels[].upgradeCost` | **reward-card free-upgrade path ONLY** (not main loop) | main upgrade = merge | ❌ |
| # of levels (currently 5) | **real building max tier** (`definition.levels.length`) | merge beyond top = no-op; `merge.maxLevel=5` is NOT the gate | ✅ |
| merge-to-upgrade | 2×same type+level → 1×next, damageFloor→0 | main upgrade verb; costs a whole 2nd building | ✅ (tier-cap by wave) |

### H. Building actives — `levels[top].active` + `triggerBuildingActive`
| Var | Controls | Coupling | Sim |
|---|---|---|---|
| active on **top level only** | `getActiveAbility` reads `levels[len-1].active` → endgame-gated | moving to L5 = actives now need 16 base copies (much rarer than old L3) | 🟡 (small burn est) |
| `active.cost` {res} | per-use resource burn | **per-battle sink, scales w/ battle length & count** | 🟡 |
| `active.cooldownSeconds` | uses/battle | ~1-3 per battle | ❌ |
| effects: overcharge (turret ×2.5 dmg 6s), spawnSquad (barracks/stables), volley (archery), frost (mage slow), shield (wall dmg-reduction) | combat swing | opt-in, not required to win | ❌ (effects) |

### I. Attrition + repair — `balance.attrition` + fortressSystem/battleSystem
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| `floorPerDefeat` | 0.2 | permanent HP floor per defeat | repeated losses bite cumulatively | 🟡 |
| `postDefeatHpFraction` | 0.4 | HP a destroyed building keeps for next attempt | `hp=maxHp×max(0,0.4−floor)`; 2nd defeat→0 | 🟡 |
| `repairCostPerHpFractionOfBuyCost` | 0.5 | repair price | **FIXED this session**: now `missingFraction×rate×buyCost` (was absolute HP → exploded on high-HP walls). Full destruction ≈ 0.5×buyCost | 🟡 (repair scaled by win%) |
| victory | clears floor, full HP, free | no attrition if you win | ✅ |
| only **destroyed** (hp≤0) buildings take floor | survivors keep HP | placement matters (front dies first) | 🟡 |

### J. Enemies — `data/fortress-enemies.json` + `createFortressEnemy`
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| archetype base {hp,attack,cd,range,speed,tag} | grunt/runner/armored/archerE + bosses | per-type threat | counters intended but combat is DPS-flow dominated | ✅ |
| **wave hp scaling** | `hp + 5(w-1) + 0.35(w-1)²` | tankiness ramp | **TUNED UP this session** (was +3(w-1)) to outscale L5+spawner defense | ✅ synced |
| **wave attack scaling** | `+ (w-1)//2` | enemy DPS ramp | was `//3` | ✅ synced |
| boss `orcKing` aura {radius,dps} | 2.2/6 | AoE on allies+buildings | boss puzzle | ✅ |
| boss `necromancer` summon {archetype,interval} | grunt/6s | adds bodies | ✅ | 
| boss `breacher` {damageMultVsBuildings} | ×3 | shreds buildings | inline in tickEnemies | ✅ |

### K. Waves — `data/fortress-waves.json` (24 waves)
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| count | 24 | run length | boss at 5/10/15/20 | ✅ |
| `enemyCount` | 4→44 | wave size | with hp scaling = total threat | ✅ |
| `spawnIntervalSeconds` | 1.15→0.5 | arrival rate | throughput vs spawner throughput | ✅ |
| `composition` [{archetype,count}] | per wave | archetype mix | intended counters | ✅ |
| `victoryGold` | ~14+4w | gold faucet | roster growth under exp cost | ✅ |
| `killGold` | 1-2 | gold faucet | ×enemyCount | ✅ |
| `startBonusGold` / `startBonusWindowSeconds` | ~½victory / 20s | **early-start melting bonus** | faster next-wave start = more gold; anti-over-prep | ✅ |
| `demandResource` | manual | see F | 🟡 |

### L. Reward draft — `balance.rewardDraft` + `upgradeSystem.js`
Post-victory: 1 card from each of permanent/temporary/oneShot, pick 1.
| Var | Now | Controls | Coupling | Sim |
|---|---|---|---|---|
| permanent.goldGainMultiplier | 1.15 | compounding gold faucet | picks compound → roster/production curve | 🟡 (rotation) |
| permanent.resourceGainMultiplier | 1.15 | compounding production | ✅ affects prod curve | 🟡 |
| permanent.baseHealthBonus | 12 | +HP all buildings (`economy.baseHealthBonus`) | raises attrition/repair base | ❌ |
| temporary.durationWaves | 2 | temp bonus length | queued→begin next wave→decays on victory | 🟡 |
| temporary.productionMultiplier | 1.25 | temp production | stacks on battle mult | 🟡 |
| temporary.damageMultiplier | 1.2 | temp ally damage (`getFortressDamageMultiplier`) | + skirmisher capstone bonus | ❌ |
| temporary.defenseMultiplier | 1.15 | temp incoming-dmg reduction | ❌ |
| oneShot.goldInjection | 180 | burst gold | ❌ |
| oneShot.resourceInjection | 70 | burst each resource | ❌ |
| oneShot cards: worker upgrade / building free-upgrade / free mine slot / supply drop / mass repair | instant effects | **mass repair + free upgrade interact w/ attrition & merge economy** | ❌ |

### M. Ally units — `data/fortress-units.json`
warrior/archer/rider/mage {hp,attack,cooldownSeconds,rangeTiles,speedTilesPerSecond}. Spawned by
buildings; **these decide spawner DPS**. Ranged (archer/mage) vs melee (warrior/rider) roles. Not
independently tuned this session — a lever for rebalancing building roles. ✅ (used by battle_sim)

### N. Combat engine constants — `fortressBattleSystem.js` / `pathfinding.js` / `battle_sim.py`
Grid 5×7, A* pathing, enemy targets NEAREST building (not HQ directly), allies stream from spawners,
collision/push, projectile speed, HQ hp 460. Enemies route to nearest building → **wall placement can
funnel** (but only if it blocks the path). These are structural; rarely tuned but they explain WHY
DPS-flow dominates and why walls' value is placement-dependent. Ported in `battle_sim.py`.

---

## 3. The couplings that bite (non-obvious)

1. **Production magnitude ↔ ALL sinks, not just buildings.** Resources only come from mines and go to
   build + upgrade + **repair + actives + obstacle-removal**. Calibrate total production against the
   *sum of all sinks*. (We first sized only vs building cost → looked like 89% waste.)
2. **Roster soft-cap (exp cost) ↔ # mines that can be staffed.** ~8-10 workers can't fill 4 mines'
   scarce slots → the wave **demand signal** exists precisely so you focus ~1 resource/wave.
3. **Slot scarcity ↔ overproduction ↔ merge pressure.** Too many slots → batteries + flood. Too few →
   can't feed 4 resources + slow opening. Sweet spot: few, expensive, steep per-level.
4. **Building tier count ↔ enemy scaling.** Turret dps ×2/level (merge payoff) means a *maxed* defense
   is very strong → enemies must scale HARD (quadratic-ish) or combat plateaus and the economy goes
   trivial. **Combat difficulty and economy engagement are the SAME dial.**
5. **Spawner throughput ≫ turret point-DPS.** 2 spawner buildings can flip a wave 5%→100%. Turret/
   wall/mine are under-tuned by comparison → building-role balance is a real open task.
6. **Grid capacity (29 tiles) caps the whole late defense.** You cannot field "everything"; multi-tile
   spawners compete with turrets for space.
7. **Resource introduction cliffs.** A building needing iron/crystal the wave its mine opens = stall.
   Unlock mine ≥2 waves before first demand; ramp demand from zero.
8. **Actives moved L3→L5.** Endgame-gated now (16 base copies). Availability of actives dropped a lot.
9. **Repair formula was HP-absolute** (bug) → walls cost absurd amounts. Now fraction-based.
10. **`merge.maxLevel` vs `levels.length`.** Building max tier = data array length, NOT the config
    field. Adding tiers = add level entries (and move `active` to the new top).

---

## 4. Sinks vs faucets ledger

**GOLD faucets:** victoryGold, killGold, startBonusGold, Golden-trait/capstone trickle, reward
(perm gold mult, oneShot injection). **GOLD sinks:** worker buy, mine unlock, slot unlock.

**RESOURCE faucets:** mine production (× yield trait × demand mult × battle/temp mults), reward
(resource mult, injection). **RESOURCE sinks:** building buy, merge-upgrade (2^n×buyCost), **repair**,
**building actives**, obstacle removal.

If any faucet/sink here isn't in the sim, the sim's prep/utilization is off. Current ❌ sinks:
actives (partial), obstacle removal, some reward interactions.

---

## 5. Sim coverage matrix (`tools/balance-sim/`)

| Reliable ✅ | Approximate 🟡 | Blind ❌ |
|---|---|---|
| Combat win% per defense (battle_sim 1:1 port) | trait yield/golden (avg approx) | worker trait VECTORS + capstones |
| Enemy scaling + boss mechanics | wave-demand mult | battle-shift haul (×2-5) |
| Building stats/tiers/merge cost | repair (scaled by win%) | active EFFECTS (only cost est) |
| Grid packing + footprints | reward draft (rotation) | reward stat interactions |
| Roster exp-cost cap | battle-time production | obstacle removal, temp damage/defense mults |
| Mixed defense (spawners+turret+wall+mine+mage) | early-start bonus | placement/pathing nuance (walls funnel) |

**Sim's core blind spot:** it assumes a *reasonable static player*. It cannot see shift risk-taking,
active micro, or exact placement. Use it for **trends and guardrails**, not per-second truth. Final
feel needs playtest.

---

## 6. Session insights / corrections (traps we hit)

- **"Unwinnable wall at wave 15" was FALSE** — an artifact of a too-shallow test ladder. A dense
  grid of L3 turrets cleared wave 24. The real wall is *economic* (can't afford the defense), and
  even that dissolved once combat/economy were recoupled.
- **econ_timing.py understated demand ~12×** (missing COST_SCALE) → its W8 600s stall was largely a
  sim artifact. calibrate.py (coupled) supersedes it.
- **The sim only modelled barracks+turret** for most of the session → ignored spawner dominance, the
  wood sink (walls), the crystal sink (mage/mines). Fixed with the mixed-defense grid model.
- **Combat-easy ⇒ economy-trivial.** After L5 tiers made defense strong, a cheap spawner defense
  coasted the game → had to steepen enemy scaling. The economy only engages when combat demands it.

---

## 7. Open questions / what we might still be missing

- [ ] **Building-role balance.** Spawners dominate; turrets/walls/mines/stables/mageTower need
      distinct, viable roles vs archetypes (anti-armor, funnel, boss-burst, anti-air). Combat-design
      task, not just numbers.
- [ ] **Archetype counters actually matter?** Do runner/armored/archerE/boss create real tactical
      choices, or does raw DPS-flow wash them out? (Sim suggests the latter.)
- [ ] **Actives at L5 too rare?** 16 base copies to unlock an active may make them dead content again.
      Reconsider gating (L4? separate unlock?).
- [ ] **Battle-shift haul math.** ×2-5 production during battle is a big untracked faucet earmarked
      for repair/actives. Model it, or the resource economy is under-counted.
- [ ] **Capstone build diversity.** Are the 8 capstones meaningfully different builds or cosmetic?
- [ ] **Reward-draft power budget.** Compounding perms (gold/production ×1.15) over 24 waves is large;
      is it accounted for in the target curve?
- [ ] **demandResource ↔ archetype link** still manual. Auto-linking would tie the mining and combat
      layers.
- [ ] **Gold sinks thin.** Gold → workers/slots only. Once roster caps, is gold wasted late-game?
- [ ] **Obstacle removal cost** (`removeFortressObstacle`) — a resource sink not inventoried in data;
      verify its numbers.
- [ ] **Merge-path trait steering** — does the "path matters" promise hold, or do most builds
      converge? Untested.

---

**Related:** [[fortress-balance-analysis]] · [[shift-refresh-on-victory]] · design intent in
`plans/balance-and-systems-redesign.md` · calibration oracle `tools/balance-sim/calibrate.py` ·
run knobs `tools/balance-sim/PARAMS.md`.
