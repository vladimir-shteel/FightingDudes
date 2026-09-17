// Records every successful player action (buy/merge/repair/move/demolish a building, buy/merge a
// worker, assign/move a worker in a mine slot) into `state.actionLog`, so a played session can be
// exported afterward as a readable build-order transcript — no UI change, no touching the ~20 call
// sites that already invoke these functions: `withActionLog` wraps the function itself.
//
// Every action function in this codebase already follows the same `{ok, reason}` contract, and
// `reason` on success already names the building/unit and what happened to it (e.g. "Barracks
// placed.", "Merged into level 3"). Rather than re-deriving cost/type per action type, this just
// diffs `state.resources` before/after the call — automatically correct for every action, present
// and future, with zero per-action-type bookkeeping.

function snapshotResources(state) {
  return { ...state.resources };
}

function diffResources(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff = {};
  for (const key of keys) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (Math.abs(delta) > 1e-6) diff[key] = Math.round(delta * 100) / 100;
  }
  return diff;
}

function formatDelta(delta) {
  return Object.entries(delta)
    .map(([key, value]) => `${value > 0 ? "+" : ""}${value} ${key}`)
    .join(", ");
}

// Wraps a state-mutating action function so every SUCCESSFUL call appends a log entry and prints a
// one-line console trace. Failed attempts (result.ok === false) are not logged — they didn't
// change anything the player would want to see in a build-order replay.
export function withActionLog(type, fn) {
  return (state, ...args) => {
    const before = snapshotResources(state);
    const result = fn(state, ...args);
    if (result?.ok) {
      const delta = diffResources(before, snapshotResources(state));
      const entry = {
        t: Math.round(state.elapsedSeconds ?? 0),
        wave: state.fortress?.waveNumber ?? null,
        type,
        reason: result.reason,
        resourceDelta: delta
      };
      state.actionLog?.push(entry);
      const deltaText = formatDelta(delta);
      console.log(`[action t=${entry.t}s wave=${entry.wave}] ${entry.reason}${deltaText ? ` (${deltaText})` : ""}`);
    }
    return result;
  };
}

export function formatActionLog(state) {
  const log = state.actionLog ?? [];
  if (log.length === 0) return "(no actions logged yet)";
  return log
    .map((entry) => {
      const deltaText = formatDelta(entry.resourceDelta);
      return `[t=${entry.t}s wave=${entry.wave}] ${entry.reason}${deltaText ? ` (${deltaText})` : ""}`;
    })
    .join("\n");
}

export function downloadActionLog(state) {
  const text = formatActionLog(state);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fortress-action-log-wave${state.fortress?.waveNumber ?? 0}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
