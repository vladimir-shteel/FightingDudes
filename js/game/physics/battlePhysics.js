import * as planck from "https://cdn.jsdelivr.net/npm/planck@1.5.0/+esm";
import { CONFIG } from "../config.js";

const CATEGORY_ALLY = 0x0002;
const CATEGORY_ENEMY = 0x0004;
const CATEGORY_WALL = 0x0008;

let world = null;
let allyBodies = new Map();
let enemyBodies = new Map();
let initializedConfigKey = "";

function getSteeringConfig() {
  return {
    acceleration: CONFIG.battle.steering?.acceleration ?? 30,
    maxForce: CONFIG.battle.steering?.maxForce ?? 42,
    brakeForce: CONFIG.battle.steering?.brakeForce ?? 56,
    baseLinearDamping: CONFIG.battle.steering?.baseLinearDamping ?? 6.8,
    slowRadius: CONFIG.battle.steering?.slowRadius ?? 10,
    stopRadius: CONFIG.battle.steering?.stopRadius ?? 1.15,
    idleBrake: CONFIG.battle.steering?.idleBrake ?? 14,
    fallbackSpeedMultiplier: CONFIG.battle.steering?.fallbackSpeedMultiplier ?? 0.76,
    targetSpeedMultiplier: CONFIG.battle.steering?.targetSpeedMultiplier ?? 1,
    targetOffsetRadius: CONFIG.battle.steering?.targetOffsetRadius ?? 1.6,
    attackStopSlack: CONFIG.battle.steering?.attackStopSlack ?? 0.05,
    combatHoldRadius: CONFIG.battle.steering?.combatHoldRadius ?? 1.8,
    combatApproachForceMultiplier: CONFIG.battle.steering?.combatApproachForceMultiplier ?? 0.3,
    combatLinearDamping: CONFIG.battle.steering?.combatLinearDamping ?? 8.5
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getPhysicsRadius() {
  return Math.max(0.18, CONFIG.battle.physicsRadius ?? CONFIG.battle.unitRadius * 0.1);
}

function getActorPhysicsRadius(actor) {
  return Math.max(0.18, actor.physicsRadius ?? CONFIG.battle.physicsRadius ?? getPhysicsRadius());
}

function getAttackRange(actor) {
  return actor.attackRange ?? ((CONFIG.battle.baseAttackReach ?? 0) + (actor.attackRangeBonus ?? 0));
}

function getTargetVector(fromX, fromY, toX, toY) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy);

  if (distance <= 0.0001) {
    return { dx: 0, dy: 0, distance: 0 };
  }

  return { dx: dx / distance, dy: dy / distance, distance };
}

function getStableRatio(seed) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }

  return (Math.abs(hash) % 1000) / 1000;
}

function buildArena() {
  const arena = world.createBody();

  arena.createFixture({
    shape: planck.Edge(planck.Vec2(0, 0), planck.Vec2(CONFIG.battle.fieldWidth, 0)),
    filterCategoryBits: CATEGORY_WALL,
    filterMaskBits: CATEGORY_ALLY | CATEGORY_ENEMY
  });
  arena.createFixture({
    shape: planck.Edge(
      planck.Vec2(0, CONFIG.battle.fieldHeight),
      planck.Vec2(CONFIG.battle.fieldWidth, CONFIG.battle.fieldHeight)
    ),
    filterCategoryBits: CATEGORY_WALL,
    filterMaskBits: CATEGORY_ALLY | CATEGORY_ENEMY
  });

}

function createUnitBody(unit, kind) {
  const radius = getPhysicsRadius();
  const startX = kind === "ally" ? CONFIG.battle.allySpawnX : CONFIG.battle.enemySpawnX;
  const categoryBits = kind === "ally" ? CATEGORY_ALLY : CATEGORY_ENEMY;
  const teamBits = kind === "ally" ? CATEGORY_ALLY : CATEGORY_ENEMY;
  const maskBits = CATEGORY_WALL | teamBits;

  const body = world.createBody({
    type: "dynamic",
    position: planck.Vec2(
      unit.x ?? startX,
      clamp(unit.y ?? CONFIG.battle.fieldHeight / 2, radius, CONFIG.battle.fieldHeight - radius)
    ),
    fixedRotation: true,
    linearDamping: getSteeringConfig().baseLinearDamping,
    allowSleep: false
  });

  body.createFixture({
    shape: planck.Circle(radius),
    density: 1.35,
    friction: 0.02,
    restitution: 0,
    filterCategoryBits: categoryBits,
    filterMaskBits: maskBits
  });

  body.setUserData({ kind, id: unit.id });
  return body;
}

