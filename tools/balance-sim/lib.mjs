// Balance simulation library — mirrors the formulas in js/game exactly (config.json + systems).
// All numbers come from data/config.json and the system code as of codex/fmfm-realtime.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const CONFIG = JSON.parse(readFileSync(join(here, "..", "..", "data", "config.json"), "utf8"));

// ---------- field ----------
export const FIELD_W = 9;
export const FIELD_H = 7;

// ---------- resources ----------
export function canAfford(res, cost = {}) {
  return Object.entries(cost).every(([k, v]) => v <= 0 || (res[k] ?? 0) >= v);
}
export function spend(res, cost = {}) {
  if (!canAfford(res, cost)) return false;
  for (const [k, v] of Object.entries(cost)) res[k] = Math.max(0, (res[k] ?? 0) - v);
  return true;
}

// ---------- enemy scaling (fortressBattleSystem.createFortressEnemy) ----------
export function makeEnemyStats(archetype, waveNumber) {
  const base = CONFIG.fortressEnemies[archetype];
  const w = Math.max(0, waveNumber - 1);
  const c = CONFIG.combat;
  const hp = Math.round(base.hp * Math.pow(1 + c.hpScalePerWave, w));
  const baseArmor = base.armor ?? 0;
  const armor = baseArmor > 0 ? Math.round(baseArmor * Math.pow(1 + c.armorScalePerWave, w)) : 0;
  return {
    archetype,
    tag: base.tag,
    hp, maxHp: hp, armor,
    attack: Math.round(base.attack * Math.pow(1 + c.attackScalePerWave, w)),
    cooldownSeconds: base.cooldownSeconds,
    range: base.rangeTiles,
    speed: base.speedTilesPerSecond,
    mechanic: base.mechanic ?? null,
  };
}

// ---------- ally scaling (createFortressAlly) ----------
export function makeAllyStats(unitType, buildingLevel) {
  const base = CONFIG.fortressUnits[unitType];
  const c = CONFIG.combat;
  return {
    type: unitType,
    hp: Math.round(base.hp * (1 + c.unitHpPerLevel * (buildingLevel - 1))),
    attack: base.attack * (1 + c.unitAttackPerLevel * (buildingLevel - 1)),
    cooldownSeconds: base.cooldownSeconds,
    range: base.rangeTiles,
    speed: base.speedTilesPerSecond,
    splashRadius: base.splashRadius ?? 0,
  };
}

// ---------- building costs ----------
function costEntries(costs = {}) {
  return Object.entries(costs).filter(([, v]) => v > 0);
}
export function buildingBuyCost(roster, type) {
  const def = CONFIG.fortressBuildings[type];
  const esc = CONFIG.buildingCostEscalation ?? {};
  const factor = esc[type] ?? esc.default ?? 1;
  const typePower = roster.filter((b) => b.type === type).reduce((s, b) => s + 2 ** (b.level - 1), 0);
  const escalation = Math.pow(factor, typePower);
  return Object.fromEntries(costEntries(def.buyCost ?? {}).map(([k, v]) => [k, Math.max(1, Math.floor(v * escalation))]));
}
export function buildingUpgradeCost(b) {
  return CONFIG.fortressBuildings[b.type].levels[b.level - 1].upgradeCost ?? null;
}
export function buildingMaxHp(b) {
  return CONFIG.fortressBuildings[b.type].levels[b.level - 1].hp;
}
export function buildingRepairCost(b) {
  const missing = buildingMaxHp(b) - b.hp;
  if (missing <= 0) return {};
  const missingFraction = Math.min(1, missing / Math.max(1, buildingMaxHp(b)));
  const rate = CONFIG.attrition?.repairCostPerHpFractionOfBuyCost ?? 1;
  const levelMult = b.level;
  const buyCost = costEntries(CONFIG.fortressBuildings[b.type].buyCost ?? {});
  if (buyCost.length === 0) {
    const perLevel = CONFIG.fortress?.repairFallbackWoodPerLevel ?? 20;
    return { wood: Math.max(1, Math.ceil(missingFraction * perLevel * levelMult)) };
  }
  return Object.fromEntries(buyCost.map(([k, v]) => [k, Math.max(1, Math.ceil(missingFraction * rate * v * levelMult))]));
}
export function mergeCrystalCost(type, targetLevel) {
  if (!CONFIG.fortressBuildings[type]?.crystalMergeGated) return 0;
  return CONFIG.merge?.crystalCostByLevel?.[String(targetLevel)] ?? 0;
}

