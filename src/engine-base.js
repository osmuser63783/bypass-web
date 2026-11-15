// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers and constants the Engine and its method files share: coordinates, great-circle maths, references
// (slots, areas, derived), outlines, out … geom clipping and tag filters. Split out of engine.js.

import { latFromY, lonFromX } from './bundle.js';
import * as G from './geometry.js';

/** Up to this many nodes, waysOfNodes checks each candidate way's box against every node before its node list. */
const FEW_POINTS = 8;

/** around: an element box over more grid cells than this skips the quick no-source check. */
const ANY_NEAR_MAX_CELLS = 64;
/** Overpass's copyright line (osm3s in JSON, <note> in XML). */
export const COPYRIGHT = 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.';

// ---- coordinates ------------------------------------------------------------------------------------------

/** round(v, 7) as Python and toFixed do it. Away from a tie, Math.round(v·1e7) is the right integer and
 *  r / 1e7 the same double as parsing its decimal; near a tie the exact (slow) path decides. */
const round7 = (v) => { const y = v * 1e7, r = Math.round(y); return Math.abs(y - r) < 0.4999 ? r / 1e7 : Number(v.toFixed(7)); };
const lat7 = (y) => round7(latFromY(y));
const lon7 = (x) => round7(lonFromX(x));
const ilat = (lat) => Math.trunc((lat + 91) * 1e7 + 0.5);
const ilon = (lon) => Math.trunc(lon * 1e7 + (lon > 0 ? 0.5 : -0.5));
const decoded = (lat, lon) => [ilat(lat) / 1e7 - 91, ilon(lon) / 1e7];       // geometry.py decoded()

// ---- Overpass spherical maths (spherical.py) --------------------------------------------------------------

const EARTH_R = 2e7 / Math.PI;
const A0 = Math.acos(0);
const cartesian = (lat, lon) => [Math.sin(lat / 90 * A0), Math.cos(lat / 90 * A0) * Math.sin(lon / 90 * A0),
  Math.cos(lat / 90 * A0) * Math.cos(lon / 90 * A0)];
const cross = (v, w) => [v[1] * w[2] - v[2] * w[1], v[2] * w[0] - v[0] * w[2], v[0] * w[1] - v[1] * w[0]];
const dot = (v, w) => v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
function lineDistance(norm, c) {
  const nn = Math.sqrt(dot(norm, norm));
  if (nn === 0) return Infinity;
  let sp = Math.abs(dot(c, norm)) / nn;
  if (sp > 1) sp = 1;
  return Math.asin(sp) * (10 * 1000 * 1000 / A0);
}
function segmentsIntersect(sa, na, sb, nb) {
  let ip = cross(na, nb);
  const ln = Math.sqrt(dot(ip, ip));
  if (ln === 0) return false;
  ip = [ip[0] / ln, ip[1] / ln, ip[2] / ln];
  const asum = [sa[0][0] + sa[1][0], sa[0][1] + sa[1][1], sa[0][2] + sa[1][2]];
  const bsum = [sb[0][0] + sb[1][0], sb[0][1] + sb[1][1], sb[0][2] + sb[1][2]];
  return Math.abs(dot(asum, ip)) >= dot(asum, sa[0]) && Math.abs(dot(bsum, ip)) >= dot(bsum, sb[0]);
}
function gcd(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0;
  const d = Math.PI / 180;
  const sp = Math.cos((lat2 - lat1) * d) + Math.cos(lat1 * d) * Math.cos(lat2 * d) * (Math.cos((lon2 - lon1) * d) - 1);
  return Math.acos(Math.min(sp, 1)) * EARTH_R;
}

// ---- references -------------------------------------------------------------------------------------------
// Set members are numbers. A feature is the store's ref (slot · 2^32 + index, below 2^48). An untagged way
// node, which isn't a feature, is VNODE + slot · 2^32 + its point index in a way of that tile (one canonical
// ref per node ID, see Engine.nodeRef). An Overpass area is AREA + the ref of its relation or closed way.

