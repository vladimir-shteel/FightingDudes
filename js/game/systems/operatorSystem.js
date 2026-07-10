import { CONFIG } from "../config.js";
import { removeUnitFromReserve, returnUnitToReserve } from "./reserveSystem.js";
import { removeUnitFromMine } from "./mineSystem.js";
import { getBuildingBaseHp } from "./fortressSystem.js";
import {
  ensureWorkerTraits,
  getCapstoneOperatorBuffMultiplier,
  getCapstoneOperatorNoDelevel,
  getMaxRestCharges,
  trimWorkerTraitsToLevel
} from "./workerTraitSystem.js";

// === Building operator (FMFM vector B core) ===============================================
// One worker can operate a building (exactly one slot per building). While operating it buffs the
// building's HP / damage / summon rate, scaled by the worker's LEVEL (core) and the `maintainer`
// trait, with a modest Rest "prep" bonus on top. If the building is DESTROYED during the wave the
// operator loses a level (an L1 operator is lost entirely) — that attrition is the roster-churn
// engine that keeps the buy/merge/gold loop alive. Tunables live in balance.json > operator.

function operatorConfig() {
  return CONFIG.operator ?? {};
}

// Only some buildings accept an operator (walls/turret/trap mine opt out via `operable: false`).
export function isBuildingOperable(type) {
  return CONFIG.fortressBuildings?.[type]?.operable !== false;
}

function getMaintainerPoints(worker) {
  const traits = ensureWorkerTraits(worker);
  return traits.maintainer ?? 0;
}

// Pure: the multipliers an operator grants its building. Identity ({1,1,1}) when there is no operator.
export function getOperatorBuff(building) {
  const worker = building?.operator ?? null;
  if (!worker) {
    return { hpMult: 1, damageMult: 1, cooldownMult: 1, rested: false };
  }
  const cfg = operatorConfig();
  const level = Math.max(1, worker.level ?? 1);
  const maintainer = getMaintainerPoints(worker);
  const rested = (worker.restCharges ?? 0) > 0;

  const maintainerScale = 1 + (cfg.maintainerPerPoint ?? 0) * maintainer;
  const restScale = rested ? (cfg.restBonusMultiplier ?? 1) : 1;
  const scale = maintainerScale * restScale * getCapstoneOperatorBuffMultiplier(worker);

  const hpFrac = (cfg.hpPerLevel ?? 0) * level * scale;
  const damageFrac = (cfg.damagePerLevel ?? 0) * level * scale;
  const cooldownFrac = Math.min(
    cfg.summonCooldownMaxReduction ?? 0.6,
    (cfg.summonCooldownPerLevel ?? 0) * level * scale
  );

  return {
    hpMult: 1 + hpFrac,
    damageMult: 1 + damageFrac,
    cooldownMult: Math.max(0.1, 1 - cooldownFrac),
    rested
  };
}

function findWorkerAnywhere(state, workerId) {
  const reserved = state.reserveUnits.find((unit) => unit.id === workerId);
  if (reserved) return { source: "reserve" };
  for (const mine of state.mines) {
    if ((mine.workerIds ?? []).some((worker) => worker?.id === workerId)) {
      return { source: "mine" };
    }
  }
  return null;
}

export function assignOperatorToBuilding(state, buildingId, workerId) {
  if (state.fortress.battle.active) {
    return { ok: false, reason: "Cannot reassign operators during battle." };
  }
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building) {
    return { ok: false, reason: "Building not found." };
  }
  if (!isBuildingOperable(building.type)) {
    return { ok: false, reason: `${buildingName(building)} cannot take an operator.` };
  }
  if (building.hp <= 0) {
    return { ok: false, reason: "Repair the building before assigning an operator." };
  }
  if (building.operator) {
    return { ok: false, reason: "This building already has an operator." };
  }
  const located = findWorkerAnywhere(state, workerId);
  if (!located) {
    return { ok: false, reason: "Worker not found." };
  }
  const worker = located.source === "reserve"
    ? removeUnitFromReserve(state, workerId)
    : removeUnitFromMine(state, workerId)?.unit ?? null;
  if (!worker) {
    return { ok: false, reason: "Worker could not be reassigned." };
  }
  building.operator = worker;
  return { ok: true, reason: `${worker.name} now operates the ${buildingName(building)}.` };
}

