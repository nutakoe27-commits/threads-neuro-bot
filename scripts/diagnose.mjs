#!/usr/bin/env node
// Plays a single bot-vs-bot match and prints a timeline of the economy, army
// sizes, territory and base health. Used to work out why a match stalls.
//
//   node scripts/diagnose.mjs [--minutes 12] [--map duel]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright-loader.mjs';

const { chromium } = loadPlaywright();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DIR = path.join(ROOT, 'game');
const PORT = 8127;
const MINUTES = Number(process.argv[process.argv.indexOf('--minutes') + 1]) || 12;
const MAP = process.argv.includes('--map') ? process.argv[process.argv.indexOf('--map') + 1] : 'duel';

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const rel = req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '').split('?')[0];
    const file = path.join(GAME_DIR, rel);
    if (!fs.existsSync(file)) {
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

const out = await page.evaluate(async ({ minutes, mapId }) => {
  const { Game } = await import('./src/game.js');
  const { AIController } = await import('./src/ai.js');
  const { getMap } = await import('./src/maps.js');

  const game = new Game({
    map: getMap(mapId),
    seed: 777,
    slots: [
      { kind: 'ai', team: 0, difficulty: 'normal' },
      { kind: 'ai', team: 1, difficulty: 'hard' },
    ],
  });
  const ais = [new AIController(game, 0, 'normal'), new AIController(game, 1, 'hard')];

  const rows = [];
  const limit = 60 * 60 * minutes;
  const sample = 60 * 30; // every 30 seconds of game time

  while (!game.over && game.tickCount < limit) {
    for (const ai of ais) ai.update(1 / 60);
    game.step();
    if (game.tickCount % sample === 0) {
      rows.push({
        min: +(game.time / 60).toFixed(1),
        f: game.factions.map((fa) => ({
          gold: Math.round(fa.gold),
          inc: fa.income,
          up: fa.upkeep,
          units: game.countUnits(fa.index),
          cities: game.countCities(fa.index),
          land: Math.round(game.territoryShare(fa.index) * 100),
          baseHp: Math.round(
            game.bases.filter((b) => b.owner === fa.index && !b.dead).reduce((a, b) => a + b.hp, 0),
          ),
        })),
        neutral: game.cities.filter((c) => c.owner < 0).length,
        starving: game.units.filter((u) => u.starving).length,
        cutOff: game.units.filter((u) => !u.supplied).length,
      });
    }
  }

  return { over: game.over, winner: game.winnerTeam, minutes: game.time / 60, rows };
}, { minutes: MINUTES, mapId: MAP });

console.log(`map=${MAP} over=${out.over} winner=${out.winner} length=${out.minutes.toFixed(1)}min\n`);
console.log('  min |          faction 0 (normal)      |          faction 1 (hard)        | neutral starve cut');
console.log('      | gold  inc up units cty land bHP  | gold  inc up units cty land bHP  |');
for (const r of out.rows) {
  const fmt = (f) =>
    `${String(f.gold).padStart(5)} ${String(f.inc).padStart(4)} ${String(f.up).padStart(2)} ` +
    `${String(f.units).padStart(5)} ${String(f.cities).padStart(3)} ${String(f.land).padStart(4)} ${String(f.baseHp).padStart(4)}`;
  console.log(
    `${String(r.min).padStart(5)} | ${fmt(r.f[0])} | ${fmt(r.f[1])} | ` +
      `${String(r.neutral).padStart(7)} ${String(r.starving).padStart(6)} ${String(r.cutOff).padStart(3)}`,
  );
}

await browser.close();
server.close();
