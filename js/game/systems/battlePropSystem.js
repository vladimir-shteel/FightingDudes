import { CONFIG, getBattlePropConfig } from "../config.js";
import { clamp, generateId } from "../utils.js";

function seededRatio(seed) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function weightedType(seed) {
  const entries = Object.entries(CONFIG.battleProps.types ?? {});
  const totalWeight = entries.reduce((total, [, config]) => total + (config.weight ?? 1), 0);
  let roll = seededRatio(seed) * totalWeight;
  for (const [type, config] of entries) {
    roll -= config.weight ?? 1;
    if (roll <= 0) {
      return type;
    }
  }
  return entries[0]?.[0] ?? null;
}

export function createBattlePropsForWave(waveIndex) {
  const perWave = CONFIG.battleProps.perWave ?? { min: 0, max: 0 };
  const min = perWave.min ?? 0;
  const max = Math.max(min, perWave.max ?? min);
  const count = min + Math.floor(seededRatio(`count:${waveIndex}`) * (max - min + 1));
  const spawn = CONFIG.battleProps.spawn ?? {};

  return Array.from({ length: count }, (_, index) => {
    const type = weightedType(`type:${waveIndex}:${index}`);
    const config = getBattlePropConfig(type);
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = (column + 0.5) / columns;
    const cellY = (row + 0.5) / rows;
    const jitterX = (seededRatio(`jitter-x:${waveIndex}:${index}`) - 0.5) / columns * 0.75;
    const jitterY = (seededRatio(`jitter-y:${waveIndex}:${index}`) - 0.5) / rows * 0.75;
    const xRatio = clamp(cellX + jitterX, 0, 1);
    const yRatio = clamp(cellY + jitterY, 0, 1);
    const minX = spawn.minX ?? 20;
    const maxX = spawn.maxX ?? 62;
    const minY = spawn.minY ?? 4;
    const maxY = spawn.maxY ?? CONFIG.battle.fieldHeight - 4;
    return {
      id: generateId("prop"),
      type,
      name: config.label,
      icon: config.icon ?? "?",
      maxHealth: config.health,
      health: config.health,
      radius: config.radius ?? 3,
      physicsRadius: (config.radius ?? 3) * 0.12,
      x: clamp(minX + (maxX - minX) * xRatio, 0, CONFIG.battle.fieldWidth),
      y: clamp(minY + (maxY - minY) * yRatio, 0, CONFIG.battle.fieldHeight),
      solid: Boolean(config.solid),
      hitUntil: 0
    };
  });
}

export function createAdditionalBattlePropsForWave(state, waveIndex) {
  const existingProps = [...state.battleProps];
  const props = createBattlePropsForWave(waveIndex);

  for (const prop of props) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nearestDistance = existingProps.reduce((nearest, existing) => {
        const distance = Math.hypot((existing.x ?? 0) - prop.x, (existing.y ?? 0) - prop.y);
        return Math.min(nearest, distance);
      }, Number.POSITIVE_INFINITY);

      if (nearestDistance >= Math.max(7, prop.radius * 1.5)) {
        break;
      }

      prop.x = clamp(prop.x + (seededRatio(`repel-x:${waveIndex}:${prop.id}:${attempt}`) - 0.5) * 14, 0, CONFIG.battle.fieldWidth);
      prop.y = clamp(prop.y + (seededRatio(`repel-y:${waveIndex}:${prop.id}:${attempt}`) - 0.5) * 10, 0, CONFIG.battle.fieldHeight);
    }

    existingProps.push(prop);
  }

  return props;
}

function applyExplosion(state, prop, config, nowSeconds) {
  const radius = config.explosionRadius ?? 0;
  const damage = config.explosionDamage ?? 0;
  if (radius <= 0 || damage <= 0) {
    return;
  }

  for (const actor of [...state.battleUnits, ...state.enemies]) {
    const distance = Math.hypot((actor.x ?? 0) - prop.x, (actor.y ?? 0) - prop.y);
    if (distance <= radius) {
      actor.health -= damage;
      actor.hitUntil = nowSeconds + 0.18;
    }
  }

  state.battleEffects.push({
    id: generateId("blast"),
    type: "prop-blast",
    createdAt: nowSeconds,
    x: prop.x,
    y: prop.y,
    radius
  });
}

function applyResourceDrop(state, prop, config) {
  const payouts = Object.entries(config.resourceDrop ?? {}).map(([resourceKey, range]) => {
    const [min, max] = range;
    const amount = min + Math.floor(Math.random() * (max - min + 1));
    state.resources[resourceKey] = clamp((state.resources[resourceKey] ?? 0) + amount, 0, Number.MAX_SAFE_INTEGER);
    return { resourceKey, amount };
  });

  if (payouts.length > 0) {
    state.resourceBursts.push({
      id: generateId("prop-loot"),
      battlefield: { x: prop.x, y: prop.y },
      payouts
    });
  }
}

export function cleanupDestroyedProps(state, nowSeconds) {
  state.battleProps = state.battleProps.filter((prop) => {
    if (prop.health > 0) {
      return true;
    }

    const config = getBattlePropConfig(prop.type);
    applyExplosion(state, prop, config, nowSeconds);
    applyResourceDrop(state, prop, config);
    return false;
  });
}
