// Core balance & presentation constants for War of Dots.
// Everything the simulation needs is here so the numbers stay in one place.

export const SIM_HZ = 60;
export const DT = 1 / SIM_HZ;

// Terrain type ids. 0/1/2 keep their original meaning so map files saved by
// earlier versions of the editor still load.
export const TERRAIN = {
  PLAINS: 0,
  FOREST: 1,
  WATER: 2,
  HILLS: 3,
  MOUNTAIN: 4,
  ROAD: 5,
  BRIDGE: 6,
};

// `speed` is a flat movement multiplier, `rough` is the combat category heavy
// units suffer in, and `cover` hides whoever stands in it from enemy radar.
// `heavyBonus` is the open-ground speed reward for heavy units.
export const TERRAIN_INFO = [
  { id: 0, key: 'plains',   name: 'Plains',   passable: true,  rough: false, cover: false, speed: 1,    heavyBonus: 1.25, pathCost: 1,   color: '#a5c93c' },
  { id: 1, key: 'forest',   name: 'Forest',   passable: true,  rough: true,  cover: true,  speed: 0.8,  heavyBonus: 1,    pathCost: 1.5, color: '#2f7d32' },
  { id: 2, key: 'water',    name: 'Water',    passable: false, rough: false, cover: false, speed: 1,    heavyBonus: 1,    pathCost: 0,   color: '#3fa9f5' },
  { id: 3, key: 'hills',    name: 'Hills',    passable: true,  rough: true,  cover: false, speed: 0.7,  heavyBonus: 1,    pathCost: 1.9, color: '#939f9f' },
  { id: 4, key: 'mountain', name: 'Mountain', passable: true,  rough: true,  cover: false, speed: 0.45, heavyBonus: 1,    pathCost: 3.2, color: '#6f7479' },
  { id: 5, key: 'road',     name: 'Road',     passable: true,  rough: false, cover: false, speed: 1.35, heavyBonus: 1.1,  pathCost: 0.6, color: '#b5b5b0' },
  { id: 6, key: 'bridge',   name: 'Bridge',   passable: true,  rough: false, cover: false, speed: 1.25, heavyBonus: 1.1,  pathCost: 0.7, color: '#8a5a2b' },
];

export const info = (type) => TERRAIN_INFO[type] || TERRAIN_INFO[0];
export const isPassableType = (type) => info(type).passable;

// Two unit types: numbers versus breakthrough.
export const UNITS = {
  light: {
    key: 'light',
    name: 'Light',
    hp: 46,
    dps: 8,
    range: 32,
    speed: 70,
    radius: 6,
    cost: 30,
    buildTime: 3.5,
    sight: 150,
    // Light troops shrug off terrain and take cover in the rough.
    rough: { damage: 1, taken: 0.8 },
  },
  heavy: {
    key: 'heavy',
    name: 'Heavy',
    hp: 175,
    dps: 28,
    range: 42,
    speed: 44,
    radius: 9,
    cost: 85,
    buildTime: 9,
    sight: 140,
    // Heavies are built for open ground and are near useless in the trees.
    rough: { damage: 0.4, taken: 1.3 },
  },
};

// Main bases: they hold the gold engine, build the army, and losing them all
// loses the match.
export const BASE = {
  hp: 800,
  radius: 30,
  regen: 8,           // hp per second once nothing has attacked it recently
  regenDelay: 12,     // seconds of quiet before repairs start
  income: 5,          // gold per second
  freeRadius: 110,    // units this close are garrisoned and cost no upkeep
};

export const CITY = {
  radius: 18,
  captureRadius: 78,
  captureTime: 6,      // unit-seconds needed for a solo capturer
  captureMaxUnits: 4,  // more than this stops speeding the capture up
  income: 3,           // gold per second once captured
  freeRadius: 78,      // garrisoned units inside cost no upkeep
};

// The whole economy: bases and cities earn, field units spend, and a deficit
// starves the army.
export const ECONOMY = {
  startGold: 130,
  upkeepPerUnit: 1,        // gold per second, per unit outside a city or base
  starveDpsPerGold: 0.9,   // hp/s lost per gold/s of deficit
  maxStarveDps: 9,
  minGold: -60,            // the debt cannot spiral past this
};

// Morale: sustained fire wears a unit down long before it dies.
export const MORALE = {
  lossPerSecondUnderFire: 0.34,
  recoveryPerSecond: 0.11,
  recoveryInSupply: 0.24,  // faster next to a friendly base or city
  calmDelay: 2.5,          // seconds without being hit before recovery starts
  minSpeed: 0.55,          // speed multiplier at zero morale
  minDamage: 0.45,         // damage multiplier at zero morale
};

// Encirclement: units that cannot trace a route home are finished quickly.
export const SUPPLY = {
  graceSeconds: 1.5, // brief disconnects do not count
  dpsFraction: 0.4,  // fraction of max hp lost per second once cut off
  moraleDrain: 0.6,
};

// Radar: units standing in cover are invisible until somebody gets close.
export const DETECTION = { spotRadius: 95 };

export const VICTORY = { territoryShare: 0.75 };

export const FACTION_COLORS = [
  '#2323e0', // blue
  '#f01d1d', // red
  '#17a81a', // green
  '#f5a623', // amber
];
export const NEUTRAL_COLOR = '#f2d024';

export const PALETTE = {
  background: '#7f8489', // out-of-bounds surround, as on a printed map
  border: '#111111',     // territory front line
  text: '#0f1418',
};

// Tuned with scripts/tune.mjs against the current maps.
export const AI_PROFILES = {
  easy:   { think: 1.6, wave: 16, defenders: 4, retreatHp: 0.35, heavyRatio: 0.5, focus: 0.2, reserve: 140 },
  normal: { think: 0.8, wave: 8,  defenders: 2, retreatHp: 0.15, heavyRatio: 0.3, focus: 0.7, reserve: 40 },
  hard:   { think: 0.4, wave: 4,  defenders: 2, retreatHp: 0,    heavyRatio: 0.3, focus: 1.2, reserve: 0 },
};
