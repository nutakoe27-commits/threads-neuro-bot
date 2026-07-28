#!/usr/bin/env node
// Unit balance harness. Pits a heavy-leaning bot against an all-light bot with
// identical tactics, so the only variable is unit composition. A candidate heavy
// stat line is healthy when it lands near 50% — viable, not dominant.
//
//   node scripts/tune-units.mjs [--seeds 3]
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DIR = path.join(ROOT, 'game');
const PORT = 8126;
const SEEDS = Number(process.argv[process.argv.indexOf('--seeds') + 1]) || 3;

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const rel = req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '').split('?')[0];
    const file = path.join(GAME_DIR, rel);
    if (!file.startsWith(GAME_DIR) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

const server = await serve();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

const candidates = [
  ['current 13s', {}],
  ['build 12s spd42', { buildTime: 12, speed: 42 }],
  ['build 11s spd42', { buildTime: 11, speed: 42 }],
];

const out = await page.evaluate(
  async ({ candidates, SEEDS }) => {
    const { Game } = await import('./src/game.js');
    const { AIController } = await import('./src/ai.js');
    const { MAPS } = await import('./src/maps.js');
    const { UNITS } = await import('./src/config.js');

    const original = JSON.parse(JSON.stringify(UNITS.heavy));
    const maps = MAPS.filter((m) => m.players === 2);
    const LIMIT = 60 * 60 * 20;

    const TACTICS = { think: 0.6, wave: 6, defenders: 1, retreatHp: 0, focus: 0.4 };
    const HEAVY_BOT = { ...TACTICS, heavyRatio: 0.5 };
    const LIGHT_BOT = { ...TACTICS, heavyRatio: 0 };

    const play = (map, a, b, seed) => {
      const setup = {
        map,
        seed,
        slots: [
          { kind: 'ai', team: 0, difficulty: 'normal' },
          { kind: 'ai', team: 1, difficulty: 'normal' },
        ],
      };
      const game = new Game(setup);
      const ais = [new AIController(game, 0, a), new AIController(game, 1, b)];
      while (!game.over && game.tickCount < LIMIT) {
        for (const ai of ais) ai.update(1 / 60);
        game.step();
      }
      return { winner: game.over ? game.winnerTeam : null, minutes: game.time / 60 };
    };

    const results = [];
    for (const [name, patch] of candidates) {
      Object.assign(UNITS.heavy, original, patch);
      UNITS.heavy.rough = { ...original.rough, ...(patch.rough || {}) };

      let wins = 0;
      let losses = 0;
      let draws = 0;
      let minutes = 0;
      let games = 0;
      for (const map of maps) {
        for (let s = 0; s < SEEDS; s++) {
          const seed = 909 + s * 65537;
          const r1 = play(map, HEAVY_BOT, LIGHT_BOT, seed);
          const r2 = play(map, LIGHT_BOT, HEAVY_BOT, seed);
          for (const [r, heavyTeam] of [[r1, 0], [r2, 1]]) {
            games++;
            minutes += r.minutes;
            if (r.winner === null) draws++;
            else if (r.winner === heavyTeam) wins++;
            else losses++;
          }
        }
      }
      results.push({ name, wins, losses, draws, avgMinutes: minutes / games });
    }
    Object.assign(UNITS.heavy, original);
    return results;
  },
  { candidates, SEEDS },
);

console.log('heavy stat line          win  loss  draw   heavy win%   avg match');
for (const r of out) {
  const pct = ((r.wins / Math.max(1, r.wins + r.losses)) * 100).toFixed(0);
  console.log(
    `${r.name.padEnd(24)}${String(r.wins).padStart(3)}  ${String(r.losses).padStart(4)}  ${String(r.draws).padStart(4)}   ${pct.padStart(6)}%    ${r.avgMinutes.toFixed(1)} min`,
  );
}

await browser.close();
server.close();
