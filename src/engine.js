// SPDX-License-Identifier: AGPL-3.0-or-later
// The Overpass QL engine over decoded bundle tiles (TileStore). This file holds the Engine core (access to
// features, running statements); the parser is parse.js, shared helpers engine-base.js, and the methods by topic
// engine-query.js, engine-areas.js, engine-recurse.js, engine-make.js and engine-output.js.
// Statements: queries (tag filters, bbox,
// around, IDs, input sets, recursion filters, areas), unions, item statements (`.a;`), recursion
// (> >> < <<), is_in, map_to_area, and out (ids/skel/body/tags, center/bb/geom, count, asc/qt, limit).
// Semantics follow Bypass Server, the Python engine used as the oracle: spatial filters
// use outlines (points, way segments, relation node/way members), around is Overpass's great-circle test
// (osm_bypass/around.py), recursion is osm_bypass/recursion.py, areas osm_bypass/areas.py + area_tests.py,
// queries osm_bypass/query.py, output osm_bypass/output.py.

import { AREA, COPYRIGHT, DERIVED, REL_AREA_OFFSET, SLOT, VNODE, WAY_AREA_OFFSET, isArea, isDerived, isVnode } from './engine-base.js';
import { F_NODE_IDS, TYPES } from './tes.js';
import { NO_WAYNODE_IDS, RuntimeQLError, Unsupported, Incomplete } from './errors.js';
import { cpCompare } from './text.js';
import { evaluate, truthy } from './expr.js';
import { latFromY, lonFromX } from './bundle.js';
import { localize } from './localize.js';
import { parse } from './parse.js';
import { QueryMethods } from './engine-query.js';
import { AreaMethods } from './engine-areas.js';
import { RecurseMethods } from './engine-recurse.js';
import { MakeMethods } from './engine-make.js';
import { OutputMethods } from './engine-output.js';
export { Unsupported, Incomplete, RuntimeQLError, WAY_AREA_OFFSET, REL_AREA_OFFSET, parse };

// Overpass's statement names (each statement's get_name()), which its runtime errors quote (engine.py)
const STATEMENT_NAMES = { query: 'query', union: 'union', recurse: 'recurse', copy: 'item', foreach: 'foreach', for: 'for',
  if: 'if', complete: 'complete', is_in: 'coord-query', map_to_area: 'map-to-area', out: 'print', local: 'localize' };

export class Engine {
  constructor(store) {
    this.store = store; this.version = -1; this.deadline = Infinity; this.ticks = 0; this.maxTimeout = Infinity;
    this.dataTime = null;     // the OSM data's time (2026-11-09T21:22:17Z), set by whoever opened the bundle:
  }                           // Overpass's timestamp_osm_base (engine.py data_time)

  /** Cooperative [timeout:] check (engine.py _tick): cheap enough for hot loops. */
  tick() {
    if (++this.ticks < 20000) return;
    this.check();
  }

  /** The clock read of tick(), now (engine.py check): also before every statement, so a foreach whose
   *  body takes milliseconds per element can't run minutes past its [timeout:]. */
  check() {
    this.ticks = 0;
    if (performance.now() > this.deadline) throw this.timedOut();
  }

  /** The timeout, naming the statement and line it stopped in (engine.py _timed_out): the remark is
   *  Overpass's sentence with the seconds it ran, the message also names the limit that applied. */
  timedOut() {
    const where = this.where();
    const ran = Math.max(1, Math.round((performance.now() - this.started) / 1000));
    const setting = this.timeoutGiven ? `the query's [timeout:${this.timeoutSeconds}]` : "Overpass's default [timeout:], 180 s";
    return new RuntimeQLError(`runtime error: Query timed out${where} after ${this.timeoutSeconds} seconds (${setting}).`,
                              `runtime error: Query timed out${where} after ${ran} seconds.`);
  }

  /** ` in "query" at line 3`: the running statement as Overpass names it (engine.py _where). */
  where() {
    const s = this.current;
    if (!s) return '';
    const name = s.kind === 'make' ? s.make : s.kind === 'union' && s.items.some(x => x.sign === '-') ? 'difference'
      : STATEMENT_NAMES[s.kind] ?? 'query';
    return ` in "${name}" at line ${s.line ?? 1}`;
  }

  /** Caches that depend on the loaded tiles (reset when tiles were added). */
  sync() {
    if (this.version === this.store.slots.length) return;
    this.version = this.store.slots.length;
    this.vnodes = new Map();          // node ID -> canonical VNODE ref
    this.hasAreaCache = new Map();    // relation ref -> has an Overpass area
    this.polyCache = new Map();       // relation/way ref -> PolygonArea | null
    this.ringCache = new Map();       // way ref -> ClosedWayArea | null
    this.idxCache = new Map();        // ref -> Overpass storage index
    this.isInCache = new Map();       // "x,y" -> is_in result for that point
  }

