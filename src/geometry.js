// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass's geometry model: a port of osm_bypass/geometry.py, itself a port of Overpass API
// core/geometry.cc and core/four_field_index.cc (Copyright (C) 2008-2018 Roland Olbricht et al.,
// AGPL-3.0-or-later). Geometries are what geom(), center(), trace(), hull(), gcat(), pt(), lstr() and poly()
// produce, what make/convert store under ::geom, and what lat(), lon(), length() and angle() read.
// Points are [lat, lon] arrays; [100, 200] marks an invalid point. The algorithms, thresholds and C
// integer arithmetic follow the C++ (and the Python port) line by line, so outputs are identical.

export const INVALID = [100.0, 200.0];
const DEG = Math.acos(0) / 90.0;

// ---- C integer helpers
export const u32 = (x) => x >>> 0;
export const i32 = (x) => x | 0;
export const ilat = (lat) => u32(Math.trunc((lat + 91.0) * 10000000 + 0.5));
export const ilon = (lon) => i32(Math.trunc(lon * 10000000 + (lon > 0 ? 0.5 : -0.5)));
export const latOf = (v) => u32(v) / 10000000 - 91.0;
export const lonOf = (v) => i32(v) / 10000000;
export const decoded = (lat, lon) => [latOf(ilat(lat)), lonOf(ilon(lon))];
export const epsEqual = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const ptKey = (p) => p[0] + ',' + p[1];
const ptCmp = (a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : 0);

// ---- bounds
export class Bbox {
  constructor(s, w, n, e) { this.south = s; this.west = w; this.north = n; this.east = e; }
  valid() { return -90 <= this.south && this.south <= this.north && this.north <= 90 && -180 <= this.east && this.east <= 180 && -180 <= this.west && this.west <= 180; }
  centerLat() { return (this.south + this.north) / 2; }
  centerLon() {
    if (this.west <= this.east) return (this.west + this.east) / 2;
    if ((this.west + this.east) / 2 <= 0) return (this.west + this.east) / 2 + 180.0;
    return (this.west + this.east) / 2 - 180.0;
  }
}
const invalidBbox = () => new Bbox(100.0, 200.0, 100.0, 200.0);

function boundsOfPoints(pts) {
  let s = 100.0, w = 200.0, n = -100.0, e = -200.0;
  for (const [la, lo] of pts) if (la < 100) { s = Math.min(s, la); w = Math.min(w, lo); n = Math.max(n, la); e = Math.max(e, lo); }
  if (n === -100.0) return invalidBbox();
  if (e - w > 180.0) {
    let ww = 180.0, we = -180.0;
    for (const [la, lo] of pts) if (la < 100) { if (lo > 0) ww = Math.min(ww, lo); else we = Math.max(we, lo); }
    if (ww - we > 180.0) return new Bbox(s, ww, n, we);
    return new Bbox(s, -180.0, n, 180.0);
  }
  return new Bbox(s, w, n, e);
}
const boundsOfLines = (lines) => boundsOfPoints(lines.flat());

function boundsOfComponents(comps) {
  let s = 100.0, w = 200.0, n = -100.0, e = -200.0, wrapped = false;
  for (const c of comps) if (c.hasBbox()) {
    s = Math.min(s, c.south()); n = Math.max(n, c.north()); w = Math.min(w, c.west()); e = Math.max(e, c.east());
    wrapped ||= c.east() < c.west();
  }
  if (n === -100.0) return invalidBbox();
  if (!wrapped && e - w <= 180) return new Bbox(s, w, n, e);
  w = 200; e = -200;
  for (const c of comps) {
    if (!c.hasBbox()) continue;
    if (c.east() <= 0) { e = Math.max(e, c.east()); if (c.west() >= 0) w = Math.min(w, c.west()); }
    else if (c.west() >= 0) w = Math.min(w, c.west());
    else return new Bbox(s, -180.0, n, 180.0);
  }
  if (w - e > 180) return new Bbox(s, w, n, e);
  return new Bbox(s, -180.0, n, 180.0);
}