// ---------- workers ----------
export function workerBuyCost(power) {
  return Math.max(1, Math.floor(CONFIG.unitBuyBaseCost * (CONFIG.unitBuyExponent ** power)));
}
export function maxWorkerLevel(waveNumber) {
  const waves = CONFIG.merge.workerLevelUnlockWaves;
  let cap = 1;
  for (let i = 0; i < waves.length; i++) if (waveNumber >= (waves[i] ?? 1)) cap = i + 1;
  return Math.min(CONFIG.merge.maxLevel, cap);
}

// ---------- mines ----------
// Mirrors createMine: slot count = slotUnlockWaves.length; syncMineUnlocks auto-opens
// mines/slots once waveNumber reaches their unlock wave.
export function mineSlots(resourceKey) {
  return CONFIG.mine.resourceTypes.find((r) => r.key === resourceKey).slotUnlockWaves.length;
}
export function slotsUnlockedAt(resourceKey, waveNumber) {
  const waves = CONFIG.mine.resourceTypes.find((r) => r.key === resourceKey).slotUnlockWaves;
  return waves.filter((w) => waveNumber >= w).length;
}
export function mineUnlockedAt(resourceKey, waveNumber) {
  const t = CONFIG.mine.resourceTypes.find((r) => r.key === resourceKey);
  return t.unlockedByDefault || waveNumber >= t.unlockWave;
}
export function mineSlotMultiplier(resourceKey, slotIndex) {
  // mine.level == highest purchased slot index + 1
  const level = slotIndex + 1;
  return CONFIG.mine.levels[Math.min(level, CONFIG.mine.levels.length) - 1].slotProductionMultipliers[slotIndex] ?? 1;
}
export function workerProduction(level) {
  return CONFIG.mine.workerProductionByLevel[String(level)] ?? 1;
}

// ---------- combat math ----------
export function damageAfterArmor(raw, armor) {
  const minFraction = CONFIG.combat.armorMinFraction ?? 0.15;
  return Math.max(raw * minFraction, raw - armor);
}

// Wave composition expansion (expandComposition: round-robin across groups)
export function expandComposition(wave) {
  const comp = wave.composition ?? [{ archetype: "grunt", count: wave.enemyCount }];
  const groups = comp.map((e) => ({ archetype: e.archetype, remaining: e.count }));
  const queue = [];
  let any = groups.some((g) => g.remaining > 0);
  while (any) {
    any = false;
    for (const g of groups) {
      if (g.remaining > 0) {
        queue.push(g.archetype);
        g.remaining -= 1;
        if (g.remaining > 0) any = true;
      }
    }
  }
  return queue;
}

// ---------- static per-wave pressure table ----------
// Effective EHP of an enemy for an attacker whose per-hit raw damage is `hitSize`.
export function enemyEffectiveHp(stats, hitSize) {
  const eff = Math.max(CONFIG.combat.armorMinFraction, 1 - stats.armor / Math.max(1, hitSize));
  return stats.hp / Math.min(1, eff);
}
export function waveSummary(waveIndex, hitSize = 22) {
  const wave = CONFIG.fortressWaves[waveIndex];
  const waveNumber = waveIndex + 1;
  let ehp = 0, dps = 0, count = 0, ehpRaw = 0;
  const byType = {};
  for (const entry of wave.composition ?? []) {
    const stats = makeEnemyStats(entry.archetype, waveNumber);
    ehp += enemyEffectiveHp(stats, hitSize) * entry.count;
    ehpRaw += stats.hp * entry.count;
    dps += (stats.attack / stats.cooldownSeconds) * entry.count;
    count += entry.count;
    byType[entry.archetype] = (byType[entry.archetype] ?? 0) + entry.count;
  }
  return { wave: waveNumber, count, ehpRaw: Math.round(ehpRaw), ehp: Math.round(ehp), dps: Math.round(dps), byType };
}
