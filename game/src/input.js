import { CITY } from './config.js';

const EDGE = 24;
const EDGE_SPEED = 900;

// Mouse + keyboard + touch handling for the match screen.
export class InputController {
  constructor({ canvas, minimap, camera, session }) {
    this.canvas = canvas;
    this.minimap = minimap;
    this.camera = camera;
    this.session = session;

    this.selection = { units: new Set(), cityId: -1 };
    this.groups = new Map();
    this.selectionBox = null;
    this.hoverUnitId = -1;
    this.attackMoveArmed = false;
    this.pointer = { x: 0, y: 0, inside: false };
    this.keys = new Set();
    this.dragging = null;
    this.panning = null;
    this.lastClickTime = 0;
    this.lastClickPos = { x: 0, y: 0 };
    this.touches = new Map();
    this.pinchDist = 0;
    this.longPressTimer = 0;
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
    if (this.minimap) {
      this.on(this.minimap, 'mousedown', (e) => this.onMinimap(e));
      this.on(this.minimap, 'mousemove', (e) => {
        if (e.buttons & 1) this.onMinimap(e);
      });
      this.on(this.minimap, 'touchstart', (e) => this.onMinimapTouch(e), { passive: false });
      this.on(this.minimap, 'touchmove', (e) => this.onMinimapTouch(e), { passive: false });
    }
  }

  localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ------------------------------------------------------------------ picking

