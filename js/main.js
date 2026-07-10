import { createInitialState } from "./game/state.js";
import { mountUI } from "./game/ui.js";
import { tickFortressBattle } from "./game/systems/fortressBattleSystem.js";
import { tickMineProduction } from "./game/systems/mineSystem.js";
import { createDevTools } from "./game/devTools.js";
import { CONFIG, initConfig } from "./game/config.js";

async function bootstrap() {
  await initConfig();

  const state = createInitialState();
  const ui = mountUI(state, () => ui.render());
  const dev = createDevTools(state, () => ui.render());

  let previousTimestamp = performance.now();

  function gameLoop(timestamp) {
    const deltaSeconds = Math.min((timestamp - previousTimestamp) / 1000, 0.25);
    previousTimestamp = timestamp;

    // Dev speed multiplier runs the sim in whole sub-steps (each with the real delta) rather than one
    // giant delta, so pathfinding/collisions stay stable while the clock runs faster for playtesting.
    const steps = Math.max(1, Math.round(dev.getSpeed()));
    for (let step = 0; step < steps; step += 1) {
      tickMineProduction(state, deltaSeconds);
      tickFortressBattle(state, deltaSeconds);
    }
    ui.renderFrame();

    window.setTimeout(() => {
      window.requestAnimationFrame(gameLoop);
    }, CONFIG.tickRateMs);
  }

  ui.render();
  window.requestAnimationFrame(gameLoop);

  window.__game = { state, ui, CONFIG, dev };
}

bootstrap().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre style="padding:16px;color:white;">Failed to load game data.\n${error.message}</pre>`;
});
