// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: Query statements: tag filters, the spatial tests (bbox, around, poly) and scanning tiles.
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

import { ANY_NEAR_MAX_CELLS, AREA, POSITIVE_TAG_KINDS, SLOT, STANDALONE, TYPE_INDEX_OF, acceptsUntagged, cartesian, compileTags, cross, decoded, gcd, isArea, isDerived, isVnode, keyedFeatures, lineDistance, partMeetsBox, partPoints, px, py, segmentsIntersect } from './engine-base.js';
import { F_DUPLICATE, F_NODE_IDS } from './tes.js';
import { OUTSIDE, PolygonArea } from './areas.js';
import { NO_WAYNODE_IDS, RuntimeQLError, Unsupported } from './errors.js';
import { evaluate, truthy } from './expr.js';
import { featureMeetsBox, featuresInBoxEstimate, forEachInBox } from './spatial.js';
import { latFromY, lonFromX, xFromLon, yFromLat } from './bundle.js';
import { typeBegin, typeEnd } from './store.js';

export class QueryMethods {

  // ---- query statements (query.py)
  query(q, ctx) {
    if (q.types[0] === 'derived') return this.derivedQuery(q, ctx);
    if (q.types[0] !== 'area') return this.runQuery(q, q.types, ctx);
    // query.cc: type area is the area objects plus the closed ways that pass the same filters
    const res = this.runQuery(q, ['area'], ctx);
    const ways = this.runQuery(q, ['way'], ctx);
    const out = new Set([...ways].filter(r => this.wayIsClosed(r)));
    for (const r of res) out.add(r);
    return out;
  }

  runQuery(q, types, ctx) {
    const isAreaQuery = types[0] === 'area';
    if (isAreaQuery) ctx.usedAreas = true;
    const tags = [], ids = [], spatial = [], rels = [], recursions = [], ifs = [];
    for (const f of q.filters) {
      if (['key', 'nokey', 'eq', 'ne', 're', 'nre', 'likelike'].includes(f.kind)) tags.push(f);
      else if (f.kind === 'ids') ids.push(...f.ids);
      else if (['bbox', 'around', 'inArea', 'areaIds', 'poly'].includes(f.kind)) spatial.push(f);
      else if (f.kind === 'rel' || f.kind === 'pivot' || f.kind === 'waycount') rels.push(f);
      else if (f.kind === 'recurse') recursions.push(f);
      else if (f.kind === 'if') ifs.push(f.ast);
    }
    const standalone = !q.inputs.length && q.filters.length === 1 && STANDALONE[q.filters[0].kind]?.(q.typeName === 'rel' ? 'relation' : q.typeName);
    if (ctx.bbox && !standalone) spatial.push(ctx.bbox);      // [bbox:] constrains every *query* statement
    if (!(spatial.length || ids.length || q.inputs.length || rels.length || recursions.length || tags.some(t => POSITIVE_TAG_KINDS.includes(t.kind)))) {
      throw new RuntimeQLError('runtime error: Filters too weak in query statement: specify in addition a bbox, a tag filter, or similar.');
    }
    const tests = isAreaQuery ? [] : spatial.map(f => this.spatialTest(f, ctx));
    if (tests.some(t => t.empty)) return new Set();
    const typeIdx = isAreaQuery ? null : types.map(t => TYPE_INDEX_OF[t]);
    const typeOk = (r) => isAreaQuery ? (this.typeOf(r) === 2 && this.areaOrIncomplete(r, ctx)) : typeIdx.includes(this.typeOf(r));
    const key = (r) => isAreaQuery ? AREA + r : r;
    // (if: …) filters come last, on the element as the set will hold it (query.py _final_filter)
    const sets = this.resolver(ctx);
    const ifOk = ifs.length ? (k) => { const el = this.elem(k); return ifs.every(a => truthy(evaluate(a, el, null, '', sets))); } : () => true;
    const out = { add: (k) => { if (ifOk(k)) res.add(k); } };
    const res = new Set();
    const tagCache = new Map();
    const tagsOk = (r) => {
      if (isVnode(r)) return acceptsUntagged(tags);
      const t = this.tileOf(r);
      let tt = tagCache.get(t);
      if (tt === undefined) { tt = compileTags(t, tags); tagCache.set(t, tt); }
      return tt !== null && tt(this.indexOf(r));
    };
    const spatialOk = (r) => { for (const s of tests) if (!s.test(r)) return false; return true; };

    const pools = [...q.inputs.map(n => ctx.sets.get(n) ?? new Set()),
      ...rels.map(f => (f.kind === 'pivot' ? this.pivot(f, types, ctx) : f.kind === 'waycount' ? this.wayCount(f, types, ctx) : this.relFilter(f, types, ctx))),
      ...recursions.map(f => new Set([...this.recurse(f.op, ctx.sets.get(f.set) ?? new Set(), ctx)].filter(r => !isArea(r))))];
    let cand;
    if (pools.length) {
      pools.sort((a, b) => a.size - b.size);
      cand = [...pools[0]].filter(r => !isDerived(r) && pools.every(p => p.has(r))).map(r => this.base(r)).filter(typeOk);
      if (ids.length) cand = cand.filter(r => ids.includes(this.idOf(r)));
    } else if (isAreaQuery && ids.length) {
      cand = this.areaFeatures(ids).filter(r => this.typeOf(r) !== 2 || this.areaOrIncomplete(r, ctx));   // query.py _type_ok
      for (const r of cand) if (tagsOk(r) && spatialOk(r)) out.add(key(r));
      return res;
    } else if (ids.length) {
      cand = [];
      for (const type of typeIdx) for (const id of ids) { const r = this.store.find(type, id); if (r >= 0) cand.push(r); }
    } else {
      this.scan(types, isAreaQuery, tags, tests, typeOk, (r) => out.add(key(r)));
      if (!isAreaQuery && types.includes('node') && acceptsUntagged(tags)) this.untaggedNodes(tests, (r) => out.add(r));
      return res;
    }
    for (const r of cand) { this.tick(); if (tagsOk(r) && spatialOk(r)) out.add(key(r)); }
    return res;
  }

