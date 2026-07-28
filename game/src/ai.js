import { AI_PROFILES, CITY, UNITS } from './config.js';
import { ORDER } from './entities.js';
import { makeRng } from './rng.js';

// One controller per bot faction. It issues the exact same commands a human
// would, which keeps replays honest and the simulation deterministic.
export class AIController {
  constructor(game, faction, difficulty) {
    this.game = game;
    this.faction = faction;
    // `difficulty` is normally a profile name; a raw profile object is also
    // accepted, which is what the tuning script feeds in.
    this.profile =
      typeof difficulty === 'object' && difficulty ? difficulty : AI_PROFILES[difficulty] || AI_PROFILES.normal;
    // The bot gets its own RNG. Touching game.rng here would shift the
    // simulation's random stream, and replays run without any AI at all —
    // that difference alone is enough to desync a whole match.
    this.rng = makeRng((game.seed ^ ((faction + 1) * 0x9e3779b9)) >>> 0);
    this.timer = this.profile.think * (0.2 + 0.6 * this.rng());
    this.lastOrder = new Map();
    this.wantHeavy = false;
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.profile.think;
    this.think();
  }

  get me() {
    return this.game.factions[this.faction];
  }

  myUnits() {
    return this.game.units.filter((u) => !u.dead && u.faction === this.faction);
  }

  myBases() {
    return this.game.bases.filter((b) => !b.dead && b.owner === this.faction);
  }

  myCities() {
    return this.game.cities.filter((c) => c.owner === this.faction);
  }

  homePoints() {
    return [...this.myBases(), ...this.myCities()];
  }

  enemyOf(faction) {
    return faction >= 0 && !this.game.areAllied(faction, this.faction) && faction !== this.faction;
  }

  // Bots steer their troops one at a time, exactly like a human drawing arrows.
  // Posts are spread across the objective so a squad arrives as a line rather
  // than a column piling onto one spot.
  send(units, x, y) {
    const fresh = units.filter((u) => {
      const prev = this.lastOrder.get(u.id);
      return !(prev && Math.hypot(prev.x - x, prev.y - y) < 50 && u.order !== ORDER.IDLE);
    });
    if (!fresh.length) return;

    let cx = 0;
    let cy = 0;
    for (const u of fresh) {
      cx += u.x;
      cy += u.y;
    }
    cx /= fresh.length;
    cy /= fresh.length;

    // Broadside to the direction of travel.
    let dx = x - cx;
    let dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    const half = (fresh.length - 1) / 2;

    fresh.forEach((u, i) => {
      const offset = (i - half) * 24;
      const tx = x + px * offset;
      const ty = y + py * offset;
      this.lastOrder.set(u.id, { x, y });
      this.game.issue({ type: 'steer', faction: this.faction, unit: u.id, x: tx, y: ty });
    });
  }

  think() {
    const game = this.game;
    const units = this.myUnits();
    const bases = this.myBases();
    if (!bases.length && !units.length) return;

    this.manageProduction(bases, units);
    if (!units.length) return;

    const assigned = new Set();

    // 0. Anything encircled runs for home before it bleeds out.
    for (const u of units) {
      if (u.supplied) continue;
      const home = this.nearestHome(u);
      if (!home) continue;
      assigned.add(u.id);
      this.send([u], home.x, home.y);
    }

    // 1. Defence: threatened bases and cities pull the closest troops back.
    for (const point of this.homePoints()) {
      const threat = game.units.filter(
        (u) => !u.dead && this.enemyOf(u.faction) && Math.hypot(u.x - point.x, u.y - point.y) < 320,
      );
      if (!threat.length) continue;
      const need = Math.ceil(threat.length * 1.3) + this.profile.defenders;
      const pool = units
        .filter((u) => !assigned.has(u.id))
        .sort((a, b) => this.dist2(a, point) - this.dist2(b, point))
        .slice(0, need);
      for (const u of pool) assigned.add(u.id);
      this.send(pool, point.x, point.y);
    }

    // 2. Economy first: grab uncontested neutral cities for the income.
    const free = game.cities
      .filter((c) => c.owner < 0 && !this.contested(c))
      .sort((a, b) => this.distToHome(a) - this.distToHome(b));
    for (const city of free.slice(0, 2)) {
      const pool = units
        .filter((u) => !assigned.has(u.id))
        .sort((a, b) => this.dist2(a, city) - this.dist2(b, city))
        .slice(0, 2);
      if (pool.length < 2) break;
      for (const u of pool) assigned.add(u.id);
      this.send(pool, city.x, city.y);
    }

    // 3. Wounded or shaken troops fall back to be patched up.
    if (this.profile.retreatHp > 0) {
      for (const u of units) {
        if (assigned.has(u.id)) continue;
        if (u.hp / u.maxHp > this.profile.retreatHp && u.morale > 0.25) continue;
        const home = this.nearestHome(u);
        if (!home) continue;
        assigned.add(u.id);
        this.send([u], home.x, home.y);
      }
    }

    // 4. Everything else is the field army.
    const army = units.filter((u) => !assigned.has(u.id));
    if (!army.length) return;

    const objective = this.pickObjective(army);
    if (!objective) return;

    if (army.length >= this.profile.wave) {
      this.send(army, objective.x, objective.y);
    } else {
      const staging = this.stagingPoint(objective);
      if (staging) this.send(army, staging.x, staging.y);
    }
  }