// ---- geometry classes
export class Geometry {
  get kind() { return 'null'; }
  hasCenter() { return false; } centerLat() { return 0.0; } centerLon() { return 0.0; }
  hasBbox() { return false; } south() { return 0.0; } north() { return 0.0; } west() { return 0.0; } east() { return 0.0; }
  hasLineGeometry() { return false; } line() { return null; }
  hasMultilineGeometry() { return false; } multiline() { return null; }
  hasComponents() { return false; } components() { return null; }
  hasFaithfulWayGeometry() { return false; } waySize() { return 0; } wayPosIsValid() { return false; } wayPos() { return [0, 0]; }
}
export class Null extends Geometry {}
export class Point extends Geometry {
  constructor(lat, lon) { super(); this.pt = [lat, lon]; }
  get kind() { return 'point'; }
  hasCenter() { return true; } centerLat() { return this.pt[0]; } centerLon() { return this.pt[1]; }
  hasBbox() { return true; } south() { return this.pt[0]; } north() { return this.pt[0]; } west() { return this.pt[1]; } east() { return this.pt[1]; }
}
class Bounded extends Geometry {
  b() { return this._b ??= this.bounds(); }
  centerLat() { return this.b().centerLat(); } centerLon() { return this.b().centerLon(); }
  south() { return this.b().south; } north() { return this.b().north; } west() { return this.b().west; } east() { return this.b().east; }
}
export class Linestring extends Bounded {
  constructor(points) { super(); this.points = [...points]; }
  get kind() { return 'linestring'; }
  bounds() { return boundsOfPoints(this.points); }
  hasCenter() { return true; } hasBbox() { return true; }
  hasLineGeometry() { return true; } line() { return this.points; }
  hasFaithfulWayGeometry() { return true; } waySize() { return this.points.length; }
  wayPosIsValid(i) { return i < this.points.length; } wayPos(i) { return this.points[i]; }
}
export class PartialWay extends Bounded {
  constructor(points = []) { super(); this.points = []; this.segments = []; this.hasCoords = false; for (const p of points) this.addPoint(p); }
  get kind() { return 'partial_way'; }
  addPoint(p) {
    this._b = undefined;
    if (p[0] < 100) {
      if (!this.points.length || this.points[this.points.length - 1][0] >= 100) this.segments.push([]);
      this.segments[this.segments.length - 1].push(p);
      this.hasCoords = true;
    }
    this.points.push(p);
  }
  bounds() { return boundsOfPoints(this.points); }
  hasCenter() { return this.hasCoords; }
  centerLat() { return this.hasCoords ? this.b().centerLat() : 0.0; } centerLon() { return this.hasCoords ? this.b().centerLon() : 0.0; }
  hasBbox() { return this.hasCoords; }
  hasLineGeometry() { return this.segments.length === 1; } line() { return this.segments.length === 1 ? this.segments[0] : null; }
  hasMultilineGeometry() { return true; } multiline() { return this.segments; }
  hasFaithfulWayGeometry() { return true; } waySize() { return this.points.length; }
  wayPosIsValid(i) { return i < this.points.length && this.points[i][0] < 100; } wayPos(i) { return this.points[i]; }
}
export class FreePolygon extends Bounded {
  constructor(lines = []) { super(); this.lines = []; for (const ln of lines) this.addLinestring(ln, true); }
  get kind() { return 'free_polygon'; }
  addLinestring(ln, always = false) {
    if (!always && ln.length < 2) return;
    this._b = undefined;
    ln = [...ln];
    if (!same(ln[0], ln[ln.length - 1])) ln.push(ln[0]);
    this.lines.push(ln);
  }
  bounds() { return boundsOfLines(this.lines); }
  hasCenter() { return true; } hasBbox() { return true; }
  hasMultilineGeometry() { return true; } multiline() { return this.lines; }
}
export class Compound extends Bounded {
  constructor(comps = []) { super(); this.comps = [...comps]; }
  get kind() { return 'compound'; }
  addComponent(g) { this._b = undefined; this.comps.push(g); }
  bounds() { return boundsOfComponents(this.comps); }
  hasCenter() { return this.b().valid(); } hasBbox() { return this.b().valid(); }
  hasComponents() { return true; } components() { return this.comps; }
}
export class PartialRelation extends Compound {
  constructor() { super(); this.hasCoords = false; }
  get kind() { return 'partial_relation'; }
  addPlaceholder() { this.comps.push(new Null()); }
  addPoint(p) { this._b = undefined; if (p[0] < 100) { this.hasCoords = true; this.comps.push(new Point(p[0], p[1])); } else this.comps.push(new Null()); }
  startWay() { this.comps.push(new PartialWay()); }
  addWayPoint(p) { this._b = undefined; const c = this.comps[this.comps.length - 1]; if (c instanceof PartialWay) { this.hasCoords = true; c.addPoint(p); } }
  addWayPlaceholder() { const c = this.comps[this.comps.length - 1]; if (c instanceof PartialWay) c.addPoint(INVALID); }
  hasCenter() { return this.hasCoords && this.b().valid(); }
  centerLat() { return this.hasCoords ? this.b().centerLat() : 0.0; } centerLon() { return this.hasCoords ? this.b().centerLon() : 0.0; }
  hasBbox() { return this.hasCoords && this.b().valid(); }
}
export class RHRPolygon extends Bounded {
  constructor(lines) { super(); this.lines = lines; }
  get kind() { return 'rhr_polygon'; }
  bounds() { return boundsOfLines(this.lines); }
  hasCenter() { return true; } hasBbox() { return true; }
  hasMultilineGeometry() { return true; } multiline() { return this.lines; }
}

export const ZERO_QUAD = [-91.0, -214.7483648];   // what ::lat/::lon decode Quad_Coord(0, 0) -- a dropped point -- to

/** Bbox_Double::intersects (segment against box, 5e-8 tolerance). */
export function bboxIntersects(bb, from, to) {
  const s = bb.south, w = bb.west, n = bb.north, e = bb.east;
  let flon = from[1], tlon = to[1];
  if (from[1] < 0 && to[1] - from[1] > 180) flon += 360;
  if (to[1] < 0 && from[1] - to[1] > 180) tlon += 360;
  let df = 0.0;
  if (from[0] + 5e-8 < s) {
    if (to[0] + 5e-8 < s) return false;
    if (to[0] - 5e-8 > from[0]) df = (tlon - flon) * (s - from[0]) / (to[0] - from[0]);
  } else if (from[0] - 5e-8 > n) {
    if (to[0] - 5e-8 > n) return false;
    if (to[0] + 5e-8 < from[0]) df = (tlon - flon) * (n - from[0]) / (to[0] - from[0]);
  }
  if (to[0] + 5e-8 < s && from[0] - 5e-8 > to[0]) tlon += (flon - tlon) * (s - to[0]) / (from[0] - to[0]);
  else if (to[0] - 5e-8 > n && from[0] + 5e-8 < to[0]) tlon += (flon - tlon) * (n - to[0]) / (from[0] - to[0]);
  flon += df;
  const lo = Math.min(flon, tlon), hi = Math.max(flon, tlon);
  if (w <= e) {
    if (hi < 180) return lo - 5e-8 <= e && hi + 5e-8 >= w;
    if (lo > 180) return lo - 5e-8 - 360 <= e && hi + 5e-8 - 360 >= w;
    return lo - 5e-8 <= e && hi + 5e-8 - 360 >= w;
  }
  if (hi < 180) return lo - 5e-8 <= e || hi + 5e-8 >= w;
  if (lo > 180) return lo - 5e-8 - 360 <= e || hi + 5e-8 - 360 >= w;
  return true;
}

// ---- length, trace, hull
export function greatCircleDist(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0.0;
  let sp = Math.cos((lat2 - lat1) * DEG) + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * (Math.cos((lon2 - lon1) * DEG) - 1);
  if (sp > 1) sp = 1.0;
  return Math.acos(sp) * (10 * 1000 * 1000 / Math.acos(0));
}

export function length(g) {
  let r = 0.0;
  if (g.hasComponents()) { for (const c of g.components()) r += c ? length(c) : 0.0; }
  else if (g.hasLineGeometry()) { const ln = g.line(); for (let k = 0; k + 1 < ln.length; k++) r += greatCircleDist(ln[k][0], ln[k][1], ln[k + 1][0], ln[k + 1][1]); }
  else if (g.hasFaithfulWayGeometry()) {
    for (let i = 1; i < g.waySize(); i++) if (g.wayPosIsValid(i - 1) && g.wayPosIsValid(i)) {
      const a = g.wayPos(i - 1), b = g.wayPos(i);
      r += greatCircleDist(a[0], a[1], b[0], b[1]);
    }
  }
  return r;
}

