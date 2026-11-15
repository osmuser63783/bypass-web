// SPDX-License-Identifier: AGPL-3.0-or-later
// Area tests for `(area)` filters, `is_in` and the geocoder.
//
// ClosedWayArea is a port of osm_bypass/area_tests.py, itself a port of the point and segment tests in
// Overpass API data/tilewise_geometry.h and statements/area_query.cc (Copyright (C) 2008-2018 Roland
// Olbricht et al., AGPL-3.0-or-later): closed ways as areas, in Overpass's integer coordinates
// (ilat = (lat + 91)·10⁷, ilon = lon·10⁷), with the same double arithmetic as the Python port.
//
// PolygonArea stands in for what the Python engine does with shapely on GeoDesk's assembled relation
// polygons (Mercator): rings joined from the member ways, even-odd containment, and
//   - a point meets the area when it is inside or on the border (shapely intersects);
//   - a line meets it when its interior meets the area's interior (relate "T********"): a vertex strictly
//     inside, a proper crossing of the border, or a stretch between touching points that lies inside.

export const OUTSIDE = 0, INSIDE = 1, BORDER = 2;

// ---- closed ways, Overpass's own tests -----------------------------------------------------------------

const segment = (a, b) => (a[1] < b[1] ? [a[0], a[1], b[0], b[1]] : [b[0], b[1], a[0], a[1]]);
const cdiv2 = (v) => (v >= 0 ? Math.floor(v / 2) : -Math.floor(-v / 2));

export class ClosedWayArea {
  /** pts: the closed way's points as [ilat, ilon], the closing point included. */
  constructor(pts) {
    this.segments = [];
    for (let k = 0; k + 1 < pts.length; k++) this.segments.push(segment(pts[k], pts[k + 1]));
    if (pts.length) {
      let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
      for (const [la, lo] of pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
      this.bounds = [s, w, n, e];
    } else this.bounds = [0, 0, -1, -1];
  }

  near(lat, lon) { const [s, w, n, e] = this.bounds; return s <= lat && lat <= n && w <= lon && lon <= e; }

  /** rel_pos_ilat_ilon: a vertical ray from the point southwards, edges half-open [west, east). */
  point(latP, lonP) {
    let inside = false;
    for (const [latW, lonW, latE, lonE] of this.segments) {
      if (lonW === lonP) {
        if (latW === latP) return BORDER;
        if (lonW === lonE) {
          if (Math.min(latW, latE) <= latP && latP <= Math.max(latW, latE)) return BORDER;
        } else inside = inside !== (latW < latP);
      } else if (lonE === lonP) {
        if (latE === latP) return BORDER;
      } else if (lonW < lonP && lonP < lonE) {
        const isect = latW + (lonP - lonW) * (latE - latW) / (lonE - lonW);
        if (isect - 0.5 < latP) {
          if (latP < isect + 0.5) return BORDER;
          inside = !inside;
        }
      }
    }
    return inside ? INSIDE : OUTSIDE;
  }

  /** rel_position(idx, segment, block): a proper crossing, or a touching midpoint strictly inside. */
  segmentInside(seg) {
    const [sLatW, sLonW, sLatE, sLonE] = seg;
    const dLon = sLonE - sLonW, dLat = sLatE - sLatW;
    const touching = [];
    for (const [aLatW, aLonW, aLatE, aLonE] of this.segments) {
      if (!(aLonW <= sLonE && sLonW <= aLonE)) continue;
      const scalAW = (aLatW - sLatW) * dLon - (aLonW - sLonW) * dLat;
      const scalAE = (aLatE - sLatW) * dLon - (aLonE - sLonW) * dLat;
      if (scalAE * scalAW > 0) continue;
      const aDLon = aLonE - aLonW, aDLat = aLatE - aLatW;
      const scalSW = (sLatW - aLatW) * aDLon - (sLonW - aLonW) * aDLat;
      const scalSE = (sLatE - aLatW) * aDLon - (sLonE - aLonW) * aDLat;
      if (scalSE * scalSW > 0) continue;
      if (scalAW === 0) {
        touching.push([aLatW, aLonW]);
        if (scalAE === 0) touching.push([aLatE, aLonE]);
      } else if (scalAE === 0) touching.push([aLatE, aLonE]);
      else if (scalSW === 0) touching.push([sLatW, sLonW]);
      else if (scalSE !== 0) return true;
    }
    if (!touching.length) return false;
    const uniq = new Map();
    for (const p of [...touching, [sLatW, sLonW], [sLatE, sLonE]]) uniq.set(p[0] + ',' + p[1], p);
    const pts = [...uniq.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      if (this.point(Math.floor((a[0] + b[0]) / 2), cdiv2(a[1] + b[1])) === INSIDE) return true;
    }
    return false;
  }

  containsNode(lat, lon, acceptBorder) {
    if (!this.near(lat, lon)) return false;
    const pos = this.point(lat, lon);
    return pos === INSIDE || (acceptBorder && pos === BORDER);
  }

  /** pts: the way's integer points. ways_contained_in: endpoints, then edges. */
  containsWay(pts) {
    if (!pts.length) return false;
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const [la, lo] of pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
    const [bs, bw, bn, be] = this.bounds;
    if (n < bs || s > bn || e < bw || w > be) return false;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      if (this.point(a[0], a[1]) === INSIDE || this.point(b[0], b[1]) === INSIDE) return true;
      if (this.segmentInside(segment(a, b))) return true;
    }
    return pts.length === 1 && this.point(pts[0][0], pts[0][1]) === INSIDE;
  }
}

