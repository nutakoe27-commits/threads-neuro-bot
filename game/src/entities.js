import { UNITS, CITY, BASE } from './config.js';

export const ORDER = {
  IDLE: 'idle',
  MOVE: 'move',
  ATTACK_MOVE: 'attackMove',
  ATTACK: 'attack',
  HOLD: 'hold',
};

export class Unit {
  constructor(id, faction, typeKey, x, y) {
    const stats = UNITS[typeKey];
    this.id = id;
    this.faction = faction;
    this.type = typeKey;
    this.stats = stats;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.hp = stats.hp;
    this.maxHp = stats.hp;
    this.order = ORDER.IDLE;
    this.dest = null;          // {x, y}
    this.post = null;          // standing place in the line, if it has one
    this.path = null;          // waypoint list
    this.pathIndex = 0;
    this.targetId = -1;        // enemy unit being attacked
    this.targetBaseId = -1;    // enemy base being attacked
    this.attackCooldown = 0;
    this.morale = 1;
    this.sinceHit = 99;        // seconds since last taking damage
    this.supplied = true;
    this.cutoffTimer = 0;
    this.garrisoned = false;   // inside a friendly city, so upkeep is free
    this.atHome = false;       // inside a friendly base or city: repairs and rallies
    this.starving = false;
    this.visibleMask = 0;      // bit per faction that can currently see this unit
    this.stuckTimer = 0;
    this.lastX = x;
    this.lastY = y;
    this.dead = false;
  }

  get radius() {
    return this.stats.radius;
  }

  clearOrder() {
    this.order = ORDER.IDLE;
    this.dest = null;
    this.post = null;
    this.path = null;
    this.pathIndex = 0;
    this.targetId = -1;
    this.targetBaseId = -1;
  }
}

// A main base: the gold engine, the factory, and the thing you must destroy.
export class Base {
  constructor(id, x, y, owner) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.owner = owner;
    this.hp = BASE.hp;
    this.maxHp = BASE.hp;
    this.radius = BASE.radius;
    this.produce = 'light';
    this.progress = 0;
    this.paused = false;
    this.charged = false;   // gold for the unit under construction is paid up front
    this.rally = null;
    this.sinceHit = 99;
    this.dead = false;
  }

  buildTime() {
    return UNITS[this.produce].buildTime;
  }
}

// A neutral point worth capturing: pure economy, plus free upkeep for whoever
// garrisons it.
export class City {
  constructor(id, x, y) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.owner = -1;
    this.produce = 'light';
    this.progress = 0;
    this.paused = false;
    this.rally = null;
    this.dead = false;
    this.captureBy = -1;
    this.captureProgress = 0;
    this.radius = CITY.radius;
  }
}
