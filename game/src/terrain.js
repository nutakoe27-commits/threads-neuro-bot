import { TERRAIN } from './config.js';
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
  }

  clone() {
    const t = new Terrain(this.width, this.height);
    t.cells.set(this.cells);
    return t;
  }

  index(cx, cy) {
    return cy * this.cols + cx;
  }

  atCell(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return TERRAIN.WATER;
    return this.cells[cy * this.cols + cx];
  }

  at(x, y) {
    return this.atCell(Math.floor(x / CELL), Math.floor(y / CELL));
  }

  isPassable(x, y) {
    return this.at(x, y) !== TERRAIN.WATER;
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
    this.paint(x, y, radius, TERRAIN.CLEAR);
  }

  applyFeatures(features, seed) {
    const rng = makeRng(seed >>> 0);
    for (const f of features) {
      const type = TERRAIN[f.type] ?? TERRAIN.ROUGH;
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
