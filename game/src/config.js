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

// `rough` is the gameplay category that heavy units suffer in. `speed` is a
// flat multiplier for everyone, which is what makes roads worth using.
export const TERRAIN_INFO = [
  { id: 0, key: 'plains',   name: 'Plains',   passable: true,  rough: false, speed: 1,    pathCost: 1,   color: '#a5c93c' },
  { id: 1, key: 'forest',   name: 'Forest',   passable: true,  rough: true,  speed: 1,    pathCost: 1.4, color: '#2f7d32' },
  { id: 2, key: 'water',    name: 'Water',    passable: false, rough: false, speed: 1,    pathCost: 0,   color: '#3fa9f5' },
  { id: 3, key: 'hills',    name: 'Hills',    passable: true,  rough: true,  speed: 0.92, pathCost: 1.5, color: '#939f9f' },
  { id: 4, key: 'mountain', name: 'Mountain', passable: false, rough: false, speed: 1,    pathCost: 0,   color: '#6f7479' },
  { id: 5, key: 'road',     name: 'Road',     passable: true,  rough: false, speed: 1.35, pathCost: 0.6, color: '#b5b5b0' },
  { id: 6, key: 'bridge',   name: 'Bridge',   passable: true,  rough: false, speed: 1.25, pathCost: 0.7, color: '#8a5a2b' },
];

export const info = (type) => TERRAIN_INFO[type] || TERRAIN_INFO[0];
export const isPassableType = (type) => info(type).passable;
export const isRoughType = (type) => info(type).rough;

// Two unit types, exactly as the design calls for: numbers vs. breakthrough.
export const UNITS = {
  light: {
    key: 'light',
    name: 'Light',
    hp: 42,
    dps: 7.5,
    range: 30,
    speed: 68,
    radius: 6,
    buildTime: 4.5,
    // Light troops barely care about terrain and even gain cover in rough ground.
    rough: { speed: 0.85, damage: 1.0, taken: 0.8 },
  },
  heavy: {
    key: 'heavy',
    name: 'Heavy',
    hp: 165,
    dps: 27,
    range: 40,
    speed: 44,
    radius: 9,
    buildTime: 11,
    // Heavies bog down and lose most of their punch outside clear terrain.
    rough: { speed: 0.42, damage: 0.35, taken: 1.35 },
  },
};

export const CITY = {
  radius: 20,
  captureRadius: 78,
  captureTime: 7,      // unit-seconds needed for a solo capturer
  captureMaxUnits: 4,  // more than this stops speeding the capture up
  supply: 5,           // units supported per city
};

// Units above the supply cap slowly starve.
export const STARVE_DPS = 5;

// Regeneration while sitting inside a friendly city's supply radius.
export const RESUPPLY_HPS = 6;

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

// Tuned with scripts/tune.mjs against the current maps. Measured impact, in
// order: reaction time (by far the largest), how big a force the bot masses
// before pushing, whether it wastes units retreating, and how hard it steers
// around defended cities. `defenders: 2` measured best for everyone, so the
// weak tier over-garrisons instead. Weak tiers get the losing side of each.
export const AI_PROFILES = {
  easy:   { think: 1.6, wave: 18, defenders: 4, retreatHp: 0.35, heavyRatio: 0.5, focus: 0.2 },
  normal: { think: 0.8, wave: 8,  defenders: 2, retreatHp: 0.15, heavyRatio: 0.3, focus: 0.7 },
  hard:   { think: 0.4, wave: 4,  defenders: 2, retreatHp: 0,    heavyRatio: 0.3, focus: 1.2 },
};
