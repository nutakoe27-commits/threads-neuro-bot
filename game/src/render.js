import { TERRAIN, PALETTE, FACTION_COLORS, NEUTRAL_COLOR, CITY } from './config.js';
import { CELL } from './terrain.js';

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.round(amount > 0 ? r + (255 - r) * amount : r * (1 + amount));
  g = Math.round(amount > 0 ? g + (255 - g) * amount : g * (1 + amount));
  b = Math.round(amount > 0 ? b + (255 - b) * amount : b * (1 + amount));
  return `rgb(${r},${g},${b})`;
}

// Terrain never changes during a match, so bake it once into an offscreen
// canvas and blit it. Cells are drawn as overlapping discs, which reads as
// organic shapes without any art assets.
export function bakeTerrain(terrain) {
  const canvas = document.createElement('canvas');
  canvas.width = terrain.width;
  canvas.height = terrain.height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = PALETTE.clear;
  ctx.fillRect(0, 0, terrain.width, terrain.height);

  const draw = (type, color, radius) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let cy = 0; cy < terrain.rows; cy++) {
      for (let cx = 0; cx < terrain.cols; cx++) {
        if (terrain.atCell(cx, cy) !== type) continue;
        const x = cx * CELL + CELL / 2;
        const y = cy * CELL + CELL / 2;
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  };

  draw(TERRAIN.ROUGH, PALETTE.rough, CELL * 0.8);
  draw(TERRAIN.WATER, '#0d1420', CELL * 0.9);
  draw(TERRAIN.WATER, PALETTE.water, CELL * 0.78);

  // Faint grid to give the empty plains a sense of scale.
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= terrain.width; x += 200) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, terrain.height);
  }
  for (let y = 0; y <= terrain.height; y += 200) {
    ctx.moveTo(0, y);
    ctx.lineTo(terrain.width, y);
  }
  ctx.stroke();

  return canvas;
}

