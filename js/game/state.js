import { CONFIG } from "./config.js";
import { createMine } from "./factories.js";

export function createInitialState() {
  return {
    resources: {
      gold: CONFIG.startingGold,
      ore: CONFIG.startingOre
    },
    ui: {
      selectedGearKey: "sword",
      dragUnitId: null
    },
    reserveUnits: [],
    mines: Array.from({ length: 4 }, (_, index) => createMine(index)),
    battleUnits: [],
    enemies: [],
    castle: {
      maxHealth: CONFIG.castle.maxHealth,
      health: CONFIG.castle.maxHealth
    },
    battle: {
      nextWaveIndex: 0,
      waveCooldownRemaining: CONFIG.battle.waveCooldownSeconds,
      status: "idle",
      log: "Deploy a unit through the garrison."
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