export function returnOperatorToReserve(state, buildingId) {
  if (state.fortress.battle.active) {
    return { ok: false, reason: "Cannot pull operators during battle." };
  }
  const building = state.fortress.buildings.find((item) => item.id === buildingId);
  if (!building?.operator) {
    return { ok: false, reason: "No operator to return." };
  }
  const worker = building.operator;
  building.operator = null;
  returnUnitToReserve(state, worker);
  return { ok: true, reason: `${worker.name} returned to reserve.` };
}

function buildingName(building) {
  return CONFIG.fortressBuildings[building.type]?.name ?? "building";
}

// Battle start: lock in each operator's buff, spend one Rest charge for the prep bonus, and add the
// operator's HP bonus on top of the building. The bonus is tracked so it can be peeled back off
// maxHp when the battle ends (see resolveOperatorAttrition).
export function applyOperatorPrepAtBattleStart(state) {
  for (const building of state.fortress.buildings) {
    const worker = building.operator;
    if (!worker || building.hp <= 0) {
      building.operatorBuff = { hpMult: 1, damageMult: 1, cooldownMult: 1 };
      building.operatorHpBonus = 0;
      continue;
    }
    const buff = getOperatorBuff(building);
    // Prep bonus is baked into `buff` (rested check above); now actually spend the charge.
    if (buff.rested) {
      worker.restCharges = Math.max(0, (worker.restCharges ?? 0) - 1);
    }
    const bonus = Math.round(getBuildingBaseHp(building) * (buff.hpMult - 1));
    building.operatorHpBonus = bonus;
    building.maxHp += bonus;
    building.hp += bonus;
    building.operatorBuff = { hpMult: buff.hpMult, damageMult: buff.damageMult, cooldownMult: buff.cooldownMult };
  }
}

// Battle end: peel the temporary operator HP bonus back off maxHp, then apply attrition. MUST run
// BEFORE finishBattle's maxHp-based HP restore so the restore uses the true (un-buffed) maxHp.
export function resolveOperatorAttrition(state) {
  const messages = [];
  for (const building of state.fortress.buildings) {
    const bonus = building.operatorHpBonus ?? 0;
    if (bonus > 0) {
      building.maxHp = Math.max(1, building.maxHp - bonus);
      building.hp = Math.min(building.hp, building.maxHp);
      building.operatorHpBonus = 0;
    }
    building.operatorBuff = { hpMult: 1, damageMult: 1, cooldownMult: 1 };

    const worker = building.operator;
    if (!worker) continue;

    const destroyed = building.hp <= 0;
    if (destroyed && getCapstoneOperatorNoDelevel(worker)) {
      // Steadfast: the operator holds its level even as the building falls.
      messages.push(`${worker.name} held the line (Steadfast) as the ${buildingName(building)} fell.`);
    } else if (destroyed) {
      const newLevel = (worker.level ?? 1) - 1;
      if (newLevel < 1) {
        // L1 operator is lost entirely — this is the bottom-of-the-loop churn: buy a fresh worker.
        building.operator = null;
        messages.push(`${worker.name} was lost defending the ${buildingName(building)}.`);
      } else {
        worker.level = newLevel;
        worker.restCharges = Math.min(getMaxRestCharges(newLevel), worker.restCharges ?? 0);
        // Losing a level must also shed trait points so a downgraded worker isn't over-powered.
        trimWorkerTraitsToLevel(worker);
        messages.push(`${worker.name} dropped to level ${newLevel} when the ${buildingName(building)} fell.`);
      }
    } else {
      // Survived: the operator rests up between waves (it is parked, not mining).
      worker.restCharges = Math.min(getMaxRestCharges(worker.level ?? 1), (worker.restCharges ?? 0) + 1);
    }
  }
  return messages;
}