  contested(city) {
    return this.game.units.some(
      (u) => !u.dead && this.enemyOf(u.faction) && Math.hypot(u.x - city.x, u.y - city.y) < CITY.captureRadius * 1.4,
    );
  }

  dist2(unit, point) {
    return (unit.x - point.x) ** 2 + (unit.y - point.y) ** 2;
  }

  center() {
    const list = this.homePoints().length ? this.homePoints() : this.myUnits();
    if (!list.length) return { x: this.game.terrain.width / 2, y: this.game.terrain.height / 2 };
    let x = 0;
    let y = 0;
    for (const c of list) {
      x += c.x;
      y += c.y;
    }
    return { x: x / list.length, y: y / list.length };
  }

  distToHome(point) {
    const c = this.center();
    return Math.hypot(c.x - point.x, c.y - point.y);
  }

  nearestHome(unit) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.homePoints()) {
      const d = this.dist2(unit, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // Neutral cities are cheap income; enemy bases end the game. Defended ground
  // is discounted by `focus`.
  pickObjective(army) {
    const game = this.game;
    let ax = 0;
    let ay = 0;
    for (const u of army) {
      ax += u.x;
      ay += u.y;
    }
    ax /= army.length;
    ay /= army.length;

    const defendersNear = (p, radius) =>
      game.units.filter((u) => !u.dead && this.enemyOf(u.faction) && Math.hypot(u.x - p.x, u.y - p.y) < radius).length;

    let best = null;
    let bestScore = Infinity;

    for (const city of game.cities) {
      if (city.owner === this.faction) continue;
      if (city.owner >= 0 && game.areAllied(city.owner, this.faction)) continue;
      const dist = Math.hypot(city.x - ax, city.y - ay);
      const score = dist * (city.owner < 0 ? 0.55 : 1) + defendersNear(city, CITY.captureRadius * 1.6) * 130 * this.profile.focus;
      if (score < bestScore) {
        bestScore = score;
        best = city;
      }
    }

    for (const base of game.bases) {
      if (base.dead || !this.enemyOf(base.owner)) continue;
      const dist = Math.hypot(base.x - ax, base.y - ay);
      // Worth committing to, but only once the army is big enough to matter.
      const readiness = army.length >= this.profile.wave * 1.5 ? 0.45 : 2;
      const score = dist * readiness + defendersNear(base, 260) * 140 * this.profile.focus;
      if (score < bestScore) {
        bestScore = score;
        best = base;
      }
    }

    return best;
  }

  stagingPoint(objective) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.homePoints()) {
      const d = Math.hypot(p.x - objective.x, p.y - objective.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  manageProduction(bases, units) {
    const points = [...bases, ...this.myCities()];
    if (!points.length) return;
    const heavies = units.filter((u) => u.type === 'heavy').length;
    const ratio = units.length ? heavies / units.length : 0;

    // Hysteresis, so the choice does not flip every time a unit pops.
    const target = this.profile.heavyRatio;
    if (ratio < target * 0.75) this.wantHeavy = true;
    else if (ratio > target * 1.25) this.wantHeavy = false;

    for (const point of points) {
      let want = this.wantHeavy ? 'heavy' : 'light';
      // Under attack there is no time for a unit that takes twice as long.
      if (this.threatened(point)) want = 'light';
      if (point.produce !== want) {
        const cmd = { type: 'produce', faction: this.faction, unitType: want };
        if (point.maxHp) cmd.base = point.id;
        else cmd.city = point.id;
        this.game.issue(cmd);
      }
      if (!point.rally) {
        const objective = this.pickObjective(units.length ? units : [{ x: point.x, y: point.y }]);
        const staging = (objective && this.stagingPoint(objective)) || point;
        const cmd = { type: 'rally', faction: this.faction, x: staging.x, y: staging.y };
        if (point.maxHp) cmd.base = point.id;
        else cmd.city = point.id;
        this.game.issue(cmd);
      }
    }
  }

  threatened(point) {
    return this.game.units.some(
      (u) => !u.dead && this.enemyOf(u.faction) && Math.hypot(u.x - point.x, u.y - point.y) < 260,
    );
  }
}