  // ---- reference helpers
  tileOf(r) { return this.store.slots[Math.floor((isArea(r) ? r - AREA : isVnode(r) ? r - VNODE : r) / SLOT)]; }
  indexOf(r) { return (isArea(r) ? r - AREA : isVnode(r) ? r - VNODE : r) % SLOT; }
  base(r) { return isArea(r) ? r - AREA : r; }
  derivedOf(r) { return this.derived[r - DERIVED]; }
  typeOf(r) { return isDerived(r) ? 4 : isArea(r) ? 3 : isVnode(r) ? 0 : this.tileOf(r).typeOf(this.indexOf(r)); }
  typeName(r) { return isDerived(r) ? this.derivedOf(r).type : isArea(r) ? 'area' : TYPES[this.typeOf(r)]; }
  idOf(r) {
    if (isDerived(r)) return this.derivedOf(r).id;
    const t = this.tileOf(r), i = this.indexOf(r);
    if (isVnode(r)) return t.nodeIds[i];
    if (isArea(r)) return (t.typeOf(i) === 1 ? WAY_AREA_OFFSET : REL_AREA_OFFSET) + t.ids[i];
    return t.ids[i];
  }
  tags(r) { if (isDerived(r)) return [...this.derivedOf(r).tags]; if (isVnode(r)) return []; const b = this.base(r); return this.tileOf(b).tags(this.indexOf(b)); }
  tag(r, k) { return this.tags(r).find(([kk]) => kk === k)?.[1]; }

  /** The canonical ref of a node at point p of a way in tile t: the feature node, else one VNODE per ID. */
  nodeRef(t, p) {
    const id = t.nodeIds[p];
    const f = this.store.find(0, id);
    if (f >= 0) return f;
    let v = this.vnodes.get(id);
    if (v === undefined) { v = VNODE + t.slot * SLOT + p; this.vnodes.set(id, v); }
    return v;
  }
  /** The canonical copy of a reference (members may point at a copy in any tile). */
  canon(r) {
    if (isVnode(r) || isDerived(r)) return r;
    if (isArea(r)) return AREA + this.canon(r - AREA);
    const c = this.store.canonical(r);
    return c >= 0 ? c : r;
  }

  /** [x, y] of a node (feature or untagged way node). */
  point(r) {
    const t = this.tileOf(r), i = this.indexOf(r);
    return isVnode(r) ? [t.xy[2 * i], t.xy[2 * i + 1]] : [t.x(i), t.y(i)];
  }
  ownPart(t, i) {
    const s = t.ptOff[i], n = t.ptOff[i + 1] - s;
    return { xy: t.xy, s, n, closed: i >= t.wayStart && t.isArea(i), isNode: i < t.wayStart };
  }
  /** Outline parts for spatial tests and bounds: a node's point, a way's line, a relation's node and way members. */
  parts(r) {
    if (isVnode(r)) { const t = this.tileOf(r); return [{ xy: t.xy, s: this.indexOf(r), n: 1, closed: false, isNode: true }]; }
    const b = this.base(r), t = this.tileOf(b), i = this.indexOf(b);
    if (t.typeOf(i) < 2) return [this.ownPart(t, i)];
    const out = [];
    for (const m of this.memberRefs(t, i)) {
      const mt = this.tileOf(m.ref), mi = this.indexOf(m.ref);
      if (mt.typeOf(mi) < 2) out.push(this.ownPart(mt, mi));
    }
    return out;
  }
  /** Bounding box in Mercator (null for a relation without stored bounds). */
  box(r) {
    if (isVnode(r)) { const [x, y] = this.point(r); return { minX: x, minY: y, maxX: x, maxY: y }; }
    const b = this.base(r), t = this.tileOf(b), i = this.indexOf(b);
    if (i < t.wayStart) {
      if (t.ptOff[i + 1] === t.ptOff[i]) return null;
      const x = t.x(i), y = t.y(i);
      return { minX: x, minY: y, maxX: x, maxY: y };
    }
    const k = 4 * (i - t.wayStart), bb = t.bbox;
    return { minX: bb[k], minY: bb[k + 1], maxX: bb[k + 2], maxY: bb[k + 3] };
  }
  /** Members of relation i in tile t: [{ ref, role }] for the loaded ones; `missing` counts the others. */
  memberRefs(t, i, info) {
    const out = [];
    for (let r = t.refOff[i], end = t.refOff[i + 1]; r < end; r++) {
      const m = this.store.resolve(t, t.refs[3 * r], t.refs[3 * r + 1]);
      if (m < 0) { if (info) info.missing++; continue; }
      out.push({ ref: m, role: t.role(t.refs[3 * r + 2]) });
    }
    return out;
  }
  /** Parent relations (canonical refs) of a feature. */
  parentRelations(r) {
    if (isVnode(r) || isArea(r)) return [];
    const t = this.tileOf(r), i = this.indexOf(r), pt = t.parTab[i], out = [];
    if (pt < 0) return out;
    for (let k = t.parOff[pt]; k < t.parOff[pt + 1]; k++) {
      const p = this.store.resolve(t, t.parRefs[2 * k], t.parRefs[2 * k + 1]);
      if (p >= 0) out.push(this.canon(p));
    }
    return out;
  }
  /** The nodes of a way (canonical refs, closing node included), which needs way-node IDs. */
  wayNodes(r) {
    if (!this.store.bundle.header.wayNodeIds) {
      throw new Unsupported('Recursing from ways to their nodes needs way-node IDs. ' + NO_WAYNODE_IDS);
    }
    const t = this.tileOf(r), i = this.indexOf(r), s = t.ptOff[i], e = t.ptOff[i + 1], out = [];
    if (!(t.flags[i] & F_NODE_IDS)) return out;
    for (let p = s; p < e; p++) out.push(this.nodeRef(t, p));
    if (t.isArea(i) && e > s) out.push(out[0]);
    return out;
  }
  /** way_is_closed: first and last node the same (by ID, else by coordinates). */
  wayIsClosed(r) {
    const t = this.tileOf(r), i = this.indexOf(r), s = t.ptOff[i], e = t.ptOff[i + 1];
    if (e <= s) return false;
    if (t.isArea(i)) return true;                        // stored without the closing point
    if (t.flags[i] & F_NODE_IDS && t.nodeIds[s] && t.nodeIds[e - 1]) return t.nodeIds[s] === t.nodeIds[e - 1];
    return t.xy[2 * s] === t.xy[2 * (e - 1)] && t.xy[2 * s + 1] === t.xy[2 * (e - 1) + 1];
  }
  /** [w, s, e, n] in degrees of a feature's bounds. */
  wsen(r) {
    const b = this.box(r);
    return b ? [lonFromX(b.minX), latFromY(b.minY), lonFromX(b.maxX), latFromY(b.maxY)] : null;
  }

