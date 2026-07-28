// Front lines. Every point on the map belongs to whoever owns the nearest city,
// and the black line is simply the boundary between two different owners.
//
// This only changes when a city changes hands, so it is computed on demand and
// cached against game.territoryVersion rather than rebuilt every frame.

import { chainSegments, chaikin } from './contour.js';

const CELL = 32;

function ownerGrid(game, cellSize) {
  const cols = Math.ceil(game.terrain.width / cellSize);
  const rows = Math.ceil(game.terrain.height / cellSize);
  const owner = new Int8Array(cols * rows).fill(-1);
  const cities = game.cities;
  if (!cities.length) return { cols, rows, owner };

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * cellSize + cellSize / 2;
      const y = cy * cellSize + cellSize / 2;
      let best = -1;
      let bestD = Infinity;
      for (const c of cities) {
        const d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c.owner;
        }
      }
      owner[cy * cols + cx] = best;
    }
  }
  return { cols, rows, owner };
}

export function computeFrontLines(game, cellSize = CELL) {
  const { cols, rows, owner } = ownerGrid(game, cellSize);
  const segments = [];

  const differs = (a, b) => a !== b && (a >= 0 || b >= 0);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const here = owner[cy * cols + cx];
      if (cx + 1 < cols && differs(here, owner[cy * cols + cx + 1])) {
        const x = (cx + 1) * cellSize;
        segments.push([{ x, y: cy * cellSize }, { x, y: (cy + 1) * cellSize }]);
      }
      if (cy + 1 < rows && differs(here, owner[(cy + 1) * cols + cx])) {
        const y = (cy + 1) * cellSize;
        segments.push([{ x: cx * cellSize, y }, { x: (cx + 1) * cellSize, y }]);
      }
    }
  }

  return chainSegments(segments).map((line) => chaikin(line, 3));
}