  /** All canonical features of the types that pass the tag filters (compiled per tile) and spatial tests. */
  scan(types, isAreaQuery, tags, tests, typeOk, emit) {
    const store = this.store;
    store.index();                                   // flags duplicate copies
    const typeIdx = isAreaQuery ? [2] : types.map(t => TYPE_INDEX_OF[t]);
    const boxes = tests.map(t => t.box).filter(Boolean);
    // the smallest box decides which features the spatial index hands out; the others are checked per feature
    const area = (b) => (b.maxX - b.minX) * (b.maxY - b.minY);
    const lead = boxes.length ? boxes.reduce((a, b) => (area(b) < area(a) ? b : a)) : null;
    const wanted = new Uint8Array(3);
    for (const ty of typeIdx) wanted[ty] = 1;
    for (const t of store.slots) {
      const tt = compileTags(t, tags);
      if (!tt) continue;
      const flags = t.flags;
      const consider = (i) => {
        if (flags[i] & F_DUPLICATE) return;
        this.tick();
        if (!tt(i)) return;
        const r = t.slot * SLOT + i;
        if (boxes.length > 1) {
          const b = this.box(r);
          if (b && boxes.some(x => b.maxX < x.minX || b.minX > x.maxX || b.maxY < x.minY || b.minY > x.maxY)) return;
        }
        if (isAreaQuery && !typeOk(r)) return;
        for (const s of tests) if (!s.test(r)) return;
        emit(r);
      };
      const keyed = keyedFeatures(t, tags);
      if (keyed && (!lead || keyed.length < featuresInBoxEstimate(t, lead))) {
        for (const i of keyed) if (wanted[t.typeOf(i)] && (!lead || featureMeetsBox(t, i, lead))) consider(i);
      } else if (lead) forEachInBox(t, lead, (i) => { if (wanted[t.typeOf(i)]) consider(i); });
      else for (const type of typeIdx) for (let i = typeBegin(t, type), end = typeEnd(t, type); i < end; i++) consider(i);
    }
  }

