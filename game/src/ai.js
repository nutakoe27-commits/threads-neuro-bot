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
    // Stagger the first think so bots do not all fire on the same tick.
    this.timer = this.profile.think * (0.2 + 0.6 * this.rng());
    this.lastOrder = new Map(); // unitId -> {x, y}
    this.stagingCityId = -1;
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.profile.think;
    this.think();
  }

  myUnits() {
    return this.game.units.filter((u) => !u.dead && u.faction === this.faction);
  }

  myCities() {
    return this.game.cities.filter((c) => c.owner === this.faction);
  }

  enemyOf(faction) {
    return faction >= 0 && !this.game.areAllied(faction, this.faction);
  }

  // Avoid re-issuing an order that barely changes anything.
  send(units, x, y, attackMove = true) {
    const ids = [];
    for (const u of units) {
      const prev = this.lastOrder.get(u.id);
      if (prev && Math.hypot(prev.x - x, prev.y - y) < 45 && u.order !== ORDER.IDLE) continue;
      this.lastOrder.set(u.id, { x, y });
      ids.push(u.id);
    }
    if (!ids.length) return;
    this.game.issue({ type: attackMove ? 'attackMove' : 'move', faction: this.faction, units: ids, x, y });
  }

  think() {
    const game = this.game;
    const units = this.myUnits();
    const cities = this.myCities();
    if (!cities.length && !units.length) return;

    this.manageProduction(cities, units);
    if (!units.length) return;

    const assigned = new Set();

    // 1. Defence: cities with enemies nearby pull the closest troops home.
    for (const city of cities) {
      const threat = game.units.filter(
        (u) => !u.dead && this.enemyOf(u.faction) && Math.hypot(u.x - city.x, u.y - city.y) < 300,
      );
      if (!threat.length) continue;
      const need = Math.ceil(threat.length * 1.3) + this.profile.defenders;
      const pool = units
        .filter((u) => !assigned.has(u.id))
        .sort((a, b) => this.dist2(a, city) - this.dist2(b, city))
        .slice(0, need);
      for (const u of pool) assigned.add(u.id);
      this.send(pool, city.x, city.y);
    }

    // 2. Grab free real estate: neutral cities nobody is contesting.
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

    // 3. Wounded troops fall back to a city to be resupplied (higher tiers only).
    if (this.profile.retreatHp > 0) {
      for (const u of units) {
        if (assigned.has(u.id)) continue;
        if (u.hp / u.maxHp > this.profile.retreatHp) continue;
        const home = this.nearestOwnCity(u);
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
      // Not enough for a push yet: gather at the city closest to the objective.
      const staging = this.stagingPoint(objective);
      if (staging) this.send(army, staging.x, staging.y);
    }
  }

  contested(city) {
    return this.game.units.some(
      (u) => !u.dead && this.enemyOf(u.faction) && Math.hypot(u.x - city.x, u.y - city.y) < CITY.captureRadius * 1.4,
    );
  }

  dist2(unit, city) {
    return (unit.x - city.x) ** 2 + (unit.y - city.y) ** 2;
  }

  center() {
    const cities = this.myCities();
    const list = cities.length ? cities : this.myUnits();
    if (!list.length) return { x: this.game.terrain.width / 2, y: this.game.terrain.height / 2 };
    let x = 0;
    let y = 0;
    for (const c of list) {
      x += c.x;
      y += c.y;
    }
    return { x: x / list.length, y: y / list.length };
  }

  distToHome(city) {
    const c = this.center();
    return Math.hypot(c.x - city.x, c.y - city.y);
  }

  nearestOwnCity(unit) {
    let best = null;
    let bestD = Infinity;
    for (const c of this.myCities()) {
      const d = this.dist2(unit, c);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // Prefer nearby, lightly defended targets; neutrals are cheapest of all.
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

    let best = null;
    let bestScore = Infinity;
    for (const city of game.cities) {
      if (city.owner === this.faction) continue;
      if (city.owner >= 0 && game.areAllied(city.owner, this.faction)) continue;
      const defenders = game.units.filter(
        (u) => !u.dead && this.enemyOf(u.faction) && Math.hypot(u.x - city.x, u.y - city.y) < CITY.captureRadius * 1.6,
      ).length;
      const dist = Math.hypot(city.x - ax, city.y - ay);
      const neutralBonus = city.owner < 0 ? 0.55 : 1;
      const score = dist * neutralBonus + defenders * 130 * this.profile.focus;
      if (score < bestScore) {
        bestScore = score;
        best = city;
      }
    }
    return best;
  }

  stagingPoint(objective) {
    let best = null;
    let bestD = Infinity;
    for (const c of this.myCities()) {
      const d = Math.hypot(c.x - objective.x, c.y - objective.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  manageProduction(cities, units) {
    if (!cities.length) return;
    const heavies = units.filter((u) => u.type === 'heavy').length;
    const ratio = units.length ? heavies / units.length : 0;
    const wantHeavy = ratio < this.profile.heavyRatio;

    for (const city of cities) {
      // Front-line cities keep pumping cheap bodies; safe rear cities invest.
      const distToFront = this.frontDistance(city);
      const safe = distToFront > 520;
      let want = 'light';
      if (wantHeavy && (safe || this.profile.heavyRatio > 0.3)) want = 'heavy';
      // Never start a 13-second heavy while the city itself is under attack.
      if (this.contested(city)) want = 'light';

      if (city.produce !== want) {
        // Do not throw away an almost-finished unit.
        if (city.progress / UNITS[city.produce].buildTime < 0.65) {
          this.game.issue({ type: 'produce', faction: this.faction, city: city.id, unitType: want });
        }
      }
      if (!city.rally) {
        const objective = this.pickObjective(units.length ? units : [{ x: city.x, y: city.y }]);
        if (objective) {
          const staging = this.stagingPoint(objective) || city;
          this.game.issue({ type: 'rally', faction: this.faction, city: city.id, x: staging.x, y: staging.y });
        }
      }
    }
  }

  frontDistance(city) {
    let best = Infinity;
    for (const c of this.game.cities) {
      if (c.owner === this.faction) continue;
      if (c.owner >= 0 && this.game.areAllied(c.owner, this.faction)) continue;
      const d = Math.hypot(c.x - city.x, c.y - city.y);
      if (d < best) best = d;
    }
    return best;
  }
}
