import {
  DT, UNITS, BASE, CITY, ECONOMY, MORALE, SUPPLY, DETECTION, VICTORY, info,
} from './config.js';
import { Terrain, buildRoads } from './terrain.js';
import { Pathfinder } from './pathfinder.js';
import { Unit, Base, City, ORDER } from './entities.js';
import { InfluenceField } from './influence.js';
import { assignPosts, segmentUnits, manTheLine, SPACING } from './line.js';
import { makeRng } from './rng.js';

// How often the territory / supply field is rebuilt. It is part of the
// simulation (it decides starvation and victory), so it runs on a fixed tick
// count rather than a wall-clock timer.
const INFLUENCE_INTERVAL = 12;

class SpatialHash {
  constructor(cellSize = 72) {
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
    const k = this.key(Math.floor(unit.x / this.cellSize), Math.floor(unit.y / this.cellSize));
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
    this.rng = makeRng(this.seed);
    this.fxRng = makeRng((this.seed ^ 0x5bf03635) >>> 0);

    if (this.mapDef.grid) {
      this.terrain = Terrain.decode(this.mapDef.width, this.mapDef.height, this.mapDef.grid);
    } else {
      this.terrain = new Terrain(this.mapDef.width, this.mapDef.height);
      this.terrain.applyFeatures(this.mapDef.features || [], this.mapDef.seed ?? this.seed);
    }
    for (const c of this.mapDef.cities) this.terrain.clearAround(c.x, c.y, BASE.radius * 2);
    buildRoads(this.terrain, this.mapDef.cities, this.mapDef.seed ?? this.seed);

    this.pathfinder = new Pathfinder(this.terrain);
    this.hash = new SpatialHash(72);
    this.scratch = [];

    this.factions = setup.slots.map((s, i) => ({
      index: i,
      team: s.team,
      kind: s.kind,
      difficulty: s.difficulty || 'normal',
      alive: s.kind !== 'none',
      gold: ECONOMY.startGold,
      income: 0,
      upkeep: 0,
      produced: 0,
      producedHeavy: 0,
      lost: 0,
      killed: 0,
      captured: 0,
      basesLost: 0,
      peakTerritory: 0,
    }));

    this.units = [];
    this.unitsById = new Map();
    this.bases = [];
    this.cities = [];
    this.nextUnitId = 1;

    // A map's player start positions become bases; everything else is a city.
    for (const spec of this.mapDef.cities) {
      const active = spec.slot >= 0 && this.factions[spec.slot] && this.factions[spec.slot].alive;
      if (spec.slot >= 0) {
        if (active) this.bases.push(new Base(this.bases.length, spec.x, spec.y, spec.slot));
        else this.cities.push(new City(this.cities.length, spec.x, spec.y));
      } else {
        this.cities.push(new City(this.cities.length, spec.x, spec.y));
      }
    }

    // A pair of scouts so the opening is not pure waiting.
    for (const base of this.bases) {
      for (let i = 0; i < 2; i++) {
        const a = (i / 2) * Math.PI * 2 + 0.6;
        this.spawnUnit(base.owner, 'light', base.x + Math.cos(a) * 48, base.y + Math.sin(a) * 48);
      }
    }

    this.influence = new InfluenceField(this);
    this.influence.update();

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
      case 'advance':
        this.orderAdvance(cmd.faction, cmd.fromX, cmd.fromY, cmd.x, cmd.y, cmd.radius);
        break;
      case 'attack':
        this.orderAttack(cmd.faction, cmd.units, cmd.target, cmd.targetKind || 'unit');
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
        const base = this.bases[cmd.base];
        if (base && !base.dead && base.owner === cmd.faction) {
          if (base.produce !== cmd.unitType) {
            // Refund whatever was already paid for the cancelled unit.
            if (base.charged) this.factions[base.owner].gold += UNITS[base.produce].cost;
            base.produce = cmd.unitType;
            base.progress = 0;
            base.charged = false;
          }
          base.paused = false;
        }
        break;
      }
      case 'togglePause': {
        const base = this.bases[cmd.base];
        if (base && !base.dead && base.owner === cmd.faction) base.paused = !base.paused;
        break;
      }
      case 'rally': {
        const base = this.bases[cmd.base];
        if (base && !base.dead && base.owner === cmd.faction) base.rally = { x: cmd.x, y: cmd.y };
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
      u.targetBaseId = -1;
      u.dest = { x: slot.x, y: slot.y };
      u.path = this.pathfinder.find(u.x, u.y, slot.x, slot.y, u.type);
      u.pathIndex = 0;
      u.stuckTimer = 0;
      if (!u.path) u.path = [{ x: slot.x, y: slot.y }];
    }
  }

  // A dragged arrow: take the stretch of line under its tail and push it to the
  // head, keeping the units abreast instead of letting them pile into a column.
  orderAdvance(faction, fromX, fromY, x, y, radius) {
    const own = this.units.filter((u) => !u.dead && u.faction === faction);
    const picked = segmentUnits(own, fromX, fromY, radius);
    if (!picked.length) return;
    for (const { unit, post } of assignPosts(picked, fromX, fromY, x, y)) {
      unit.order = ORDER.ATTACK_MOVE;
      unit.targetId = -1;
      unit.targetBaseId = -1;
      unit.post = { x: post.x, y: post.y };
      unit.dest = { x: post.x, y: post.y };
      unit.path = this.pathfinder.find(unit.x, unit.y, post.x, post.y, unit.type);
      unit.pathIndex = 0;
      unit.stuckTimer = 0;
      if (!unit.path) unit.path = [{ x: post.x, y: post.y }];
    }
  }

  nearestHomePoint(faction, x, y) {
    let best = null;
    let bestD = Infinity;
    const consider = (p) => {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    for (const b of this.bases) if (!b.dead && this.areAlliedOrSame(b.owner, faction)) consider(b);
    for (const c of this.cities) if (c.owner >= 0 && this.areAlliedOrSame(c.owner, faction)) consider(c);
    return best;
  }

  orderAttack(faction, ids, targetId, targetKind) {
    const target = targetKind === 'base' ? this.bases[targetId] : this.unitsById.get(targetId);
    const valid = target && !target.dead && !this.areAllied(target.faction ?? target.owner, faction);
    for (const id of ids) {
      const u = this.unitsById.get(id);
      if (!u || u.faction !== faction) continue;
      if (!valid) {
        u.clearOrder();
        continue;
      }
      u.order = ORDER.ATTACK;
      u.targetId = targetKind === 'base' ? -1 : targetId;
      u.targetBaseId = targetKind === 'base' ? targetId : -1;
      u.dest = null;
      u.path = null;
    }
  }

  formation(count, x, y) {
    const slots = [{ x, y }];
    const spacing = 19;
    let ring = 1;
    while (slots.length < count) {
      const r = ring * spacing;
      const n = Math.max(6, Math.floor((Math.PI * 2 * r) / spacing));
      for (let i = 0; i < n && slots.length < count; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.6;
        slots.push({
          x: Math.max(8, Math.min(this.terrain.width - 8, x + Math.cos(a) * r)),
          y: Math.max(8, Math.min(this.terrain.height - 8, y + Math.sin(a) * r)),
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
    if (typeKey === 'heavy') this.factions[faction].producedHeavy++;
    return u;
  }

  areAllied(a, b) {
    if (a == null || b == null || a < 0 || b < 0) return false;
    return this.factions[a].team === this.factions[b].team;
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

  countBases(faction) {
    let n = 0;
    for (const b of this.bases) if (!b.dead && b.owner === faction) n++;
    return n;
  }

  territoryShare(faction) {
    return this.influence.shareForTeam(this.factions[faction].team);
  }

  step() {
    if (this.over) return;
    this.applyCommands();

    if (this.tickCount % INFLUENCE_INTERVAL === 0) this.influence.update();

    this.hash.clear();
    for (const u of this.units) if (!u.dead) this.hash.insert(u);

    this.updateCities(DT);
    this.updateGarrisons();
    this.updateEconomy(DT);
    this.updateBases(DT);
    this.updateVisibility();

    for (const u of this.units) if (!u.dead) this.updateUnit(u, DT);

    this.cleanup();
    this.updateEffects(DT);
    this.checkVictory();

    this.tickCount++;
    this.time += DT;
  }

  // Only a city feeds its garrison for free — that is the whole reason to take
  // them. A base repairs and steadies troops but still pays their upkeep.
  updateGarrisons() {
    for (const u of this.units) {
      u.garrisoned = false;
      u.atHome = false;
    }
    const mark = (x, y, radius, owner, field) => {
      const list = this.hash.query(x, y, radius, this.scratch);
      for (const u of list) {
        if (u.dead || !this.areAlliedOrSame(u.faction, owner)) continue;
        if (Math.hypot(u.x - x, u.y - y) <= radius) u[field] = true;
      }
    };
    for (const c of this.cities) {
      if (c.owner < 0) continue;
      mark(c.x, c.y, CITY.freeRadius, c.owner, 'garrisoned');
      mark(c.x, c.y, CITY.freeRadius, c.owner, 'atHome');
    }
    for (const b of this.bases) {
      if (b.dead || b.owner < 0) continue;
      mark(b.x, b.y, BASE.freeRadius, b.owner, 'atHome');
    }
  }

  areAlliedOrSame(a, b) {
    return a === b || this.areAllied(a, b);
  }

  updateEconomy(dt) {
    for (const f of this.factions) {
      if (!f.alive) continue;
      let income = 0;
      for (const b of this.bases) if (!b.dead && b.owner === f.index) income += BASE.income;
      for (const c of this.cities) if (c.owner === f.index) income += CITY.income;

      let upkeep = 0;
      for (const u of this.units) {
        if (u.dead || u.faction !== f.index) continue;
        if (!u.garrisoned) upkeep += ECONOMY.upkeepPerUnit;
      }

      f.income = income;
      f.upkeep = upkeep;
      f.gold = Math.max(ECONOMY.minGold, f.gold + (income - upkeep) * dt);

      const share = this.territoryShare(f.index);
      if (share > f.peakTerritory) f.peakTerritory = share;
    }

    // In the red: everything in the field starts to starve.
    for (const u of this.units) {
      if (u.dead) continue;
      const f = this.factions[u.faction];
      const deficit = f.upkeep - f.income;
      const broke = f.gold <= 0 && deficit > 0;
      u.starving = broke && !u.garrisoned;
      if (u.starving) {
        const dps = Math.min(ECONOMY.maxStarveDps, deficit * ECONOMY.starveDpsPerGold);
        u.hp -= dps * dt;
        u.morale = Math.max(0, u.morale - 0.12 * dt);
        if (u.hp <= 0) this.kill(u, -1);
      }
    }
  }

  updateBases(dt) {
    for (const base of this.bases) {
      if (base.dead) continue;
      base.sinceHit += dt;
      if (base.sinceHit > BASE.regenDelay && base.hp < base.maxHp) {
        base.hp = Math.min(base.maxHp, base.hp + BASE.regen * dt);
      }
      if (base.owner < 0 || base.paused) continue;

      const faction = this.factions[base.owner];
      const cost = UNITS[base.produce].cost;
      if (!base.charged) {
        // Production only starts once the unit is paid for.
        if (faction.gold < cost) continue;
        faction.gold -= cost;
        base.charged = true;
        base.progress = 0;
      }

      base.progress += dt;
      if (base.progress >= base.buildTime()) {
        base.progress = 0;
        base.charged = false;
        const angle = this.rng() * Math.PI * 2;
        const r = BASE.radius + 16;
        let sx = base.x + Math.cos(angle) * r;
        let sy = base.y + Math.sin(angle) * r;
        if (!this.terrain.isPassable(sx, sy)) {
          sx = base.x;
          sy = base.y;
        }
        const unit = this.spawnUnit(base.owner, base.produce, sx, sy);
        if (base.rally) this.orderMove(base.owner, [unit.id], base.rally.x, base.rally.y, true);
      }
    }
  }

  updateCities(dt) {
    const near = [];
    for (const city of this.cities) {
      this.hash.query(city.x, city.y, CITY.captureRadius, near);
      const presentTeams = new Map();
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
        const [, entry] = attackers[0];
        const speed = Math.min(entry.count, CITY.captureMaxUnits) / CITY.captureTime;
        if (city.captureBy !== entry.faction) {
          city.captureBy = entry.faction;
          city.captureProgress = Math.max(0, city.captureProgress - dt * 2);
        }
        city.captureProgress += speed * dt;
        if (city.captureProgress >= 1) {
          city.owner = entry.faction;
          city.captureProgress = 0;
          city.captureBy = -1;
          this.factions[entry.faction].captured++;
          this.effects.push({ kind: 'capture', x: city.x, y: city.y, t: 0, life: 1.2, faction: entry.faction });
        }
      } else {
        city.captureProgress = Math.max(0, city.captureProgress - dt * 0.5);
        if (city.captureProgress === 0) city.captureBy = -1;
      }
    }
  }

  // Units standing in cover are invisible until an enemy gets close.
  updateVisibility() {
    const allMask = (1 << this.factions.length) - 1;
    for (const u of this.units) {
      if (u.dead) continue;
      if (!info(this.terrain.at(u.x, u.y)).cover) {
        u.visibleMask = allMask;
        continue;
      }
      let mask = 0;
      for (const f of this.factions) {
        if (this.areAlliedOrSame(f.index, u.faction)) mask |= 1 << f.index;
      }
      const near = this.hash.query(u.x, u.y, DETECTION.spotRadius, this.scratch);
      for (const other of near) {
        if (other.dead || (mask & (1 << other.faction))) continue;
        if (Math.hypot(other.x - u.x, other.y - u.y) <= DETECTION.spotRadius) mask |= 1 << other.faction;
      }
      u.visibleMask = mask;
    }
  }

  isVisibleTo(unit, faction) {
    return (unit.visibleMask & (1 << faction)) !== 0;
  }

  terrainMods(unit) {
    const cell = info(this.terrain.at(unit.x, unit.y));
    return cell.rough ? unit.stats.rough : null;
  }

  speedFactor(unit) {
    const cell = info(this.terrain.at(unit.x, unit.y));
    let s = cell.speed;
    if (unit.type === 'heavy') s *= cell.heavyBonus;
    return s * (MORALE.minSpeed + (1 - MORALE.minSpeed) * unit.morale);
  }

  findTarget(unit, radius) {
    const list = this.hash.query(unit.x, unit.y, radius, this.scratch);
    let best = null;
    let bestD = Infinity;
    for (const other of list) {
      if (other.dead || this.areAlliedOrSame(other.faction, unit.faction)) continue;
      if (!this.isVisibleTo(other, unit.faction)) continue;
      const d = Math.hypot(other.x - unit.x, other.y - unit.y) - other.radius;
      if (d < bestD && d <= radius) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  findEnemyBase(unit, radius) {
    let best = null;
    let bestD = Infinity;
    for (const b of this.bases) {
      if (b.dead || b.owner < 0 || this.areAlliedOrSame(b.owner, unit.faction)) continue;
      const d = Math.hypot(b.x - unit.x, b.y - unit.y) - b.radius;
      if (d < bestD && d <= radius) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  updateUnit(unit, dt) {
    if (unit.attackCooldown > 0) unit.attackCooldown -= dt;
    unit.sinceHit += dt;

    this.updateSupplyState(unit, dt);
    this.updateMorale(unit, dt);
    if (unit.dead) return;

    const range = unit.stats.range + unit.radius;
    const chasing = unit.order === ORDER.ATTACK || unit.order === ORDER.ATTACK_MOVE;

    // A commanded base assault takes priority over anything else.
    let base = unit.targetBaseId >= 0 ? this.bases[unit.targetBaseId] : null;
    if (base && base.dead) {
      base = null;
      unit.targetBaseId = -1;
      if (unit.order === ORDER.ATTACK) unit.clearOrder();
    }

    let target = unit.targetId >= 0 ? this.unitsById.get(unit.targetId) : null;
    if (target && (target.dead || this.areAlliedOrSame(target.faction, unit.faction))) target = null;

    if (!target && !base) {
      const acquireRadius = chasing ? range * 3.2 : unit.order === ORDER.MOVE ? range : range * 1.9;
      target = this.findTarget(unit, acquireRadius);
      unit.targetId = target ? target.id : -1;
      if (!target && unit.order !== ORDER.MOVE) {
        const enemyBase = this.findEnemyBase(unit, range);
        if (enemyBase) base = enemyBase;
      }
    }

    let moved = false;

    if (target) {
      const dist = Math.hypot(target.x - unit.x, target.y - unit.y) - target.radius;
      if (dist <= range) {
        this.dealDamage(unit, target, dt);
        if (unit.order === ORDER.MOVE) moved = this.followPath(unit, dt);
      } else if (chasing) {
        moved = this.steer(unit, target.x, target.y, dt);
      } else if (unit.order === ORDER.MOVE) {
        moved = this.followPath(unit, dt);
      } else if (unit.order === ORDER.IDLE && dist < range * 1.9) {
        moved = this.steer(unit, target.x, target.y, dt);
      }
    } else if (base) {
      const dist = Math.hypot(base.x - unit.x, base.y - unit.y) - base.radius;
      if (dist <= range) {
        this.damageBase(unit, base, dt);
      } else if (unit.order === ORDER.ATTACK) {
        moved = this.steer(unit, base.x, base.y, dt);
      } else if (unit.order === ORDER.MOVE || unit.order === ORDER.ATTACK_MOVE) {
        moved = this.followPath(unit, dt);
      }
    } else {
      if (unit.order === ORDER.ATTACK) unit.clearOrder();
      if (unit.order === ORDER.MOVE || unit.order === ORDER.ATTACK_MOVE) moved = this.followPath(unit, dt);
      else if (unit.order === ORDER.IDLE) moved = this.holdLine(unit, dt);
    }

    if (!moved) this.separate(unit, dt);

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

  // Idle troops are not spectators: they walk to the nearest stretch of front
  // and stand shoulder to shoulder with whoever is already there. This is what
  // turns a crowd into a line, and what closes a gap when somebody dies.
  holdLine(unit, dt) {
    const team = this.factions[unit.faction].team;
    const front = this.influence.frontForTeam(team);
    const target = manTheLine(this, unit, front);
    if (!target) return false;

    // Slide along the line rather than stacking on the same spot.
    const list = this.hash.query(unit.x, unit.y, SPACING, this.scratch);
    let sx = 0;
    let sy = 0;
    for (const other of list) {
      if (other === unit || other.dead || other.faction !== unit.faction) continue;
      const dx = unit.x - other.x;
      const dy = unit.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d === 0 || d > SPACING) continue;
      sx += (dx / d) * (SPACING - d);
      sy += (dy / d) * (SPACING - d);
    }

    const tx = target.x + sx;
    const ty = target.y + sy;
    if (Math.hypot(tx - unit.x, ty - unit.y) < 4) return false;
    return this.steer(unit, tx, ty, dt);
  }

  // Encirclement: cut the route home and the unit collapses within seconds.
  updateSupplyState(unit, dt) {
    const team = this.factions[unit.faction].team;
    const supplied = this.influence.isSuppliedAt(unit.x, unit.y, team);
    unit.supplied = supplied;
    if (supplied) {
      unit.cutoffTimer = 0;
      return;
    }
    unit.cutoffTimer += dt;
    if (unit.cutoffTimer < SUPPLY.graceSeconds) return;
    unit.hp -= unit.maxHp * SUPPLY.dpsFraction * dt;
    unit.morale = Math.max(0, unit.morale - SUPPLY.moraleDrain * dt);
    if (unit.hp <= 0) this.kill(unit, -1);
  }

  updateMorale(unit, dt) {
    if (unit.sinceHit < 0.4) {
      unit.morale = Math.max(0, unit.morale - MORALE.lossPerSecondUnderFire * dt);
    } else if (unit.sinceHit > MORALE.calmDelay) {
      const rate = unit.atHome ? MORALE.recoveryInSupply : MORALE.recoveryPerSecond;
      unit.morale = Math.min(1, unit.morale + rate * dt);
    }
    if (unit.atHome && unit.hp < unit.maxHp && unit.sinceHit > MORALE.calmDelay) {
      unit.hp = Math.min(unit.maxHp, unit.hp + 7 * dt);
    }
  }

  outgoingDamage(attacker) {
    const mods = this.terrainMods(attacker);
    let dps = attacker.stats.dps;
    if (mods) dps *= mods.damage;
    dps *= MORALE.minDamage + (1 - MORALE.minDamage) * attacker.morale;
    return dps;
  }

  dealDamage(attacker, defender, dt) {
    const defMods = this.terrainMods(defender);
    let dps = this.outgoingDamage(attacker);
    if (defMods) dps *= defMods.taken;
    defender.hp -= dps * dt;
    defender.sinceHit = 0;
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

  damageBase(attacker, base, dt) {
    base.hp -= this.outgoingDamage(attacker) * dt;
    base.sinceHit = 0;
    attacker.attackCooldown = 0.12;
    if (this.fxRng() < dt * 6) {
      this.effects.push({
        kind: 'tracer',
        x1: attacker.x, y1: attacker.y, x2: base.x, y2: base.y,
        faction: attacker.faction, t: 0, life: 0.12,
      });
    }
    if (base.hp <= 0) this.destroyBase(base, attacker.faction);
  }

  destroyBase(base, byFaction) {
    if (base.dead) return;
    base.dead = true;
    base.hp = 0;
    this.factions[base.owner].basesLost++;
    this.effects.push({ kind: 'baseFall', x: base.x, y: base.y, faction: base.owner, t: 0, life: 1.6 });
    void byFaction;
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

    const speed = unit.stats.speed * this.speedFactor(unit);
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
    const speed = unit.stats.speed * this.speedFactor(unit) * 0.55;
    this.applyVelocity(unit, sep.x * speed, sep.y * speed, dt);
  }

  separationVector(unit) {
    const list = this.hash.query(unit.x, unit.y, 30, this.scratch);
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
      if (this.terrain.isPassable(nx, unit.y)) ny = unit.y;
      else if (this.terrain.isPassable(unit.x, ny)) nx = unit.x;
      else return;
    }
    unit.x = Math.max(2, Math.min(this.terrain.width - 2, nx));
    unit.y = Math.max(2, Math.min(this.terrain.height - 2, ny));
    unit.vx = vx;
    unit.vy = vy;
  }

  cleanup() {
    if (!this.units.some((u) => u.dead)) return;
    for (const u of this.units) if (u.dead) this.unitsById.delete(u.id);
    this.units = this.units.filter((u) => !u.dead);
  }

  updateEffects(dt) {
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter((e) => e.t < e.life);
    if (this.effects.length > 400) this.effects.splice(0, this.effects.length - 400);
  }

  // Win by razing every enemy base, or by holding three quarters of the map.
  checkVictory() {
    const liveTeams = new Set();
    for (const f of this.factions) {
      if (!f.alive) continue;
      if (this.countBases(f.index) === 0) {
        f.alive = false;
        // Without a base there is no way back: the remnants disband.
        for (const u of this.units) if (u.faction === f.index) this.kill(u, -1);
        continue;
      }
      liveTeams.add(f.team);
    }

    if (liveTeams.size <= 1) {
      this.over = true;
      this.winnerTeam = liveTeams.size === 1 ? [...liveTeams][0] : -1;
      return;
    }

    for (const team of liveTeams) {
      if (this.influence.shareForTeam(team) >= VICTORY.territoryShare) {
        this.over = true;
        this.winnerTeam = team;
        return;
      }
    }
  }
}

export { ORDER };