  // ---- running a program
  run(src) {
    this.sync();
    const { settings, statements } = parse(src);
    const t = Number(settings.timeout);
    this.timeoutGiven = Number.isFinite(t) && t > 0;     // engine.py's message names the limit that applied
    this.timeoutSeconds = Math.min(this.timeoutGiven ? t : 180, this.maxTimeout);
    this.started = performance.now();
    this.deadline = this.started + this.timeoutSeconds * 1000;
    this.ticks = 0;
    this.current = null;
    this.derived = [];
    const ctx = { sets: new Map([['_', new Set()]]), bbox: settings.bbox ?? null, usedAreas: false, val: '', forvals: new Map(), derivedIds: 0,
      result: { version: 0.6, generator: 'osm-bypass browser', osm3s: null, elements: [] }, notes: new Set() };
    try {
      for (const s of statements) this.exec(s, ctx);
    } catch (e) {
      if (e instanceof RuntimeQLError) { e.result = this.answer(ctx, settings); e.result.remark = e.overpass; }   // as Overpass keeps it
      throw e;
    }
    return this.answer(ctx, settings);
  }

  /** The result of what the query has printed (engine.py _answer). */
  answer(ctx, settings) {
    ctx.result.osm3s = this.osm3s(ctx);
    if (ctx.notes.size) ctx.result.bypass = { notes: [...ctx.notes] };
    Object.defineProperty(ctx.result, 'settings', { value: settings, enumerable: false, configurable: true });   // for render.js
    return ctx.result;
  }

  /** Overpass's osm3s block (output_json.cc): the data's time, the areas' time when the query used areas (built
   *  here from the same data, so the same time), then the copyright. Without a known time both are left out. */
  osm3s(ctx) {
    const out = {};
    if (this.dataTime) {
      out.timestamp_osm_base = this.dataTime;
      if (ctx.usedAreas) out.timestamp_areas_base = this.dataTime;
    }
    out.copyright = COPYRIGHT;
    return out;
  }

  /** sets(name) -> [element views in Overpass's set order, its loop value] for expressions (context.py
   *  resolver): `a.gcat()` concatenates in that order. Cached per set while it's unchanged. */
  resolver(ctx) {
    ctx.ordered ??= new Map();
    return (name) => {
      const set = ctx.sets.get(name) ?? new Set();
      let hit = ctx.ordered.get(name);
      if (!hit || hit.set !== set || hit.size !== set.size) {
        hit = { set, size: set.size, views: this.storageOrder(set).map(r => this.elem(r)) };
        ctx.ordered.set(name, hit);
      }
      return [hit.views, ctx.forvals.get(name) ?? (name === '_' ? ctx.val : '')];
    };
  }