function collect(nodes, lines, g) {
  if (g.hasComponents()) { for (const c of g.components()) if (c) collect(nodes, lines, c); }
  else if (g.hasLineGeometry()) lines.push([...g.line()]);
  else if (g.hasMultilineGeometry()) for (const x of g.multiline()) lines.push([...x]);
  else if (g.hasCenter()) nodes.push([g.centerLat(), g.centerLon()]);
}

/** Linestring_Geometry_Ptr ordering key: size, then the points read from the smaller end. */
function lstrKey(pts) {
  const seq = ptCmp(pts[pts.length - 1], pts[0]) < 0 ? [...pts].reverse() : pts;
  return pts.length + '|' + seq.map(ptKey).join(';');
}

export function makeTrace(g) {
  const nodes0 = [], lines = [];
  collect(nodes0, lines, g);
  const uniq = new Map();
  for (const p of nodes0) uniq.set(ptKey(p), p);
  const nodes = [...uniq.values()].sort(ptCmp);
  const count = new Map();
  const inc = (p, k) => count.set(ptKey(p), (count.get(ptKey(p)) ?? 0) + k);
  for (const p of nodes) inc(p, 1);
  for (const ln of lines) {
    if (!ln.length) continue;
    inc(ln[0], 2); inc(ln[ln.length - 1], 2);
    for (const p of ln.slice(1, -1)) inc(p, 1);
  }
  const res = new Compound();
  for (const p of nodes) res.addComponent(new Point(p[0], p[1]));
  const seen = new Set();
  const emit = (pts) => { const k = lstrKey(pts); if (!seen.has(k)) { seen.add(k); res.addComponent(new Linestring(pts)); } };
  for (const ln of lines) {
    if (!ln.length) continue;
    let pts = [ln[0]];
    for (const p of ln.slice(1, -1)) {
      if ((count.get(ptKey(p)) ?? 0) > 1) { pts.push(p); emit(pts); pts = []; }
      pts.push(p);
    }
    pts.push(ln[ln.length - 1]);
    emit(pts);
  }
  return res;
}

function collectPoints(nodes, g) {
  if (g.hasComponents()) { for (const c of g.components()) if (c) collectPoints(nodes, c); }
  else if (g.hasLineGeometry()) nodes.push(...g.line());
  else if (g.hasMultilineGeometry()) for (const ln of g.multiline()) nodes.push(...ln);
  else if (g.hasCenter()) nodes.push([g.centerLat(), g.centerLon()]);
}

class SV {                                         // Spherical_Vector
  constructor(x = 0.0, y = 0.0, z = 0.0) { this.x = x; this.y = y; this.z = z; }
  static of(pt) { const c = Math.cos(pt[0] * DEG); return new SV(Math.sin(pt[0] * DEG), c * Math.sin(pt[1] * DEG), c * Math.cos(pt[1] * DEG)); }
  static cross(a, b) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    const ln = Math.sqrt(x * x + y * y + z * z);
    if (ln === 0) return new SV(NaN, NaN, NaN);
    return new SV(x / ln, y / ln, z / ln);
  }
  dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
}
class Seg { constructor(ll, s) { this.ll = ll; this.s = s ?? SV.of(ll); this.edge = new SV(); } }