const SLOT = 2 ** 32, VNODE = 2 ** 49, AREA = 2 ** 50, DERIVED = 2 ** 51;
const WAY_AREA_OFFSET = 2400000000, REL_AREA_OFFSET = 3600000000;
const TYPE_ORDER = { node: 0, way: 1, relation: 2, area: 3, derived: 4 };
const isArea = (r) => r >= AREA && r < DERIVED;
// a derived element (make/convert) is DERIVED + its index in the run's list of derived elements
const isDerived = (r) => r >= DERIVED;
const isVnode = (r) => r >= VNODE && r < AREA;

// A part is a run of points in a tile's xy array: { xy, s, n, closed }. Area rings are stored without the
// closing point; `closed` adds it back (point n is point 0).
const partCount = (q) => q.n + (q.closed && q.n ? 1 : 0);
const px = (q, k) => q.xy[2 * (q.s + (k === q.n ? 0 : k))];
const py = (q, k) => q.xy[2 * (q.s + (k === q.n ? 0 : k)) + 1];
const partPoints = (q) => { const out = []; for (let k = 0, c = partCount(q); k < c; k++) out.push([px(q, k), py(q, k)]); return out; };
const ipoint = ([x, y]) => [ilat(latFromY(y)), ilon(lonFromX(x))];

const POSITIVE_TAG_KINDS = ['key', 'nokey', 'eq', 're', 'nre', 'likelike'];      // [!k] and !~ count; != alone doesn't
const acceptsUntagged = (tags) => tags.every(t => t.kind === 'nokey' || t.kind === 'ne' || t.kind === 'nre');
// query.py STANDALONE_CRITERIA: a statement with this single filter (no tags, no input) isn't a query
// statement, so the global [bbox:] doesn't apply to it
const STANDALONE = { ids: (t) => ['node', 'way', 'relation'].includes(t), bbox: (t) => t === 'node',
  around: (t) => t === 'node', poly: (t) => t === 'node', pivot: (t) => t === 'node', rel: (t) => t !== 'nwr' };
const TYPE_INDEX_OF = { node: 0, way: 1, relation: 2 };

