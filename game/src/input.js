import { BASE } from './config.js';

const EDGE = 24;
const EDGE_SPEED = 900;
const MIN_DRAG = 18;

// Input for a front-line game: you do not pick units, you push stretches of the
// line. Dragging from the line to a destination is the only order there is.
export class InputController {
  constructor({ canvas, minimap, camera, session }) {
    this.canvas = canvas;
    this.minimap = minimap;
    this.camera = camera;
    this.session = session;

    // Kept as an object so the renderer can stay generic; only bases are ever
    // "selected", and only to look at them.
    this.selection = { units: new Set(), cityId: -1, baseId: -1 };
    this.arrow = null;        // order being drawn: {x1,y1,x2,y2} in world space
    this.pointer = { x: 0, y: 0, inside: false };
    this.keys = new Set();
    this.panning = null;
    this.touches = new Map();
    this.pinchDist = 0;
    this.touchMode = 'order';
    this.enabled = true;

    this.bind();
  }

  get game() {
    return this.session.game;
  }

  get faction() {
    return this.session.viewerFaction;
  }

  destroy() {
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    this.listeners = [];
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  bind() {
    this.listeners = [];
    const c = this.canvas;
    this.on(c, 'contextmenu', (e) => e.preventDefault());
    this.on(c, 'mousedown', (e) => this.onMouseDown(e));
    this.on(window, 'mousemove', (e) => this.onMouseMove(e));
    this.on(window, 'mouseup', (e) => this.onMouseUp(e));
    this.on(c, 'mouseleave', () => {
      this.pointer.inside = false;
    });
    this.on(c, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.on(window, 'keydown', (e) => this.onKeyDown(e));
    this.on(window, 'keyup', (e) => this.keys.delete(e.code));
    this.on(c, 'touchstart', (e) => this.onTouchStart(e), { passive: false });
    this.on(c, 'touchmove', (e) => this.onTouchMove(e), { passive: false });
    this.on(c, 'touchend', (e) => this.onTouchEnd(e), { passive: false });
    this.on(c, 'touchcancel', (e) => this.onTouchEnd(e), { passive: false });
  }

  localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  baseAt(worldX, worldY) {
    for (const b of this.game.bases) {
      if (b.dead) continue;
      if (Math.hypot(b.x - worldX, b.y - worldY) <= BASE.radius + 10) return b;
    }
    return null;
  }

  // ------------------------------------------------------------------- orders

  beginArrow(world) {
    this.arrow = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
  }

  finishArrow() {
    const a = this.arrow;
    this.arrow = null;
    if (!a || !this.enabled) return false;
    const length = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
    if (length < MIN_DRAG) return false;
    this.game.issue({
      type: 'advance',
      faction: this.faction,
      fromX: a.x1,
      fromY: a.y1,
      x: a.x2,
      y: a.y2,
    });
    this.session.pingMarker(a.x2, a.y2, true);
    return true;
  }

  // -------------------------------------------------------------------- mouse

  onMouseDown(e) {
    this.canvas.focus?.();
    const p = this.localPoint(e);
    const world = this.camera.screenToWorld(p.x, p.y);

    if (e.button === 1 || e.button === 2 || this.keys.has('Space')) {
      e.preventDefault();
      this.panning = { x: p.x, y: p.y };
      return;
    }
    if (e.button === 0) this.beginArrow(world);
  }

  onMouseMove(e) {
    const p = this.localPoint(e);
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = p.x;
    this.pointer.y = p.y;
    this.pointer.inside = p.x >= 0 && p.y >= 0 && p.x <= rect.width && p.y <= rect.height;

    if (this.panning) {
      this.camera.move(-(p.x - this.panning.x) / this.camera.zoom, -(p.y - this.panning.y) / this.camera.zoom);
      this.panning = { x: p.x, y: p.y };
      return;
    }
    if (this.arrow) {
      const world = this.camera.screenToWorld(p.x, p.y);
      this.arrow.x2 = world.x;
      this.arrow.y2 = world.y;
    }
  }

  onMouseUp(e) {
    if (this.panning && e.button !== 0) {
      this.panning = null;
      return;
    }
    if (e.button !== 0) return;
    const a = this.arrow;
    const issued = this.finishArrow();
    if (issued || !a) return;

    // A click, not a drag: look at whatever is under it.
    const base = this.baseAt(a.x1, a.y1);
    this.selection.baseId = base && base.owner === this.faction ? base.id : -1;
    this.session.onSelectionChanged();
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.localPoint(e);
    this.camera.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.14 : 1 / 1.14);
  }

  // ----------------------------------------------------------------- keyboard

  onKeyDown(e) {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    this.keys.add(e.code);

    if (e.code === 'Escape') {
      if (this.arrow) this.arrow = null;
      else this.session.toggleMenu();
      e.preventDefault();
      return;
    }

    switch (e.code) {
      case 'KeyQ':
        this.setProduction('light');
        break;
      case 'KeyW':
        this.setProduction('heavy');
        break;
      case 'KeyE':
        if (this.enabled && this.selection.baseId >= 0) {
          this.game.issue({ type: 'togglePause', faction: this.faction, base: this.selection.baseId });
        }
        break;
      case 'Tab':
        e.preventDefault();
        this.cycleBases();
        break;
      case 'Space':
        e.preventDefault();
        this.session.togglePause();
        break;
      case 'BracketLeft':
        this.session.changeSpeed(-1);
        break;
      case 'BracketRight':
        this.session.changeSpeed(1);
        break;
      default:
        break;
    }
  }

  setProduction(type) {
    if (!this.enabled || this.selection.baseId < 0) return;
    const base = this.game.bases[this.selection.baseId];
    if (!base || base.dead || base.owner !== this.faction) return;
    this.game.issue({ type: 'produce', faction: this.faction, base: base.id, unitType: type });
  }

  cycleBases() {
    const mine = this.game.bases.filter((b) => !b.dead && b.owner === this.faction);
    if (!mine.length) return;
    const idx = mine.findIndex((b) => b.id === this.selection.baseId);
    const next = mine[(idx + 1) % mine.length];
    this.selection.baseId = next.id;
    this.camera.centerOn(next.x, next.y);
    this.session.onSelectionChanged();
  }

  clearSelection() {
    this.selection.baseId = -1;
    this.selection.units.clear();
  }

  // -------------------------------------------------------------------- touch

  setTouchMode(mode) {
    this.touchMode = mode;
    this.arrow = null;
  }

  onTouchStart(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    for (const t of e.changedTouches) {
      this.touches.set(t.identifier, {
        x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, moved: false,
      });
    }
    if (this.touches.size === 1 && this.touchMode === 'order') {
      const t = e.changedTouches[0];
      this.beginArrow(this.camera.screenToWorld(t.clientX - rect.left, t.clientY - rect.top));
    }
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.arrow = null;
    }
  }