export function makeHull(g) {
  const nodes0 = [];
  collectPoints(nodes0, g);
  nodes0.sort((a, b) => (a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const nodes = [];
  for (const p of nodes0) if (!nodes.length || !same(nodes[nodes.length - 1], p)) nodes.push(p);
  if (!nodes.length) return new Null();
  if (nodes.length === 1) return new Point(nodes[0][0], nodes[0][1]);
  if (nodes.length === 2) return new Linestring([...nodes, nodes[0]]);
  let minLat = [100, 0], maxLat = [-100, 0];
  for (const p of nodes) { if (p[0] < minLat[0]) minLat = p; if (p[0] > maxLat[0]) maxLat = p; }
  let maxDelta = nodes[0][1] + 360 - nodes[nodes.length - 1][1];
  let westEnd = nodes[0], eastEnd = nodes[nodes.length - 1];
  for (let i = 1; i < nodes.length; i++) {
    if (maxDelta < nodes[i][1] - nodes[i - 1][1]) { maxDelta = nodes[i][1] - nodes[i - 1][1]; westEnd = nodes[i]; eastEnd = nodes[i - 1]; }
  }
  let segs = [];
  const s = minLat, w = westEnd, n = maxLat, e = eastEnd;
  if (w[1] !== e[1]) segs = [new Seg(w), new Seg(e)];
  else if (n[0] !== s[0]) segs = [new Seg(s), new Seg(n)];
  if (segs.length) { segs[1].edge = SV.cross(segs[0].s, segs[1].s); segs[0].edge = SV.cross(segs[1].s, segs[0].s); }
  for (const rhs of nodes) {
    const sp = SV.of(rhs);
    let fi = 0;
    while (fi < segs.length && segs[fi].edge.dot(sp) < 1e-8) fi++;
    if (!(fi < segs.length && segs[fi].edge.dot(sp) >= 1e-8)) continue;
    let ti;
    if (segs[0].edge.dot(sp) >= 0) {
      fi = segs.length - 1;
      while (fi !== 0 && segs[fi].edge.dot(sp) >= 0) fi--;
      fi++;
      segs.splice(fi);
      ti = 0;
      while (ti < segs.length && segs[ti].edge.dot(sp) >= 0) ti++;
      ti--;
      fi = 0;
      segs[ti].edge = SV.cross(sp, segs[ti].s);
      if (fi === ti) segs.splice(fi, 0, new Seg(rhs, sp));
      else { fi++; segs.splice(fi, ti - fi); fi--; segs[fi] = new Seg(rhs, sp); }
    } else {
      ti = fi;
      while (ti < segs.length && segs[ti].edge.dot(sp) >= 0) ti++;
      ti--;
      while (fi !== 0 && segs[fi].edge.dot(sp) >= 0) fi--;
      fi++;
      segs[ti].edge = SV.cross(sp, segs[ti].s);
      if (fi === ti) segs.splice(fi, 0, new Seg(rhs, sp));
      else { fi++; segs.splice(fi, ti - fi); fi--; segs[fi] = new Seg(rhs, sp); }
    }
    if (fi === 0) segs[0].edge = SV.cross(segs[segs.length - 1].s, sp);
    else segs[fi].edge = SV.cross(segs[fi - 1].s, sp);
  }
  const line = segs.map(x => x.ll);
  if (line.length < 3) return new Linestring(line);
  return rhrPolygon(new FreePolygon([line]));
}

// ---- RHR polygon
function interpolationPoint(ox, oy, oz, lx, lz, factor, llon) {
  const sf = Math.sin(factor), cf = Math.cos(factor);
  const nx = sf * ox + cf * lx, ny = sf * oy, nz = sf * oz + cf * lz;
  const nlat = Math.asin(Math.max(-1.0, Math.min(1.0, nx))) / DEG;
  let nlon = Math.atan2(ny, nz) / DEG + llon;
  if (nlon < -180) nlon += 360; else if (nlon > 180) nlon -= 360;
  return [nlat, nlon];
}

class Collector {
  constructor(ox, oy, oz, lx, lz, dist, llon, target) {
    Object.assign(this, { ox, oy, oz, lx, lz, llon, target });
    const center = lx === 0 ? dist : Math.atan(ox / lx);
    const bounded = Math.max(Math.min(center, dist), 0);
    const ex = interpolationPoint(ox, oy, oz, lx, lz, bounded, llon);
    this.exGcLat = ex[0];
    this.acc = 0.0065536 * Math.cos(ex[0] * DEG);
    if (this.acc < 0.0016384 && center !== bounded) this.exGcLat = interpolationPoint(ox, oy, oz, lx, lz, center, llon)[0];
    this.center = bounded;
  }
  point(d) { this.target.push(interpolationPoint(this.ox, this.oy, this.oz, this.lx, this.lz, d, this.llon)); }
  sequence(from, to, step) {
    const n = Math.trunc((to - from) / step) + 1;
    for (let j = 1; j < n; j++) this.point(from + (to - from) * j / n);
  }
  collectCenter(from, to, divisor) {
    const thr = 0.0065536 / divisor;
    if (this.acc < thr && divisor < 65536) {
      const d = Math.acos(Math.sqrt(1 - 1 / divisor / divisor) / Math.sin(this.exGcLat * DEG));
      const bl = Math.max(Math.min(this.center - d, to), from);
      const br = Math.max(Math.min(this.center + d, to), from);
      this.sequence(from, bl, thr * DEG);
      if (0 < bl && bl < to) this.point(bl);
      this.collectCenter(bl, br, divisor * 4);
      if (0 < br && br < to) this.point(br);
      this.sequence(br, to, thr * DEG);
    } else {
      if (this.acc < 1e-9) this.acc = 1e-9;
      this.acc *= DEG;
      this.sequence(from, this.center, this.acc);
      if (from < this.center && this.center < to) this.point(this.center);
      this.sequence(this.center, to, this.acc);
    }
  }
}

function interpolateSegment(llat, llon, rlat, rlon, target) {
  if (Math.abs(rlat - llat) < 0.0065536 && Math.abs(rlon - llon) < 0.0065536) { target.push([rlat, rlon]); return; }
  if (Math.abs(rlon - llon) > 180) rlon = llon < 0 ? rlon - 360 : rlon + 360;
  if (Math.abs(rlon - llon) > 179.999999) {
    const pole = llat + rlat >= 0 ? 90.0 : -90.0;
    let n = Math.trunc(Math.abs(pole - llat) / 0.0065536) + 1;
    for (let j = 1; j < n; j++) target.push([llat + (pole - llat) * j / n, llon]);
    target.push([pole, llon]);
    n = Math.trunc(Math.abs(rlon - llon) / 0.0065536) + 1;
    for (let j = 1; j < n; j++) target.push([pole, llon + (rlon - llon) * j / n]);
    target.push([pole, rlon]);
    n = Math.trunc(Math.abs(rlat - pole) / 0.0065536) + 1;
    for (let j = 1; j < n; j++) target.push([pole + (rlat - pole) * j / n, rlon]);
  } else {
    const lcos = Math.cos(llat * DEG);
    const lx = Math.sin(llat * DEG), lz = lcos;
    const rcos = Math.cos(rlat * DEG);
    const rx = Math.sin(rlat * DEG);
    const ry = Math.sin((rlon - llon) * DEG) * rcos;
    const rz = Math.cos((rlon - llon) * DEG) * rcos;
    const prod = lx * rx + lz * rz;
    const dist = Math.acos(Math.max(-1.0, Math.min(1.0, prod)));
    let ox = rx - prod * lx, oy = ry, oz = rz - prod * lz;
    const lg = Math.sqrt(ox * ox + oy * oy + oz * oz);
    ox /= lg; oy /= lg; oz /= lg;
    new Collector(ox, oy, oz, lx, lz, dist, llon, target).collectCenter(0, dist, 4);
  }
  if (rlon < -180) rlon += 360; else if (rlon > 180) rlon -= 360;
  target.push([rlat, rlon]);
}

const idx = (p) => u32((ilat(p[0]) & 0xffff0000) | (u32(ilon(p[1])) >>> 16));
const spiGet = (spi, k) => { let l = spi.get(k); if (!l) { l = []; spi.set(k, l); } return l; };

function addSegment(spi, from, to, pos) {
  const la = ilat(from[0]), lo = ilon(from[1]), ra = ilat(to[0]), ro = ilon(to[1]);
  spiGet(spi, u32((la & 0xffff0000) | (u32(lo) >>> 16))).push(pos);
  if ((lo & 0xffff0000) !== (ro & 0xffff0000)) spiGet(spi, u32((la & 0xffff0000) | (u32(ro) >>> 16))).push(pos);
  if ((la & 0xffff0000) !== (ra & 0xffff0000)) {
    spiGet(spi, u32((ra & 0xffff0000) | (u32(lo) >>> 16))).push(pos);
    if ((lo & 0xffff0000) !== (ro & 0xffff0000)) spiGet(spi, u32((ra & 0xffff0000) | (u32(ro) >>> 16))).push(pos);
  }
}
const replaceIn = (lst, old, nw) => { for (let i = 0; i < lst.length; i++) if (lst[i] === old) lst[i] = nw; };

function replaceSegment(spi, from, via, to, old, nw) {
  const la = u32(ilat(from[0]) & 0xffff0000), lo = i32(ilon(from[1]) & 0xffff0000);
  const ra = u32(ilat(to[0]) & 0xffff0000), ro = i32(ilon(to[1]) & 0xffff0000);
  const va = u32(ilat(via[0]) & 0xffff0000), vo = i32(ilon(via[1]) & 0xffff0000);
  const key = (a, o) => u32(a | (u32(o) >>> 16));
  if (va === la && vo === lo) nw += 1;
  replaceIn(spiGet(spi, key(la, lo)), old, nw);
  if (lo !== ro) replaceIn(spiGet(spi, key(la, ro)), old, nw);
  if (la !== ra) {
    replaceIn(spiGet(spi, key(ra, lo)), old, nw);
    if (lo !== ro) {
      if ((va === la && vo === lo) || (va === ra && vo === ro)) replaceIn(spiGet(spi, key(ra, ro)), old, nw);
      else {
        spiGet(spi, key(la, ro)).push(nw + 1);
        spiGet(spi, key(ra, lo)).push(nw + 1);
        replaceIn(spiGet(spi, key(ra, ro)), old, nw + 1);
      }
    }
  }
  if (va === la && vo === lo) spiGet(spi, key(la, lo)).push(nw - 1);
  else if (va === ra && vo === ro) spiGet(spi, key(ra, ro)).push(nw + 1);
}

function tryIntersect(lf, lt, rf, rt) {
  const rfmltLat = rf[0] - lt[0], rfmltLon = rf[1] - lt[1];
  if (!rfmltLat && !rfmltLon) return null;
  if (same(lf, rt) || same(lf, rf) || same(lt, rt)) return null;
  const lfmltLat = lf[0] - lt[0], lfmltLon = lf[1] - lt[1];
  const rfmrtLat = rf[0] - rt[0], rfmrtLon = rf[1] - rt[1];
  const det = lfmltLat * rfmrtLon - rfmrtLat * lfmltLon;
  if (det === 0) {
    if (lfmltLat * rfmltLon - lfmltLon * rfmltLat !== 0) return null;
    const c = Math.abs(rfmltLat) > Math.abs(rfmltLon) ? 0 : 1;
    if (lf[c] < lt[c]) {
      if (rf[c] < rt[c]) { if (lt[c] < rf[c] || rt[c] < lf[c]) return null; return lf[c] < rf[c] ? rf : lf; }
      if (lt[c] < rt[c] || rf[c] < lf[c]) return null;
      return lf[c] < rt[c] ? rt : lf;
    }
    if (rf[c] < rt[c]) { if (lf[c] < rf[c] || rt[c] < lt[c]) return null; return lt[c] < rf[c] ? rf : lt; }
    if (lf[c] < rt[c] || rf[c] < lt[c]) return null;
    return lt[c] < rt[c] ? rt : lt;
  }
  const x = (rfmrtLon * rfmltLat - rfmrtLat * rfmltLon) / det;
  const y = (lfmltLat * rfmltLon - lfmltLon * rfmltLat) / det;
  if (x <= -1e-7 || x >= 1 + 1e-7 || y <= -1e-7 || y >= 1 + 1e-7) return null;
  return [lt[0] + x * lfmltLat, lt[1] + x * lfmltLon];
}

function bisectLeft(a, v) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }

function splitSegments(segs, gaps, spi) {
  // std::map iteration: keys inserted during the loop are visited if they sort after the current one
  const nextKey = (after) => { let best = null; for (const k of spi.keys()) if ((after === null || k > after) && (best === null || k < best)) best = k; return best; };
  let key = nextKey(null);
  while (key !== null) { splitOne(segs, gaps, spi, key); key = nextKey(key); }
}

function splitOne(segs, gaps, spi, key) {
  let lst = spi.get(key);
  for (let i = 1; i < lst.length; i++) {
    for (let j = 0; j < i; j++) {
      const lj = lst[j], li = lst[i];
      let isect = tryIntersect(segs[lj], segs[lj + 1], segs[li], segs[li + 1]);
      if (isect === null) continue;
      if (idx(isect) !== key) continue;
      for (let k = 0; k < lst.length; k++) {
        if (epsEqual(isect, segs[lst[k]])) isect = segs[lst[k]];
        if (epsEqual(isect, segs[lst[k] + 1])) isect = segs[lst[k] + 1];
      }
      for (const m of [j, i]) {
        const s = lst[m];
        if (!same(isect, segs[s]) && !same(isect, segs[s + 1])) {
          segs.push(segs[s]); segs.push(isect); segs.push(segs[s + 1]);
          gaps.splice(bisectLeft(gaps, s + 1), 0, s + 1);
          gaps.push(segs.length);
          replaceSegment(spi, segs[s], isect, segs[s + 1], s, segs.length - 3);
          lst = spi.get(key);
        }
      }
    }
  }
}

const UMAX = 0xffffffff;
const divIdx = (i, remote) => i * 2 + Math.trunc((remote - i - 1) / 2);

function collectDivertions(segs, key, lst, divs) {
  const pos = [];
  for (const s of lst) {
    if (idx(segs[s]) === key) pos.push([segs[s], s, s + 1]);
    if (idx(segs[s + 1]) === key) pos.push([segs[s + 1], s + 1, s]);
  }
  if (!pos.length) return;
  pos.sort((a, b) => ptCmp(a[0], b[0]) || a[1] - b[1]);
  let sameAt = 0;
  for (let i = 0; i <= pos.length; i++) {
    if (i === pos.length || !same(pos[i][0], pos[sameAt][0])) {
      if (i - sameAt === 2) {
        const a = pos[sameAt], b = pos[sameAt + 1];
        divs[divIdx(a[1], a[2])] = [b[1], b[2]];
        divs[divIdx(b[1], b[2])] = [a[1], a[2]];
      } else {
        const grad = [];
        for (let j = sameAt; j < i; j++) grad.push([Math.atan2(segs[pos[j][2]][1] - segs[pos[j][1]][1], segs[pos[j][2]][0] - segs[pos[j][1]][0]), j]);
        grad.sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] - y[1]));
        for (let j = 0; j < grad.length; ) {
          if (j + 3 < grad.length && grad[j + 1][0] === grad[j + 2][0]) {
            const [p0, p1, p2, p3] = [0, 1, 2, 3].map(k => pos[grad[j + k][1]]);
            divs[divIdx(p0[1], p0[2])] = [p3[1], p3[2]];
            divs[divIdx(p1[1], p1[2])] = [p2[1], p2[2]];
            divs[divIdx(p2[1], p2[2])] = [p1[1], p1[2]];
            divs[divIdx(p3[1], p3[2])] = [p0[1], p0[2]];
            j += 2;
          } else if (j + 1 < grad.length) {
            const p0 = pos[grad[j][1]], p1 = pos[grad[j + 1][1]];
            divs[divIdx(p0[1], p0[2])] = [p1[1], p1[2]];
            divs[divIdx(p1[1], p1[2])] = [p0[1], p0[2]];
          }
          j += 2;
        }
      }
      sameAt = i;
    }
  }
}