// ---- out … geom(s,w,n,e) (output.py)
/** Is a point inside the bbox, in Overpass's integer coordinates (east < west wraps the antimeridian)? */
function bboxMatcher(bb) {
  const so = G.ilat(bb[0]), we = G.ilon(bb[1]), no = G.ilat(bb[2]), ea = G.ilon(bb[3]);
  return (p) => {
    if (no < so) return true;
    const la = G.ilat(p[0]), lo = G.ilon(p[1]);
    return so <= la && la <= no && ((we <= lo && lo <= ea) || (ea < we && (lo >= we || lo <= ea)));
  };
}
/** Way_Bbox_Geometry_Store::get_geometry: a point is kept while it, a neighbour or an adjacent segment touches the bbox. */
function clipWayPoints(pts, bb) {
  const inside = bboxMatcher(bb);
  const box = new G.Bbox(bb[0], bb[1], bb[2], bb[3]);
  const res = [...pts];
  const n = res.length;
  let i = 0, lastDropped = false;
  while (i < n) {
    if (i < n - 1 && inside(res[i + 1])) i += 3;
    else if (!lastDropped && inside(res[i])) i += 2;
    else if (!lastDropped && i > 0 && inside(res[i - 1])) i += 1;
    else if (i < n - 1 && G.bboxIntersects(box, res[i], res[i + 1])) i += 2;
    else if (!lastDropped && i > 0 && G.bboxIntersects(box, res[i - 1], res[i])) i += 1;
    else { res[i] = null; lastDropped = true; i += 1; continue; }
    lastDropped = false;
  }
  return res;
}
/** Relation_Geometry_Store: a member way's point is dropped when it and its neighbours are outside. */
function clipMemberWay(pts, inside) {
  if (pts.length === 1) return [inside(pts[0]) ? pts[0] : null];
  if (!pts.length) return pts;
  const ok = pts.map(inside), keep = [...pts];
  if (!ok[0] && !ok[1]) keep[0] = null;
  for (let k = 1; k < pts.length - 1; k++) if (!ok[k - 1] && !ok[k] && !ok[k + 1]) keep[k] = null;
  if (!ok[ok.length - 2] && !ok[ok.length - 1]) keep[keep.length - 1] = null;
  return keep;
}
const clippedPoint = (p) => (p ? { lat: G.round7(p[0]), lon: G.round7(p[1]) } : null);
function verbatimRelGeom(groups) {
  if (groups.every(g => g.length && g.every(p => p))) return new G.Compound(groups.map(g => (g.length === 1 ? new G.Point(g[0][0], g[0][1]) : new G.Linestring(g))));
  if (!groups.length) return new G.Null();
  const pr = new G.PartialRelation();
  for (const g of groups) {
    if (!g.length) pr.addPlaceholder();
    else if (g.length === 1 && g[0]) pr.addPoint(g[0]);
    else { pr.startWay(); for (const p of g) { if (p) pr.addWayPoint(p); else pr.addWayPlaceholder(); } }
  }
  return pr;
}
/** Clipped out center/bb(…): over every position, dropped ones decoding to G.ZERO_QUAD (an Overpass quirk). */
function clippedCenterOrBounds(d, type, groups, o) {
  const flat = groups.flat().map(p => p ?? G.ZERO_QUAD);
  let mnla = 100, mxla = -100, mnlo = 200, mxlo = -200;
  for (const [la, lo] of flat) { mnla = Math.min(mnla, la); mxla = Math.max(mxla, la); mnlo = Math.min(mnlo, lo); mxlo = Math.max(mxlo, lo); }
  if (mnla > mxla) return;
  if (type === 2 && mxlo - mnlo >= 180) { mnlo = 200; mxlo = -200; for (const [, lo] of flat) { if (lo < 0) mxlo = Math.max(mxlo, lo); else mnlo = Math.min(mnlo, lo); } }
  if (o.geom === 'bb') d.bounds = { minlat: G.round7(mnla), minlon: G.round7(mnlo), maxlat: G.round7(mxla), maxlon: G.round7(mxlo) };
  else d.center = { lat: G.round7((mnla + mxla) / 2), lon: G.round7((mnlo + mxlo) / 2) };
}

/**
 * Tag filters compiled for one tile: a test of feature indexes, or null when no feature of the tile can
 * match (a required key or value doesn't occur there). Regex results are cached per value code.
 */
/** Tag filters that need a key */
const KEY_REQUIRED = new Set(['key', 'eq', 're']);

/**
 * The tile's features with the rarest key (or key=value) a filter requires ([k], [k=v], [k~v]), or null when no
 * filter requires one. Called after compileTags, which has already skipped tiles lacking such a key.
 */
function keyedFeatures(t, filters) {
  let best = null;
  for (const f of filters) {
    if (!KEY_REQUIRED.has(f.kind) || f.key === undefined) continue;
    const list = t.withTag(t.code(f.key), f.kind === 'eq' ? t.code(f.value) : -1);
    if (!best || list.length < best.length) best = list;
  }
  return best;
}