  /** Untagged way nodes meeting the spatial filters (query.py _untagged_nodes): they need way-node IDs. */
  untaggedNodes(tests, emit) {
    if (!this.store.bundle.header.wayNodeIds) {
      throw new Unsupported('This query matches nodes without tags, which a bundle only has as way nodes with IDs. ' +
        NO_WAYNODE_IDS);
    }
    const boxes = tests.map(t => t.box).filter(Boolean);
    const lead = boxes.length ? boxes.reduce((a, b) => ((b.maxX - b.minX) * (b.maxY - b.minY) < (a.maxX - a.minX) * (a.maxY - a.minY) ? b : a)) : null;
    const seen = new Set();
    for (const t of this.store.slots) {
      if (!t.nodeIds) continue;
      const ways = [];
      if (lead) forEachInBox(t, lead, (i) => { if (i >= t.wayStart && i < t.relStart) ways.push(i); });
      else for (let i = t.wayStart; i < t.relStart; i++) ways.push(i);
      ways.sort((a, b) => a - b);
      for (const i of ways) {
        if (!(t.flags[i] & F_NODE_IDS)) continue;
        const k = 4 * (i - t.wayStart);
        if (boxes.some(x => t.bbox[k + 2] < x.minX || t.bbox[k] > x.maxX || t.bbox[k + 3] < x.minY || t.bbox[k + 1] > x.maxY)) continue;
        for (let p = t.ptOff[i]; p < t.ptOff[i + 1]; p++) {
          this.tick();
          const id = t.nodeIds[p];
          if (seen.has(id)) continue;
          seen.add(id);
          const x = t.xy[2 * p], y = t.xy[2 * p + 1];
          if (boxes.some(b => x < b.minX || x > b.maxX || y < b.minY || y > b.maxY)) continue;
          const r = this.nodeRef(t, p);
          if (!isVnode(r)) continue;                     // feature nodes come from the scan
          let ok = true;
          for (const s of tests) if (!s.test(r)) { ok = false; break; }
          if (ok) emit(r);
        }
      }
    }
  }

  spatialTest(flt, ctx) {
    if (flt.kind === 'inArea' || flt.kind === 'areaIds') return this.areaTest(flt, ctx);
    if (flt.kind === 'poly') {                       // (poly:"lat lon …"): outlines touching an even-odd polygon
      const ring = flt.coords.map(([la, lo]) => [xFromLon(lo), yFromLat(la)]);
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
      if (ring.length < 4) return { box: null, test: () => false, empty: true };
      const poly = new PolygonArea([ring]);
      return { box: poly.box, test: (r) => {
        const b = this.box(r);
        if (b && (b.maxX < poly.box.minX || b.minX > poly.box.maxX || b.maxY < poly.box.minY || b.minY > poly.box.maxY)) return false;
        return this.parts(r).some(q => (q.n === 1 && !q.closed ? poly.pointPos(px(q, 0), py(q, 0)) !== OUTSIDE : poly.lineMeets(partPoints(q))));
      } };
    }
    if (flt.kind === 'bbox') {
      const xa = xFromLon(flt.w), xb = xFromLon(flt.e), ya = yFromLat(flt.s), yb = yFromLat(flt.n);
      const box = { minX: Math.min(xa, xb), maxX: Math.max(xa, xb), minY: Math.min(ya, yb), maxY: Math.max(ya, yb) };
      return { box, test: (r) => {
        const b = this.box(r);
        if (b && (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY)) return false;
        for (const q of this.parts(r)) if (partMeetsBox(q, box)) return true;
        return false;
      } };
    }
    return this.aroundTest(flt, ctx);
  }

