import { DT } from './config.js';
import { Game } from './game.js';
import { AIController } from './ai.js';
import { Camera } from './camera.js';
import { Renderer } from './render.js';
import { MAPS } from './maps.js';
import { randomSeed } from './rng.js';

// The title screen background: a real match between two bots, played out live
// with the camera drifting across the front. It is the same simulation and the
// same renderer as the game — nothing here is faked.
export class MenuDemo {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.renderer = new Renderer(this.canvas, null);
    this.running = false;
    this.emptySelection = { units: new Set(), cityId: -1, baseId: -1 };
  }

  reset() {
    const map = MAPS[Math.floor(Math.random() * MAPS.length)];
    const slots = [];
    for (let i = 0; i < map.players; i++) {
      slots.push({ kind: 'ai', team: i % 2, difficulty: i % 2 ? 'hard' : 'normal' });
    }
    this.game = new Game({ map, seed: randomSeed(), slots });
    this.game.recording = false;
    this.ais = slots.map((s, i) => new AIController(this.game, i, s.difficulty));
    this.camera = new Camera(map.width, map.height);
    this.renderer.attach(this.game);
    this.accumulator = 0;
    this.panAngle = Math.random() * Math.PI * 2;
    this.elapsed = 0;

    // Fast-forward past the opening so the title screen always shows armies on
    // the move rather than four idle cities.
    const warmup = 35 * 60;
    for (let i = 0; i < warmup && !this.game.over; i++) {
      for (const ai of this.ais) ai.update(DT);
      this.game.step();
    }
    const focus = this.focusPoint();
    this.camera.centerOn(focus.x, focus.y);
  }

  start() {
    if (this.running) return;
    this.reset();
    this.running = true;
    this.last = performance.now();
    const frame = (ts) => {
      if (!this.running) return;
      this.frame(ts);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  frame(ts) {
    const dt = Math.min(0.1, (ts - this.last) / 1000);
    this.last = ts;
    this.elapsed += dt;

    // A finished demo (or one that has run long enough) rolls into a new map.
    if (this.game.over || this.elapsed > 150) {
      this.reset();
      return;
    }

    this.accumulator += dt * 1.6;
    let steps = 0;
    while (this.accumulator >= DT && steps < 8) {
      for (const ai of this.ais) ai.update(DT);
      this.game.step();
      this.accumulator -= DT;
      steps++;
    }

    const view = this.renderer.resize();
    this.camera.setViewport(view.width, view.height);

    // Drift toward wherever the fighting is, with a slow orbit on top.
    const focus = this.focusPoint();
    this.panAngle += dt * 0.12;
    const targetX = focus.x + Math.cos(this.panAngle) * 180;
    const targetY = focus.y + Math.sin(this.panAngle) * 120;
    this.camera.zoom = Math.max(this.camera.minZoom, 0.85);
    this.camera.centerOn(
      this.camera.x + (targetX - this.camera.x) * Math.min(1, dt * 0.6),
      this.camera.y + (targetY - this.camera.y) * Math.min(1, dt * 0.6),
    );

    this.renderer.draw(this.game, this.camera, {
      selection: this.emptySelection,
      arrow: null,
      viewerFaction: -1,
      hoverUnitId: -1,
      showCommands: false,
    });
  }

  // Centre of mass of the units nearest to an enemy — roughly, the front.
  focusPoint() {
    const units = this.game.units;
    if (!units.length) {
      return { x: this.game.terrain.width / 2, y: this.game.terrain.height / 2 };
    }
    let x = 0;
    let y = 0;
    for (const u of units) {
      x += u.x;
      y += u.y;
    }
    return { x: x / units.length, y: y / units.length };
  }
}
