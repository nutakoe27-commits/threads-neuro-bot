// Core balance & presentation constants for War of Dots.
// Everything the simulation needs is here so the numbers stay in one place.

export const SIM_HZ = 60;
export const DT = 1 / SIM_HZ;

export const TERRAIN = { CLEAR: 0, ROUGH: 1, WATER: 2 };

// Two unit types, exactly as the design calls for: numbers vs. breakthrough.
export const UNITS = {
  light: {
    key: 'light',
    name: 'Light',
    hp: 42,
    dps: 7.5,
    range: 30,
    speed: 68,
    radius: 5,
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
    speed: 42,
    radius: 8,
    buildTime: 12,
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
  '#4aa3ff', // blue
  '#ff5f56', // red
  '#4ade80', // green
  '#fbbf24', // amber
];
export const NEUTRAL_COLOR = '#6b7684';

export const PALETTE = {
  background: '#0b0e13',
  clear: '#151b25',
  rough: '#222c3a',
  water: '#080b11',
  grid: '#10151d',
  text: '#c9d4e2',
};

// Tuned with scripts/tune.mjs. The levers that actually decide matches, in
// order of impact: reaction time, how big a force the bot waits for before
// pushing, how many troops it ties up defending, and whether it wastes units
// retreating. Weak tiers get the losing side of each.
export const AI_PROFILES = {
  easy:   { think: 1.6,  wave: 14, defenders: 4, retreatHp: 0.35, heavyRatio: 0.1, focus: 1.2 },
  normal: { think: 0.9,  wave: 9,  defenders: 2, retreatHp: 0.15, heavyRatio: 0.3, focus: 0.7 },
  hard:   { think: 0.45, wave: 5,  defenders: 1, retreatHp: 0,    heavyRatio: 0.3, focus: 0.3 },
};
