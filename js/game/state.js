import { CONFIG } from "./config.js";
import { createMine } from "./factories.js";
import { createFortressState } from "./systems/fortressSystem.js";

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
    fortress: createFortressState(),
    ui: {
      selectedUnitId: null,
      dragUnitId: null,
      fortressPopup: null,
      handledResourceBurstIds: [],
      isCheatsOpen: false
    },
    reserveUnits: [],
    mines: Array.from({ length: 4 }, (_, index) => createMine(index)),
    resourceBursts: [],
    economy: {
      unitsPurchased: 0,
      workerStartLevel: 1,
      workerBuyDiscount: 1
    },
    game: {
      isOver: false,
      result: null
    }
  };
}
