import { TERRAIN, TERRAIN_INFO, PALETTE, FACTION_COLORS, NEUTRAL_COLOR, CITY, BASE, info } from './config.js';
import { CELL } from './terrain.js';
import { traceContours } from './contour.js';

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
// canvas and blit it. Cells are drawn as overlapping discs, which gives the
// soft organic shapes of a hand-drawn map without any art assets.
export function bakeTerrain(terrain) {
  const canvas = document.createElement('canvas');
  canvas.width = terrain.width;
  canvas.height = terrain.height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = TERRAIN_INFO[TERRAIN.PLAINS].color;
  ctx.fillRect(0, 0, terrain.width, terrain.height);

  // Roads sit on top of the ground they cross, so they are excluded from the
  // region outlines and stroked separately afterwards.
  const roadish = (t) => t === TERRAIN.ROAD || t === TERRAIN.BRIDGE;

  const region = (types, fill, outline) => {
    const wanted = new Set(types);
    const inside = (cx, cy) => {
      if (cx < 0 || cy < 0 || cx >= terrain.cols || cy >= terrain.rows) return false;
      return wanted.has(terrain.atCell(cx, cy));
    };
    const loops = traceContours(inside, terrain.cols, terrain.rows, CELL, 3);
    if (!loops.length) return;
    const path = new Path2D();
    for (const loop of loops) {
      path.moveTo(loop[0].x, loop[0].y);
      for (let i = 1; i < loop.length; i++) path.lineTo(loop[i].x, loop[i].y);
      path.closePath();
    }
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 7;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    }
    ctx.fillStyle = fill;
    ctx.fill(path, 'evenodd');
  };

  // Painted back to front. Bridges count as water underneath so a river reads
  // as continuous rather than chopped in half at every crossing.
  const H = TERRAIN_INFO[TERRAIN.HILLS];
  const M = TERRAIN_INFO[TERRAIN.MOUNTAIN];
  const F = TERRAIN_INFO[TERRAIN.FOREST];
  const W = TERRAIN_INFO[TERRAIN.WATER];

  region([TERRAIN.HILLS, TERRAIN.MOUNTAIN], H.color);
  region([TERRAIN.MOUNTAIN], M.color, shade(M.color, -0.2));
  region([TERRAIN.FOREST], F.color);
  region([TERRAIN.WATER, TERRAIN.BRIDGE], W.color, shade(W.color, -0.25));

  drawRoads(ctx, terrain);
  return canvas;
}

// Roads are stroked along their centre lines. Each path is split into runs of
// road and bridge so a crossing gets brown planks and the rest stays gravel.
function drawRoads(ctx, terrain) {
  if (!terrain.roadPaths || !terrain.roadPaths.length) return;
  const road = TERRAIN_INFO[TERRAIN.ROAD];
  const bridge = TERRAIN_INFO[TERRAIN.BRIDGE];

  const runs = [];
  for (const path of terrain.roadPaths) {
    // Resample so the road/bridge switch lands close to the actual bank.
    const dense = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL * 0.5)));
      for (let s = 0; s < steps; s++) {
        dense.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
      }
    }
    dense.push(path[path.length - 1]);

    let current = null;
    for (let i = 0; i < dense.length; i++) {
      const onBridge = terrain.at(dense[i].x, dense[i].y) === TERRAIN.BRIDGE;
      if (!current || current.bridge !== onBridge) {
        if (current) current.points.push(dense[i]); // overlap so runs meet
        current = { bridge: onBridge, points: [dense[i]] };
        runs.push(current);
      } else {
        current.points.push(dense[i]);
      }
    }
  }

  const stroke = (run, color, width) => {
    if (run.points.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(run.points[0].x, run.points[0].y);
    for (let i = 1; i < run.points.length; i++) ctx.lineTo(run.points[i].x, run.points[i].y);
    ctx.stroke();
  };

  for (const run of runs) stroke(run, shade(run.bridge ? bridge.color : road.color, -0.35), CELL * 1.0);
  for (const run of runs) stroke(run, run.bridge ? bridge.color : road.color, CELL * 0.68);
}