function syncBodySet(entities, bodyMap, kind) {
  const ids = new Set(entities.map((entity) => entity.id));

  for (const [id, body] of bodyMap.entries()) {
    if (!ids.has(id)) {
      world.destroyBody(body);
      bodyMap.delete(id);
    }
  }

  for (const entity of entities) {
    if (!bodyMap.has(entity.id)) {
      bodyMap.set(entity.id, createUnitBody(entity, kind));
    }
  }
}

function syncPhysicsEntities(state) {
  syncBodySet(state.battleUnits, allyBodies, "ally");
  syncBodySet(state.enemies, enemyBodies, "enemy");
}

function getDesiredTargetPoint(actor, target) {
  if (!target) {
    return null;
  }

  const steering = getSteeringConfig();
  const targetX = target.x ?? CONFIG.battle.castleX;
  const targetY = target.y ?? CONFIG.battle.castleY;
  const hasEntityTarget = Boolean(target.id);

  if (hasEntityTarget && steering.targetOffsetRadius > 0) {
    const ratio = getStableRatio(`${actor.id}:${target.id}`);
    const angle = ratio * Math.PI * 2;
    return {
      x: targetX + Math.cos(angle) * steering.targetOffsetRadius,
      y: targetY + Math.sin(angle) * steering.targetOffsetRadius
    };
  }

  return {
    x: targetX,
    y: targetY
  };
}

function driveActorBody(body, actor, target, fallbackPoint) {
  if (!body) {
    return;
  }

  const position = body.getPosition();
  const velocity = body.getLinearVelocity();
  const steering = getSteeringConfig();
  const radius = getPhysicsRadius();
  const point = getDesiredTargetPoint(actor, target) ?? fallbackPoint;

  if (!point) {
    const idleBrake = planck.Vec2(-velocity.x * steering.idleBrake, -velocity.y * steering.idleBrake);
    body.applyForceToCenter(idleBrake, true);
    return;
  }

  const desired = getTargetVector(position.x, position.y, point.x, point.y);
  const targetDistance = target
    ? Math.hypot(position.x - (target.x ?? CONFIG.battle.castleX), position.y - (target.y ?? CONFIG.battle.castleY))
    : desired.distance;
  const desiredDistance = target
    ? Math.max(0, targetDistance - (getActorPhysicsRadius(target) + getAttackRange(actor) + radius))
    : desired.distance;
  const stopThreshold = Math.max(0.15, steering.stopRadius);
  const isInCombatHold = Boolean(target) && desiredDistance <= steering.combatHoldRadius;
  const speedMultiplier = target ? steering.targetSpeedMultiplier : steering.fallbackSpeedMultiplier;
  const maxSpeed = actor.moveSpeed * speedMultiplier;
  const slowdownRatio = Math.min(1, desiredDistance / Math.max(stopThreshold, steering.slowRadius));
  const attackStopSlack = target ? steering.attackStopSlack : stopThreshold;
  const desiredSpeed = desiredDistance <= attackStopSlack ? 0 : maxSpeed * slowdownRatio;
  const desiredVelocity = planck.Vec2(desired.dx * desiredSpeed, desired.dy * desiredSpeed);
  const steeringVelocity = planck.Vec2(desiredVelocity.x - velocity.x, desiredVelocity.y - velocity.y);
  const steeringLength = Math.hypot(steeringVelocity.x, steeringVelocity.y);

  body.setLinearDamping(isInCombatHold ? steering.combatLinearDamping : steering.baseLinearDamping);

  if (target && desiredDistance <= attackStopSlack) {
    body.setLinearVelocity(planck.Vec2(0, 0));
    return;
  }

  if (steeringLength > 0.0001) {
    const bodyMass = body.getMass();
    const maxForce = bodyMass * steering.maxForce;
    const approachMultiplier = isInCombatHold ? steering.combatApproachForceMultiplier : 1;
    const accelerationForce = bodyMass * steering.acceleration * steeringLength * approachMultiplier;
    const appliedForce = Math.min(maxForce, accelerationForce);
    const normalizedX = steeringVelocity.x / steeringLength;
    const normalizedY = steeringVelocity.y / steeringLength;
    body.applyForceToCenter(planck.Vec2(normalizedX * appliedForce, normalizedY * appliedForce), true);
  }

  if (!target && desiredDistance <= stopThreshold) {
    const bodyMass = body.getMass();
    body.applyForceToCenter(
      planck.Vec2(-velocity.x * steering.brakeForce * bodyMass, -velocity.y * steering.brakeForce * bodyMass),
      true
    );
  }
}

