import { DT, SIM_HZ, UNITS, CITY, BASE, VICTORY, FACTION_COLORS, NEUTRAL_COLOR } from './config.js';
import { Game } from './game.js';
import { AIController } from './ai.js';
import { Camera } from './camera.js';
import { InputController } from './input.js';
import { ReplayPlayer, buildReplay, saveReplay } from './replay.js';
import { platform } from './platform.js';

const DIFFICULTY_NAMES = { easy: 'Recruit', normal: 'Officer', hard: 'Marshal' };

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Owns one match (or one replay playback): the loop, the camera, the HUD.
export class Session {
  constructor(app, setup, options = {}) {
    this.app = app;
    this.setup = setup;
    this.replay = options.replay || null;
    this.isReplay = !!this.replay;

    if (this.isReplay) {
      this.player = new ReplayPlayer(this.replay);
      this.viewerFaction = this.replay.viewerFaction;
      this.ais = [];
    } else {
      this._game = new Game(setup);
      this.viewerFaction = setup.slots.findIndex((s) => s.kind === 'human');
      if (this.viewerFaction < 0) this.viewerFaction = 0;
      this.ais = setup.slots
        .map((s, i) => (s.kind === 'ai' ? new AIController(this._game, i, s.difficulty) : null))
        .filter(Boolean);
    }

    this.camera = new Camera(setup.map.width, setup.map.height);
    this.renderer = app.renderer;
    this.renderer.attach(this.game);

    this.canvas = document.getElementById('game-canvas');
    this.minimapEl = document.getElementById('minimap');
    this.input = new InputController({
      canvas: this.canvas,
      minimap: this.minimapEl,
      camera: this.camera,
      session: this,
    });
    this.input.enabled = !this.isReplay;

    this.speed = options.speed || 1;
    this.paused = false;
    this.accumulator = 0;
    this.hudTimer = 0;
    this.resultShown = false;
    this.running = false;
    this.selectionDirty = true;
    this.lastTs = 0;

    const home = this.game.bases.find((b) => b.owner === this.viewerFaction);
    if (home) this.camera.centerOn(home.x, home.y);
    // The default zoom needs real canvas dimensions, so it is applied by the
    // caller once the game screen is actually on screen.

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.setupReplayBar();
    this.resize();
    this.renderFactionBars();
    this.updateTouchButtons();
  }

  get game() {
    return this.player ? this.player.game : this._game;
  }

  // ------------------------------------------------------------------- loop

  start() {
    this.running = true;
    this.lastTs = performance.now();
    if (!this.isReplay) platform.gameplayStart();
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
    window.removeEventListener('resize', this.onResize);
    this.input.destroy();
    platform.gameplayStop();
  }

  frame(ts) {
    const dt = Math.min(0.12, (ts - this.lastTs) / 1000);
    this.lastTs = ts;

    this.input.updateCamera(dt);

    if (!this.paused && !this.game.over) {
      this.accumulator += dt * this.speed;
      let steps = 0;
      const maxSteps = Math.ceil(this.speed * 4) + 4;
      while (this.accumulator >= DT && steps < maxSteps) {
        this.stepSim();
        this.accumulator -= DT;
        steps++;
      }
      // Do not let a hitch build up an unpayable simulation debt.
      if (this.accumulator > DT * maxSteps) this.accumulator = 0;
    }

    this.input.prune();
    this.render();

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.12;
      this.updateHud();
    }