function assemble(segs, divs, out) {
  let pos = 0;
  let count = 0;
  for (let i = 0; i < divs.length; i += 2) if (divs[i + 1][0] === UMAX) count++;
  while (count < segs.length) {
    while (divs[2 * pos][0] === UMAX) { pos++; if (pos === segs.length - 1) pos = 0; }
    const cur = [];
    out.push(cur);
    let d = 1;
    while (divs[2 * pos + d][0] !== UMAX) {
      if (cur.length >= 2 && epsEqual(segs[pos], cur[cur.length - 2])) cur.pop();
      else if (!cur.length || !epsEqual(segs[pos], cur[cur.length - 1])) cur.push(segs[pos]);
      const oldI = 2 * pos + d;
      const dv = divs[2 * pos + Math.floor((3 * d - 1) / 2)];
      d = dv[1] - dv[0];
      pos = dv[0];
      count++;
      divs[oldI] = [UMAX, divs[oldI][1]];
    }
    pos++;
    if (pos === segs.length - 1) pos = 0;
    if (cur.length <= 2) out.pop(); else cur.push(cur[0]);
  }
}

/** toggle_if_inside; state = [isInside, onVertex, onSegment]. */
function toggle(state, borderLat, borderLon, pt, lhs0, rhs0) {
  const lhs = [...lhs0], rhs = [...rhs0];
  if (pt[1] < -179.9) { lhs[1] -= lhs[1] > 0 ? 360 : 0; rhs[1] -= rhs[1] > 0 ? 360 : 0; }
  else if (pt[1] > 179.9) { lhs[1] += lhs[1] < 0 ? 360 : 0; rhs[1] += rhs[1] < 0 ? 360 : 0; }
  const [plat, plon] = pt;
  if (lhs[0] === rhs[0]) {
    if (lhs[0] < plat) state[0] = state[0] !== ((lhs[1] - plon) * (rhs[1] - plon) < 0);
    else if (lhs[0] === plat) {
      if (plon === lhs[1] || plon === rhs[1]) state[1] = true;
      else state[2] = state[2] || ((lhs[1] - plon) * (rhs[1] - plon) < 0);
    }
  } else if (lhs[1] === rhs[1]) {
    if ((plat === lhs[0] && plon === lhs[1]) || (plat === rhs[0] && plon === rhs[1])) state[1] = true;
    else if (plon === lhs[1] && (plat - lhs[0]) * (plat - rhs[0]) < 0) state[2] = true;
    else if (lhs[1] < plon && (lhs[0] < borderLat || rhs[0] < borderLat)) state[0] = !state[0];
  } else if ((lhs[0] - rhs[0]) * (lhs[1] - rhs[1]) < 0) {
    if ((plat === lhs[0] && plon === lhs[1]) || (plat === rhs[0] && plon === rhs[1])) state[1] = true;
    else if ((plon - lhs[1]) * (plon - rhs[1]) < 0) {
      const il = lhs[0] + (rhs[0] - lhs[0]) * (plon - lhs[1]) / (rhs[1] - lhs[1]);
      if (il < plat) state[0] = !state[0]; else if (il === plat) state[2] = true;
    } else if (plon === lhs[1] && rhs[1] < plon) { if (lhs[0] < plat) state[0] = !state[0]; }
    else if (plon === rhs[1] && lhs[1] < plon) { if (rhs[0] < plat) state[0] = !state[0]; }
    else if ((borderLat - lhs[0]) * (borderLat - rhs[0]) < 0) {
      const io = lhs[1] + (rhs[1] - lhs[1]) * (borderLat - lhs[0]) / (rhs[0] - lhs[0]);
      if (borderLon < io && io < plon) state[0] = !state[0];
    }
  } else {
    if ((borderLat - lhs[0]) * (borderLat - rhs[0]) < 0) {
      const io = lhs[1] + (rhs[1] - lhs[1]) * (borderLat - lhs[0]) / (rhs[0] - lhs[0]);
      if ((lhs[1] <= plon || rhs[1] <= plon) && borderLon < io) state[0] = !state[0];
    }
    if ((plat === lhs[0] && plon === lhs[1]) || (plat === rhs[0] && plon === rhs[1])) { state[1] = true; return; }
    if ((plon - lhs[1]) * (plon - rhs[1]) < 0) {
      const il = lhs[0] + (rhs[0] - lhs[0]) * (plon - lhs[1]) / (rhs[1] - lhs[1]);
      if (il < plat) state[0] = !state[0]; else if (il === plat) state[2] = true;
    } else if (plon === lhs[1] && rhs[1] < plon) { if (lhs[0] < plat) state[0] = !state[0]; }
    else if (plon === rhs[1] && lhs[1] < plon) { if (rhs[0] < plat) state[0] = !state[0]; }
  }
}

