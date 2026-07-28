import { DT, TERRAIN, UNITS, CITY, STARVE_DPS, RESUPPLY_HPS } from './config.js';
import { Terrain } from './terrain.js';
import { Pathfinder } from './pathfinder.js';
import { Unit, City, ORDER } from './entities.js';
import { makeRng } from './rng.js';

class SpatialHash {
  constructor(cellSize = 64) {
    this.cellSize = cellSize;
    this.buckets = new Map();
  }
  clear() {
    this.buckets.clear();
  }
  key(cx, cy) {
    return cx * 73856093 ^ cy * 19349663;
  }
  insert(unit) {
    const cx = Math.floor(unit.x / this.cellSize);
    const cy = Math.floor(unit.y / this.cellSize);
    const k = this.key(cx, cy);
    let list = this.buckets.get(k);
    if (!list) {
      list = [];
      this.buckets.set(k, list);
    }
    list.push(unit);
  }
  query(x, y, radius, out) {
    out.length = 0;
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const list = this.buckets.get(this.key(cx, cy));
        if (list) for (const u of list) out.push(u);
      }
    }
    return out;
  }
}

export class Game {
  /**
   * setup = {
   *   map: <map definition>,
   *   seed: number,
   *   slots: [{ team: number, kind: 'human'|'ai'|'none', difficulty?: string }],
   * }
   */
  constructor(setup) {
    this.setup = setup;
    this.mapDef = setup.map;
    this.seed = setup.seed >>> 0;
    // Gameplay randomness. Anything cosmetic must use fxRng instead, so that
    // turning effects off can never change the outcome of a match.
    this.rng = makeRng(this.seed);
    this.fxRng = makeRng((this.seed ^ 0x5bf03635) >>> 0);

    if (this.mapDef.grid) {
      this.terrain = Terrain.decode(this.mapDef.width, this.mapDef.height, this.mapDef.grid);
    } else {
      this.terrain = new Terrain(this.mapDef.width, this.mapDef.height);
      this.terrain.applyFeatures(this.mapDef.features || [], this.mapDef.seed ?? this.seed);
    }
    for (const c of this.mapDef.cities) this.terrain.clearAround(c.x, c.y, CITY.radius * 2.6);

    this.pathfinder = new Pathfinder(this.terrain);
    this.hash = new SpatialHash(72);
    this.scratch = [];

    this.factions = setup.slots.map((s, i) => ({
      index: i,
      team: s.team,
      kind: s.kind,
      difficulty: s.difficulty || 'normal',
      alive: s.kind !== 'none',
      produced: 0,
      lost: 0,
      killed: 0,
      captured: 0,
    }));

    this.units = [];
    this.unitsById = new Map();
    this.cities = [];
    this.nextUnitId = 1;

    this.mapDef.cities.forEach((c, i) => {
      const slotActive = c.slot >= 0 && this.factions[c.slot] && this.factions[c.slot].alive;
      this.cities.push(new City(i, c.x, c.y, slotActive ? c.slot : -1));
    });

    // Starting garrison.
    for (const city of this.cities) {
      if (city.owner < 0) continue;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        this.spawnUnit(city.owner, 'light', city.x + Math.cos(a) * 40, city.y + Math.sin(a) * 40);
      }
    }