  unitAt(worldX, worldY, radiusBoost = 6) {
    let best = null;
    let bestD = Infinity;
    for (const u of this.game.units) {
      const d = Math.hypot(u.x - worldX, u.y - worldY);
      if (d <= u.radius + radiusBoost && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  cityAt(worldX, worldY) {
    for (const c of this.game.cities) {
      if (Math.hypot(c.x - worldX, c.y - worldY) <= CITY.radius + 6) return c;
    }
    return null;
  }

  // ------------------------------------------------------------------- mouse

  onMouseDown(e) {
    this.canvas.focus?.();
    const p = this.localPoint(e);
    const world = this.camera.screenToWorld(p.x, p.y);

    if (e.button === 1) {
      e.preventDefault();
      this.panning = { x: p.x, y: p.y };
      return;
    }

    if (e.button === 0) {
      if (this.attackMoveArmed) {
        this.attackMoveArmed = false;
        this.canvas.classList.remove('targeting');
        this.issueMove(world.x, world.y, true);
        return;
      }
      this.dragging = { x1: p.x, y1: p.y, x2: p.x, y2: p.y, additive: e.shiftKey };
      return;
    }

    if (e.button === 2) {
      this.commandAt(world.x, world.y, false);
    }
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
    if (this.dragging) {
      this.dragging.x2 = p.x;
      this.dragging.y2 = p.y;
      const w = Math.abs(this.dragging.x2 - this.dragging.x1);
      const h = Math.abs(this.dragging.y2 - this.dragging.y1);
      this.selectionBox = w > 4 || h > 4 ? { ...this.dragging } : null;
      return;
    }
    if (this.game && this.pointer.inside) {
      const world = this.camera.screenToWorld(p.x, p.y);
      const u = this.unitAt(world.x, world.y);
      this.hoverUnitId = u ? u.id : -1;
    }
  }

  onMouseUp(e) {
    if (e.button === 1) {
      this.panning = null;
      return;
    }
    if (e.button !== 0 || !this.dragging) return;
    const drag = this.dragging;
    this.dragging = null;
    this.selectionBox = null;

    const moved = Math.hypot(drag.x2 - drag.x1, drag.y2 - drag.y1);
    if (moved > 5) {
      this.boxSelect(drag);
    } else {
      this.clickSelect(drag);
    }
  }

  boxSelect(drag) {
    const a = this.camera.screenToWorld(Math.min(drag.x1, drag.x2), Math.min(drag.y1, drag.y2));
    const b = this.camera.screenToWorld(Math.max(drag.x1, drag.x2), Math.max(drag.y1, drag.y2));
    if (!drag.additive) this.clearSelection();
    for (const u of this.game.units) {
      if (u.faction !== this.faction) continue;
      if (u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y) this.selection.units.add(u.id);
    }
    if (this.selection.units.size) this.selection.cityId = -1;
    this.session.onSelectionChanged();
  }

  clickSelect(drag) {
    const world = this.camera.screenToWorld(drag.x1, drag.y1);
    const now = performance.now();
    const isDouble =
      now - this.lastClickTime < 320 && Math.hypot(drag.x1 - this.lastClickPos.x, drag.y1 - this.lastClickPos.y) < 8;
    this.lastClickTime = now;
    this.lastClickPos = { x: drag.x1, y: drag.y1 };

    const unit = this.unitAt(world.x, world.y);
    if (unit && unit.faction === this.faction) {
      if (!drag.additive) this.clearSelection();
      if (isDouble) {
        // Double click grabs every same-type unit currently on screen.
        const b = this.camera.bounds;
        for (const u of this.game.units) {
          if (u.faction !== this.faction || u.type !== unit.type) continue;
          if (u.x < b.left || u.x > b.right || u.y < b.top || u.y > b.bottom) continue;
          this.selection.units.add(u.id);
        }
      } else {
        this.selection.units.add(unit.id);
      }
      this.selection.cityId = -1;
      this.session.onSelectionChanged();
      return;
    }

    const city = this.cityAt(world.x, world.y);
    if (city) {
      this.clearSelection();
      this.selection.cityId = city.id;
      this.session.onSelectionChanged();
      return;
    }

    if (!drag.additive) {
      this.clearSelection();
      this.session.onSelectionChanged();
    }
  }

  clearSelection() {
    this.selection.units.clear();
    this.selection.cityId = -1;
  }

  // Right click (or touch command tap): attack a target, or move.
  commandAt(worldX, worldY, forceAttackMove) {
    if (!this.enabled) return;
    const city = this.selection.cityId >= 0 ? this.game.cities[this.selection.cityId] : null;
    if (city && city.owner === this.faction && !this.selection.units.size) {
      this.game.issue({ type: 'rally', faction: this.faction, city: city.id, x: worldX, y: worldY });
      this.session.flash('Rally point set');
      return;
    }
    if (!this.selection.units.size) return;

    const target = this.unitAt(worldX, worldY);
    if (target && target.faction !== this.faction && !this.game.areAllied(target.faction, this.faction)) {
      this.game.issue({
        type: 'attack',
        faction: this.faction,
        units: [...this.selection.units],
        target: target.id,
      });
      return;
    }
    this.issueMove(worldX, worldY, forceAttackMove);
  }

  issueMove(worldX, worldY, attackMove) {
    if (!this.enabled || !this.selection.units.size) return;
    this.game.issue({
      type: attackMove ? 'attackMove' : 'move',
      faction: this.faction,
      units: [...this.selection.units],
      x: worldX,
      y: worldY,
    });
    this.session.pingMarker(worldX, worldY, attackMove);
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.localPoint(e);
    this.camera.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.14 : 1 / 1.14);
  }

  // ---------------------------------------------------------------- keyboard

  onKeyDown(e) {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    this.keys.add(e.code);

    if (e.code === 'Escape') {
      if (this.attackMoveArmed) {
        this.attackMoveArmed = false;
        this.canvas.classList.remove('targeting');
      } else {
        this.session.toggleMenu();
      }
      e.preventDefault();
      return;
    }

    if (e.ctrlKey && e.code.startsWith('Digit')) {
      const n = e.code.slice(5);
      this.groups.set(n, new Set(this.selection.units));
      this.session.flash(`Group ${n} set`);
      e.preventDefault();
      return;
    }
    if (!e.ctrlKey && e.code.startsWith('Digit')) {
      const n = e.code.slice(5);
      const group = this.groups.get(n);
      if (group) {
        this.selection.units = new Set([...group].filter((id) => this.game.unitsById.has(id)));
        this.selection.cityId = -1;
        this.session.onSelectionChanged();
      }
      return;
    }

    switch (e.code) {
      case 'KeyA':
        if (this.enabled && this.selection.units.size) {
          this.attackMoveArmed = true;
          this.canvas.classList.add('targeting');
        }
        break;
      case 'KeyS':
        if (this.enabled && this.selection.units.size) {
          this.game.issue({ type: 'stop', faction: this.faction, units: [...this.selection.units] });
        }
        break;
      case 'KeyH':
        if (this.enabled && this.selection.units.size) {
          this.game.issue({ type: 'hold', faction: this.faction, units: [...this.selection.units] });
        }
        break;
      case 'KeyQ':
        this.setProduction('light');
        break;
      case 'KeyW':
        this.setProduction('heavy');
        break;
      case 'KeyE':
        if (this.enabled && this.selection.cityId >= 0) {
          this.game.issue({ type: 'togglePause', faction: this.faction, city: this.selection.cityId });
        }
        break;
      case 'KeyF':
        this.centerOnSelection();
        break;
      case 'Tab':
        e.preventDefault();
        this.cycleCities();
        break;
      case 'KeyZ':
        this.selectAllArmy();
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
    if (!this.enabled || this.selection.cityId < 0) return;
    const city = this.game.cities[this.selection.cityId];
    if (!city || city.owner !== this.faction) return;
    this.game.issue({ type: 'produce', faction: this.faction, city: city.id, unitType: type });
  }

  selectAllArmy() {
    this.clearSelection();
    for (const u of this.game.units) if (u.faction === this.faction) this.selection.units.add(u.id);
    this.session.onSelectionChanged();
  }

  centerOnSelection() {
    if (this.selection.cityId >= 0) {
      const c = this.game.cities[this.selection.cityId];
      this.camera.centerOn(c.x, c.y);
      return;
    }
    if (!this.selection.units.size) return;
    let x = 0;
    let y = 0;
    let n = 0;
    for (const id of this.selection.units) {
      const u = this.game.unitsById.get(id);
      if (!u) continue;
      x += u.x;
      y += u.y;
      n++;
    }
    if (n) this.camera.centerOn(x / n, y / n);
  }

  cycleCities() {
    const mine = this.game.cities.filter((c) => c.owner === this.faction);
    if (!mine.length) return;
    const idx = mine.findIndex((c) => c.id === this.selection.cityId);
    const next = mine[(idx + 1) % mine.length];
    this.clearSelection();
    this.selection.cityId = next.id;
    this.camera.centerOn(next.x, next.y);
    this.session.onSelectionChanged();
  }

  // ------------------------------------------------------------------- touch

  onTouchStart(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      this.touches.set(t.identifier, { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, time: performance.now(), moved: false });
    }
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.boxSelectTouch = null;
    }
  }

  onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const rec = this.touches.get(t.identifier);
      if (!rec) continue;
      const dx = t.clientX - rec.x;
      const dy = t.clientY - rec.y;
      rec.x = t.clientX;
      rec.y = t.clientY;
      if (Math.hypot(t.clientX - rec.sx, t.clientY - rec.sy) > 12) rec.moved = true;
      if (this.touches.size === 1 && rec.moved) {
        this.camera.move(-dx / this.camera.zoom, -dy / this.camera.zoom);
      }
    }
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0) {
        const rect = this.canvas.getBoundingClientRect();
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
      if (!rec || rec.moved || this.touches.size > 0) continue;
      const rect = this.canvas.getBoundingClientRect();
      const p = { x: rec.sx - rect.left, y: rec.sy - rect.top };
      const world = this.camera.screenToWorld(p.x, p.y);
      const held = performance.now() - rec.time > 450;

      const unit = this.unitAt(world.x, world.y, 12);
      const city = this.cityAt(world.x, world.y);

      if (held && this.selection.units.size) {
        // Long press = attack-move, the aggressive version of a tap order.
        this.commandAt(world.x, world.y, true);
        continue;
      }
      if (unit && unit.faction === this.faction) {
        this.clearSelection();
        this.selection.units.add(unit.id);
        this.session.onSelectionChanged();
        continue;
      }
      if (city && !this.selection.units.size) {
        this.clearSelection();
        this.selection.cityId = city.id;
        this.session.onSelectionChanged();
        continue;
      }
      if (this.selection.units.size) {
        this.commandAt(world.x, world.y, false);
      } else {
        this.clearSelection();
        this.session.onSelectionChanged();
      }
    }
    if (this.touches.size < 2) this.pinchDist = 0;
  }

  onMinimap(e) {
    const rect = this.minimap.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    this.camera.centerOn(fx * this.game.terrain.width, fy * this.game.terrain.height);
  }

  onMinimapTouch(e) {
    e.preventDefault();
    const t = e.touches[0];
    if (t) this.onMinimap(t);
  }

  // Edge scrolling + keyboard panning, called once per frame.
  updateCamera(dt) {
    let dx = 0;
    let dy = 0;
    // Arrow keys pan; WASD is left alone so A can stay attack-move.
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('ArrowDown')) dy += 1;

    if (this.pointer.inside && !this.dragging && document.hasFocus()) {
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
    for (const id of [...this.selection.units]) {
      if (!this.game.unitsById.has(id)) this.selection.units.delete(id);
    }
  }
}