    if (this.isReplay) this.updateReplayBar();
    if (this.game.over && !this.resultShown) this.showResult();
  }

  stepSim() {
    if (this.player) {
      if (!this.player.finished) this.player.step();
      return;
    }
    for (const ai of this.ais) ai.update(DT);
    this._game.step();
  }

  render() {
    this.renderer.draw(this.game, this.camera, {
      selection: this.input.selection,
      selectionBox: this.input.selectionBox,
      viewerFaction: this.viewerFaction,
      hoverUnitId: this.input.hoverUnitId,
      showCommands: true,
    });
  }

  resize() {
    const view = this.renderer.resize();
    this.camera.setViewport(view.width, view.height);
  }

  // Aim for a comparable slice of map on every screen: a phone should not open
  // at the same zoom as a desktop and see almost nothing.
  applyDefaultZoom() {
    const view = this.renderer.resize();
    this.camera.setViewport(view.width, view.height);
    const fit = Math.min(view.width / 700, view.height / 520);
    this.camera.zoom = Math.max(this.camera.minZoom, Math.min(1.5, fit));
    this.camera.clamp();
  }

  // -------------------------------------------------------------- callbacks

  onSelectionChanged() {
    this.selectionDirty = true;
    this.updateSelectionPanel();
  }

  onTouchStateChanged() {
    this.updateTouchButtons();
  }

  updateTouchButtons() {
    const mode = document.getElementById('touch-mode');
    const attack = document.getElementById('touch-attack');
    if (mode) {
      const selecting = this.input.touchMode === 'select';
      mode.classList.toggle('active', selecting);
      mode.querySelector('.glyph').textContent = selecting ? '▭' : '✥';
      mode.querySelector('.cap').textContent = selecting ? 'Select' : 'Pan';
    }
    if (attack) attack.classList.toggle('active', this.input.touchAttackArmed);
  }

  pingMarker(x, y, attackMove) {
    this.game.effects.push({
      kind: 'ping',
      x,
      y,
      faction: attackMove ? -2 : this.viewerFaction,
      t: 0,
      life: 0.5,
    });
  }

  flash(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
  }

  togglePause() {
    if (this.game.over) return;
    this.paused = !this.paused;
    this.flash(this.paused ? 'Paused' : 'Resumed');
  }

  toggleMenu() {
    if (this.isReplay) {
      this.app.exitReplay();
      return;
    }
    const overlay = document.getElementById('overlay-ingame');
    const opening = overlay.classList.contains('hidden');
    overlay.classList.toggle('hidden', !opening);
    this.paused = opening;
  }

  changeSpeed(direction) {
    const steps = [0.5, 0.75, 1, 1.5, 2, 3];
    let i = steps.findIndex((s) => Math.abs(s - this.speed) < 0.01);
    if (i < 0) i = 2;
    i = Math.max(0, Math.min(steps.length - 1, i + direction));
    this.speed = steps[i];
    this.flash(`Speed ${this.speed}×`);
  }

  // -------------------------------------------------------------------- HUD

  factionLabel(index) {
    const slot = this.setup.slots[index];
    if (index === this.viewerFaction) return 'You';
    if (!slot) return `Player ${index + 1}`;
    if (slot.kind === 'ai') return `Bot ${index + 1} · ${DIFFICULTY_NAMES[slot.difficulty] || 'Officer'}`;
    return `Player ${index + 1}`;
  }

  renderFactionBars() {
    const host = document.getElementById('faction-bars');
    host.innerHTML = '';
    this.factionRows = new Map();
    for (const f of this.game.factions) {
      if (f.kind === 'none') continue;
      const row = document.createElement('div');
      row.className = 'faction-row';
      row.innerHTML = `<span class="swatch" style="background:${FACTION_COLORS[f.index % FACTION_COLORS.length]}"></span>
        <span class="who">${this.factionLabel(f.index)}</span>
        <span class="cities">0</span><span style="color:var(--muted)">bases</span>
        <span class="units">0%</span><span style="color:var(--muted)">land</span>`;
      host.appendChild(row);
      this.factionRows.set(f.index, row);
    }
  }

  updateHud() {
    const game = this.game;
    const me = this.viewerFaction;
    const f = game.factions[me];
    const units = game.units.filter((u) => u.faction === me);
    const light = units.filter((u) => u.type === 'light').length;
    const heavy = units.length - light;
    const net = f.income - f.upkeep;

    const gold = document.getElementById('stat-gold');
    gold.querySelector('.stat-value').textContent = String(Math.floor(f.gold));
    gold.querySelector('.stat-sub').textContent = `${net >= 0 ? '+' : ''}${net}/s`;
    gold.classList.toggle('warn', f.gold <= 0 && net < 0);
    gold.classList.toggle('good', net > 0);

    const share = game.territoryShare(me);
    const territory = document.getElementById('stat-territory');
    territory.querySelector('.stat-value').textContent = `${Math.round(share * 100)}%`;
    territory.classList.toggle('good', share >= VICTORY.territoryShare * 0.8);

    document.getElementById('stat-bases').querySelector('.stat-value').textContent = String(game.countBases(me));
    document.getElementById('stat-army').querySelector('.stat-value').textContent = `${light}L \u00b7 ${heavy}H`;
    document.getElementById('stat-clock').querySelector('.stat-value').textContent = formatTime(game.time);
    document.getElementById('stat-speed').querySelector('.stat-value').textContent = `${this.speed}\u00d7`;

    if (this.factionRows) {
      for (const [index, row] of this.factionRows) {
        const faction = game.factions[index];
        row.querySelector('.cities').textContent = String(game.countBases(index));
        row.querySelector('.units').textContent = `${Math.round(game.territoryShare(index) * 100)}%`;
        row.classList.toggle('dead', !faction.alive);
      }
    }

    this.updateSelectionPanel();
  }

  updateSelectionPanel() {
    const panel = document.getElementById('selection-panel');
    const sel = this.input.selection;
    const game = this.game;

    if (sel.baseId >= 0) {
      const base = game.bases[sel.baseId];
      if (!base) {
        panel.classList.remove('visible');
        return;
      }
      const mine = base.owner === this.viewerFaction && !this.isReplay && !base.dead;
      const key = `base${base.id}:${base.owner}:${base.dead}`;
      if (this.selectionDirty || this.panelKind !== key) {
        this.panelKind = key;
        this.selectionDirty = false;
        const owner = base.dead ? 'Destroyed' : this.factionLabel(base.owner);
        panel.innerHTML = `
          <h4>Base <span style="color:${FACTION_COLORS[base.owner % 4]}">\u00b7 ${owner}</span></h4>
          <div class="row"><span>+${BASE.income} gold/s \u00b7 repairs and steadies troops</span></div>
          <div class="row"><span class="build-label"></span></div>
          <div class="progress"><i style="width:0%"></i></div>
          ${mine ? `<div class="build-row">
            <button class="btn small" data-produce="light">Light ${UNITS.light.cost}<span style="color:var(--muted)"> Q</span></button>
            <button class="btn small" data-produce="heavy">Heavy ${UNITS.heavy.cost}<span style="color:var(--muted)"> W</span></button>
            <button class="btn small" data-produce="toggle">\u2016</button>
          </div>
          <div class="hint">Right-click the map to set a rally point.</div>` : ''}`;
        panel.classList.add('visible');
        if (mine) {
          for (const btn of panel.querySelectorAll('[data-produce]')) {
            btn.addEventListener('click', () => {
              const kind = btn.dataset.produce;
              if (kind === 'toggle') {
                game.issue({ type: 'togglePause', faction: this.viewerFaction, base: base.id });
              } else {
                game.issue({ type: 'produce', faction: this.viewerFaction, base: base.id, unitType: kind });
              }
            });
          }
        }
      }
      const label = panel.querySelector('.build-label');
      const bar = panel.querySelector('.progress > i');
      if (label) {
        const cost = UNITS[base.produce].cost;
        if (base.dead) label.textContent = 'This base is gone';
        else if (base.paused) label.textContent = 'Production paused';
        else if (!base.charged) label.textContent = `Waiting for ${cost} gold`;
        else label.textContent = `Building ${UNITS[base.produce].name}`;
      }
      if (bar) bar.style.width = `${base.charged ? Math.min(100, (base.progress / base.buildTime()) * 100) : 0}%`;
      for (const btn of panel.querySelectorAll('[data-produce]')) {
        if (btn.dataset.produce === 'toggle') btn.classList.toggle('active', base.paused);
        else btn.classList.toggle('active', base.produce === btn.dataset.produce && !base.paused);
      }
      return;
    }

    if (sel.cityId >= 0) {
      const city = game.cities[sel.cityId];
      if (!city) {
        panel.classList.remove('visible');
        return;
      }
      const key = `city${city.id}:${city.owner}`;
      if (this.selectionDirty || this.panelKind !== key) {
        this.panelKind = key;
        this.selectionDirty = false;
        const owner = city.owner < 0 ? 'Neutral' : this.factionLabel(city.owner);
        const color = city.owner < 0 ? NEUTRAL_COLOR : FACTION_COLORS[city.owner % 4];
        panel.innerHTML = `
          <h4>City <span style="color:${color}">\u00b7 ${owner}</span></h4>
          <div class="row"><span>+${CITY.income} gold/s when held</span></div>
          <div class="row"><span>Garrisoned units cost no upkeep</span></div>
          <div class="progress"><i style="width:0%"></i></div>
          <div class="hint capture-hint">Stand inside the ring with no defenders to take it.</div>`;
        panel.classList.add('visible');
      }
      const bar = panel.querySelector('.progress > i');
      if (bar) bar.style.width = `${Math.min(100, city.captureProgress * 100)}%`;
      return;
    }

    if (sel.units.size) {
      let light = 0;
      let heavy = 0;
      let hp = 0;
      let maxHp = 0;
      let morale = 0;
      let cutOff = 0;
      let starving = 0;
      let n = 0;
      for (const id of sel.units) {
        const u = game.unitsById.get(id);
        if (!u) continue;
        if (u.type === 'light') light++;
        else heavy++;
        hp += u.hp;
        maxHp += u.maxHp;
        morale += u.morale;
        if (!u.supplied) cutOff++;
        if (u.starving) starving++;
        n++;
      }
      const avgMorale = n ? morale / n : 1;
      panel.classList.add('visible');
      panel.innerHTML = `
        <h4>${light + heavy} selected</h4>
        <div class="row"><span class="pip light"></span>${light} light</div>
        <div class="row"><span class="pip heavy"></span>${heavy} heavy</div>
        <div class="row"><span>Morale ${Math.round(avgMorale * 100)}%</span></div>
        <div class="progress"><i style="width:${maxHp ? (hp / maxHp) * 100 : 0}%"></i></div>
        ${cutOff ? `<div class="hint" style="color:#ff6b6b">${cutOff} cut off \u2014 no route home</div>` : ''}
        ${starving ? `<div class="hint" style="color:#ff9066">${starving} starving \u2014 treasury is empty</div>` : ''}`;
      this.panelKind = 'units';
      return;
    }

    panel.classList.remove('visible');
    this.panelKind = null;
  }

  // ---------------------------------------------------------------- replays

  setupReplayBar() {
    const bar = document.getElementById('replay-bar');
    bar.classList.toggle('hidden', !this.isReplay);
    if (!this.isReplay) return;
    this.scrub = document.getElementById('replay-scrub');
    this.totalTicks = Math.max(1, Math.round(this.replay.duration * SIM_HZ));
    this.scrub.max = String(this.totalTicks);
    this.scrub.value = '0';
    this.scrubbing = false;
    this.scrub.oninput = () => {
      this.scrubbing = true;
      this.paused = true;
    };
    this.scrub.onchange = () => {
      this.player.seek(Number(this.scrub.value));
      this.scrubbing = false;
      this.accumulator = 0;
    };
  }

  updateReplayBar() {
    if (!this.scrub || this.scrubbing) return;
    this.scrub.value = String(Math.min(this.totalTicks, this.game.tickCount));
    document.getElementById('replay-time').textContent =
      `${formatTime(this.game.time)} / ${formatTime(this.replay.duration)}`;
  }

  replayRestart() {
    this.player.reset();
    this.renderer.attach(this.game);
    this.input.clearSelection();
    this.accumulator = 0;
    this.paused = false;
    this.resultShown = false;
    this.renderFactionBars();
  }

  // ----------------------------------------------------------------- result

  showResult() {
    this.resultShown = true;
    const game = this.game;
    const myTeam = this.setup.slots[this.viewerFaction]?.team ?? 0;
    const won = game.winnerTeam === myTeam;

    if (this.isReplay) {
      this.flash(won ? 'Replay finished — victory' : 'Replay finished');
      this.paused = true;
      return;
    }

    const f = game.factions[this.viewerFaction];
    const overlay = document.getElementById('overlay-result');
    const title = document.getElementById('result-title');
    title.textContent = won ? 'Victory' : 'Defeat';
    title.className = won ? 'win' : 'lose';
    document.getElementById('result-sub').textContent = won
      ? 'The map is yours.'
      : 'Your last city and your last dot are gone.';
    document.getElementById('result-stats').innerHTML = `
      <div class="line"><span>Duration</span><span>${formatTime(game.time)}</span></div>
      <div class="line"><span>Units built</span><span>${f.produced}</span></div>
      <div class="line"><span>Units lost</span><span>${f.lost}</span></div>
      <div class="line"><span>Kills</span><span>${f.killed}</span></div>
      <div class="line"><span>Cities captured</span><span>${f.captured}</span></div>`;
    overlay.classList.remove('hidden');

    try {
      this.lastReplay = buildReplay(this);
      saveReplay(this.lastReplay);
    } catch {
      this.lastReplay = null;
    }
    if (won) platform.happytime();
    platform.gameplayStop();
  }
}
