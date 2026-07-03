import { CONFIG } from "./config.js";
import { createMine } from "./factories.js";

export function createInitialState() {
  const resources = {
    gold: CONFIG.startingGold
  };

  for (const resourceType of CONFIG.mine.resourceTypes) {
    resources[resourceType.key] = 0;
  }
  if (typeof CONFIG.startingOre === "number" && resources.ore !== undefined) {
    resources.ore = CONFIG.startingOre;
  }

  return {
    resources,
    ui: {
      selectedWeaponKey: Object.keys(CONFIG.equipment.weapons ?? {})[0] ?? "sword",
      selectedArmorKey: Object.keys(CONFIG.equipment.armors ?? {})[0] ?? "none",
      selectedUnitId: null,
      dragUnitId: null,
      handledResourceBurstIds: [],
      handledBattleEffectIds: [],
      isCheatsOpen: false
    },
    reserveUnits: [],
    mines: Array.from({ length: 4 }, (_, index) => createMine(index)),
    bridgeheadUnits: [],
    battleUnits: [],
    enemies: [],
    resourceBursts: [],
    battleEffects: [],
    castle: {
      maxHealth: CONFIG.castle.maxHealth,
      health: CONFIG.castle.maxHealth,
      hitUntil: 0
    },
    battle: {
      nextWaveIndex: 0,
      activeWaveIndex: null,
      retreatWaveIndex: null,
      waveProgress: {
        defeatedEnemyIndexesByWave: {}
      },
      waveCooldownRemaining: CONFIG.battle.waveCooldownSeconds,
      status: "idle",
      log: "Prepare units in the garrison, then send them from the bridgehead."
    },
    economy: {
      unitsPurchased: 0
    },
    game: {
      isOver: false,
      result: null
    }
  };
}
