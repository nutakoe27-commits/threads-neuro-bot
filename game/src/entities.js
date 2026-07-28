import { UNITS, CITY } from './config.js';

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
    this.dest = null;        // {x, y}
    this.path = null;        // waypoint list
    this.pathIndex = 0;
    this.targetId = -1;      // current attack target
    this.attackCooldown = 0; // purely cosmetic pacing for the muzzle flash
    this.starving = false;
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
    this.path = null;
    this.pathIndex = 0;
    this.targetId = -1;
  }
}

export class City {
  constructor(id, x, y, owner) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.owner = owner;        // faction index, or -1 for neutral
    this.produce = 'light';    // which unit type this city builds
    this.progress = 0;         // seconds accumulated toward the current unit
    this.paused = false;       // player toggled production off
    this.captureBy = -1;
    this.captureProgress = 0;
    this.rally = null;
    this.radius = CITY.radius;
  }

  buildTime() {
    return UNITS[this.produce].buildTime;
  }
}