class Oracle {                                     // RHR_Polygon_Area_Oracle
  constructor(segs, spi) { this.segs = segs; this.spi = spi; this.inside = new Set(); }

  buildArea(sw, value, seRef, nwRef) {
    const lst = this.spi.get(u32(value));
    if (lst === undefined) return;
    const segs = this.segs;
    if (sw) this.inside.add(u32(value));
    const v16 = i32(value << 16);
    const vlat = u32(u32(value) & 0xffff0000);
    const vlon = lonOf(value << 16);
    if (vlon > -179.99) {
      if (nwRef) {
        let nw = sw;
        for (const s of lst) {
          const lo1 = i32(ilon(segs[s][1]) & 0xffff0000), lo2 = i32(ilon(segs[s + 1][1]) & 0xffff0000);
          if ((lo1 < v16 && lo2 === v16) || (lo1 === v16 && lo2 < v16)) {
            const il = segs[s][0] + (segs[s + 1][0] - segs[s][0]) * (vlon - segs[s][1]) / (segs[s + 1][1] - segs[s][1]);
            if (u32(ilat(il) & 0xffff0000) === vlat) nw = !nw;
          }
        }
        nwRef[0] = nw;
      }
      if (seRef) {
        let se = sw;
        for (const s of lst) {
          const la1 = u32(ilat(segs[s][0]) & 0xffff0000), la2 = u32(ilat(segs[s + 1][0]) & 0xffff0000);
          if ((la1 < vlat && la2 === vlat) || (la1 === vlat && la2 < vlat)) {
            const io = segs[s][1] + (segs[s + 1][1] - segs[s][1]) * (latOf(vlat) - segs[s][0]) / (segs[s + 1][0] - segs[s][0]);
            if (u32(ilon(io) & 0xffff0000) === u32(value << 16)) se = !se;
          }
        }
        seRef[0] = se;
      }
    } else {
      if (nwRef) {
        let nw = sw;
        for (const s of lst) {
          const l1 = segs[s][1] - (segs[s][1] > 0 ? 360 : 0), l2 = segs[s + 1][1] - (segs[s + 1][1] > 0 ? 360 : 0);
          if (vlon > -180) {
            const lo1 = i32(ilon(l1) & 0xffff0000), lo2 = i32(ilon(l2) & 0xffff0000);
            if ((lo1 < v16 && lo2 === v16) || (lo1 === v16 && lo2 < v16)) {
              const il = segs[s][0] + (segs[s + 1][0] - segs[s][0]) * (vlon - segs[s][1]) / (segs[s + 1][1] - segs[s][1]);
              if (u32(ilat(il) & 0xffff0000) === vlat) nw = !nw;
            }
          } else if ((l1 <= -180 && -180 < l2) || (l2 <= -180 && -180 < l1)) {
            const il = segs[s][0] + (segs[s + 1][0] - segs[s][0]) * (-180 - segs[s][1]) / (segs[s + 1][1] - segs[s][1]);
            if (u32(ilat(il) & 0xffff0000) === vlat) nw = !nw;
          }
        }
        nwRef[0] = nw;
      }
      if (seRef) {
        let se = sw;
        for (const s of lst) {
          const la1 = u32(ilat(segs[s][0]) & 0xffff0000), la2 = u32(ilat(segs[s + 1][0]) & 0xffff0000);
          if ((la1 < vlat && la2 === vlat) || (la1 === vlat && la2 < vlat)) {
            const io = segs[s][1] + (segs[s + 1][1] - segs[s][1]) * (latOf(vlat) - segs[s][0]) / (segs[s + 1][0] - segs[s][0]);
            if (io >= -180 && u32(ilon(io) & 0xffff0000) === u32(value << 16)) se = !se;
          }
        }
        seRef[0] = se;
      }
    }
  }