// ---- relation areas: polygons from member ways -----------------------------------------------------------

/** Joins lines ([[x, y], ...]) into closed rings by their end points; lines that don't close are dropped. */
export function assembleRings(lines) {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const rings = [], open = [];
  for (const l of lines) {
    if (l.length < 2) continue;
    if (same(l[0], l[l.length - 1])) { if (l.length >= 4) rings.push(l); } else open.push(l.slice());
  }
  const key = (p) => p[0] + ',' + p[1];
  while (open.length) {
    let cur = open.pop();
    let grown = true;
    while (grown && !same(cur[0], cur[cur.length - 1])) {
      grown = false;
      const end = key(cur[cur.length - 1]), start = key(cur[0]);
      for (let k = 0; k < open.length; k++) {
        const l = open[k], a = key(l[0]), b = key(l[l.length - 1]);
        if (a === end) cur = cur.concat(l.slice(1));
        else if (b === end) cur = cur.concat(l.slice(0, -1).reverse());
        else if (b === start) cur = l.concat(cur.slice(1));
        else if (a === start) cur = l.slice().reverse().concat(cur.slice(1));
        else continue;
        open.splice(k, 1); grown = true; break;
      }
    }
    if (same(cur[0], cur[cur.length - 1]) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

/** Signed area of a ring (shoelace), in coordinate units squared. */
export function ringArea(r) {
  let a = 0;
  for (let k = 0; k + 1 < r.length; k++) a += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
  return a / 2;
}

const BANDS = 256;

export class PolygonArea {
  /** rings: closed rings of [x, y] (Mercator), outer and inner alike (even-odd). */
  constructor(rings) {
    this.rings = rings;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const edges = [];
    for (const r of rings) {
      for (let k = 0; k + 1 < r.length; k++) {
        const [x1, y1] = r[k], [x2, y2] = r[k + 1];
        if (x1 === x2 && y1 === y2) continue;
        edges.push([x1, y1, x2, y2]);
        minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2); minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
      }
    }
    this.box = { minX, minY, maxX, maxY };
    // edges by horizontal band, so a point or segment only looks at the edges at its height
    this.h = Math.max(1, (maxY - minY) / BANDS);
    this.bands = Array.from({ length: BANDS }, () => []);
    for (const e of edges) {
      const b0 = this.band(Math.min(e[1], e[3])), b1 = this.band(Math.max(e[1], e[3]));
      for (let b = b0; b <= b1; b++) this.bands[b].push(e);
    }
  }

  band(y) { return Math.max(0, Math.min(BANDS - 1, Math.floor((y - this.box.minY) / this.h))); }

  inBox(x, y) { const b = this.box; return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY; }

  /** OUTSIDE, INSIDE or BORDER (even-odd over all rings; a horizontal ray to the east). */
  pointPos(px, py) {
    if (!this.inBox(px, py)) return OUTSIDE;
    let inside = false;
    for (const [x1, y1, x2, y2] of this.bands[this.band(py)]) {
      const ax = x1 - px, ay = y1 - py, bx = x2 - px, by = y2 - py;   // relative: keeps products exact
      const cross = ax * by - ay * bx;
      if (cross === 0 && Math.min(ax, bx) <= 0 && Math.max(ax, bx) >= 0 && Math.min(ay, by) <= 0 && Math.max(ay, by) >= 0) return BORDER;
      if ((ay > 0) !== (by > 0)) {
        // x of the crossing > 0  <=>  cross has the sign of (by - ay)
        if ((by > ay) ? cross > 0 : cross < 0) inside = !inside;
      }
    }
    return inside ? INSIDE : OUTSIDE;
  }

  /** Does a polyline's interior meet the area's interior? pts: [[x, y], ...] (one point: is it strictly inside). */
  lineInterior(pts) {
    if (pts.length === 1) return this.pointPos(pts[0][0], pts[0][1]) === INSIDE;
    for (const [x, y] of pts) if (this.pointPos(x, y) === INSIDE) return true;
    const b = this.box;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      if (Math.max(ax, bx) < b.minX || Math.min(ax, bx) > b.maxX || Math.max(ay, by) < b.minY || Math.min(ay, by) > b.maxY) continue;
      const dx = bx - ax, dy = by - ay;
      const ts = [0, 1];
      const b0 = this.band(Math.min(ay, by)), b1 = this.band(Math.max(ay, by));
      const seen = new Set();
      for (let bb = b0; bb <= b1; bb++) {
        for (const e of this.bands[bb]) {
          if (seen.has(e)) continue;
          seen.add(e);
          const [x1, y1, x2, y2] = e;
          if (Math.max(x1, x2) < Math.min(ax, bx) || Math.min(x1, x2) > Math.max(ax, bx)) continue;
          // relative to the segment's start
          const px = x1 - ax, py = y1 - ay, qx = x2 - ax, qy = y2 - ay;
          const c1 = dx * py - dy * px, c2 = dx * qy - dy * qx;           // edge ends vs the segment's line
          if (c1 * c2 > 0) continue;
          const ex = qx - px, ey = qy - py;
          const c3 = ex * (0 - py) - ey * (0 - px), c4 = ex * (dy - py) - ey * (dx - px);   // segment ends vs edge line
          if (c3 * c4 > 0) continue;
          if (c1 !== 0 && c2 !== 0 && c3 !== 0 && c4 !== 0) return true;   // a proper crossing
          const len2 = dx * dx + dy * dy;
          const tOf = (x, y) => (x * dx + y * dy) / len2;
          if (c1 === 0 && c2 === 0) {                                      // collinear: overlap ends
            ts.push(tOf(px, py), tOf(qx, qy));
          } else if (c1 === 0) ts.push(tOf(px, py));
          else if (c2 === 0) ts.push(tOf(qx, qy));
          // c3 or c4 = 0: a segment end on the edge, already in ts
        }
      }
      const sorted = ts.filter(t => t >= 0 && t <= 1).sort((p, q) => p - q);
      for (let j = 0; j + 1 < sorted.length; j++) {
        if (sorted[j + 1] - sorted[j] < 1e-12) continue;
        const t = (sorted[j] + sorted[j + 1]) / 2;
        if (this.pointPos(ax + dx * t, ay + dy * t) === INSIDE) return true;
      }
    }
    return false;
  }

  /** Does a polyline touch the area at all (inside or on the border; shapely intersects)? */
  lineMeets(pts) {
    for (const [x, y] of pts) if (this.pointPos(x, y) !== OUTSIDE) return true;
    const b = this.box;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      if (Math.max(ax, bx) < b.minX || Math.min(ax, bx) > b.maxX || Math.max(ay, by) < b.minY || Math.min(ay, by) > b.maxY) continue;
      const dx = bx - ax, dy = by - ay;
      for (let bb = this.band(Math.min(ay, by)), b1 = this.band(Math.max(ay, by)); bb <= b1; bb++) {
        for (const [x1, y1, x2, y2] of this.bands[bb]) {
          if (Math.max(x1, x2) < Math.min(ax, bx) || Math.min(x1, x2) > Math.max(ax, bx)) continue;
          const px = x1 - ax, py = y1 - ay, qx = x2 - ax, qy = y2 - ay;
          const c1 = dx * py - dy * px, c2 = dx * qy - dy * qx;
          if (c1 * c2 > 0) continue;
          const ex = qx - px, ey = qy - py;
          const c3 = ex * (0 - py) - ey * (0 - px), c4 = ex * (dy - py) - ey * (dx - px);
          if (c3 * c4 > 0) continue;
          if (c1 === 0 && c2 === 0) {                    // collinear: do the projections overlap?
            if (Math.max(Math.min(px, qx), Math.min(0, dx)) <= Math.min(Math.max(px, qx), Math.max(0, dx)) &&
                Math.max(Math.min(py, qy), Math.min(0, dy)) <= Math.min(Math.max(py, qy), Math.max(0, dy))) return true;
            continue;
          }
          return true;
        }
      }
    }
    return false;
  }

  /** Area with holes: rings inside an odd number of other rings count negative. */
  area() {
    let total = 0;
    for (const r of this.rings) {
      const depth = this.rings.filter(o => o !== r && new PolygonArea([o]).pointPos(r[0][0], r[0][1]) === INSIDE).length;
      total += (depth % 2 ? -1 : 1) * Math.abs(ringArea(r));
    }
    return total;
  }
}
