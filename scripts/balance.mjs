#!/usr/bin/env node
// Runs bot-vs-bot matches headlessly and prints match length + winner, so
// balance changes can be checked without playing a hundred games by hand.
//
//   node scripts/balance.mjs [--games 3]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright-loader.mjs';

const { chromium } = loadPlaywright();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DIR = path.join(ROOT, 'game');
const PORT = 8124;
const GAMES = Number(process.argv[process.argv.indexOf('--games') + 1]) || 3;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '').split('?')[0];
    const file = path.join(GAME_DIR, rel);
    if (!file.startsWith(GAME_DIR) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

const server = await serve();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

const results = await page.evaluate(async ({ games }) => {
  const { Game } = await import('./src/game.js');
  const { AIController } = await import('./src/ai.js');
  const { MAPS } = await import('./src/maps.js');

  const MAX_MINUTES = 20;
  const run = (map, diffs, seed) => {
    const setup = {
      map,
      seed,
      slots: diffs.map((d, i) => ({ kind: 'ai', team: i, difficulty: d })),
    };
    const game = new Game(setup);
    const ais = diffs.map((d, i) => new AIController(game, i, d));
    const limit = 60 * 60 * MAX_MINUTES;
    while (!game.over && game.tickCount < limit) {
      for (const ai of ais) ai.update(1 / 60);
      game.step();
    }
    return {
      minutes: game.time / 60,
      winner: game.over ? game.winnerTeam : -1,
      timedOut: !game.over,
      peakUnits: game.units.length,
      cities: game.factions.map((f) => game.countCities(f.index)),
    };
  };

  const out = [];
  const pairs = [
    ['easy', 'easy'],
    ['normal', 'normal'],
    ['hard', 'hard'],
    ['easy', 'normal'],
    ['easy', 'hard'],
    ['normal', 'hard'],
  ];
  for (const map of MAPS.filter((m) => m.players === 2)) {
    for (const pair of pairs) {
      for (let g = 0; g < games; g++) {
        const r = run(map, pair, 1000 + g * 7919);
        out.push({ map: map.name, pair: pair.join(' vs '), ...r });
      }
    }
  }
  return out;
}, { games: GAMES });

const groups = new Map();
for (const r of results) {
  const key = `${r.map.padEnd(14)} ${r.pair.padEnd(16)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

console.log('map            matchup           avg length   winners        timeouts');
for (const [key, list] of groups) {
  const avg = list.reduce((a, r) => a + r.minutes, 0) / list.length;
  const wins = list.map((r) => (r.timedOut ? '-' : r.winner)).join('');
  const timeouts = list.filter((r) => r.timedOut).length;
  console.log(`${key} ${avg.toFixed(1).padStart(6)} min    ${wins.padEnd(14)} ${timeouts}`);
}

const en = results.filter((r) => r.pair === 'easy vs normal' && !r.timedOut);
console.log(`\nnormal beats easy: ${en.filter((r) => r.winner === 1).length}/${en.length}`);
const asym = results.filter((r) => r.pair === 'easy vs hard' && !r.timedOut);
const hardWins = asym.filter((r) => r.winner === 1).length;
console.log(`\nhard beats easy: ${hardWins}/${asym.length}`);
const nh = results.filter((r) => r.pair === 'normal vs hard' && !r.timedOut);
console.log(`hard beats normal: ${nh.filter((r) => r.winner === 1).length}/${nh.length}`);

await browser.close();
server.close();