  aroundTest(flt, ctx) {
    const r = flt.radius;
    // sources (around.py from_filter): the coordinates (one point, or a line), or the set's elements
    // (nodes as points, ways as lines, relations by their node and way members; areas are no sources)
    const pts = [], segs = [];
    const addLine = (line) => { for (let k = 0; k < line.length; k++) { pts.push(line[k]); if (k) segs.push([line[k - 1], line[k]]); } };
    const dec = ([x, y]) => decoded(latFromY(y), lonFromX(x));
    let single = false;
    if (!flt.set) {
      if (flt.coords.length === 1) { pts.push([...flt.coords[0]]); single = r > 0; }
      else addLine(flt.coords.map(([la, lo]) => [la, lo]));
    } else {
      for (const ref of ctx.sets.get(flt.set) ?? []) {
        if (isArea(ref) || isDerived(ref)) continue;
        const ty = this.typeOf(ref);
        if (ty === 0) pts.push(dec(this.point(ref)));
        else if (ty === 1) addLine(partPoints(this.parts(ref)[0]).map(dec));
        else for (const q of this.parts(ref)) { if (q.isNode) pts.push(dec([px(q, 0), py(q, 0)])); else addLine(partPoints(q).map(dec)); }
      }
    }
    if (!pts.length) return { box: null, test: () => false, empty: true };
    // A grid over the sources, cells at least 1.3 r + 50 m wide (one lon factor for the whole grid, from the
    // highest latitude, so cells only get wider in metres). Each candidate point or segment meets only the
    // sources in the cells it covers plus one ring around them: a superset of those that can match.
    const cellDeg = Math.max((r * 1.3 + 50) / 111000, 1e-4);
    const lonK = (la) => Math.max(Math.cos(Math.abs(la) * Math.PI / 180), 0.01);
    let topLat = 0;
    for (const [la] of pts) topLat = Math.max(topLat, Math.abs(la));
    const K = lonK(Math.min(90, topLat + 2 * cellDeg));
    const ca = (la) => Math.floor(la / cellDeg), cb = (lo) => Math.floor(lo * K / cellDeg);
    const CK = 4194304;                                    // |cb| < 1.8e6 for lon within ±180
    const grid = new Map();
    const put = (e, la0, lo0, la1, lo1) => {
      for (let i = ca(la0), i1 = ca(la1); i <= i1; i++) for (let j = cb(lo0), j1 = cb(lo1); j <= j1; j++) {
        const c = i * CK + j; let l = grid.get(c); if (!l) grid.set(c, l = []); l.push(e);
      }
    };
    pts.forEach((p, k) => put(k, p[0], p[1], p[0], p[1]));
    segs.forEach(([a, b], k) => put(-1 - k, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])));
    const pStamp = new Int32Array(pts.length), sStamp = new Int32Array(segs.length);
    let stamp = 0;
    const nearPs = [], nearSs = [];
    /** Is any source in the cells of a lat/lon box or the ring around them? (Yes for boxes of many cells.) */
    const anyNear = (la0, lo0, la1, lo1) => {
      if ((ca(la1) - ca(la0) + 3) * (cb(lo1) - cb(lo0) + 3) > ANY_NEAR_MAX_CELLS) return true;
      for (let i = ca(la0) - 1, i1 = ca(la1) + 1; i <= i1; i++) for (let j = cb(lo0) - 1, j1 = cb(lo1) + 1; j <= j1; j++) {
        if (grid.has(i * CK + j)) return true;
      }
      return false;
    };
    /** Fills nearPs / nearSs with the sources around a lat/lon box. */
    const near = (la0, lo0, la1, lo1) => {
      if (++stamp === 2 ** 31 - 1) { pStamp.fill(0); sStamp.fill(0); stamp = 1; }
      nearPs.length = 0; nearSs.length = 0;
      for (let i = ca(la0) - 1, i1 = ca(la1) + 1; i <= i1; i++) for (let j = cb(lo0) - 1, j1 = cb(lo1) + 1; j <= j1; j++) {
        const l = grid.get(i * CK + j);
        if (l) for (const e of l) {
          if (e >= 0) { if (pStamp[e] !== stamp) { pStamp[e] = stamp; nearPs.push(e); } }
          else if (sStamp[-1 - e] !== stamp) { sStamp[-1 - e] = stamp; nearSs.push(-1 - e); }
        }
      }
    };
    const pcart = pts.map(p => cartesian(p[0], p[1]));
    const scart = segs.map(([a, b]) => [cartesian(a[0], a[1]), cartesian(b[0], b[1])]);
    const snorm = scart.map(([a, b]) => cross(a, b));
    // Mercator prefilter: the sources' box grown by the radius (generously).
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [la, lo] of pts) { minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); }
    const dLat = (r * 1.3 + 50) / 111000, dLon = dLat / Math.max(Math.cos(Math.max(Math.abs(minLat), Math.abs(maxLat)) * Math.PI / 180), 0.01);
    const box = { minX: xFromLon(minLon - dLon), maxX: xFromLon(maxLon + dLon), minY: yFromLat(minLat - dLat), maxY: yFromLat(maxLat + dLat) };

    const nearSegment = (p, a, b) => {
      const lim = Math.sqrt(gcd(a[0], a[1], b[0], b[1]) ** 2 + r * r);
      return gcd(p[0], p[1], a[0], a[1]) <= lim && gcd(p[0], p[1], b[0], b[1]) <= lim;
    };
    const pointInside = (p) => {
      near(p[0], p[1], p[0], p[1]);
      for (const k of nearPs) {
        const q = pts[k];
        if ((r > 0 && gcd(q[0], q[1], p[0], p[1]) <= r) || (Math.abs(q[0] - p[0]) < 1e-7 && Math.abs(q[1] - p[1]) < 1e-7)) return true;
      }
      const c = cartesian(p[0], p[1]);
      for (const j of nearSs) {
        if (lineDistance(snorm[j], c) <= r && nearSegment(p, segs[j][0], segs[j][1])) return true;
      }
      return false;
    };
    const segmentInside = (a, b) => {
      const pa = cartesian(a[0], a[1]), pb = cartesian(b[0], b[1]);
      const norm = cross(pa, pb);
      near(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
      for (const k of nearPs) {
        if (lineDistance(norm, pcart[k]) <= r && nearSegment(pts[k], a, b)) return true;
      }
      for (const j of nearSs) if (segmentsIntersect(scart[j], snorm[j], [pa, pb], norm)) return true;
      return false;
    };
    const lineInside = (line) => line.some(pointInside) || line.slice(1).some((b, k) => segmentInside(line[k], b));
    const asLatLon = (q) => partPoints(q).map(([x, y]) => decoded(latFromY(y), lonFromX(x)));

    return { box, test: (ref) => {
      const b = this.box(ref);
      if (b && (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY)) return false;
      // no source in or around the grid cells of the element's box: nothing of it can be within r
      if (b && !anyNear(latFromY(b.minY), lonFromX(b.minX), latFromY(b.maxY), lonFromX(b.maxX))) return false;
      if (single && this.typeOf(ref) !== 0 && b) {          // around.py _surely_inside
        const c = pts[0];
        const s = latFromY(b.minY), n = latFromY(b.maxY), w = lonFromX(b.minX), e = lonFromX(b.maxX);
        if ([s, n].every(la => [w, e].every(lo => gcd(c[0], c[1], la, lo) <= r * 0.99))) return true;
      }
      for (const q of this.parts(ref)) if (lineInside(asLatLon(q))) return true;
      return false;
    } };
  }

  // ---- recursion (recursion.py)
  /** `(r) (w) (bn) (bw) (br)` filters: canonical refs of the allowed types. */
  relFilter(f, types, ctx) {
    const src = [...(ctx.sets.get(f.set) ?? [])].filter(r => !isArea(r) && !isDerived(r));
    const found = [];
    if (f.rel === 'w') {
      for (const r of src) {
        if (this.typeOf(r) !== 1) continue;
        let nodes = this.wayNodes(r);
        if (f.positions) {
          const n = nodes.length, picked = new Set();
          for (let [a, b] of f.positions) { a = a > 0 ? a : n + a + 1; b = b > 0 ? b : n + b + 1; for (let k = a; k <= b; k++) picked.add(k); }
          nodes = nodes.filter((_, k) => picked.has(k + 1));
        }
        found.push(...nodes);
      }
    } else if (f.rel === 'r') {
      for (const r of src) {
        if (this.typeOf(r) !== 2) continue;
        const t = this.tileOf(r), i = this.indexOf(r), info = { missing: 0 };
        for (const m of this.memberRefs(t, i, info)) if (f.role === null || m.role === f.role) found.push(this.canon(m.ref));
        if (info.missing) ctx.notes.add('Some relation members are in tiles that are not loaded.');
      }
    } else if (f.rel === 'bn') {
      found.push(...this.parentsUnion(src.filter(r => this.typeOf(r) === 0)));
    } else {
      const want = f.rel === 'bw' ? 1 : 2;
      for (const r of src) if (this.typeOf(r) === want) found.push(...this.parentRelations(r));
    }
    const allowed = types.map(t => TYPE_INDEX_OF[t] ?? -1);
    return new Set(found.filter(r => allowed.includes(this.typeOf(r))));
  }
}
