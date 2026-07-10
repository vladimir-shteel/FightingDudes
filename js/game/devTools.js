// Live-playtest dev handles. Replaces the retired balance-sim toolkit: instead of simulating the
// game offline we speed it up and poke it live. Backtick (`) toggles the panel. Nothing here runs
// unless a button is pressed, so it is safe to ship on the prototype.
import { syncFortressBuildingUnlocks } from "./systems/fortressSystem.js";

const SPEEDS = [1, 2, 4, 8];

export function createDevTools(state, requestRender) {
  const dev = { speed: 1, open: true };

  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed", "right:10px", "bottom:10px", "z-index:9999",
    "display:flex", "flex-direction:column", "gap:6px",
    "padding:8px", "border-radius:12px",
    "background:rgba(24,20,12,0.86)", "color:#ffe9b0",
    "font:600 11px/1.2 system-ui,sans-serif", "box-shadow:0 8px 24px rgba(0,0,0,0.4)",
    "user-select:none"
  ].join(";");

  const rowStyle = "display:flex;gap:4px;align-items:center;flex-wrap:wrap";
  const btnStyle = "cursor:pointer;border:1px solid rgba(255,233,176,0.3);border-radius:7px;" +
    "background:rgba(255,233,176,0.08);color:inherit;font:inherit;padding:4px 7px";

  const speedRow = document.createElement("div");
  speedRow.style.cssText = rowStyle;
  speedRow.append(label("SPEED"));
  const speedButtons = SPEEDS.map((mult) => {
    const b = button(`×${mult}`, () => { dev.speed = mult; paintSpeed(); });
    speedRow.append(b);
    return { mult, b };
  });

  const actionRow = document.createElement("div");
  actionRow.style.cssText = rowStyle;
  actionRow.append(
    button("+Res", grantResources),
    button("Win wave", winWave),
    button("+Wave", jumpWave),
    button("Repair all", repairAll)
  );

  const header = document.createElement("div");
  header.style.cssText = rowStyle + ";justify-content:space-between";
  header.append(label("DEV ( ` )"), button("–", toggle));

  panel.append(header, speedRow, actionRow);
  document.body.append(panel);

  window.addEventListener("keydown", (event) => {
    if (event.key === "`" && !event.metaKey && !event.ctrlKey) {
      toggle();
    }
  });

  paintSpeed();
  applyOpen();

  function label(text) {
    const el = document.createElement("span");
    el.textContent = text;
    el.style.cssText = "opacity:0.7;letter-spacing:0.06em";
    return el;
  }

  function button(text, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = text;
    el.style.cssText = btnStyle;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
      requestRender();
    });
    return el;
  }

  function paintSpeed() {
    for (const { mult, b } of speedButtons) {
      const active = mult === dev.speed;
      b.style.background = active ? "rgba(255,214,92,0.9)" : "rgba(255,233,176,0.08)";
      b.style.color = active ? "#231a09" : "#ffe9b0";
    }
  }

  function toggle() { dev.open = !dev.open; applyOpen(); }

  function applyOpen() {
    speedRow.style.display = dev.open ? "flex" : "none";
    actionRow.style.display = dev.open ? "flex" : "none";
  }

  function grantResources() {
    for (const key of Object.keys(state.resources)) {
      state.resources[key] += key === "gold" ? 200 : 500;
    }
    state.fortress.message = "DEV: resources granted.";
  }

  function winWave() {
    const battle = state.fortress.battle;
    if (!battle.active) {
      state.fortress.message = "DEV: start a wave first to auto-win it.";
      return;
    }
    // Drain the wave — the battle tick then resolves it as a normal victory.
    battle.spawnQueue = [];
    battle.enemiesToSpawn = 0;
    battle.enemies = [];
  }

  function jumpWave() {
    if (state.fortress.battle.active) {
      state.fortress.message = "DEV: finish the current wave before jumping.";
      return;
    }
    const max = window.__game?.CONFIG?.fortressWaves?.length ?? 24;
    state.fortress.waveNumber = Math.min(max, (state.fortress.waveNumber ?? 1) + 1);
    state.fortress.pendingRewardDraft = null;
    syncFortressBuildingUnlocks(state);
    state.fortress.message = `DEV: jumped to wave ${state.fortress.waveNumber}.`;
  }

  function repairAll() {
    for (const building of state.fortress.buildings) {
      building.hp = building.maxHp;
      building.damageFloor = 0;
    }
    state.fortress.message = "DEV: all buildings repaired.";
  }

  return { getSpeed: () => dev.speed };
}
