// Turns a boolean cell grid into smooth outlines.
//
// Drawing a terrain region as one disc per cell leaves a scalloped, bubbly
// edge. Instead we walk the boundary between inside and outside cells, chain
// those edges into loops and round them off, which gives the clean organic
// shapes of a drawn map.

// Chains loose segments into polylines by matching shared endpoints.
export function chainSegments(segments) {
  const adjacency = new Map();
  const key = (p) => `${p.x},${p.y}`;
  const add = (a, b) => {
    const k = key(a);
    if (!adjacency.has(k)) adjacency.set(k, { point: a, links: [] });
    adjacency.get(k).links.push(b);
  };
  for (const [a, b] of segments) {
    add(a, b);
    add(b, a);
  }

  const used = new Set();
  const edgeKey = (a, b) => (key(a) < key(b) ? `${key(a)}|${key(b)}` : `${key(b)}|${key(a)}`);
  const lines = [];

  // Open chains first (odd link counts are endpoints), then any closed loops.
  const nodes = [...adjacency.values()];
  const starts = nodes.filter((n) => n.links.length !== 2).concat(nodes);

  for (const start of starts) {
    for (const first of start.links) {
      if (used.has(edgeKey(start.point, first))) continue;
      const line = [start.point];
      let current = start.point;
      let next = first;
      for (;;) {
        used.add(edgeKey(current, next));
        line.push(next);
        const node = adjacency.get(key(next));
        if (!node) break;
        const onward = node.links.find((p) => !used.has(edgeKey(next, p)));
        if (!onward) break;
        current = next;
        next = onward;
      }
      if (line.length > 2) lines.push(line);
    }
  }
  return lines;
}

// Chaikin corner cutting. Closed loops are cut cyclically so the seam does not
// keep a sharp corner.
export function chaikin(points, passes = 2) {
  const isClosed =
    points.length > 2 &&
    points[0].x === points[points.length - 1].x &&
    points[0].y === points[points.length - 1].y;

  let pts = isClosed ? points.slice(0, -1) : points;

  for (let p = 0; p < passes; p++) {
    const out = [];
    if (!isClosed) out.push(pts[0]);
    const last = isClosed ? pts.length : pts.length - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    if (!isClosed) out.push(pts[pts.length - 1]);
    pts = out;
  }

  if (isClosed) pts.push(pts[0]);
  return pts;
}

// `inside(cx, cy)` decides membership; out-of-range must read as false.
export function traceContours(inside, cols, rows, cellSize, passes = 2) {
  const segments = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!inside(cx, cy)) continue;
      const x0 = cx * cellSize;
      const y0 = cy * cellSize;
      const x1 = x0 + cellSize;
      const y1 = y0 + cellSize;
      if (!inside(cx, cy - 1)) segments.push([{ x: x0, y: y0 }, { x: x1, y: y0 }]);
      if (!inside(cx, cy + 1)) segments.push([{ x: x0, y: y1 }, { x: x1, y: y1 }]);
      if (!inside(cx - 1, cy)) segments.push([{ x: x0, y: y0 }, { x: x0, y: y1 }]);
      if (!inside(cx + 1, cy)) segments.push([{ x: x1, y: y0 }, { x: x1, y: y1 }]);
    }
  }
  return chainSegments(segments).map((line) => chaikin(line, passes));
}
