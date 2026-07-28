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
        bases: g.countBases(f.index),
        cities: g.countCities(f.index),
        units: g.countUnits(f.index),
        gold: Math.round(f.gold),
        income: f.income,
        upkeep: f.upkeep,
        territory: g.territoryShare(f.index),
        produced: f.produced,
        killed: f.killed,
        captured: f.captured,
      })),
      cutOff: g.units.filter((u) => !u.supplied).length,
      shaken: g.units.filter((u) => u.morale < 0.9).length,
      neutralCities: g.cities.filter((c) => c.owner < 0).length,
      onImpassable: g.units.filter((u) => !g.terrain.isPassable(u.x, u.y)).length,
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
  check('match started', !!s && s.units === 4, `units=${s?.units}`);
  check('one base each', s.byFaction[0].bases === 1 && s.byFaction[1].bases === 1);
  check('every other point is a neutral city', s.byFaction[0].cities === 0 && s.byFaction[1].cities === 0);
  check('starting gold granted', s.byFaction[0].gold > 0, `gold=${s.byFaction[0].gold}`);
  // Regression guard: the opening zoom was once computed while the game screen
  // was still hidden, which silently opened every match fully zoomed out.
  check('opens at a sane zoom', await page.evaluate(() => {
    const c = window.warOfDots.session.camera;
    return c.zoom > c.minZoom * 1.5 && c.zoom <= 1.5;
  }), await page.evaluate(() => {
    const c = window.warOfDots.session.camera;
    return `zoom=${c.zoom.toFixed(2)} min=${c.minZoom.toFixed(2)}`;
  }));

  await runMatch(page, 6, 4);
  s = await state(page);
  check('simulation advanced', s.time > 15, `t=${s.time?.toFixed(1)}s`);
  check('bases produced units', s.byFaction[0].produced > 2, `produced=${s.byFaction[0].produced}`);
  check('bases generate income', s.byFaction[0].income >= 4, `income=${s.byFaction[0].income}`);
  check('field units cost upkeep', s.byFaction[0].upkeep > 0, `upkeep=${s.byFaction[0].upkeep}`);
  check('territory is measured', s.byFaction[0].territory > 0 && s.byFaction[0].territory < 1,
    `land=${s.byFaction[0].territory}`);
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
  check('nothing walks through water or mountains (mid-match)', s.onImpassable === 0, `stuck=${s.onImpassable}`);
  check('roads and bridges were generated', await page.evaluate(() => {
    const t = window.warOfDots.session.game.terrain;
    let road = 0;
    let bridge = 0;
    for (const c of t.cells) {
      if (c === 5) road++;
      if (c === 6) bridge++;
    }
    return road > 200 && bridge > 0;
  }));
  // With two sides still on the map there must be a border between them; once
  // somebody owns everything, having no front line is the correct answer.
  check('front line is drawn while the map is contested', await page.evaluate(() => {
    const s = window.warOfDots.session;
    const owners = new Set(s.game.cities.map((c) => c.owner));
    return owners.size < 2 || s.renderer.frontLines.length > 0;
  }));

  // City panel + production switch.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  check('base panel opens', await page.isVisible('#selection-panel.visible'));
  check('Tab selects a base', await page.evaluate(() => window.warOfDots.session.input.selection.baseId >= 0));
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(200); // commands land on the next simulation tick
  const producing = await page.evaluate(() => {
    const s = window.warOfDots.session;
    return s.game.bases[s.input.selection.baseId].produce;
  });
  check('production switched to heavy', producing === 'heavy');
  await shot(page, '03-battle');

  console.log('long run to a winner');
  await runMatch(page, 22, 8);
  s = await state(page);
  check('heavies were built', await page.evaluate(() => window.warOfDots.session.game.units.some((u) => u.type === 'heavy')));
  check('combat happened', s.byFaction[0].killed + s.byFaction[1].killed > 0,
    `kills=${s.byFaction[0].killed}/${s.byFaction[1].killed}`);
  check('cities changed hands', s.byFaction.some((f) => f.captured > 0), 'nobody captured anything');
  check('no runaway unit count', s.units < 400, `units=${s.units}`);
  check('nothing walks through water or mountains', s.onImpassable === 0, `stuck in solid=${s.onImpassable}`);

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
  await page.click('#editor-tools [data-tool="forest"]');
  const canvasBox = await page.locator('#editor-canvas').boundingBox();
  await page.mouse.move(canvasBox.x + 400, canvasBox.y + 300);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 620, canvasBox.y + 380, { steps: 12 });
  await page.mouse.up();
  check('editor paints terrain', await page.evaluate(() => window.warOfDots.editor.terrain.cells.some((c) => c !== 0)));
  await shot(page, '06-editor');
  await page.evaluate(() => window.warOfDots.closeEditor());

  // Dedicated tests for the new rules, run against fresh simulations so each
  // mechanic is checked in isolation rather than hoped for during a live match.
  console.log('mechanics');
  const mechanics = await page.evaluate(async () => {
    const { Game } = await import('./src/game.js');
    const { getMap } = await import('./src/maps.js');
    const { TERRAIN } = await import('./src/config.js');
    const results = [];
    const t = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });

    const fresh = () =>
      new Game({
        map: getMap('duel'),
        seed: 4242,
        slots: [
          { kind: 'human', team: 0, difficulty: 'normal' },
          { kind: 'ai', team: 1, difficulty: 'normal' },
        ],
      });

    // --- forest conceals ---
    {
      const g = fresh();
      // Find a forest cell and drop one unit of each side far apart.
      let spot = null;
      for (let cy = 0; cy < g.terrain.rows && !spot; cy++) {
        for (let cx = 0; cx < g.terrain.cols; cx++) {
          if (g.terrain.atCell(cx, cy) === TERRAIN.FOREST) {
            spot = { x: cx * 20 + 10, y: cy * 20 + 10 };
            break;
          }
        }
      }
      g.units.length = 0;
      g.unitsById.clear();
      const hider = g.spawnUnit(0, 'light', spot.x, spot.y);
      const seeker = g.spawnUnit(1, 'light', spot.x + 400, spot.y);
      g.step();
      t('forest hides a unit from a distant enemy', !g.isVisibleTo(hider, 1));
      t('a hidden unit still sees itself', g.isVisibleTo(hider, 0));
      t('open ground hides nobody', g.isVisibleTo(seeker, 0));
      seeker.x = spot.x + 60;
      g.step();
      t('walking close spots the hider', g.isVisibleTo(hider, 1));
    }

    // --- encirclement ---
    {
      const g = fresh();
      const enemyBase = g.bases.find((b) => b.owner === 1);
      g.units.length = 0;
      g.unitsById.clear();
      // One lone unit next to the enemy base, ringed by enemies: no way home.
      const trapped = g.spawnUnit(0, 'light', enemyBase.x + 60, enemyBase.y);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        g.spawnUnit(1, 'light', enemyBase.x + 60 + Math.cos(a) * 90, enemyBase.y + Math.sin(a) * 90);
      }
      for (let i = 0; i < 30; i++) g.step();
      t('a surrounded unit loses supply', !trapped.supplied);
      const hpBefore = trapped.hp;
      for (let i = 0; i < 60 * 5; i++) g.step();
      t('encircled units die within seconds', trapped.dead, `hp ${hpBefore.toFixed(0)} -> ${trapped.hp.toFixed(0)}`);

      const home = fresh();
      const ownBase = home.bases.find((b) => b.owner === 0);
      home.units.length = 0;
      home.unitsById.clear();
      const safe = home.spawnUnit(0, 'light', ownBase.x + 40, ownBase.y);
      for (let i = 0; i < 30; i++) home.step();
      t('a unit at home stays supplied', safe.supplied);
    }

    // --- economy ---
    {
      const g = fresh();
      g.units.length = 0;
      g.unitsById.clear();
      const f = g.factions[0];
      // Pause the factory, otherwise the base spends the very gold we measure.
      for (const b of g.bases) b.paused = true;
      const before = f.gold;
      for (let i = 0; i < 60; i++) g.step();
      t('an army-free faction banks its income', f.gold > before, `${before} -> ${f.gold.toFixed(0)}`);

      // Far more units than the treasury can feed.
      const g2 = fresh();
      const b2 = g2.bases.find((b) => b.owner === 0);
      g2.factions[0].gold = 0;
      for (let i = 0; i < 40; i++) g2.spawnUnit(0, 'light', b2.x + 200 + i * 3, b2.y + 200);
      for (let i = 0; i < 30; i++) g2.step();
      t('upkeep outruns income', g2.factions[0].upkeep > g2.factions[0].income,
        `${g2.factions[0].upkeep} vs ${g2.factions[0].income}`);
      t('the treasury goes negative', g2.factions[0].gold < 0, g2.factions[0].gold.toFixed(1));
      t('unpaid troops starve', g2.units.some((u) => u.starving && u.hp < u.maxHp));
    }

    // --- morale ---
    {
      const g = fresh();
      g.units.length = 0;
      g.unitsById.clear();
      const a = g.spawnUnit(0, 'light', 900, 600);
      const b = g.spawnUnit(1, 'heavy', 925, 600);
      for (let i = 0; i < 60; i++) g.step();
      t('sustained fire breaks morale', a.morale < 0.9, a.morale.toFixed(2));
      // Compare like for like: same tile, only morale differs.
      const shakenSpeed = g.speedFactor(a);
      const wasMorale = a.morale;
      a.morale = 1;
      const freshSpeed = g.speedFactor(a);
      a.morale = wasMorale;
      t('low morale slows a unit', shakenSpeed < freshSpeed, `${shakenSpeed.toFixed(2)} vs ${freshSpeed.toFixed(2)}`);
      const shaken = a.morale;
      b.dead = true;
      g.cleanup();
      for (let i = 0; i < 60 * 6; i++) g.step();
      t('morale recovers out of contact', a.dead || a.morale > shaken, `${shaken.toFixed(2)} -> ${a.morale.toFixed(2)}`);
    }

    // --- victory ---
    {
      const g = fresh();
      for (const base of g.bases) if (base.owner === 1) g.destroyBase(base, 0);
      g.checkVictory();
      t('razing every enemy base wins', g.over && g.winnerTeam === 0, `winner=${g.winnerTeam}`);

      const g2 = fresh();
      g2.influence.shareForTeam = (team) => (team === 0 ? 0.8 : 0.2);
      g2.checkVictory();
      t('holding 75% of the map wins', g2.over && g2.winnerTeam === 0, `winner=${g2.winnerTeam}`);

      const g3 = fresh();
      g3.influence.shareForTeam = (team) => (team === 0 ? 0.6 : 0.4);
      g3.checkVictory();
      t('60% is not enough to win', !g3.over);
    }

    return results;
  });
  for (const m of mechanics) check(m.name, m.pass, m.detail);

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
  check('touch controls shown on mobile', await mobile.isVisible('#touch-bar .touch-btn'));
  await mobile.evaluate(() => {
    const s = window.warOfDots.session;
    s.input.selectAllArmy();
  });
  await mobile.waitForTimeout(400);
  if (WANT_SHOTS) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await mobile.screenshot({ path: path.join(SHOT_DIR, '07-mobile.png') });
    console.log('  shot 07-mobile.png');
  }
  check('touch mode toggles to box-select', await mobile.evaluate(() => {
    const app = window.warOfDots;
    app.handleAction('touch-mode');
    const selecting = app.session.input.touchMode === 'select';
    app.handleAction('touch-mode');
    return selecting && app.session.input.touchMode === 'pan';
  }));
  check('attack button arms an attack-move', await mobile.evaluate(() => {
    const app = window.warOfDots;
    app.handleAction('touch-attack');
    const armed = app.session.input.touchAttackArmed;
    app.handleAction('touch-attack');
    return armed && !app.session.input.touchAttackArmed;
  }));
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
