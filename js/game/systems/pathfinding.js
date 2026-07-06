import { FORTRESS_HEIGHT, FORTRESS_WIDTH } from "./fortressSystem.js";

const NEIGHBOR_OFFSETS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 }
];

function tileKey(x, y) {
  return `${x}:${y}`;
}

function reconstructPath(cameFrom, currentKey) {
  const path = [];
  let key = currentKey;
  while (key) {
    const [x, y] = key.split(":").map(Number);
    path.unshift({ x, y });
    key = cameFrom.get(key);
  }
  return path;
}

/**
 * A* on the fortress tile grid, 4-neighbour Manhattan.
 * @param {{x:number,y:number}} startTile - integer tile coords, may be outside the grid (e.g. enemy spawn above).
 * @param {{x:number,y:number}} goalTile - integer tile coords, must be inside the grid.
 * @param {(x:number, y:number) => boolean} isBlocked - true if that tile can NOT be walked into.
 * @returns {{x:number,y:number}[] | null} path from start (inclusive) to goal (inclusive), or null if unreachable.
 */
export function findTilePath(startTile, goalTile, isBlocked) {
  const start = { x: Math.round(startTile.x), y: Math.round(startTile.y) };
  const goal = { x: Math.round(goalTile.x), y: Math.round(goalTile.y) };
  const startKey = tileKey(start.x, start.y);
  const goalKey = tileKey(goal.x, goal.y);
  if (startKey === goalKey) {
    return [start];
  }

  const openSet = new Map();
  const cameFrom = new Map();
  const gScore = new Map();
  const heuristic = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);

  gScore.set(startKey, 0);
  openSet.set(startKey, { x: start.x, y: start.y, f: heuristic(start.x, start.y) });

  while (openSet.size > 0) {
    let currentKey = null;
    let currentEntry = null;
    for (const [key, entry] of openSet) {
      if (currentEntry === null || entry.f < currentEntry.f) {
        currentKey = key;
        currentEntry = entry;
      }
    }
    if (currentKey === goalKey) {
      return reconstructPath(cameFrom, currentKey);
    }
    openSet.delete(currentKey);

    for (const { dx, dy } of NEIGHBOR_OFFSETS) {
      const nx = currentEntry.x + dx;
      const ny = currentEntry.y + dy;
      const insideGrid = nx >= 0 && nx < FORTRESS_WIDTH && ny >= 0 && ny < FORTRESS_HEIGHT;
      if (!insideGrid) {
        continue;
      }
      // Blocked check does not apply to the goal — enemies path to a tile that IS the target building.
      const isGoal = nx === goal.x && ny === goal.y;
      if (!isGoal && isBlocked(nx, ny)) {
        continue;
      }

      const tentativeG = (gScore.get(currentKey) ?? Infinity) + 1;
      const neighborKey = tileKey(nx, ny);
      if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentativeG);
        openSet.set(neighborKey, { x: nx, y: ny, f: tentativeG + heuristic(nx, ny) });
      }
    }
  }

  return null;
}