function driveBodies(state) {
  const allyAdvancePoint = {
    x: CONFIG.battle.fieldWidth * 0.82,
    y: CONFIG.battle.fieldHeight / 2
  };
  const enemyAdvancePoint = {
    x: CONFIG.battle.fieldWidth * 0.18,
    y: CONFIG.battle.fieldHeight / 2
  };

  for (const unit of state.battleUnits) {
    const targetEnemy = state.enemies.find((enemy) => enemy.id === unit.targetId) ?? null;
    driveActorBody(
      allyBodies.get(unit.id),
      unit,
      targetEnemy,
      allyAdvancePoint
    );
  }

  for (const enemy of state.enemies) {
    const targetUnit = state.battleUnits.find((unit) => unit.id === enemy.targetId) ?? null;
    driveActorBody(
      enemyBodies.get(enemy.id),
      enemy,
      targetUnit,
      enemyAdvancePoint
    );
  }
}

function syncStateFromBodies(state) {
  const radius = getPhysicsRadius();
  const steering = getSteeringConfig();

  for (const unit of state.battleUnits) {
    const body = allyBodies.get(unit.id);
    if (!body) {
      continue;
    }

    const velocity = body.getLinearVelocity();
    const maxSpeed = unit.moveSpeed * 1.1;
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed > maxSpeed) {
      body.setLinearVelocity(planck.Vec2((velocity.x / speed) * maxSpeed, (velocity.y / speed) * maxSpeed));
    } else if (speed < steering.stopRadius * 0.35) {
      body.setLinearVelocity(planck.Vec2(0, 0));
    }

    const position = body.getPosition();
    unit.x = clamp(position.x, radius, CONFIG.battle.fieldWidth - radius);
    unit.y = clamp(position.y, radius, CONFIG.battle.fieldHeight - radius);
  }

  for (const enemy of state.enemies) {
    const body = enemyBodies.get(enemy.id);
    if (!body) {
      continue;
    }

    const velocity = body.getLinearVelocity();
    const maxSpeed = enemy.moveSpeed * 1.1;
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed > maxSpeed) {
      body.setLinearVelocity(planck.Vec2((velocity.x / speed) * maxSpeed, (velocity.y / speed) * maxSpeed));
    } else if (speed < steering.stopRadius * 0.35) {
      body.setLinearVelocity(planck.Vec2(0, 0));
    }

    const position = body.getPosition();
    enemy.x = clamp(position.x, radius, CONFIG.battle.fieldWidth - radius);
    enemy.y = clamp(position.y, radius, CONFIG.battle.fieldHeight - radius);
  }
}

export function initBattlePhysics() {
  const configKey = JSON.stringify({
    fieldWidth: CONFIG.battle.fieldWidth,
    fieldHeight: CONFIG.battle.fieldHeight,
    castleX: CONFIG.battle.castleX,
    castleY: CONFIG.battle.castleY,
    castleRadius: CONFIG.battle.castleRadius,
    physicsRadius: CONFIG.battle.physicsRadius
  });

  if (world && initializedConfigKey === configKey) {
    return;
  }

  world = new planck.World({
    gravity: planck.Vec2(0, 0)
  });
  allyBodies = new Map();
  enemyBodies = new Map();
  initializedConfigKey = configKey;

  buildArena();
}

export function stepBattlePhysics(state, deltaSeconds) {
  if (!world) {
    initBattlePhysics();
  }

  syncPhysicsEntities(state);
  driveBodies(state);
  world.step(deltaSeconds, 10, 4);
  syncStateFromBodies(state);
}