    this.tickCount = 0;
    this.time = 0;
    this.pending = [];
    this.commandLog = [];
    this.recording = true;
    this.over = false;
    this.winnerTeam = -1;
    this.effects = [];
  }

  // ---------------------------------------------------------------- commands

  issue(cmd) {
    cmd.tick = this.tickCount;
    if (this.recording) this.commandLog.push(cmd);
    this.pending.push(cmd);
  }

  // Used during replay playback: inject a logged command without re-logging it.
  inject(cmd) {
    this.pending.push(cmd);
  }

  applyCommands() {
    for (const cmd of this.pending) this.applyCommand(cmd);
    this.pending.length = 0;
  }

  applyCommand(cmd) {
    switch (cmd.type) {
      case 'move':
      case 'attackMove':
        this.orderMove(cmd.faction, cmd.units, cmd.x, cmd.y, cmd.type === 'attackMove');
        break;
      case 'attack':
        this.orderAttack(cmd.faction, cmd.units, cmd.target);
        break;
      case 'stop':
        for (const id of cmd.units) {
          const u = this.unitsById.get(id);
          if (u && u.faction === cmd.faction) u.clearOrder();
        }
        break;
      case 'hold':
        for (const id of cmd.units) {
          const u = this.unitsById.get(id);
          if (u && u.faction === cmd.faction) {
            u.clearOrder();
            u.order = ORDER.HOLD;
          }
        }
        break;
      case 'produce': {
        const city = this.cities[cmd.city];
        if (city && city.owner === cmd.faction) {
          if (city.produce !== cmd.unitType) {
            city.produce = cmd.unitType;
            city.progress = 0;
          }
          city.paused = false;
        }
        break;
      }
      case 'togglePause': {
        const city = this.cities[cmd.city];
        if (city && city.owner === cmd.faction) city.paused = !city.paused;
        break;
      }
      case 'rally': {
        const city = this.cities[cmd.city];
        if (city && city.owner === cmd.faction) city.rally = { x: cmd.x, y: cmd.y };
        break;
      }
      default:
        break;
    }
  }

  orderMove(faction, ids, x, y, attackMove) {
    const units = ids.map((id) => this.unitsById.get(id)).filter((u) => u && u.faction === faction && !u.dead);
    if (!units.length) return;
    const slots = this.formation(units.length, x, y);
    // Assign the nearest slot to each unit so formations do not cross over.
    const taken = new Uint8Array(slots.length);
    for (const u of units) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < slots.length; i++) {
        if (taken[i]) continue;
        const d = (slots[i].x - u.x) ** 2 + (slots[i].y - u.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) best = 0;
      taken[best] = 1;
      const slot = slots[best];
      u.order = attackMove ? ORDER.ATTACK_MOVE : ORDER.MOVE;
      u.targetId = -1;
      u.dest = { x: slot.x, y: slot.y };
      u.path = this.pathfinder.find(u.x, u.y, slot.x, slot.y, u.type);
      u.pathIndex = 0;
      u.stuckTimer = 0;
      if (!u.path) {
        // Unreachable: walk toward it anyway, local steering may find a way.
        u.path = [{ x: slot.x, y: slot.y }];
      }
    }
  }

  orderAttack(faction, ids, targetId) {
    const target = this.unitsById.get(targetId);
    for (const id of ids) {
      const u = this.unitsById.get(id);
      if (!u || u.faction !== faction) continue;
      if (!target || target.dead || this.areAllied(target.faction, faction)) {
        u.clearOrder();
        continue;
      }
      u.order = ORDER.ATTACK;
      u.targetId = targetId;
      u.dest = null;
      u.path = null;
    }
  }

  // Rings of slots around the target point, spaced so units do not overlap.
  formation(count, x, y) {
    const slots = [{ x, y }];
    const spacing = 17;
    let ring = 1;
    while (slots.length < count) {
      const r = ring * spacing;
      const n = Math.max(6, Math.floor((Math.PI * 2 * r) / spacing));
      for (let i = 0; i < n && slots.length < count; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.6;
        const sx = x + Math.cos(a) * r;
        const sy = y + Math.sin(a) * r;
        slots.push({
          x: Math.max(8, Math.min(this.terrain.width - 8, sx)),
          y: Math.max(8, Math.min(this.terrain.height - 8, sy)),
        });
      }
      ring++;
      if (ring > 20) break;
    }
    return slots;
  }

  // ------------------------------------------------------------------- ticks

  spawnUnit(faction, typeKey, x, y) {
    const u = new Unit(this.nextUnitId++, faction, typeKey, x, y);
    this.units.push(u);
    this.unitsById.set(u.id, u);
    this.factions[faction].produced++;
    return u;
  }

  areAllied(a, b) {
    if (a < 0 || b < 0) return false;
    return this.factions[a].team === this.factions[b].team;
  }

  supplyCap(faction) {
    let n = 0;
    for (const c of this.cities) if (c.owner === faction) n++;
    return n * CITY.supply;
  }

  countUnits(faction) {
    let n = 0;
    for (const u of this.units) if (u.faction === faction && !u.dead) n++;
    return n;
  }

  countCities(faction) {
    let n = 0;
    for (const c of this.cities) if (c.owner === faction) n++;
    return n;
  }

  step() {
    if (this.over) return;
    this.applyCommands();
    this.updateCities(DT);
    this.updateSupply(DT);

    this.hash.clear();
    for (const u of this.units) if (!u.dead) this.hash.insert(u);

    for (const u of this.units) if (!u.dead) this.updateUnit(u, DT);

    this.cleanup();
    this.updateEffects(DT);
    this.checkVictory();

    this.tickCount++;
    this.time += DT;
  }

  updateCities(dt) {
    const near = [];
    for (const city of this.cities) {
      // --- capture ---
      this.hash.query(city.x, city.y, CITY.captureRadius, near);
      const presentTeams = new Map(); // team -> {faction, count}
      for (const u of near) {
        if (u.dead) continue;
        if (Math.hypot(u.x - city.x, u.y - city.y) > CITY.captureRadius) continue;
        const team = this.factions[u.faction].team;
        const entry = presentTeams.get(team) || { faction: u.faction, count: 0 };
        entry.count++;
        presentTeams.set(team, entry);
      }
      const ownerTeam = city.owner >= 0 ? this.factions[city.owner].team : -1;
      const attackers = [...presentTeams.entries()].filter(([team]) => team !== ownerTeam);

      const defenderPresent = ownerTeam >= 0 && presentTeams.has(ownerTeam);
      if (attackers.length === 1 && !defenderPresent) {
        const [, info] = attackers[0];
        const speed = Math.min(info.count, CITY.captureMaxUnits) / CITY.captureTime;
        if (city.captureBy !== info.faction) {
          city.captureBy = info.faction;
          city.captureProgress = Math.max(0, city.captureProgress - dt * 2);
          if (city.captureProgress <= 0.01) city.captureProgress = 0;
        }
        city.captureProgress += speed * dt;
        if (city.captureProgress >= 1) {
          const previous = city.owner;
          city.owner = info.faction;
          city.captureProgress = 0;
          city.captureBy = -1;
          city.progress = 0;
          city.paused = false;
          city.rally = null;
          city.produce = 'light';
          this.factions[info.faction].captured++;
          this.effects.push({ kind: 'capture', x: city.x, y: city.y, t: 0, life: 1.2, faction: info.faction });
          this.onCityCaptured?.(city, previous, info.faction);
        }
      } else {
        // Contested or unattended: progress bleeds away.
        city.captureProgress = Math.max(0, city.captureProgress - dt * 0.5);
        if (city.captureProgress === 0) city.captureBy = -1;
      }

      // --- production ---
      if (city.owner < 0 || city.paused) continue;
      const cap = this.supplyCap(city.owner);
      const used = this.countUnits(city.owner);
      if (used >= cap) {
        // Full: production idles at the brink instead of wasting progress.
        city.progress = Math.min(city.progress, city.buildTime() * 0.999);
        continue;
      }
      city.progress += dt;
      if (city.progress >= city.buildTime()) {
        city.progress -= city.buildTime();
        const angle = this.rng() * Math.PI * 2;
        const r = CITY.radius + 14;
        let sx = city.x + Math.cos(angle) * r;
        let sy = city.y + Math.sin(angle) * r;
        if (!this.terrain.isPassable(sx, sy)) {
          sx = city.x;
          sy = city.y;
        }
        const unit = this.spawnUnit(city.owner, city.produce, sx, sy);
        if (city.rally) {
          this.orderMove(city.owner, [unit.id], city.rally.x, city.rally.y, true);
        }
      }
    }
  }

  updateSupply(dt) {
    for (const faction of this.factions) {
      if (!faction.alive) continue;
      const cap = this.supplyCap(faction.index);
      const own = this.units.filter((u) => !u.dead && u.faction === faction.index);
      if (own.length <= cap) {
        for (const u of own) u.starving = false;
      } else {
        // The units furthest from friendly supply are the ones that go hungry.
        const withDist = own.map((u) => ({ u, d: this.distToOwnCity(u) }));
        withDist.sort((a, b) => b.d - a.d);
        const overflow = own.length - cap;
        for (let i = 0; i < withDist.length; i++) withDist[i].u.starving = i < overflow;
      }
    }

    for (const u of this.units) {
      if (u.dead) continue;
      if (u.starving) {
        u.hp -= STARVE_DPS * dt;
        if (u.hp <= 0) this.kill(u, -1);
      } else if (u.hp < u.maxHp && this.distToOwnCity(u) < CITY.captureRadius) {
        u.hp = Math.min(u.maxHp, u.hp + RESUPPLY_HPS * dt);
      }
    }
  }

  distToOwnCity(unit) {
    let best = Infinity;
    for (const c of this.cities) {
      if (c.owner !== unit.faction) continue;
      const d = Math.hypot(c.x - unit.x, c.y - unit.y);
      if (d < best) best = d;
    }
    return best;
  }

  terrainMods(unit) {
    const cell = this.terrain.at(unit.x, unit.y);
    if (cell === TERRAIN.ROUGH) return unit.stats.rough;
    return null;
  }

  findTarget(unit, radius) {
    const list = this.hash.query(unit.x, unit.y, radius, this.scratch);
    let best = null;
    let bestD = Infinity;
    for (const other of list) {
      if (other.dead || other.faction === unit.faction) continue;
      if (this.areAllied(other.faction, unit.faction)) continue;
      const d = Math.hypot(other.x - unit.x, other.y - unit.y) - other.radius;
      if (d < bestD && d <= radius) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  updateUnit(unit, dt) {
    if (unit.attackCooldown > 0) unit.attackCooldown -= dt;

    const range = unit.stats.range + unit.radius;
    let target = unit.targetId >= 0 ? this.unitsById.get(unit.targetId) : null;
    if (target && (target.dead || this.areAllied(target.faction, unit.faction))) target = null;

    const chasing = unit.order === ORDER.ATTACK || unit.order === ORDER.ATTACK_MOVE;

    if (!target) {
      const acquireRadius = chasing ? range * 3.2 : unit.order === ORDER.MOVE ? range : range * 1.9;
      target = this.findTarget(unit, acquireRadius);
      unit.targetId = target ? target.id : -1;
    }

    let moved = false;

    if (target) {
      const dx = target.x - unit.x;
      const dy = target.y - unit.y;
      const dist = Math.hypot(dx, dy) - target.radius;
      if (dist <= range) {
        this.dealDamage(unit, target, dt);
        // Hold position while firing; move orders still take priority.
        if (unit.order === ORDER.MOVE) {
          moved = this.followPath(unit, dt);
        }
      } else if (unit.order === ORDER.ATTACK) {
        moved = this.steer(unit, target.x, target.y, dt);
      } else if (unit.order === ORDER.ATTACK_MOVE) {
        moved = this.steer(unit, target.x, target.y, dt);
      } else if (unit.order === ORDER.MOVE) {
        moved = this.followPath(unit, dt);
      } else if (unit.order === ORDER.IDLE && dist < range * 1.9) {
        moved = this.steer(unit, target.x, target.y, dt);
      }
    } else {
      if (unit.order === ORDER.ATTACK) unit.clearOrder();
      if (unit.order === ORDER.MOVE || unit.order === ORDER.ATTACK_MOVE) {
        moved = this.followPath(unit, dt);
      }
    }

    if (!moved) this.separate(unit, dt);

    // Anti-jam: units that ask to move but do not are re-pathed, then give up.
    if (unit.order === ORDER.MOVE || unit.order === ORDER.ATTACK_MOVE) {
      const delta = Math.hypot(unit.x - unit.lastX, unit.y - unit.lastY);
      if (delta < unit.stats.speed * dt * 0.25) {
        unit.stuckTimer += dt;
        if (unit.stuckTimer > 1.5 && unit.dest) {
          unit.path = this.pathfinder.find(unit.x, unit.y, unit.dest.x, unit.dest.y, unit.type);
          unit.pathIndex = 0;
          unit.stuckTimer = 0;
          if (!unit.path) unit.clearOrder();
        }
      } else {
        unit.stuckTimer = 0;
      }
    }
    unit.lastX = unit.x;
    unit.lastY = unit.y;
  }

  dealDamage(attacker, defender, dt) {
    const atkMods = this.terrainMods(attacker);
    const defMods = this.terrainMods(defender);
    let dps = attacker.stats.dps;
    if (atkMods) dps *= atkMods.damage;
    if (defMods) dps *= defMods.taken;
    defender.hp -= dps * dt;
    attacker.attackCooldown = 0.12;
    if (this.fxRng() < dt * 6) {
      this.effects.push({
        kind: 'tracer',
        x1: attacker.x, y1: attacker.y, x2: defender.x, y2: defender.y,
        faction: attacker.faction, t: 0, life: 0.12,
      });
    }
    if (defender.hp <= 0) this.kill(defender, attacker.faction);
  }

  kill(unit, byFaction) {
    if (unit.dead) return;
    unit.dead = true;
    this.factions[unit.faction].lost++;
    if (byFaction >= 0 && this.factions[byFaction]) this.factions[byFaction].killed++;
    this.effects.push({ kind: 'death', x: unit.x, y: unit.y, faction: unit.faction, t: 0, life: 0.45, r: unit.radius });
  }

  followPath(unit, dt) {
    if (!unit.path || unit.pathIndex >= unit.path.length) {
      if (unit.order === ORDER.MOVE || unit.order === ORDER.ATTACK_MOVE) unit.clearOrder();
      return false;
    }
    const wp = unit.path[unit.pathIndex];
    const d = Math.hypot(wp.x - unit.x, wp.y - unit.y);
    const isLast = unit.pathIndex === unit.path.length - 1;
    if (d < (isLast ? 6 : 16)) {
      unit.pathIndex++;
      if (unit.pathIndex >= unit.path.length) {
        unit.clearOrder();
        return false;
      }
    }
    const next = unit.path[unit.pathIndex];
    return this.steer(unit, next.x, next.y, dt);
  }

  steer(unit, tx, ty, dt) {
    const dx = tx - unit.x;
    const dy = ty - unit.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.5) return false;

    const mods = this.terrainMods(unit);
    const speed = unit.stats.speed * (mods ? mods.speed : 1);

    let vx = (dx / d) * speed;
    let vy = (dy / d) * speed;

    const sep = this.separationVector(unit);
    vx += sep.x * speed * 0.9;
    vy += sep.y * speed * 0.9;

    const len = Math.hypot(vx, vy);
    if (len > speed) {
      vx = (vx / len) * speed;
      vy = (vy / len) * speed;
    }

    this.applyVelocity(unit, vx, vy, dt);
    return true;
  }

  separate(unit, dt) {
    const sep = this.separationVector(unit);
    if (!sep.x && !sep.y) return;
    const mods = this.terrainMods(unit);
    const speed = unit.stats.speed * (mods ? mods.speed : 1) * 0.55;
    this.applyVelocity(unit, sep.x * speed, sep.y * speed, dt);
  }

  separationVector(unit) {
    const list = this.hash.query(unit.x, unit.y, 26, this.scratch);
    let sx = 0;
    let sy = 0;
    for (const other of list) {
      if (other === unit || other.dead) continue;
      const dx = unit.x - other.x;
      const dy = unit.y - other.y;
      const minDist = unit.radius + other.radius + 1.5;
      const d = Math.hypot(dx, dy);
      if (d > minDist || d === 0) continue;
      const push = (minDist - d) / minDist;
      sx += (dx / d) * push;
      sy += (dy / d) * push;
    }
    const len = Math.hypot(sx, sy);
    if (len > 1) {
      sx /= len;
      sy /= len;
    }
    return { x: sx, y: sy };
  }

  applyVelocity(unit, vx, vy, dt) {
    let nx = unit.x + vx * dt;
    let ny = unit.y + vy * dt;
    if (!this.terrain.isPassable(nx, ny)) {
      // Slide along whichever axis is still walkable.
      if (this.terrain.isPassable(nx, unit.y)) {
        ny = unit.y;
      } else if (this.terrain.isPassable(unit.x, ny)) {
        nx = unit.x;
      } else {
        return;
      }
    }
    unit.x = Math.max(2, Math.min(this.terrain.width - 2, nx));
    unit.y = Math.max(2, Math.min(this.terrain.height - 2, ny));
    unit.vx = vx;
    unit.vy = vy;
  }

  cleanup() {
    if (!this.units.some((u) => u.dead)) return;
    for (const u of this.units) {
      if (u.dead) this.unitsById.delete(u.id);
    }
    this.units = this.units.filter((u) => !u.dead);
  }

  updateEffects(dt) {
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter((e) => e.t < e.life);
    if (this.effects.length > 400) this.effects.splice(0, this.effects.length - 400);
  }

  checkVictory() {
    const teams = new Set();
    for (const f of this.factions) {
      if (!f.alive) continue;
      const hasCities = this.countCities(f.index) > 0;
      const hasUnits = this.countUnits(f.index) > 0;
      if (!hasCities && !hasUnits) {
        f.alive = false;
        continue;
      }
      teams.add(f.team);
    }
    if (teams.size <= 1) {
      this.over = true;
      this.winnerTeam = teams.size === 1 ? [...teams][0] : -1;
    }
  }
}

export { ORDER };