  onTouchMove(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    for (const t of e.changedTouches) {
      const rec = this.touches.get(t.identifier);
      if (!rec) continue;
      const dx = t.clientX - rec.x;
      const dy = t.clientY - rec.y;
      rec.x = t.clientX;
      rec.y = t.clientY;
      if (Math.hypot(t.clientX - rec.sx, t.clientY - rec.sy) > 10) rec.moved = true;
      if (this.touches.size !== 1) continue;
      if (this.arrow) {
        const w = this.camera.screenToWorld(t.clientX - rect.left, t.clientY - rect.top);
        this.arrow.x2 = w.x;
        this.arrow.y2 = w.y;
      } else if (rec.moved) {
        this.camera.move(-dx / this.camera.zoom, -dy / this.camera.zoom);
      }
    }
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0) {
        const cx = (a.x + b.x) / 2 - rect.left;
        const cy = (a.y + b.y) / 2 - rect.top;
        this.camera.zoomAt(cx, cy, dist / this.pinchDist);
      }
      this.pinchDist = dist;
    }
  }

  onTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const rec = this.touches.get(t.identifier);
      this.touches.delete(t.identifier);
      if (!rec || this.touches.size > 0) continue;
      const a = this.arrow;
      const issued = this.finishArrow();
      if (issued || rec.moved || !a) continue;
      const base = this.baseAt(a.x1, a.y1);
      this.selection.baseId = base && base.owner === this.faction ? base.id : -1;
      this.session.onSelectionChanged();
    }
    if (this.touches.size < 2) this.pinchDist = 0;
  }

  // Edge scrolling + keyboard panning, called once per frame.
  updateCamera(dt) {
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('ArrowDown')) dy += 1;

    if (this.pointer.inside && !this.arrow && document.hasFocus()) {
      const rect = this.canvas.getBoundingClientRect();
      if (this.pointer.x < EDGE) dx -= 1;
      if (this.pointer.x > rect.width - EDGE) dx += 1;
      if (this.pointer.y < EDGE) dy -= 1;
      if (this.pointer.y > rect.height - EDGE) dy += 1;
    }

    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      const speed = (EDGE_SPEED / this.camera.zoom) * dt;
      this.camera.move((dx / len) * speed, (dy / len) * speed);
    }
  }

  prune() {
    if (this.selection.baseId >= 0) {
      const b = this.game.bases[this.selection.baseId];
      if (!b || b.dead) this.selection.baseId = -1;
    }
  }
}
