import { MAPS } from './maps.js';
import { Terrain } from './terrain.js';
import { Renderer, bakeMinimap } from './render.js';
import { FACTION_COLORS, NEUTRAL_COLOR, CITY } from './config.js';
import { randomSeed } from './rng.js';
import { Session } from './session.js';
import { MapEditor, listCustomMaps } from './editor.js';
import { listReplays, deleteReplay, deserializeSetup } from './replay.js';
import { load, save } from './storage.js';
import { initPlatform, platform } from './platform.js';

const SCREENS = ['screen-menu', 'screen-setup', 'screen-game', 'screen-editor', 'screen-replays'];

class App {
  constructor() {
    this.renderer = new Renderer(document.getElementById('game-canvas'), document.getElementById('minimap'));
    this.session = null;
    this.editor = null;
    this.prefs = load('prefs', { mapId: 'duel', mode: 'duel', difficulty: 'normal', speed: 1 });
    this.helpReturn = null;
  }

  init() {
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('touch');

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      this.handleAction(el.dataset.action, el);
    });

    document.getElementById('mode-select').addEventListener('change', (e) => {
      this.prefs.mode = e.target.value;
      this.savePrefs();
    });
    document.getElementById('difficulty-select').addEventListener('change', (e) => {
      this.prefs.difficulty = e.target.value;
      this.savePrefs();
    });
    document.getElementById('speed-select').addEventListener('change', (e) => {
      this.prefs.speed = Number(e.target.value);
      this.savePrefs();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.session && !this.session.paused) {
        this.session.paused = true;
        this.session.flash('Paused');
      }
    });

    this.show('screen-menu');
  }

  savePrefs() {
    save('prefs', this.prefs);
  }

  show(id) {
    for (const s of SCREENS) document.getElementById(s).classList.toggle('active', s === id);
    this.current = id;
  }

  flashGlobal(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
  }

  allMaps() {
    return [...MAPS, ...listCustomMaps()];
  }

  // ------------------------------------------------------------------ setup

  openSetup() {
    this.renderMapList();
    this.renderModes();
    document.getElementById('difficulty-select').value = this.prefs.difficulty;
    document.getElementById('speed-select').value = String(this.prefs.speed);
    this.show('screen-setup');
  }

  renderMapList() {
    const host = document.getElementById('map-list');
    const maps = this.allMaps();
    if (!maps.some((m) => m.id === this.prefs.mapId)) this.prefs.mapId = maps[0].id;
    host.innerHTML = '';
    for (const map of maps) {
      const card = document.createElement('div');
      card.className = `map-card${map.id === this.prefs.mapId ? ' selected' : ''}`;
      card.innerHTML = `<div class="name">${map.name}<span class="players">${map.players} players${map.custom ? ' · custom' : ''}</span></div>
        <div class="desc">${map.desc || ''}</div>`;
      card.addEventListener('click', () => {
        this.prefs.mapId = map.id;
        this.savePrefs();
        this.renderMapList();
        this.renderModes();
      });
      host.appendChild(card);
    }
    this.renderPreview();
  }

  currentMap() {
    return this.allMaps().find((m) => m.id === this.prefs.mapId) || MAPS[0];
  }

  renderModes() {
    const map = this.currentMap();
    const select = document.getElementById('mode-select');
    const options = [{ value: 'duel', label: '1 v 1 — you against one bot' }];
    if (map.players >= 3) {
      options.push({ value: 'ffa', label: `Free-for-all — ${map.players} sides, everyone alone` });
      if (map.players % 2 === 0) {
        options.push({ value: 'teams', label: `${map.players / 2} v ${map.players / 2} — you and a bot ally` });
      }
      options.push({ value: 'siege', label: `1 v ${map.players - 1} — last stand` });
    }
    select.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    if (!options.some((o) => o.value === this.prefs.mode)) this.prefs.mode = 'duel';
    select.value = this.prefs.mode;
    this.renderPreview();
  }

  renderPreview() {
    const host = document.getElementById('map-preview');
    const map = this.currentMap();
    host.innerHTML = '';
    let terrain;
    if (map.grid) {
      terrain = Terrain.decode(map.width, map.height, map.grid);
    } else {
      terrain = new Terrain(map.width, map.height);
      terrain.applyFeatures(map.features || [], map.seed ?? 1);
    }
    for (const c of map.cities) terrain.clearAround(c.x, c.y, CITY.radius * 2.6);

    const canvas = bakeMinimap(terrain, 420);
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / map.width;
    for (const c of map.cities) {
      ctx.beginPath();
      ctx.arc(c.x * scale, c.y * scale, 5, 0, Math.PI * 2);
      ctx.fillStyle = c.slot < 0 ? NEUTRAL_COLOR : FACTION_COLORS[c.slot % FACTION_COLORS.length];
      ctx.fill();
    }
    host.appendChild(canvas);
  }

  buildSlots(map, mode, difficulty) {
    const n = map.players;
    const slots = [];
    for (let i = 0; i < n; i++) slots.push({ kind: 'none', team: i, difficulty });

    switch (mode) {
      case 'ffa':
        for (let i = 0; i < n; i++) slots[i] = { kind: i === 0 ? 'human' : 'ai', team: i, difficulty };
        break;
      case 'teams':
        for (let i = 0; i < n; i++) slots[i] = { kind: i === 0 ? 'human' : 'ai', team: i % 2, difficulty };
        break;
      case 'siege':
        for (let i = 0; i < n; i++) slots[i] = { kind: i === 0 ? 'human' : 'ai', team: i === 0 ? 0 : 1, difficulty };
        break;
      case 'duel':
      default:
        slots[0] = { kind: 'human', team: 0, difficulty };
        slots[1] = { kind: 'ai', team: 1, difficulty };
        break;
    }
    return slots;
  }

  startMatch(mapOverride) {
    const map = mapOverride || this.currentMap();
    const mode = mapOverride ? 'duel' : this.prefs.mode;
    const setup = {
      map,
      seed: randomSeed(),
      slots: this.buildSlots(map, mode, this.prefs.difficulty),
    };
    this.lastSetup = setup;
    this.launch(new Session(this, setup, { speed: this.prefs.speed }));
  }

  launch(session) {
    if (this.session) this.session.stop();
    document.getElementById('overlay-result').classList.add('hidden');
    document.getElementById('overlay-ingame').classList.add('hidden');
    this.session = session;
    this.show('screen-game');
    session.resize();
    session.start();
  }

  quitMatch() {
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
    document.getElementById('overlay-result').classList.add('hidden');
    document.getElementById('overlay-ingame').classList.add('hidden');
    this.show('screen-menu');
  }

  // ---------------------------------------------------------------- replays

  openReplays() {
    const host = document.getElementById('replay-list');
    const replays = listReplays();
    host.innerHTML = '';
    if (!replays.length) {
      host.innerHTML = '<p class="empty-note">No replays yet. Finish a battle and it will be saved here automatically.</p>';
    }
    for (const r of replays) {
      const item = document.createElement('div');
      item.className = 'replay-item';
      const mins = Math.floor(r.duration / 60);
      const secs = String(Math.floor(r.duration % 60)).padStart(2, '0');
      const won = r.winnerTeam === (r.setup.slots[r.viewerFaction]?.team ?? 0);
      item.innerHTML = `<div class="meta">
          <div class="name">${r.mapName}</div>
          <div class="sub">${new Date(r.date).toLocaleString()} · ${mins}:${secs} · ${won ? 'victory' : 'defeat'}</div>
        </div>`;
      const watch = document.createElement('button');
      watch.className = 'btn small primary';
      watch.textContent = 'Watch';
      watch.addEventListener('click', () => this.watchReplay(r));
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        deleteReplay(r.id);
        this.openReplays();
      });
      item.append(watch, del);
      host.appendChild(item);
    }
    this.show('screen-replays');
  }

  watchReplay(replay) {
    const setup = deserializeSetup(replay.setup);
    this.launch(new Session(this, setup, { replay, speed: 1 }));
  }

  exitReplay() {
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
    document.getElementById('replay-bar').classList.add('hidden');
    this.openReplays();
  }

  // ----------------------------------------------------------------- editor

  openEditor() {
    if (!this.editor) this.editor = new MapEditor(this);
    this.show('screen-editor');
    this.editor.open();
  }

  closeEditor() {
    if (this.editor) this.editor.close();
    this.show('screen-menu');
  }

  // ---------------------------------------------------------------- actions

  handleAction(action, el) {
    const session = this.session;
    switch (action) {
      case 'goto-menu':
        if (this.editor) this.editor.close();
        this.show('screen-menu');
        break;
      case 'goto-setup':
        this.openSetup();
        break;
      case 'goto-replays':
        this.openReplays();
        break;
      case 'goto-editor':
        this.openEditor();
        break;
      case 'goto-help':
        this.helpReturn = this.current;
        document.getElementById('overlay-help').classList.remove('hidden');
        break;
      case 'close-help':
        document.getElementById('overlay-help').classList.add('hidden');
        break;
      case 'start-match':
        this.startMatch();
        break;
      case 'restart-match':
        if (this.lastSetup) {
          const setup = { ...this.lastSetup, seed: randomSeed() };
          this.lastSetup = setup;
          this.launch(new Session(this, setup, { speed: this.prefs.speed }));
        }
        break;
      case 'quit-match':
        this.quitMatch();
        break;
      case 'resume':
        document.getElementById('overlay-ingame').classList.add('hidden');
        if (session) session.paused = false;
        break;
      case 'open-ingame-menu':
        if (session) session.toggleMenu();
        break;
      case 'toggle-pause':
        if (session) session.togglePause();
        break;
      case 'speed-up':
        if (session) session.changeSpeed(1);
        break;
      case 'speed-down':
        if (session) session.changeSpeed(-1);
        break;
      case 'select-army':
        if (session) session.input.selectAllArmy();
        break;
      case 'cmd-stop':
        if (session && session.input.selection.units.size) {
          session.game.issue({
            type: 'stop',
            faction: session.viewerFaction,
            units: [...session.input.selection.units],
          });
        }
        break;
      case 'cmd-hold':
        if (session && session.input.selection.units.size) {
          session.game.issue({
            type: 'hold',
            faction: session.viewerFaction,
            units: [...session.input.selection.units],
          });
        }
        break;
      case 'watch-replay':
        if (session && session.lastReplay) {
          const replay = session.lastReplay;
          this.watchReplay(replay);
        } else {
          this.flashGlobal('Replay unavailable');
        }
        break;
      case 'replay-toggle':
        if (session) session.paused = !session.paused;
        break;
      case 'replay-restart':
        if (session) session.replayRestart();
        break;
      case 'replay-exit':
        this.exitReplay();
        break;
      case 'editor-exit':
        this.closeEditor();
        break;
      case 'editor-save':
        if (this.editor) this.editor.saveMap();
        break;
      case 'editor-clear-all':
        if (this.editor) {
          this.editor.reset();
          document.getElementById('editor-name').value = '';
        }
        break;
      case 'editor-play':
        if (this.editor) {
          const error = this.editor.validate();
          if (error) {
            this.flashGlobal(error);
            break;
          }
          const def = this.editor.toMapDef(this.editor.editingId || 'custom-preview', this.editor.name || 'Custom map');
          this.editor.close();
          this.startMatch(def);
        }
        break;
      default:
        break;
    }
  }
}

const app = new App();
app.init();

platform.loadingStart();
initPlatform().finally(() => platform.loadingStop());

// Handy for debugging from the console.
window.warOfDots = app;
