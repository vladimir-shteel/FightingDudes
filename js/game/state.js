import { CONFIG } from "./config.js";
import { createMine } from "./factories.js";
import { createFortressState } from "./systems/fortressSystem.js";
import { syncMineUnlocks } from "./systems/mineSystem.js";

export function createInitialState() {
  const resources = {
    gold: CONFIG.startingGold
  };

  for (const resourceType of CONFIG.mine.resourceTypes) {
    resources[resourceType.key] = 0;
  }
  for (const [resourceKey, amount] of Object.entries(CONFIG.startingResources ?? {})) {
    if (resources[resourceKey] !== undefined && typeof amount === "number") {
      resources[resourceKey] = amount;
    }
  }
  const state = {
    resources,
    fortress: createFortressState(),
    ui: {
      dragUnitId: null,
      fortressPopup: null,
      workerActionPopup: null,
      handledResourceBurstIds: [],
      isCheatsOpen: false
    },
    reserveUnits: [],
    mines: Array.from({ length: CONFIG.mine.resourceTypes.length }, (_, index) => createMine(index)),
    resourceBursts: [],
    economy: {
      goldMultiplier: 1,
      productionMultiplier: 1,
      temporaryProductionMultiplier: 1,
      damageMultiplier: 1,
      defenseMultiplier: 1,
      baseHealthBonus: 0
    },
    game: {
      isOver: false,
      result: null
    }
  };

  syncMineUnlocks(state);
  return state;
}