export function bakeMinimap(terrain, width = 220) {
  const scale = width / terrain.width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(terrain.width * scale);
  canvas.height = Math.round(terrain.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = TERRAIN_INFO[TERRAIN.PLAINS].color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const w = Math.max(1, CELL * scale);
  for (let cy = 0; cy < terrain.rows; cy++) {
    for (let cx = 0; cx < terrain.cols; cx++) {
      const t = terrain.atCell(cx, cy);
      if (t === TERRAIN.PLAINS) continue;
      ctx.fillStyle = TERRAIN_INFO[t] ? TERRAIN_INFO[t].color : TERRAIN_INFO[0].color;
      ctx.fillRect(cx * CELL * scale, cy * CELL * scale, w + 0.5, w + 0.5);
    }
  }
  return canvas;
}

function star(ctx, x, y, outer, inner, points = 5) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
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
    this.frontLines = [];
    this.frontVersion = -1;
  }

  attach(game) {
    this.game = game;
    this.terrainCanvas = bakeTerrain(game.terrain);
    this.minimapBase = bakeMinimap(game.terrain, 240);
    this.frontVersion = -1;
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
    const { selection, viewerFaction, hoverUnitId, showCommands, arrow } = view;

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

    this.drawFrontLines(ctx, game, camera);
    this.drawCities(ctx, game, selection);
    this.drawBases(ctx, game, selection, viewerFaction);
    this.drawOrders(ctx, game, selection, showCommands);
    this.drawUnits(ctx, game, b, selection, hoverUnitId, viewerFaction);
    this.drawEffects(ctx, game);
    if (arrow) this.drawArrow(ctx, arrow, camera);

    ctx.restore();
    ctx.restore();
    this.drawMinimap(game, camera, viewerFaction);
  }

  // The front line, taken straight from the influence field, so it shifts with
  // the armies rather than only when a city changes hands.
  drawFrontLines(ctx, game, camera) {
    if (this.frontVersion !== game.influence.version) {
      this.frontVersion = game.influence.version;
      this.frontLines = game.influence.frontLines();
    }
    if (!this.frontLines.length) return;
    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = Math.max(2.5, 4 / camera.zoom);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const line of this.frontLines) {
      ctx.moveTo(line[0].x, line[0].y);
      for (let i = 1; i < line.length; i++) ctx.lineTo(line[i].x, line[i].y);
    }
    ctx.stroke();
  }

  // Bases are the big dots: the gold engine, the factory, and the win condition.
  drawBases(ctx, game, selection, viewerFaction) {
    for (const base of game.bases) {
      const color = this.colorOf(base.owner);
      const r = BASE.radius;

      if (base.dead) {
        ctx.beginPath();
        ctx.arc(base.x, base.y, r * 0.7, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(20,24,28,0.45)';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }

      // Garrison ring: units inside eat for free.
      ctx.beginPath();
      ctx.arc(base.x, base.y, BASE.freeRadius, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.setLineDash([10, 10]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(base.x, base.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#12161a';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      star(ctx, base.x, base.y, r * 0.62, r * 0.27);
      ctx.fill();

      // Structural damage runs as a red arc around the rim.
      const hpFrac = base.hp / base.maxHp;
      if (hpFrac < 0.999) {
        ctx.beginPath();
        ctx.arc(base.x, base.y, r + 7, -Math.PI / 2, -Math.PI / 2 + hpFrac * Math.PI * 2);
        ctx.strokeStyle = hpFrac > 0.5 ? '#3ddc6b' : hpFrac > 0.25 ? '#ffd23f' : '#ff4d4d';
        ctx.lineWidth = 5;
        ctx.stroke();
      }

      if (!base.paused && base.charged) {
        const frac = Math.min(1, base.progress / base.buildTime());
        ctx.beginPath();
        ctx.arc(base.x, base.y, r + 14, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.strokeStyle = base.produce === 'heavy' ? '#12161a' : '#ffffff';
        ctx.lineWidth = base.produce === 'heavy' ? 4.5 : 3;
        ctx.stroke();
      }

      if (selection.baseId === base.id) {
        ctx.beginPath();
        ctx.arc(base.x, base.y, r + 20, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        if (base.rally) {
          ctx.beginPath();
          ctx.moveTo(base.x, base.y);
          ctx.lineTo(base.rally.x, base.rally.y);
          ctx.strokeStyle = color;
          ctx.setLineDash([7, 6]);
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(base.rally.x, base.rally.y, 6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      if (base.owner === viewerFaction && base.paused) {
        ctx.fillStyle = '#12161a';
        ctx.fillRect(base.x - 7, base.y - r - 22, 5, 13);
        ctx.fillRect(base.x + 2, base.y - r - 22, 5, 13);
      }
    }
  }

  drawCities(ctx, game, selection) {
    for (const city of game.cities) {
      const color = this.colorOf(city.owner);
      const r = CITY.radius;

      // Supply ring — the area where units are fed and repaired.
      if (city.owner >= 0) {
        ctx.beginPath();
        ctx.arc(city.x, city.y, CITY.captureRadius, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([9, 9]);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // Cities are pure economy: a small coloured disc with a dark rim.
      ctx.beginPath();
      ctx.arc(city.x, city.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#12161a';
      ctx.stroke();

      ctx.fillStyle = city.owner < 0 ? '#12161a' : '#ffffff';
      ctx.beginPath();
      ctx.arc(city.x, city.y, r * 0.34, 0, Math.PI * 2);
      ctx.fill();

      if (city.captureProgress > 0.001 && city.captureBy >= 0) {
        ctx.beginPath();
        ctx.arc(city.x, city.y, r + 12, -Math.PI / 2, -Math.PI / 2 + city.captureProgress * Math.PI * 2);
        ctx.strokeStyle = this.colorOf(city.captureBy);
        ctx.lineWidth = 4;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (selection.cityId === city.id) {
        ctx.beginPath();
        ctx.arc(city.x, city.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(city.x, city.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = '#12161a';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // The order being dragged: tail on the stretch of line it picks up, head where
  // that stretch is being sent.
  drawArrow(ctx, arrow, camera) {
    const dx = arrow.x2 - arrow.x1;
    const dy = arrow.y2 - arrow.y1;
    const len = Math.hypot(dx, dy);
    const scale = Math.max(1, 1 / camera.zoom);

    ctx.strokeStyle = 'rgba(15,20,25,0.55)';
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.arc(arrow.x1, arrow.y1, 150, 0, Math.PI * 2);
    ctx.setLineDash([8 * scale, 8 * scale]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (len < 6) return;
    const ux = dx / len;
    const uy = dy / len;
    const head = Math.min(34, len * 0.4) * scale;

    ctx.strokeStyle = '#12161a';
    ctx.lineCap = 'round';
    ctx.lineWidth = 6 * scale;
    ctx.beginPath();
    ctx.moveTo(arrow.x1, arrow.y1);
    ctx.lineTo(arrow.x2 - ux * head * 0.6, arrow.y2 - uy * head * 0.6);
    ctx.stroke();

    ctx.fillStyle = '#12161a';
    ctx.beginPath();
    ctx.moveTo(arrow.x2, arrow.y2);
    ctx.lineTo(arrow.x2 - ux * head + uy * head * 0.45, arrow.y2 - uy * head - ux * head * 0.45);
    ctx.lineTo(arrow.x2 - ux * head - uy * head * 0.45, arrow.y2 - uy * head + ux * head * 0.45);
    ctx.closePath();
    ctx.fill();
  }

  drawOrders(ctx, game, selection, showCommands) {
    if (!showCommands || !selection.units.size) return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(18,22,26,0.35)';
    ctx.setLineDash([6, 5]);
    for (const id of selection.units) {
      const u = game.unitsById.get(id);
      if (!u || !u.dest) continue;
      ctx.beginPath();
      ctx.moveTo(u.x, u.y);
      if (u.path) {
        for (let i = u.pathIndex; i < u.path.length; i++) ctx.lineTo(u.path[i].x, u.path[i].y);
      } else {
        ctx.lineTo(u.dest.x, u.dest.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  drawUnits(ctx, game, bounds, selection, hoverUnitId, viewerFaction) {
    const pad = 30;
    for (const u of game.units) {
      if (u.x < bounds.left - pad || u.x > bounds.right + pad || u.y < bounds.top - pad || u.y > bounds.bottom + pad) {
        continue;
      }
      // Cover hides units from everyone who has nobody close enough to spot them.
      if (viewerFaction >= 0 && !game.isVisibleTo(u, viewerFaction)) continue;
      const color = this.colorOf(u.faction);
      const r = u.radius;
      const isSelected = selection.units.has(u.id);

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (u.id === hoverUnitId) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Light is a plain dot; heavy wears a thick black ring.
      if (u.type === 'heavy') {
        ctx.lineWidth = r * 0.55;
        ctx.strokeStyle = '#0b0d10';
        ctx.beginPath();
        ctx.arc(u.x, u.y, r * 0.78, 0, Math.PI * 2);
        ctx.stroke();
      }

      const hpFrac = u.hp / u.maxHp;
      if (hpFrac < 0.995) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 3, -Math.PI / 2, -Math.PI / 2 + hpFrac * Math.PI * 2);
        ctx.strokeStyle = hpFrac > 0.5 ? '#3ddc6b' : hpFrac > 0.25 ? '#ffd23f' : '#ff4d4d';
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }

      // Shaken troops get a pale wedge; the lower the morale, the wider it is.
      if (u.morale < 0.92) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 6, Math.PI / 2, Math.PI / 2 + (1 - u.morale) * Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (u.starving || !u.supplied) {
        const pulse = 0.5 + 0.5 * Math.sin(game.time * 6 + u.id);
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 9, 0, Math.PI * 2);
        // Encircled is the emergency; merely broke is a warning.
        ctx.strokeStyle = u.supplied
          ? `rgba(255,150,40,${0.3 + pulse * 0.45})`
          : `rgba(255,40,40,${0.45 + pulse * 0.5})`;
        ctx.lineWidth = u.supplied ? 2 : 3;
        ctx.stroke();
      }
    }
  }

  drawEffects(ctx, game) {
    for (const e of game.effects) {
      const k = 1 - e.t / e.life;
      if (e.kind === 'tracer') {
        ctx.strokeStyle = `rgba(20,24,28,${k * 0.7})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(e.x1, e.y1);
        ctx.lineTo(e.x2, e.y2);
        ctx.stroke();
      } else if (e.kind === 'death') {
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r + (1 - k) * 12, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(30,34,38,${k * 0.6})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (e.kind === 'ping') {
        // Order marker: white for a move, amber for an attack-move.
        const color = e.faction === -2 ? '255,140,0' : '255,255,255';
        ctx.beginPath();
        ctx.arc(e.x, e.y, 5 + (1 - k) * 18, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${color},${k})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else if (e.kind === 'baseFall') {
        ctx.beginPath();
        ctx.arc(e.x, e.y, BASE.radius + (1 - k) * 130, 0, Math.PI * 2);
        ctx.strokeStyle = this.colorOf(e.faction);
        ctx.globalAlpha = k;
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (e.kind === 'capture') {
        ctx.beginPath();
        ctx.arc(e.x, e.y, CITY.radius + (1 - k) * 70, 0, Math.PI * 2);
        ctx.strokeStyle = this.colorOf(e.faction);
        ctx.globalAlpha = k;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  drawMinimap(game, camera, viewerFaction = -1) {
    const ctx = this.minimapCtx;
    if (!ctx || !this.minimapBase) return;
    const scale = this.minimapBase.width / game.terrain.width;
    ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.drawImage(this.minimapBase, 0, 0);

    for (const c of game.cities) {
      ctx.fillStyle = this.colorOf(c.owner);
      ctx.strokeStyle = '#12161a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.x * scale, c.y * scale, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const b of game.bases) {
      if (b.dead) continue;
      ctx.fillStyle = this.colorOf(b.owner);
      ctx.strokeStyle = '#12161a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(b.x * scale, b.y * scale, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const u of game.units) {
      // Radar respects cover too.
      if (viewerFaction >= 0 && !game.isVisibleTo(u, viewerFaction)) continue;
      ctx.fillStyle = this.colorOf(u.faction);
      const s = u.type === 'heavy' ? 3 : 2;
      ctx.fillRect(u.x * scale - s / 2, u.y * scale - s / 2, s, s);
    }

    const b = camera.bounds;
    ctx.strokeStyle = '#12161a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.left * scale, b.top * scale, (b.right - b.left) * scale, (b.bottom - b.top) * scale);
  }
}
