import { TERRAIN, FACTION_COLORS, NEUTRAL_COLOR, PALETTE, CITY } from './config.js';
import { Terrain } from './terrain.js';
import { bakeTerrain } from './render.js';
import { load, save } from './storage.js';

const EDITOR_WIDTH = 2000;
const EDITOR_HEIGHT = 1300;
const TOOL_TERRAIN = {
  plains: TERRAIN.PLAINS,
  forest: TERRAIN.FOREST,
  hills: TERRAIN.HILLS,
  mountain: TERRAIN.MOUNTAIN,
  water: TERRAIN.WATER,
};

export function listCustomMaps() {
  return load('customMaps', []);
}

function saveCustomMaps(maps) {
  save('customMaps', maps);
}

export class MapEditor {
  constructor(app) {
    this.app = app;
    this.canvas = document.getElementById('editor-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tool = 'plains';
    this.brush = 70;
    this.owner = -1;
    this.painting = false;
    this.dirty = true;
    this.reset();
    this.bind();
  }

  reset() {
    this.terrain = new Terrain(EDITOR_WIDTH, EDITOR_HEIGHT);
    this.cities = [];
    this.name = '';
    this.editingId = null;
    this.dirty = true;
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('mousedown', (e) => {
      this.painting = true;
      this.apply(e, true);
    });
    c.addEventListener('mousemove', (e) => {
      if (this.painting) this.apply(e, false);
    });
    window.addEventListener('mouseup', () => {
      this.painting = false;
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.painting = true;
      this.apply(e.touches[0], true);
    }, { passive: false });
    c.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (this.painting) this.apply(e.touches[0], false);
    }, { passive: false });
    c.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.painting = false;
    }, { passive: false });

    document.getElementById('editor-tools').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tool]');
      if (!btn) return;
      this.tool = btn.dataset.tool;
      for (const b of document.querySelectorAll('#editor-tools .tool')) b.classList.toggle('active', b === btn);
    });
    document.getElementById('editor-brush').addEventListener('input', (e) => {
      this.brush = Number(e.target.value);
    });
    document.getElementById('editor-owner').addEventListener('change', (e) => {
      this.owner = Number(e.target.value);
    });
    document.getElementById('editor-name').addEventListener('input', (e) => {
      this.name = e.target.value;
    });
  }

  // The whole map is always visible, so the transform is a single scale factor.
  metrics() {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / EDITOR_WIDTH, (rect.height - 120) / EDITOR_HEIGHT);
    const w = EDITOR_WIDTH * scale;
    const h = EDITOR_HEIGHT * scale;
    return { scale, offsetX: (rect.width - w) / 2, offsetY: (rect.height - h) / 2, rect };
  }

  toWorld(e) {
    const { scale, offsetX, offsetY, rect } = this.metrics();
    const x = (e.clientX - rect.left - offsetX) / scale;
    const y = (e.clientY - rect.top - offsetY) / scale;
    return { x, y };
  }

  apply(e, isClick) {
    if (!e) return;
    const { x, y } = this.toWorld(e);
    if (x < 0 || y < 0 || x > EDITOR_WIDTH || y > EDITOR_HEIGHT) return;

    if (this.tool === 'city') {
      if (!isClick) return;
      if (this.cities.some((c) => Math.hypot(c.x - x, c.y - y) < CITY.captureRadius * 1.2)) {
        this.app.flashGlobal('Too close to another city');
        return;
      }
      this.cities.push({ x: Math.round(x), y: Math.round(y), slot: this.owner });
      this.terrain.clearAround(x, y, CITY.radius * 2.6);
    } else if (this.tool === 'erase') {
      if (!isClick) return;
      const idx = this.cities.findIndex((c) => Math.hypot(c.x - x, c.y - y) < CITY.radius + 12);
      if (idx >= 0) this.cities.splice(idx, 1);
    } else {
      this.terrain.paint(x, y, this.brush, TOOL_TERRAIN[this.tool]);
    }
    this.dirty = true;
  }

  open() {
    this.refreshSavedList();
    this.dirty = true;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.draw();
      requestAnimationFrame(loop);
    };
    loop();
  }

  close() {
    this.running = false;
  }

  draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    if (this.canvas.width !== Math.round(rect.width * dpr) || this.canvas.height !== Math.round(rect.height * dpr)) {
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.dirty = true;
    }
    if (this.dirty) {
      this.baked = bakeTerrain(this.terrain);
      this.dirty = false;
    }

    const ctx = this.ctx;
    const { scale, offsetX, offsetY } = this.metrics();
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = PALETTE.background;
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.drawImage(this.baked, 0, 0);

    for (const city of this.cities) {
      const color = city.slot < 0 ? NEUTRAL_COLOR : FACTION_COLORS[city.slot % FACTION_COLORS.length];
      ctx.beginPath();
      ctx.arc(city.x, city.y, CITY.captureRadius, 0, Math.PI * 2);
      ctx.strokeStyle = `${color}55`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(city.x, city.y, CITY.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#12161a';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(city.x, city.y, CITY.radius * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#12161a';
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, EDITOR_WIDTH, EDITOR_HEIGHT);
    ctx.restore();
    ctx.restore();
  }

  validate() {
    const slots = new Set(this.cities.filter((c) => c.slot >= 0).map((c) => c.slot));
    if (slots.size < 2) return 'Place starting cities for at least two players.';
    if (this.cities.length < 4) return 'A map needs at least four cities to be worth fighting over.';
    return null;
  }

  toMapDef(id, name) {
    const slots = [...new Set(this.cities.filter((c) => c.slot >= 0).map((c) => c.slot))].sort();
    // Compact the slot numbering so slots are always 0..n-1.
    const remap = new Map(slots.map((s, i) => [s, i]));
    return {
      id,
      custom: true,
      name,
      desc: 'Custom map',
      players: slots.length,
      width: EDITOR_WIDTH,
      height: EDITOR_HEIGHT,
      grid: this.terrain.encode(),
      cities: this.cities.map((c) => ({ x: c.x, y: c.y, slot: c.slot < 0 ? -1 : remap.get(c.slot) })),
    };
  }

  saveMap() {
    const error = this.validate();
    if (error) {
      this.app.flashGlobal(error);
      return null;
    }
    const name = (this.name || '').trim() || `Custom ${new Date().toLocaleDateString()}`;
    const id = this.editingId || `custom-${Date.now().toString(36)}`;
    this.editingId = id;
    const def = this.toMapDef(id, name);
    const maps = listCustomMaps().filter((m) => m.id !== id);
    maps.unshift(def);
    saveCustomMaps(maps.slice(0, 12));
    this.refreshSavedList();
    this.app.flashGlobal(`Saved "${name}"`);
    return def;
  }

  loadMap(def) {
    this.terrain = Terrain.decode(def.width, def.height, def.grid);
    this.cities = def.cities.map((c) => ({ ...c }));
    this.name = def.name;
    this.editingId = def.id;
    document.getElementById('editor-name').value = def.name;
    this.dirty = true;
  }

  refreshSavedList() {
    const host = document.getElementById('editor-saved');
    const maps = listCustomMaps();
    host.innerHTML = '';
    if (!maps.length) {
      host.innerHTML = '<span class="editor-help">No saved maps yet.</span>';
      return;
    }
    for (const def of maps) {
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = def.name;
      btn.title = 'Load this map';
      btn.addEventListener('click', () => this.loadMap(def));
      host.appendChild(btn);
    }
    const del = document.createElement('button');
    del.className = 'btn small danger';
    del.textContent = 'Delete loaded';
    del.addEventListener('click', () => {
      if (!this.editingId) return;
      saveCustomMaps(listCustomMaps().filter((m) => m.id !== this.editingId));
      this.editingId = null;
      this.refreshSavedList();
      this.app.flashGlobal('Map deleted');
    });
    host.appendChild(del);
  }
}
