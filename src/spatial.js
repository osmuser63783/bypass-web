// SPDX-License-Identifier: AGPL-3.0-or-later
// A spatial index per tile: a grid over the tile's extent with every feature filed under the cells its
// bounding box covers (Mercator). Built lazily on the first spatial query against the tile.
//
//   - Features that reach outside the tile (multi-tile features are stored whole in each tile they touch)
//     are filed under their cells clamped to the tile and also go on an overflow list, which a query
//     checks only when its box reaches outside the tile: such a box still finds the canonical copy,
//     which may live in this tile.
//   - Features covering many cells, and nodes without a stored point, go on the "large" list, checked
//     by every query.
//   - `extent` is the union of all features' boxes: a tile whose extent misses the query box is skipped.

const MAX_CELLS_PER_FEATURE = 16;

function featureBox(t, i, out) {
  if (i < t.wayStart) {
    if (t.ptOff[i + 1] === t.ptOff[i]) return false;
    const x = t.xy[2 * t.ptOff[i]], y = t.xy[2 * t.ptOff[i] + 1];
    out[0] = x; out[1] = y; out[2] = x; out[3] = y;
    return true;
  }
  const k = 4 * (i - t.wayStart), b = t.bbox;
  out[0] = b[k]; out[1] = b[k + 1]; out[2] = b[k + 2]; out[3] = b[k + 3];
  return true;
}

export function tileIndex(t) {
  if (t.grid) return t.grid;
  const n = t.n, tb = t.bounds;
  const G = Math.max(4, Math.min(64, Math.round(Math.sqrt(n / 24))));
  const w = (tb.maxX - tb.minX + 1) / G, h = (tb.maxY - tb.minY + 1) / G;
  const col = (x) => Math.max(0, Math.min(G - 1, Math.floor((x - tb.minX) / w)));
  const row = (y) => Math.max(0, Math.min(G - 1, Math.floor((y - tb.minY) / h)));
  const counts = new Int32Array(G * G + 1);
  const big = [], over = [];
  const bx = new Int32Array(4);
  let eMinX = Infinity, eMinY = Infinity, eMaxX = -Infinity, eMaxY = -Infinity;
  const cells = new Int32Array(4 * n);           // c0, r0, c1, r1 per feature, -1 = not in the grid
  for (let i = 0; i < n; i++) {
    if (!featureBox(t, i, bx)) { big.push(i); cells[4 * i] = -1; continue; }
    if (bx[0] < eMinX) eMinX = bx[0]; if (bx[1] < eMinY) eMinY = bx[1]; if (bx[2] > eMaxX) eMaxX = bx[2]; if (bx[3] > eMaxY) eMaxY = bx[3];
    const outside = bx[0] < tb.minX || bx[1] < tb.minY || bx[2] > tb.maxX || bx[3] > tb.maxY;
    if (outside) over.push(i);
    const c0 = col(bx[0]), c1 = col(bx[2]), r0 = row(bx[1]), r1 = row(bx[3]);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_FEATURE) { big.push(i); if (outside) over.pop(); cells[4 * i] = -1; continue; }
    cells[4 * i] = c0; cells[4 * i + 1] = r0; cells[4 * i + 2] = c1; cells[4 * i + 3] = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * G + c + 1]++;
  }
  for (let k = 1; k <= G * G; k++) counts[k] += counts[k - 1];
  const items = new Int32Array(counts[G * G]);
  const fill = counts.slice(0, G * G);
  for (let i = 0; i < n; i++) {
    const c0 = cells[4 * i];
    if (c0 < 0) continue;
    const r0 = cells[4 * i + 1], c1 = cells[4 * i + 2], r1 = cells[4 * i + 3];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) items[fill[r * G + c]++] = i;
  }
  t.grid = { G, col, row, start: counts, items, big: Int32Array.from(big), over: Int32Array.from(over),
    extent: { minX: eMinX, minY: eMinY, maxX: eMaxX, maxY: eMaxY }, stamp: new Int32Array(n), mark: 0 };
  return t.grid;
}

const meets = (b, minX, minY, maxX, maxY) => !(maxX < b.minX || minX > b.maxX || maxY < b.minY || minY > b.maxY);

/**
 * Calls fn(i) once for every feature of tile t whose bounding box may meet `box` (a superset: callers
 * still test exactly). Features without a box are always included.
 */
/** Does feature i's bounding box meet the box? */
export function featureMeetsBox(t, i, box) {
  const bx = (featureMeetsBox.bx ??= new Int32Array(4));
  return featureBox(t, i, bx) && meets(box, bx[0], bx[1], bx[2], bx[3]);
}

