import { info } from './config.js';
import { CELL } from './terrain.js';

// Minimal binary heap keyed by f-score.
class Heap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(node, priority) {
    this.items.push({ node, priority });
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].priority <= this.items[i].priority) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      i = p;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < this.items.length && this.items[l].priority < this.items[s].priority) s = l;
        if (r < this.items.length && this.items[r].priority < this.items[s].priority) s = r;
        if (s === i) break;
        [this.items[s], this.items[i]] = [this.items[i], this.items[s]];
        i = s;
      }
    }
    return top.node;
  }
}

const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export class Pathfinder {
  constructor(terrain) {
    this.terrain = terrain;
    this.cache = new Map();
  }

  invalidate() {
    this.cache.clear();
  }

  // Rough ground is passable for everyone but heavies pay dearly for it, so
  // their paths naturally hug the open lanes and the roads.
  cost(type, unitKey) {
    const t = info(type);
    if (!t.passable) return Infinity;
    if (t.rough) return unitKey === 'heavy' ? t.pathCost * 2.3 : t.pathCost;
    return t.pathCost;
  }

  nearestPassable(cx, cy) {
    if (info(this.terrain.atCell(cx, cy)).passable) return [cx, cy];
    for (let r = 1; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (info(this.terrain.atCell(cx + dx, cy + dy)).passable) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  }

  // Returns a list of world-space waypoints, or null when unreachable.
  find(sx, sy, gx, gy, unitKey) {
    const t = this.terrain;
    let scx = Math.floor(sx / CELL);
    let scy = Math.floor(sy / CELL);
    let gcx = Math.floor(gx / CELL);
    let gcy = Math.floor(gy / CELL);

    const start = this.nearestPassable(scx, scy);
    const goal = this.nearestPassable(gcx, gcy);
    if (!start || !goal) return null;
    [scx, scy] = start;
    [gcx, gcy] = goal;

    const key = `${unitKey}:${scx},${scy}->${gcx},${gcy}`;
    const cached = this.cache.get(key);
    if (cached) return cached.slice();

    if (scx === gcx && scy === gcy) return [{ x: gx, y: gy }];

    const size = t.cols * t.rows;
    const gScore = new Float32Array(size).fill(Infinity);
    const cameFrom = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const startIdx = t.index(scx, scy);
    const goalIdx = t.index(gcx, gcy);
    gScore[startIdx] = 0;

    const heap = new Heap();
    heap.push(startIdx, 0);
    let found = false;
    let expansions = 0;
    const maxExpansions = size * 2;

    while (heap.size && expansions++ < maxExpansions) {
      const current = heap.pop();
      if (closed[current]) continue;
      closed[current] = 1;
      if (current === goalIdx) {
        found = true;
        break;
      }
      const cx = current % t.cols;
      const cy = (current / t.cols) | 0;
      for (const [dx, dy, step] of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= t.cols || ny >= t.rows) continue;
        const cellType = t.atCell(nx, ny);
        const c = this.cost(cellType, unitKey);
        if (!isFinite(c)) continue;
        // Do not cut diagonal corners through solid terrain.
        if (dx && dy) {
          if (!info(t.atCell(cx + dx, cy)).passable || !info(t.atCell(cx, cy + dy)).passable) continue;
        }
        const idx = ny * t.cols + nx;
        if (closed[idx]) continue;
        const tentative = gScore[current] + step * c;
        if (tentative < gScore[idx]) {
          gScore[idx] = tentative;
          cameFrom[idx] = current;
          const h = Math.hypot(nx - gcx, ny - gcy);
          heap.push(idx, tentative + h);
        }
      }
    }

    if (!found) return null;

    const cells = [];
    let node = goalIdx;
    while (node !== -1) {
      cells.push(node);
      node = cameFrom[node];
    }
    cells.reverse();

    const points = cells.map((idx) => ({
      x: (idx % t.cols) * CELL + CELL / 2,
      y: ((idx / t.cols) | 0) * CELL + CELL / 2,
    }));
    const smoothed = this.smooth(points, unitKey);
    smoothed[smoothed.length - 1] = { x: gx, y: gy };

    if (this.cache.size > 400) this.cache.clear();
    this.cache.set(key, smoothed);
    return smoothed.slice();
  }

  // Drop waypoints we can walk past in a straight line.
  smooth(points, unitKey) {
    if (points.length <= 2) return points;
    const out = [points[0]];
    let anchor = 0;
    for (let i = 2; i < points.length; i++) {
      if (!this.lineIsClear(points[anchor], points[i], unitKey)) {
        out.push(points[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(points[points.length - 1]);
    return out;
  }

  lineIsClear(a, b, unitKey) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(dist / (CELL * 0.5));
    for (let i = 1; i < steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const y = a.y + ((b.y - a.y) * i) / steps;
      const cell = info(this.terrain.at(x, y));
      if (!cell.passable) return false;
      // Heavies should not be shortcut through forests they were routed around.
      if (unitKey === 'heavy' && cell.rough) return false;
    }
    return true;
  }
}
