import { TERRAIN, info } from './config.js';
import { makeRng } from './rng.js';

export const CELL = 20;

// Organic-looking blob test: a circle whose radius wobbles with a few harmonics.
function makeBlob(rng, cx, cy, r) {
  const harmonics = [];
  for (let i = 0; i < 4; i++) {
    harmonics.push({ f: i + 2, a: (0.06 + rng() * 0.14) / (i * 0.6 + 1), p: rng() * Math.PI * 2 });
  }
  return (px, py) => {
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.hypot(dx, dy);
    if (d > r * 1.6) return false;
    const ang = Math.atan2(dy, dx);
    let m = 1;
    for (const h of harmonics) m += h.a * Math.sin(ang * h.f + h.p);
    return d <= r * m;
  };
}

export class Terrain {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / CELL);
    this.rows = Math.ceil(height / CELL);
    this.cells = new Uint8Array(this.cols * this.rows);
    // Centre lines of the road network, kept so roads can be drawn as smooth
    // strokes instead of a row of cells.
    this.roadPaths = [];
  }

  clone() {
    const t = new Terrain(this.width, this.height);
    t.cells.set(this.cells);
    t.roadPaths = this.roadPaths.map((p) => p.slice());
    return t;
  }

  index(cx, cy) {
    return cy * this.cols + cx;
  }

  atCell(cx, cy) {
    // Off-map reads as mountain: solid, so nothing ever walks off the edge.
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return TERRAIN.MOUNTAIN;
    return this.cells[cy * this.cols + cx];
  }

  at(x, y) {
    return this.atCell(Math.floor(x / CELL), Math.floor(y / CELL));
  }

  isPassable(x, y) {
    return info(this.at(x, y)).passable;
  }

  setCell(cx, cy, type) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return;
    this.cells[cy * this.cols + cx] = type;
  }

  // Circular brush used by the map editor and by feature generation.
  paint(x, y, radius, type) {
    const minX = Math.max(0, Math.floor((x - radius) / CELL));
    const maxX = Math.min(this.cols - 1, Math.floor((x + radius) / CELL));
    const minY = Math.max(0, Math.floor((y - radius) / CELL));
    const maxY = Math.min(this.rows - 1, Math.floor((y + radius) / CELL));
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const px = cx * CELL + CELL / 2;
        const py = cy * CELL + CELL / 2;
        if (Math.hypot(px - x, py - y) <= radius) this.cells[cy * this.cols + cx] = type;
      }
    }
  }

  // Keep a ring of clear ground around cities so spawns never suffocate.
  clearAround(x, y, radius) {
    this.paint(x, y, radius, TERRAIN.PLAINS);
  }

  applyFeatures(features, seed) {
    const rng = makeRng(seed >>> 0);
    for (const f of features) {
      const type = TERRAIN[f.type] ?? TERRAIN.FOREST;
      const test = makeBlob(rng, f.x, f.y, f.r);
      const minX = Math.max(0, Math.floor((f.x - f.r * 1.6) / CELL));
      const maxX = Math.min(this.cols - 1, Math.floor((f.x + f.r * 1.6) / CELL));
      const minY = Math.max(0, Math.floor((f.y - f.r * 1.6) / CELL));
      const maxY = Math.min(this.rows - 1, Math.floor((f.y + f.r * 1.6) / CELL));
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cx = minX; cx <= maxX; cx++) {
          const px = cx * CELL + CELL / 2;
          const py = cy * CELL + CELL / 2;
          if (test(px, py)) this.cells[cy * this.cols + cx] = type;
        }
      }
    }
  }

  // Lays a road between two points. Water becomes a bridge, mountains are cut
  // through, so a road is always a usable route.
  layRoad(points, halfWidth = CELL * 0.8) {
    this.roadPaths.push(points.map((p) => ({ x: p.x, y: p.y })));
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / (CELL * 0.4)));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps;
        const y = a.y + ((b.y - a.y) * s) / steps;
        this.stampRoad(x, y, halfWidth);
      }
    }
  }

  stampRoad(x, y, halfWidth) {
    const minX = Math.max(0, Math.floor((x - halfWidth) / CELL));
    const maxX = Math.min(this.cols - 1, Math.floor((x + halfWidth) / CELL));
    const minY = Math.max(0, Math.floor((y - halfWidth) / CELL));
    const maxY = Math.min(this.rows - 1, Math.floor((y + halfWidth) / CELL));
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const px = cx * CELL + CELL / 2;
        const py = cy * CELL + CELL / 2;
        if (Math.hypot(px - x, py - y) > halfWidth) continue;
        const current = this.cells[cy * this.cols + cx];
        const isBridge = current === TERRAIN.WATER || current === TERRAIN.BRIDGE;
        this.cells[cy * this.cols + cx] = isBridge ? TERRAIN.BRIDGE : TERRAIN.ROAD;
      }
    }
  }

  // Compact run-length encoding so custom maps stay small in localStorage.
  encode() {
    const runs = [];
    let value = this.cells[0];
    let count = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === value) {
        count++;
      } else {
        runs.push(value, count);
        value = this.cells[i];
        count = 1;
      }
    }
    runs.push(value, count);
    return runs;
  }

  static decode(width, height, runs) {
    // Roads are rebuilt from the city layout, so an encoded grid does not
    // carry its road paths.
    const t = new Terrain(width, height);
    let i = 0;
    for (let r = 0; r < runs.length; r += 2) {
      const value = runs[r];
      const count = runs[r + 1];
      for (let c = 0; c < count && i < t.cells.length; c++) t.cells[i++] = value;
    }
    return t;
  }
}

// Builds a road network: a minimum spanning tree over the cities, with each
// link bent slightly so the result looks drawn rather than ruled.
export function buildRoads(terrain, cities, seed) {
  if (cities.length < 2) return;
  const rng = makeRng((seed ^ 0x2545f491) >>> 0);
  const connected = [0];
  const remaining = cities.map((_, i) => i).slice(1);

  while (remaining.length) {
    let bestFrom = 0;
    let bestTo = 0;
    let bestIdx = 0;
    let bestD = Infinity;
    for (const a of connected) {
      for (let i = 0; i < remaining.length; i++) {
        const b = remaining[i];
        const d = Math.hypot(cities[a].x - cities[b].x, cities[a].y - cities[b].y);
        if (d < bestD) {
          bestD = d;
          bestFrom = a;
          bestTo = b;
          bestIdx = i;
        }
      }
    }
    remaining.splice(bestIdx, 1);
    connected.push(bestTo);

    const a = cities[bestFrom];
    const b = cities[bestTo];
    // One midpoint displaced perpendicular to the link gives a gentle curve.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const nx = -(b.y - a.y);
    const ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    const offset = (rng() - 0.5) * bestD * 0.22;
    const mid = { x: mx + (nx / len) * offset, y: my + (ny / len) * offset };

    const points = [];
    const SEGMENTS = 16;
    for (let s = 0; s <= SEGMENTS; s++) {
      const t = s / SEGMENTS;
      const inv = 1 - t;
      points.push({
        x: inv * inv * a.x + 2 * inv * t * mid.x + t * t * b.x,
        y: inv * inv * a.y + 2 * inv * t * mid.y + t * t * b.y,
      });
    }
    terrain.layRoad(points);
  }
}