export function bakeMinimap(terrain, width = 220) {
  const scale = width / terrain.width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(terrain.width * scale);
  canvas.height = Math.round(terrain.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PALETTE.clear;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const w = Math.max(1, CELL * scale);
  for (let cy = 0; cy < terrain.rows; cy++) {
    for (let cx = 0; cx < terrain.cols; cx++) {
      const t = terrain.atCell(cx, cy);
      if (t === TERRAIN.CLEAR) continue;
      ctx.fillStyle = t === TERRAIN.WATER ? PALETTE.water : PALETTE.rough;
      ctx.fillRect(cx * CELL * scale, cy * CELL * scale, w + 0.5, w + 0.5);
    }
  }
  return canvas;
}

export class Renderer {
  constructor(canvas, minimapCanvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minimap = minimapCanvas;
    this.minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
    this.terrainCanvas = null;
    this.minimapBase = null;
    this.dpr = 1;
  }

  attach(game) {
    this.game = game;
    this.terrainCanvas = bakeTerrain(game.terrain);
    this.minimapBase = bakeMinimap(game.terrain, 240);
    if (this.minimap) {
      this.minimap.width = this.minimapBase.width;
      this.minimap.height = this.minimapBase.height;
      this.minimap.style.width = `${this.minimapBase.width}px`;
      this.minimap.style.height = `${this.minimapBase.height}px`;
    }
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    return { width: rect.width, height: rect.height };
  }

  colorOf(faction) {
    return faction < 0 ? NEUTRAL_COLOR : FACTION_COLORS[faction % FACTION_COLORS.length];
  }

  draw(game, camera, view) {
    const ctx = this.ctx;
    const { selection, selectionBox, viewerFaction, hoverUnitId, showCommands } = view;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = PALETTE.background;
    ctx.fillRect(0, 0, camera.viewWidth, camera.viewHeight);

    ctx.save();
    ctx.translate(camera.viewWidth / 2, camera.viewHeight / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    const b = camera.bounds;
    ctx.drawImage(this.terrainCanvas, 0, 0);

    this.drawCities(ctx, game, camera, selection, viewerFaction);
    this.drawOrders(ctx, game, selection, showCommands);
    this.drawUnits(ctx, game, camera, b, selection, viewerFaction, hoverUnitId);
    this.drawEffects(ctx, game);

    ctx.restore();

    if (selectionBox) {
      ctx.strokeStyle = 'rgba(230,240,255,0.9)';
      ctx.fillStyle = 'rgba(120,170,255,0.12)';
      ctx.lineWidth = 1;
      const x = Math.min(selectionBox.x1, selectionBox.x2);
      const y = Math.min(selectionBox.y1, selectionBox.y2);
      const w = Math.abs(selectionBox.x2 - selectionBox.x1);
      const h = Math.abs(selectionBox.y2 - selectionBox.y1);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }

    ctx.restore();
    this.drawMinimap(game, camera, viewerFaction);
  }

  drawCities(ctx, game, camera, selection, viewerFaction) {
    for (const city of game.cities) {
      const color = this.colorOf(city.owner);
      const r = CITY.radius;

      // Supply halo — the area where units are fed and repaired.
      if (city.owner >= 0) {
        ctx.beginPath();
        ctx.arc(city.x, city.y, CITY.captureRadius, 0, Math.PI * 2);
        ctx.fillStyle = `${color}0d`;
        ctx.fill();
        ctx.strokeStyle = `${color}22`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(city.x, city.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#0d1119';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(city.x, city.y, r * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Production progress runs clockwise from the top.
      if (city.owner >= 0 && !city.paused) {
        const frac = Math.min(1, city.progress / city.buildTime());
        if (frac > 0.001) {
          ctx.beginPath();
          ctx.arc(city.x, city.y, r + 6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
          ctx.strokeStyle = city.produce === 'heavy' ? shade(color, 0.35) : color;
          ctx.lineWidth = city.produce === 'heavy' ? 4 : 2.5;
          ctx.stroke();
        }
      }

      if (city.captureProgress > 0.001 && city.captureBy >= 0) {
        ctx.beginPath();
        ctx.arc(city.x, city.y, r + 12, -Math.PI / 2, -Math.PI / 2 + city.captureProgress * Math.PI * 2);
        ctx.strokeStyle = this.colorOf(city.captureBy);
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (selection.cityId === city.id) {
        ctx.beginPath();
        ctx.arc(city.x, city.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (city.rally) {
          ctx.beginPath();
          ctx.moveTo(city.x, city.y);
          ctx.lineTo(city.rally.x, city.rally.y);
          ctx.strokeStyle = `${color}66`;
          ctx.setLineDash([6, 6]);
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(city.rally.x, city.rally.y, 5, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.stroke();
        }
      }

      // Paused production gets a clear visual so it is never a mystery.
      if (city.owner === viewerFaction && city.paused) {
        ctx.fillStyle = '#0b0e13';
        ctx.fillRect(city.x - 5, city.y - r - 16, 10, 10);
        ctx.fillStyle = color;
        ctx.fillRect(city.x - 4, city.y - r - 15, 3, 8);
        ctx.fillRect(city.x + 1, city.y - r - 15, 3, 8);
      }
    }
  }

  drawOrders(ctx, game, selection, showCommands) {
    if (!showCommands || !selection.units.size) return;
    ctx.lineWidth = 1;
    for (const id of selection.units) {
      const u = game.unitsById.get(id);
      if (!u || !u.dest) continue;
      ctx.strokeStyle = 'rgba(200,220,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(u.x, u.y);
      if (u.path) {
        for (let i = u.pathIndex; i < u.path.length; i++) ctx.lineTo(u.path[i].x, u.path[i].y);
      } else {
        ctx.lineTo(u.dest.x, u.dest.y);
      }
      ctx.stroke();
    }
  }

  drawUnits(ctx, game, camera, bounds, selection, viewerFaction, hoverUnitId) {
    const pad = 30;
    for (const u of game.units) {
      if (u.x < bounds.left - pad || u.x > bounds.right + pad || u.y < bounds.top - pad || u.y > bounds.bottom + pad) {
        continue;
      }
      const color = this.colorOf(u.faction);
      const r = u.radius;
      const isSelected = selection.units.has(u.id);

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (u.id === hoverUnitId) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (u.type === 'heavy') {
        // Heavies get a dark core so they read instantly at any zoom.
        ctx.beginPath();
        ctx.arc(u.x, u.y, r * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = '#0b0e13';
        ctx.fill();
      }

      const hpFrac = u.hp / u.maxHp;
      if (hpFrac < 0.995) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 2.5, -Math.PI / 2, -Math.PI / 2 + hpFrac * Math.PI * 2);
        ctx.strokeStyle = hpFrac > 0.5 ? '#8ef0a8' : hpFrac > 0.25 ? '#f5d76e' : '#ff6b6b';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      if (u.starving) {
        const pulse = 0.5 + 0.5 * Math.sin(game.time * 6 + u.id);
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,120,80,${0.25 + pulse * 0.5})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
  }

  drawEffects(ctx, game) {
    for (const e of game.effects) {
      const k = 1 - e.t / e.life;
      if (e.kind === 'tracer') {
        ctx.strokeStyle = `${this.colorOf(e.faction)}${Math.round(k * 200).toString(16).padStart(2, '0')}`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(e.x1, e.y1);
        ctx.lineTo(e.x2, e.y2);
        ctx.stroke();
      } else if (e.kind === 'death') {
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r + (1 - k) * 10, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${k * 0.5})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (e.kind === 'ping') {
        // Order marker: white for a move, amber for an attack-move.
        const color = e.faction === -2 ? '255,180,80' : '235,245,255';
        ctx.beginPath();
        ctx.arc(e.x, e.y, 4 + (1 - k) * 16, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${color},${k * 0.85})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (e.kind === 'capture') {
        ctx.beginPath();
        ctx.arc(e.x, e.y, CITY.radius + (1 - k) * 60, 0, Math.PI * 2);
        ctx.strokeStyle = `${this.colorOf(e.faction)}${Math.round(k * 180).toString(16).padStart(2, '0')}`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  drawMinimap(game, camera, viewerFaction) {
    const ctx = this.minimapCtx;
    if (!ctx || !this.minimapBase) return;
    const scale = this.minimapBase.width / game.terrain.width;
    ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.drawImage(this.minimapBase, 0, 0);

    for (const c of game.cities) {
      ctx.fillStyle = this.colorOf(c.owner);
      ctx.beginPath();
      ctx.arc(c.x * scale, c.y * scale, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const u of game.units) {
      ctx.fillStyle = this.colorOf(u.faction);
      const s = u.type === 'heavy' ? 2.2 : 1.4;
      ctx.fillRect(u.x * scale - s / 2, u.y * scale - s / 2, s, s);
    }

    const b = camera.bounds;
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.left * scale, b.top * scale, (b.right - b.left) * scale, (b.bottom - b.top) * scale);
  }
}
