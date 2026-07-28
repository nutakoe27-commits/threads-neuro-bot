#!/usr/bin/env node
// Bot tuning harness. Plays candidate AI profiles against a baseline across
// every 1v1 map, swapping sides so map asymmetry cancels out, and prints the
// win rate of each candidate. Used to make the difficulty tiers actually rank.
//
//   node scripts/tune.mjs [--seeds 3]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright-loader.mjs';

const { chromium } = loadPlaywright();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DIR = path.join(ROOT, 'game');
const PORT = 8125;
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

const BASE = { think: 0.8, wave: 8, defenders: 2, retreatHp: 0.15, heavyRatio: 0.25, focus: 0.6 };

const variants = [
  ['baseline', {}],
  ['wave 4', { wave: 4 }],
  ['wave 6', { wave: 6 }],
  ['wave 11', { wave: 11 }],
  ['wave 15', { wave: 15 }],
  ['wave 20', { wave: 20 }],
  ['think 0.4', { think: 0.4 }],
  ['think 1.6', { think: 1.6 }],
  ['no retreat', { retreatHp: 0 }],
  ['retreat 0.35', { retreatHp: 0.35 }],
  ['all light', { heavyRatio: 0 }],
  ['heavy 0.45', { heavyRatio: 0.45 }],
  ['focus 0.1', { focus: 0.1 }],
  ['focus 1.2', { focus: 1.2 }],
  ['defenders 0', { defenders: 0 }],
  ['defenders 4', { defenders: 4 }],
];

const out = await page.evaluate(
  async ({ BASE, variants, SEEDS }) => {
    const { Game } = await import('./src/game.js');
    const { AIController } = await import('./src/ai.js');
    const { MAPS } = await import('./src/maps.js');

    const maps = MAPS.filter((m) => m.players === 2);
    const LIMIT = 60 * 60 * 20;

    const play = (map, profileA, profileB, seed) => {
      const setup = {
        map,
        seed,
        slots: [
          { kind: 'ai', team: 0, difficulty: 'normal' },
          { kind: 'ai', team: 1, difficulty: 'normal' },
        ],
      };
      const game = new Game(setup);
      const ais = [new AIController(game, 0, profileA), new AIController(game, 1, profileB)];
      while (!game.over && game.tickCount < LIMIT) {
        for (const ai of ais) ai.update(1 / 60);
        game.step();
      }
      if (!game.over) return null; // draw
      return game.winnerTeam;
    };

    const results = [];
    for (const [name, patch] of variants) {
      const candidate = { ...BASE, ...patch };
      let wins = 0;
      let losses = 0;
      let draws = 0;
      let minutes = 0;
      let games = 0;
      for (const map of maps) {
        for (let s = 0; s < SEEDS; s++) {
          const seed = 4242 + s * 104729;
          // Candidate plays each side once to cancel out map bias.
          const r1 = play(map, candidate, BASE, seed);
          const r2 = play(map, BASE, candidate, seed);
          for (const [res, candidateTeam] of [[r1, 0], [r2, 1]]) {
            games++;
            if (res === null) draws++;
            else if (res === candidateTeam) wins++;
            else losses++;
          }
        }
      }
      results.push({ name, wins, losses, draws, games, minutes });
    }
    return results;
  },
  { BASE, variants, SEEDS },
);

console.log('candidate        win   loss  draw   win%');
for (const r of out) {
  const pct = ((r.wins / Math.max(1, r.wins + r.losses)) * 100).toFixed(0);
  console.log(`${r.name.padEnd(16)} ${String(r.wins).padStart(3)}  ${String(r.losses).padStart(4)}  ${String(r.draws).padStart(4)}  ${pct.padStart(4)}%`);
}

await browser.close();
server.close();