function compileTags(t, filters) {
  const tests = [];
  for (const f of filters) {
    const key = f.key === undefined ? -1 : t.code(f.key);
    switch (f.kind) {
      case 'key': if (key < 0) return null; tests.push(i => t.value(i, key) >= 0); break;
      case 'nokey': if (key >= 0) tests.push(i => t.value(i, key) < 0); break;
      case 'eq': {
        const val = t.code(f.value);
        if (key < 0 || val < 0) return null;
        tests.push(i => t.value(i, key) === val); break;
      }
      case 'ne': {
        const val = t.code(f.value);
        if (key >= 0 && val >= 0) tests.push(i => t.value(i, key) !== val); break;
      }
      case 'likelike': {                           // [~"k"~"v"]: some tag whose key and value both match
        const kc = new Map(), vc = new Map(), strs = t.strs, kv = t.tagKV;
        const keyOk = (c) => { let m = kc.get(c); if (m === undefined) { const k = strs[c]; m = !k.startsWith('geodesk:') && f.kre.test(k); kc.set(c, m); } return m; };
        const valOk = (c) => { let m = vc.get(c); if (m === undefined) { m = f.vre.test(strs[c]); vc.set(c, m); } return m; };
        if (!strs.some((k, c) => keyOk(c))) return null;
        tests.push(i => {
          const tt = t.tagTab[i];
          for (let k = 2 * t.tagOff[tt], end = 2 * t.tagOff[tt + 1]; k < end; k += 2) if (keyOk(kv[k]) && valOk(kv[k + 1])) return true;
          return false;
        });
        break;
      }
      case 're': case 'nre': {
        if (key < 0) { if (f.kind === 're') return null; break; }
        const cache = new Map(), strs = t.strs, re = f.re;
        const matches = (c) => { let m = cache.get(c); if (m === undefined) { m = re.test(strs[c]); cache.set(c, m); } return m; };
        if (f.kind === 're') tests.push(i => { const c = t.value(i, key); return c >= 0 && matches(c); });
        else tests.push(i => { const c = t.value(i, key); return c < 0 || !matches(c); });
        break;
      }
    }
  }
  if (!tests.length) return () => true;
  if (tests.length === 1) return tests[0];
  return (i) => { for (const test of tests) if (!test(i)) return false; return true; };
}

/** Does a part (polyline or single point) touch an axis-aligned box (boundary included)? */
function partMeetsBox(q, b) {
  const c = partCount(q);
  for (let k = 0; k < c; k++) {
    const x = px(q, k), y = py(q, k);
    if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return true;
  }
  for (let k = 0; k + 1 < c; k++) if (segmentMeetsBox(px(q, k), py(q, k), px(q, k + 1), py(q, k + 1), b)) return true;
  return false;
}

function segmentMeetsBox(x1, y1, x2, y2, b) {
  // Liang-Barsky clipping on exact integer-valued doubles.
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x1 - b.minX) && clip(dx, b.maxX - x1) && clip(-dy, y1 - b.minY) && clip(dy, b.maxY - y1) && t0 <= t1;
}

function overpassCenter(s, w, n, e) {                    // output.py _overpass_center
  const la1 = Math.round((s + 91) * 1e7) / 1e7 - 91, la2 = Math.round((n + 91) * 1e7) / 1e7 - 91;
  const lo1 = Math.round(w * 1e7) / 1e7, lo2 = Math.round(e * 1e7) / 1e7;
  return { lat: Number(((la1 + la2) / 2).toFixed(7)), lon: Number(((lo1 + lo2) / 2).toFixed(7)) };
}

export { FEW_POINTS, ANY_NEAR_MAX_CELLS, round7, lat7, lon7, ilat, ilon, decoded, EARTH_R, A0, cartesian, cross, dot, lineDistance, segmentsIntersect, gcd, SLOT, VNODE, AREA, DERIVED, WAY_AREA_OFFSET, REL_AREA_OFFSET, TYPE_ORDER, isArea, isDerived, isVnode, partCount, px, py, partPoints, ipoint, POSITIVE_TAG_KINDS, acceptsUntagged, STANDALONE, TYPE_INDEX_OF, bboxMatcher, clipWayPoints, clipMemberWay, clippedPoint, verbatimRelGeom, clippedCenterOrBounds, KEY_REQUIRED, keyedFeatures, compileTags, partMeetsBox, segmentMeetsBox, overpassCenter };
