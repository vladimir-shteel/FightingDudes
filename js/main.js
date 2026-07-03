import { createInitialState } from "./game/state.js";
import { mountUI } from "./game/ui.js";
import { tickBattle } from "./game/systems/battleSystem.js";
import { tickMineProduction } from "./game/systems/mineSystem.js";
import { CONFIG, initConfig } from "./game/config.js";

async function bootstrap() {
  await initConfig();

  const state = createInitialState();
  const ui = mountUI(state, () => ui.render());

  let previousTimestamp = performance.now();

  function gameLoop(timestamp) {
    const deltaSeconds = Math.min((timestamp - previousTimestamp) / 1000, 0.25);
    const scaledDeltaSeconds = deltaSeconds * (state.ui.gameSpeedMultiplier ?? 1);
    previousTimestamp = timestamp;

    tickMineProduction(state, scaledDeltaSeconds);
    tickBattle(state, scaledDeltaSeconds, timestamp / 1000);
    ui.renderFrame();

    window.setTimeout(() => {
      window.requestAnimationFrame(gameLoop);
    }, CONFIG.tickRateMs);
  }

  ui.render();
  window.requestAnimationFrame(gameLoop);
}

bootstrap().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre style="padding:16px;color:white;">Failed to load game data.\n${error.message}</pre>`;
});