  pointStatus(value, lat, lon) {
    if (value === 1) return 1;
    const lst = this.spi.get(u32(value));
    if (lst === undefined) return 0;
    const borderLon = Math.max(lonOf(value << 16), -180);
    const borderLat = latOf(u32(value) & 0xffff0000);
    const st = [this.inside.has(u32(value)), false, false];
    for (const s of lst) toggle(st, borderLat, borderLon, [lat, lon], this.segs[s], this.segs[s + 1]);
    if (st[1]) return 0x20 + 2 * st[0];
    if (st[2]) return 0x10 + 2 * st[0];
    return 2 * st[0];
  }
}

class FourField {                                  // Four_Field_Index; entries are [sw, se, nw, ne]
  constructor(oracle) { this.tree = []; this.baseLat = 0; this.baseLon = u32(2000000000); this.bits = 0; this.oracle = oracle; this.minLon = ilon(-180); }
  static slot(la, lo) { return (la & 0x00010000 ? 2 : 0) + (lo & 0x00010000 ? 1 : 0); }
  addPoint(lat, lon, value) {
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return 0;
    const la = ilat(lat), lo = ilon(lon);
    const e = this.makeAvailable(u32(la & 0xfffe0000), u32(u32(lo) & 0xfffe0000), 15);
    const k = FourField.slot(la, u32(lo));
    const old = e[k];
    e[k] = i32(value);
    return old;
  }
  makeAvailable(lat, lon, sig) {
    const t = this.tree;
    if (!t.length) { this.baseLat = lat; this.baseLon = lon; this.bits = sig; t.push([0, 0, 0, 0]); return t[t.length - 1]; }
    let mask = u32(~(0xffffffff >>> this.bits));
    while (u32(lat & mask) !== u32(this.baseLat & mask) || u32(lon & mask) !== u32(this.baseLon & mask)) {
      this.bits -= 1;
      t.push(t[0]);
      t[0] = [0, 0, 0, 0];
      const bit = 0x80000000 >>> this.bits;
      const k = (this.baseLat & bit ? 2 : 0) + (this.baseLon & bit ? 1 : 0);
      t[0][k] = -t.length + 1;
      mask = u32(~(0xffffffff >>> this.bits));
      this.baseLat = u32(this.baseLat & mask);
      this.baseLon = u32(this.baseLon & mask);
    }
    let cur = this.bits, pos = 0;
    while (cur < sig) {
      const bit = 0x80000000 >>> cur;
      const k = (lat & bit ? 2 : 0) + (lon & bit ? 1 : 0);
      if (t[pos][k] < 0) pos = -t[pos][k];
      else { t[pos][k] = -t.length; pos = t.length; t.push([0, 0, 0, 0]); }
      if (pos === t.length) t.push([0, 0, 0, 0]);
      cur++;
    }
    return t[pos];
  }
  computeInsideParts() { if (this.oracle && this.tree.length) this.cip(this.baseLat, this.baseLon, this.bits, 0, false, null, null); }
  cip(lat, lon, sig, pos, sw, rSe, rNw) {
    const t = this.tree, o = this.oracle;
    const half = sig < 32 ? 0x80000000 >>> sig : 0;
    if (!sig || this.minLon <= i32(i32(lon) + i32(half))) {
      const se = [false], nw = [false], ne = [false];
      const e = t[pos];
      if (e[0] < 0) this.cip(lat, lon, sig + 1, -e[0], sw, se, nw);
      else if (e[0] > 0) o.buildArea(sw, e[0], se, nw);
      else { e[0] = +sw; se[0] = sw; nw[0] = sw; }
      if (e[1] < 0) this.cip(lat, u32(lon + half), sig + 1, -e[1], se[0], rSe, null);
      else if (e[1] > 0) o.buildArea(se[0], e[1], rSe, null);
      else { e[1] = +se[0]; if (rSe) rSe[0] = se[0]; }
      if (e[2] < 0) this.cip(u32(lat + half), lon, sig + 1, -e[2], nw[0], ne, rNw);
      else if (e[2] > 0) o.buildArea(nw[0], e[2], ne, rNw);
      else { e[2] = +nw[0]; ne[0] = nw[0]; if (rNw) rNw[0] = nw[0]; }
      if (e[3] < 0) this.cip(u32(lat + half), u32(lon + half), sig + 1, -e[3], ne[0], null, null);
      else if (e[3] > 0) o.buildArea(ne[0], e[3], null, null);
      else e[3] = +ne[0];
    } else {
      const ne = [false];
      const e = t[pos];
      if (e[1] < 0) this.cip(lat, u32(lon + half), sig + 1, -e[1], sw, rSe, ne);
      else if (e[1] > 0) o.buildArea(sw, e[1], rSe, ne);
      else { e[1] = +sw; if (rSe) rSe[0] = sw; }
      if (e[3] < 0) this.cip(u32(lat + half), u32(lon + half), sig + 1, -e[3], ne[0], null, rNw);
      else if (e[3] > 0) o.buildArea(ne[0], e[3], null, rNw);
      else { e[3] = +ne[0]; if (rNw) rNw[0] = ne[0]; }
    }
  }
  pointStatus(lat, lon) {
    if (!this.oracle || !this.tree.length) return 0;
    const la = ilat(lat), lo = u32(ilon(lon));
    let cur = this.bits, pos = 0;
    while (cur < 32) {
      const bit = 0x80000000 >>> cur;
      const k = (la & bit ? 2 : 0) + (lo & bit ? 1 : 0);
      const v = this.tree[pos][k];
      if (v < 0) pos = -v; else if (v > 0) return this.oracle.pointStatus(v, lat, lon); else return 0;
      cur++;
    }
    return 0;
  }
}

