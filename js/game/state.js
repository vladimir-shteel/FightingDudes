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
      selectedClassId: Object.keys(CONFIG.classes ?? {})[0] ?? "swordsman",
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
    battle: {
      currentWaveIndex: 0,
      waveProgress: {
        defeatedEnemyIndexesByWave: {}
      },
      status: "idle",
      log: "Подготовьте отряд в казарме, затем отправьте его в бой."
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