  /** Overpass's internal set order: by type, then storage index, then id (engine.py _storage_order). */
  storageOrder(set) {
    return [...set].map(r => {
      const ty = this.typeOf(r), id = this.idOf(r);
      if (ty === 4) return [ty, 0, 0, r - DERIVED + 1, r];
      if (ty === 3) return [ty, 0, 0, id, r];
      const v = this.ovidx(r);
      return [ty, ty !== 0 ? (v & 0x7fffffff) : v, v, id, r];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]).map(x => x[4]);
  }

  exec(s, ctx) {
    const outer = this.current;
    this.current = s;
    try { this.execStatement(s, ctx); } finally { this.current = outer; }
  }

  execStatement(s, ctx) {
    this.check();
    const { sets } = ctx;
    switch (s.kind) {
      case 'union': {                                // items run in turn, each writing its set; '-' removes
        const acc = new Set();
        for (const { sign, st } of s.items) {
          this.exec(st, ctx);
          const res = sets.get(st.kind === 'out' || st.kind === 'if' ? '_' : st.into ?? '_') ?? new Set();   // make writes `into` too
          if (sign === '+') for (const r of res) acc.add(r); else for (const r of res) acc.delete(r);
        }
        sets.set(s.into, acc);
        break;
      }
      case 'foreach': {                              // foreach.cc: one element at a time, in storage order
        for (const r of this.storageOrder(sets.get(s.from) ?? new Set())) {
          this.tick();
          sets.set(s.into, new Set([r]));
          for (const sub of s.body) this.exec(sub, ctx);
        }
        sets.set(s.into, new Set());
        break;
      }
      case 'for': {                                  // for.cc: one group per value of the key, values ordered as strings
        const groups = new Map();
        const items = [...(sets.get(s.from) ?? [])].map(r => [this.typeOf(r), isDerived(r) ? r - DERIVED + 1 : this.idOf(r), r]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const byKeys = s.key[0] === 'call' && s.key[1] === 'keys';
        const resolve = this.resolver(ctx);
        for (const [, , r] of items) {
          const el = this.elem(r);
          const values = byKeys ? Object.keys(el.tags()) : [evaluate(s.key, el, null, '', resolve)];
          for (const v of values) { if (!groups.has(v)) groups.set(v, new Set()); groups.get(v).add(r); }
        }
        sets.set(s.into, new Set());
        for (const v of [...groups.keys()].sort(cpCompare)) {
          sets.set(s.into, groups.get(v));
          ctx.forvals.set(s.into, v);
          if (s.into === '_') ctx.val = v;
          for (const sub of s.body) this.exec(sub, ctx);
        }
        sets.set(s.into, new Set());
        ctx.val = '';
        break;
      }
      case 'if': {                                   // bare aggregates count `_`
        const group = [...(sets.get('_') ?? [])].map(r => this.elem(r));
        const cond = evaluate(s.cond, null, group, ctx.val, this.resolver(ctx));
        for (const sub of truthy(cond) ? s.then : s.orelse) this.exec(sub, ctx);
        break;
      }
      case 'make': sets.set(s.into, this.make(s, ctx)); break;
      case 'local': sets.set(s.into, localize(this, s, ctx)); break;
      case 'complete': {                             // complete.cc: repeat until the input set stops growing
        const acc = new Set(sets.get(s.from) ?? []);
        for (let k = 0; k <= s.maxnum; k++) {
          sets.set(s.into, new Set(acc));
          for (const sub of s.body) this.exec(sub, ctx);
          const before = acc.size;
          for (const r of sets.get(s.from) ?? []) acc.add(r);
          if (acc.size === before) break;
        }
        sets.set(s.into, acc);
        break;
      }
      case 'query': sets.set(s.into, this.query(s, ctx)); break;
      case 'copy': sets.set(s.into, new Set(sets.get(s.from) ?? [])); break;
      case 'recurse': sets.set(s.into, this.recurse(s.op, sets.get(s.from) ?? new Set(), ctx)); break;
      case 'is_in': sets.set(s.into, this.isIn(s, ctx)); break;
      case 'map_to_area': sets.set(s.into, this.mapToArea(sets.get(s.from) ?? new Set(), ctx)); break;
      case 'out': this.out(s, sets.get(s.from) ?? new Set(), ctx); break;
    }
  }
}

// The methods of each topic file become Engine methods (same names, `this` is the Engine).
for (const topic of [QueryMethods, AreaMethods, RecurseMethods, MakeMethods, OutputMethods]) {
  for (const name of Object.getOwnPropertyNames(topic.prototype)) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(Engine.prototype, name)) throw new Error(`Engine.${name} is defined twice`);
    Object.defineProperty(Engine.prototype, name, Object.getOwnPropertyDescriptor(topic.prototype, name));
  }
}