const strictlyWest = (a, b) => (a - b > 180 ? a - 360 < b : a < b);
const weaklyWest = (a, b) => (a - b > 180 ? a - 360 <= b : a <= b);

export function rhrPolygon(free) {
  const segs = [], gaps = [0];
  for (const ln of free.lines) {
    segs.push(ln[0]);
    for (let k = 0; k + 1 < ln.length; k++) interpolateSegment(ln[k][0], ln[k][1], ln[k + 1][0], ln[k + 1][1], segs);
    gaps.push(segs.length);
  }
  const spi = new Map();
  let gi = 0;
  for (let i = 0; i < segs.length; i++) {
    if (gaps[gi] === i) gi++;
    else addSegment(spi, segs[i - 1], segs[i], i - 1);
  }
  splitSegments(segs, gaps, spi);
  const divs = Array.from({ length: 2 * segs.length }, () => [UMAX, UMAX]);
  for (const g of gaps.slice(1)) { divs[g * 2 - 2] = [UMAX, UMAX]; divs[g * 2 - 1] = [UMAX, UMAX]; }
  const keys = [...spi.keys()].sort((a, b) => a - b);
  for (const key of keys) collectDivertions(segs, key, spi.get(key), divs);
  const lines = [];
  assemble(segs, divs, lines);
  const oracle = new Oracle(segs, spi);
  const ff = new FourField(oracle);
  for (const key of keys) ff.addPoint(latOf(u32(key | 0x8000)), lonOf(u32(key << 16) | 0x8000), key);
  ff.computeInsideParts();
  for (const ln of lines) {
    if (ln.length <= 2) continue;
    const [a, b, c] = ln;
    const ins = Boolean(ff.pointStatus(b[0], b[1]) & 0x3);
    let rev;
    if (strictlyWest(a[1], b[1])) {
      if (weaklyWest(b[1], c[1])) rev = ins;
      else rev = ins !== ((b[0] - a[0]) / (b[1] - a[1]) < (c[0] - b[0]) / (c[1] - b[1]));
    } else if (strictlyWest(c[1], b[1])) rev = !ins;
    else if (a[1] === b[1]) rev = ins !== (a[0] < b[0]);
    else if (c[1] === b[1]) rev = ins !== (b[0] < c[0]);
    else rev = ins !== ((b[0] - a[0]) / (b[1] - a[1]) < (c[0] - b[0]) / (c[1] - b[1]));
    if (rev) ln.reverse();
  }
  return new RHRPolygon(lines);
}

// ---- output (output_json.cc)
/** round(v, 7) as Python and toFixed do it. Away from a tie, Math.round(v·1e7) is the right integer and
 *  r / 1e7 the same double as parsing its decimal; near a tie the exact (slow) path decides. */
export function round7(v) { const y = v * 1e7, r = Math.round(y); return Math.abs(y - r) < 0.4999 ? r / 1e7 : Number(v.toFixed(7)); }

export function toGeoJSON(g) {
  if (g.hasComponents()) return { type: 'GeometryCollection', geometries: g.components().filter(c => c && c.hasCenter()).map(toGeoJSON) };
  if (g.hasLineGeometry()) return { type: 'LineString', coordinates: g.line().map(([la, lo]) => [round7(lo), round7(la)]) };
  if (g.hasMultilineGeometry()) return { type: 'Polygon', coordinates: g.multiline().map(ln => ln.map(([la, lo]) => [round7(lo), round7(la)])) };
  if (g.hasCenter()) return { type: 'Point', coordinates: [round7(g.centerLon()), round7(g.centerLat())] };
  return null;
}

/** print_geometry(geometry, mode) for a derived element: mode in geom/bb/center. */
export function derivedGeometry(g, mode) {
  if (mode === 'geom' && g.hasCenter()) return toGeoJSON(g);
  if (mode === 'bb' && g.hasBbox()) {
    const w = round7(g.west()), s = round7(g.south()), e = round7(g.east()), n = round7(g.north());
    return { type: 'Polygon', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] };
  }
  if (mode === 'center' && g.hasCenter()) return { type: 'Point', coordinates: [round7(g.centerLon()), round7(g.centerLat())] };
  return null;
}