/** Roughly how many of tile t's features lie in the box (its share of the tile's area). */
export function featuresInBoxEstimate(t, box) {
  const tb = t.bounds;
  const w = Math.min(box.maxX, tb.maxX) - Math.max(box.minX, tb.minX), h = Math.min(box.maxY, tb.maxY) - Math.max(box.minY, tb.minY);
  if (w < 0 || h < 0) return 0;
  return t.n * Math.min(1, ((w + 1) * (h + 1)) / ((tb.maxX - tb.minX + 1) * (tb.maxY - tb.minY + 1)));
}

/** The big list's features that meet the box; those without a box (no location) always. */
function visitBig(t, g, box, visit) {
  const bx = new Int32Array(4);
  for (const i of g.big) if (!featureBox(t, i, bx) || meets(box, bx[0], bx[1], bx[2], bx[3])) visit(i);
}

export function forEachInBox(t, box, fn) {
  const g = tileIndex(t);
  if (g.extent.minX === Infinity && !g.big.length) return;
  if (!meets(box, g.extent.minX, g.extent.minY, g.extent.maxX, g.extent.maxY) && !g.big.length) return;
  if (++g.mark === 2 ** 31 - 1) { g.stamp.fill(0); g.mark = 1; }
  const mark = g.mark, stamp = g.stamp;
  const visit = (i) => { if (stamp[i] !== mark) { stamp[i] = mark; fn(i); } };
  visitBig(t, g, box, visit);
  const tb = t.bounds;
  if (box.minX < tb.minX || box.minY < tb.minY || box.maxX > tb.maxX || box.maxY > tb.maxY) {
    const bx = new Int32Array(4);
    for (const i of g.over) { featureBox(t, i, bx); if (meets(box, bx[0], bx[1], bx[2], bx[3])) visit(i); }
  }
  if (!meets(box, tb.minX, tb.minY, tb.maxX, tb.maxY)) return;
  const c0 = g.col(box.minX), c1 = g.col(box.maxX), r0 = g.row(box.minY), r1 = g.row(box.maxY);
  const { start, items, G } = g;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * G + c;
      for (let k = start[cell], end = start[cell + 1]; k < end; k++) visit(items[k]);
    }
  }
}

/**
 * forEachInBox for many boxes at once (e.g. thousands of nodes): the big and overflow lists are walked
 * once (overflow features against the boxes' union) and each grid cell once. Also a superset.
 */
export function forEachInBoxes(t, boxes, fn) {
  if (boxes.length === 1) return forEachInBox(t, boxes[0], fn);
  if (!boxes.length) return;
  const g = tileIndex(t);
  const u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const b of boxes) {
    if (b.minX < u.minX) u.minX = b.minX; if (b.minY < u.minY) u.minY = b.minY;
    if (b.maxX > u.maxX) u.maxX = b.maxX; if (b.maxY > u.maxY) u.maxY = b.maxY;
  }
  if (!g.big.length && (g.extent.minX === Infinity || !meets(u, g.extent.minX, g.extent.minY, g.extent.maxX, g.extent.maxY))) return;
  if (++g.mark === 2 ** 31 - 1) { g.stamp.fill(0); g.mark = 1; }
  const mark = g.mark, stamp = g.stamp;
  const visit = (i) => { if (stamp[i] !== mark) { stamp[i] = mark; fn(i); } };
  visitBig(t, g, u, visit);
  const tb = t.bounds, { start, items, G } = g;
  if (u.minX < tb.minX || u.minY < tb.minY || u.maxX > tb.maxX || u.maxY > tb.maxY) {
    const bx = new Int32Array(4);
    for (const i of g.over) { featureBox(t, i, bx); if (meets(u, bx[0], bx[1], bx[2], bx[3])) visit(i); }
  }
  if (!meets(u, tb.minX, tb.minY, tb.maxX, tb.maxY)) return;
  const seen = new Uint8Array(G * G);
  for (const b of boxes) {
    if (!meets(b, tb.minX, tb.minY, tb.maxX, tb.maxY)) continue;
    const c0 = g.col(b.minX), c1 = g.col(b.maxX), r0 = g.row(b.minY), r1 = g.row(b.maxY);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const cell = r * G + c;
      if (seen[cell]) continue;
      seen[cell] = 1;
      for (let k = start[cell], end = start[cell + 1]; k < end; k++) visit(items[k]);
    }
  }
}
