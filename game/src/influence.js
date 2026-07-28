import { info } from './config.js';
import { chainSegments, chaikin } from './contour.js';

// Territory, front lines and supply, all derived from where things actually
// stand. Bases project control furthest, cities less, individual units least —
// so the front moves the moment an army moves, and a squad that pushes too deep
// finds its route home cut.

export const CELL = 40;

// Bases and cities project a fixed distance. Units *stack*: one scout barely
// claims the ground under its feet, but a massed army out-projects a base — which
// is what lets an attack take territory instead of instantly being encircled.
const REACH = { base: 380, city: 260, unitEach: 85, unitCap: 430 };

class MaxHeap {
  constructor(capacity) {
    this.cells = new Int32Array(capacity);
    this.priority = new Float32Array(capacity);
    this.size = 0;
  }
  clear() {
    this.size = 0;
  }
  push(cell, priority) {
    let i = this.size++;
    if (i >= this.cells.length) return; // capacity is generous; never grow mid-run
    this.cells[i] = cell;
    this.priority[i] = priority;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.priority[p] >= this.priority[i]) break;
      this.swap(p, i);
      i = p;
    }
  }
  swap(a, b) {
    const c = this.cells[a];
    const p = this.priority[a];
    this.cells[a] = this.cells[b];
    this.priority[a] = this.priority[b];
    this.cells[b] = c;
    this.priority[b] = p;
  }
  pop() {
    const top = this.cells[0];
    this.size--;
    if (this.size > 0) {
      this.cells[0] = this.cells[this.size];
      this.priority[0] = this.priority[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.priority[l] > this.priority[m]) m = l;
        if (r < this.size && this.priority[r] > this.priority[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }
}

export class InfluenceField {
  constructor(game, cellSize = CELL) {
    this.game = game;
    this.cellSize = cellSize;
    this.cols = Math.ceil(game.terrain.width / cellSize);
    this.rows = Math.ceil(game.terrain.height / cellSize);
    const n = this.cols * this.rows;

    this.passable = new Uint8Array(n);
    this.passableCount = 0;
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const x = cx * cellSize + cellSize / 2;
        const y = cy * cellSize + cellSize / 2;
        const ok = info(game.terrain.at(x, y)).passable ? 1 : 0;
        this.passable[cy * this.cols + cx] = ok;
        this.passableCount += ok;
      }
    }

    // Teams are the unit of ownership: allies share territory and supply.
    this.teams = [...new Set(game.factions.filter((f) => f.kind !== 'none').map((f) => f.team))].sort();
    this.teamIndex = new Map(this.teams.map((t, i) => [t, i]));

    this.reach = this.teams.map(() => new Float32Array(n));
    this.supplied = this.teams.map(() => new Uint8Array(n));
    this.owner = new Int8Array(n).fill(-1);
    this.shares = this.teams.map(() => 0);
    this.heap = new MaxHeap(n * 4);
    this.queue = new Int32Array(n);
    this.version = 0;

    this.neighbours = [
      [1, 0, cellSize], [-1, 0, cellSize], [0, 1, cellSize], [0, -1, cellSize],
      [1, 1, cellSize * Math.SQRT2], [1, -1, cellSize * Math.SQRT2],
      [-1, 1, cellSize * Math.SQRT2], [-1, -1, cellSize * Math.SQRT2],
    ];
  }

  cellOf(x, y) {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.cellSize)));
    const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.cellSize)));
    return cy * this.cols + cx;
  }

  update() {
    const game = this.game;

    for (let t = 0; t < this.teams.length; t++) this.spread(t);

    // Strongest projection wins the ground.
    for (let i = 0; i < this.owner.length; i++) {
      let best = -1;
      let bestValue = 0;
      for (let t = 0; t < this.teams.length; t++) {
        const v = this.reach[t][i];
        if (v > bestValue) {
          bestValue = v;
          best = t;
        }
      }
      this.owner[i] = best;
    }

    for (let t = 0; t < this.teams.length; t++) {
      let count = 0;
      for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === t) count++;
      this.shares[t] = this.passableCount ? count / this.passableCount : 0;
      this.traceSupply(t);
    }

    this.version++;
    void game;
  }

  spread(teamIdx) {
    const reach = this.reach[teamIdx];
    reach.fill(0);
    const heap = this.heap;
    heap.clear();
    const team = this.teams[teamIdx];
    const game = this.game;

    // Units accumulate into their cell first, so a stack counts as a stack.
    for (const u of game.units) {
      if (u.dead || game.factions[u.faction].team !== team) continue;
      const c = this.cellOf(u.x, u.y);
      reach[c] = Math.min(REACH.unitCap, reach[c] + REACH.unitEach);
    }
    for (const b of game.bases) {
      if (b.dead || b.owner < 0 || game.factions[b.owner].team !== team) continue;
      const c = this.cellOf(b.x, b.y);
      reach[c] = Math.max(reach[c], REACH.base);
    }
    for (const c of game.cities) {
      if (c.owner < 0 || game.factions[c.owner].team !== team) continue;
      const idx = this.cellOf(c.x, c.y);
      reach[idx] = Math.max(reach[idx], REACH.city);
    }
    for (let i = 0; i < reach.length; i++) {
      if (reach[i] > 0) heap.push(i, reach[i]);
    }

    while (heap.size) {
      const cell = heap.pop();
      const value = reach[cell];
      if (value <= 0) continue;
      const cx = cell % this.cols;
      const cy = (cell / this.cols) | 0;
      for (const [dx, dy, step] of this.neighbours) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const idx = ny * this.cols + nx;
        if (!this.passable[idx]) continue;
        const next = value - step;
        if (next > reach[idx]) {
          reach[idx] = next;
          heap.push(idx, next);
        }
      }
    }
  }

  // A cell is in supply if it connects back to a base or owned city without
  // crossing ground the enemy controls. Everything else is encircled.
  traceSupply(teamIdx) {
    const supplied = this.supplied[teamIdx];
    supplied.fill(0);
    const game = this.game;
    const team = this.teams[teamIdx];
    const queue = this.queue;
    let head = 0;
    let tail = 0;

    const push = (x, y) => {
      const c = this.cellOf(x, y);
      if (supplied[c]) return;
      supplied[c] = 1;
      queue[tail++] = c;
    };

    for (const b of game.bases) {
      if (!b.dead && b.owner >= 0 && game.factions[b.owner].team === team) push(b.x, b.y);
    }
    for (const c of game.cities) {
      if (c.owner >= 0 && game.factions[c.owner].team === team) push(c.x, c.y);
    }

    while (head < tail) {
      const cell = queue[head++];
      const cx = cell % this.cols;
      const cy = (cell / this.cols) | 0;
      for (const [dx, dy] of this.neighbours) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const idx = ny * this.cols + nx;
        if (supplied[idx] || !this.passable[idx]) continue;
        // Own or no-man's-land carries supply; enemy ground blocks it.
        const owner = this.owner[idx];
        if (owner >= 0 && owner !== teamIdx) continue;
        supplied[idx] = 1;
        queue[tail++] = idx;
      }
    }
  }

  ownerTeamAt(x, y) {
    const t = this.owner[this.cellOf(x, y)];
    return t < 0 ? -1 : this.teams[t];
  }

  isSuppliedAt(x, y, team) {
    const idx = this.teamIndex.get(team);
    if (idx === undefined) return true;
    return this.supplied[idx][this.cellOf(x, y)] === 1;
  }

  shareForTeam(team) {
    const idx = this.teamIndex.get(team);
    return idx === undefined ? 0 : this.shares[idx];
  }

  // Boundary between two different owners, for drawing the front.
  frontLines() {
    const segments = [];
    const cs = this.cellSize;
    const differs = (a, b) => a !== b && (a >= 0 || b >= 0);
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const here = this.owner[cy * this.cols + cx];
        if (cx + 1 < this.cols && differs(here, this.owner[cy * this.cols + cx + 1])) {
          const x = (cx + 1) * cs;
          segments.push([{ x, y: cy * cs }, { x, y: (cy + 1) * cs }]);
        }
        if (cy + 1 < this.rows && differs(here, this.owner[(cy + 1) * this.cols + cx])) {
          const y = (cy + 1) * cs;
          segments.push([{ x: cx * cs, y }, { x: (cx + 1) * cs, y }]);
        }
      }
    }
    return chainSegments(segments).map((line) => chaikin(line, 3));
  }
}
