#!/usr/bin/env node
// Headless smoke test + screenshot capture for the War of Dots build.
//
//   node scripts/playtest.mjs            # run the checks
//   node scripts/playtest.mjs --shots    # also write game/screenshots/*.png
//
// Needs Playwright: npm install -D playwright && npx playwright install chromium
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright-loader.mjs';

const { chromium } = loadPlaywright();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DIR = path.join(ROOT, 'game');
const SHOT_DIR = path.join(GAME_DIR, 'screenshots');
const PORT = 8123;
const WANT_SHOTS = process.argv.includes('--shots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(GAME_DIR, rel);
    if (!file.startsWith(GAME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

async function shot(page, name) {
  if (!WANT_SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
  console.log(`  shot ${name}.png`);
}

// Advance the simulation by wall-clock seconds at an elevated speed.
async function runMatch(page, seconds, speed = 4) {
  await page.evaluate((s) => {
    window.warOfDots.session.speed = s;
  }, speed);
  await page.waitForTimeout(seconds * 1000);
}

const state = (page) =>
  page.evaluate(() => {
    const s = window.warOfDots.session;
    if (!s) return null;
    const g = s.game;
    return {
      time: g.time,
      tick: g.tickCount,
      over: g.over,
      winnerTeam: g.winnerTeam,
      units: g.units.length,
      effects: g.effects.length,
      byFaction: g.factions.map((f) => ({
        index: f.index,
        alive: f.alive,
        cities: g.countCities(f.index),
        units: g.countUnits(f.index),
        produced: f.produced,
        killed: f.killed,
        captured: f.captured,
      })),
      neutralCities: g.cities.filter((c) => c.owner < 0).length,
      starving: g.units.filter((u) => u.starving).length,
      commands: g.commandLog.length,
    };
  });

async function main() {
  const server = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  console.log('main menu');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  check('menu rendered', await page.isVisible('#screen-menu.active'));
  await shot(page, '01-menu');

  console.log('setup screen');
  await page.click('[data-action="goto-setup"]');
  await page.waitForTimeout(250);
  check('map list populated', (await page.locator('#map-list .map-card').count()) >= 5);
  check('map preview drawn', (await page.locator('#map-preview canvas').count()) === 1);
  await shot(page, '02-setup');

  console.log('battle: duel on Twin Rivers, Marshal bot');
  await page.locator('#map-list .map-card', { hasText: 'Twin Rivers' }).click();
  await page.selectOption('#difficulty-select', 'hard');
  await page.click('[data-action="start-match"]');
  await page.waitForTimeout(500);

  let s = await state(page);
  check('match started', !!s && s.units === 6, `units=${s?.units}`);
  check('cities split 1/1/rest neutral', s.byFaction[0].cities === 1 && s.byFaction[1].cities === 1);

  await runMatch(page, 6, 4);
  s = await state(page);
  check('simulation advanced', s.time > 15, `t=${s.time?.toFixed(1)}s`);
  check('cities produced units', s.byFaction[0].produced > 3, `produced=${s.byFaction[0].produced}`);
  check('bot issued commands', s.commands > 0, `commands=${s.commands}`);

  // Drive the human side: select the whole army and attack-move at the middle.
  console.log('player commands');
  await page.locator('#game-canvas').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('KeyZ');
  const selected = await page.evaluate(() => window.warOfDots.session.input.selection.units.size);
  check('select-all picked up the army', selected > 0, `selected=${selected}`);

  await page.evaluate(() => {
    const s = window.warOfDots.session;
    const mid = { x: s.game.terrain.width / 2, y: s.game.terrain.height / 2 };
    s.input.issueMove(mid.x, mid.y, true);
  });
  await runMatch(page, 5, 4);
  s = await state(page);
  check('human commands recorded', s.commands > 2);
  check('neutral cities are being taken', s.neutralCities < 7, `neutral=${s.neutralCities}`);

  // City panel + production switch.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  check('city panel opens', await page.isVisible('#selection-panel.visible'));
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(200); // commands land on the next simulation tick
  const producing = await page.evaluate(() => {
    const s = window.warOfDots.session;
    return s.game.cities[s.input.selection.cityId].produce;
  });
  check('production switched to heavy', producing === 'heavy');
  await shot(page, '03-battle');

  console.log('long run to a winner');
  await runMatch(page, 22, 8);
  s = await state(page);
  check('heavies were built', await page.evaluate(() => window.warOfDots.session.game.units.some((u) => u.type === 'heavy')));
  check('combat happened', s.byFaction[0].killed + s.byFaction[1].killed > 0,
    `kills=${s.byFaction[0].killed}/${s.byFaction[1].killed}`);
  check('supply pressure exists', s.byFaction.some((f) => f.cities > 1), 'no expansion at all');
  check('no runaway unit count', s.units < 400, `units=${s.units}`);

  // Zoomed-out overview shot.
  await page.evaluate(() => {
    const s = window.warOfDots.session;
    s.camera.zoom = s.camera.minZoom;
    s.camera.centerOn(s.game.terrain.width / 2, s.game.terrain.height / 2);
    s.paused = true;
  });
  await page.waitForTimeout(300);
  await shot(page, '04-overview');
  await page.evaluate(() => {
    window.warOfDots.session.paused = false;
  });

  console.log('help + editor + replays');
  await page.evaluate(() => window.warOfDots.handleAction('goto-help'));
  await page.waitForTimeout(200);
  check('help overlay visible', await page.isVisible('#overlay-help .dialog'));
  await shot(page, '05-help');
  await page.click('[data-action="close-help"]');

  await page.evaluate(() => window.warOfDots.quitMatch());
  await page.click('[data-action="goto-editor"]');
  await page.waitForTimeout(400);
  await page.click('#editor-tools [data-tool="rough"]');
  const canvasBox = await page.locator('#editor-canvas').boundingBox();
  await page.mouse.move(canvasBox.x + 400, canvasBox.y + 300);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 620, canvasBox.y + 380, { steps: 12 });
  await page.mouse.up();
  check('editor paints terrain', await page.evaluate(() => window.warOfDots.editor.terrain.cells.some((c) => c !== 0)));
  await shot(page, '06-editor');
  await page.evaluate(() => window.warOfDots.closeEditor());

  // A short match played to completion, then replayed.
  console.log('replay determinism');
  const replayCheck = await page.evaluate(async () => {
    const app = window.warOfDots;
    const { Game } = await import('./src/game.js');
    const { AIController } = await import('./src/ai.js');
    const { getMap } = await import('./src/maps.js');

    const setup = {
      map: getMap('duel'),
      seed: 12345,
      slots: [
        { kind: 'human', team: 0, difficulty: 'normal' },
        { kind: 'ai', team: 1, difficulty: 'hard' },
      ],
    };

    // Play out a scripted match: the "human" side is driven by a bot too, so
    // every command in the log comes from an AI controller.
    const g1 = new Game(setup);
    const ais = [new AIController(g1, 0, 'normal'), new AIController(g1, 1, 'hard')];
    for (let i = 0; i < 60 * 90 && !g1.over; i++) {
      for (const ai of ais) ai.update(1 / 60);
      g1.step();
    }

    // Replay the command log into a fresh game with no AI at all.
    const g2 = new Game(setup);
    g2.recording = false;
    let cursor = 0;
    while (g2.tickCount < g1.tickCount && !g2.over) {
      while (cursor < g1.commandLog.length && g1.commandLog[cursor].tick <= g2.tickCount) {
        g2.inject(g1.commandLog[cursor++]);
      }
      g2.step();
    }

    const fingerprint = (g) =>
      JSON.stringify({
        units: g.units.length,
        cities: g.cities.map((c) => c.owner),
        hp: Math.round(g.units.reduce((a, u) => a + u.hp, 0)),
        pos: Math.round(g.units.reduce((a, u) => a + u.x + u.y, 0)),
      });

    return {
      ticks: g1.tickCount,
      commands: g1.commandLog.length,
      over: g1.over,
      match: fingerprint(g1) === fingerprint(g2),
      a: fingerprint(g1),
      b: fingerprint(g2),
    };
  });
  check('replay reproduces the match exactly', replayCheck.match, `${replayCheck.a} vs ${replayCheck.b}`);
  check('the scripted match generated commands', replayCheck.commands > 20, `commands=${replayCheck.commands}`);

  // Mobile layout.
  console.log('mobile layout');
  const mobile = await browser.newPage({
    viewport: { width: 412, height: 820 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await mobile.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await mobile.click('[data-action="goto-setup"]');
  await mobile.click('[data-action="start-match"]');
  await mobile.waitForTimeout(1200);
  check('touch controls shown on mobile', await mobile.isVisible('#touch-bar .btn'));
  check('no horizontal overflow', await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await mobile.close();

  check('no console/page errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  await browser.close();
  server.close();

  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
