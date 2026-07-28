import { UNITS } from './config.js';

// Front-line behaviour: the army is a chain, not a crowd.
//
// Two things live here. `assignPosts` turns a dragged arrow into a row of
// standing positions, so pushing a stretch of the line moves it as a stretch.
// `manTheLine` is what idle troops do on their own: find the nearest piece of
// the front and take a place on it, spaced off their neighbours, which is how
// a wall forms and how gaps close without anybody being told to.

export const SPACING = 21;      // distance between neighbours in the chain
export const STANDOFF = 26;     // how far behind the boundary a post sits
const SEGMENT_RADIUS = 150;     // how much of the line one drag picks up

// The units a drag starting at (x, y) commands: whatever stands near it.
export function segmentUnits(units, x, y, radius = SEGMENT_RADIUS) {
  return units.filter((u) => Math.hypot(u.x - x, u.y - y) <= radius);
}

// Lay out `count` posts as a row centred on (tx, ty), broadside to the advance,
// then hand each unit the nearest free one.
export function assignPosts(units, fromX, fromY, tx, ty) {
  const n = units.length;
  if (!n) return [];
  let dx = tx - fromX;
  let dy = ty - fromY;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  // Perpendicular to the push: the row faces the direction of travel.
  const px = -dy;
  const py = dx;

  const posts = [];
  const half = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const offset = (i - half) * SPACING;
    posts.push({ x: tx + px * offset, y: ty + py * offset });
  }

  const taken = new Uint8Array(posts.length);
  const out = [];
  for (const u of units) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < posts.length; i++) {
      if (taken[i]) continue;
      const d = (posts[i].x - u.x) ** 2 + (posts[i].y - u.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) best = 0;
    taken[best] = 1;
    out.push({ unit: u, post: posts[best] });
  }
  return out;
}

// Where an idle unit should stand: on the nearest stretch of front, pulled back
// a little and nudged sideways out of its neighbours' way.
export function manTheLine(game, unit, frontPoints) {
  if (!frontPoints.length) return null;

  let nearest = null;
  let bestD = Infinity;
  for (const p of frontPoints) {
    const d = (p.x - unit.x) ** 2 + (p.y - unit.y) ** 2;
    if (d < bestD) {
      bestD = d;
      nearest = p;
    }
  }
  if (!nearest) return null;

  // Too far from any front to be manning it — stay put rather than sprint across
  // the map, otherwise every reserve abandons the rear the moment it is idle.
  const dist = Math.sqrt(bestD);
  if (dist > UNITS.light.range * 12) return null;

  // Step back from the boundary so the chain forms on our side of it.
  const home = game.nearestHomePoint(unit.faction, nearest.x, nearest.y);
  let bx = 0;
  let by = 0;
  if (home) {
    bx = home.x - nearest.x;
    by = home.y - nearest.y;
    const l = Math.hypot(bx, by) || 1;
    bx /= l;
    by /= l;
  }
  return { x: nearest.x + bx * STANDOFF, y: nearest.y + by * STANDOFF };
}
