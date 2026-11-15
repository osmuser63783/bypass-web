// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: make and convert: derived objects and what their expressions read from elements.
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

import { DERIVED, decoded, isArea, isDerived, isVnode, partPoints } from './engine-base.js';
import { F_NODE_IDS, TYPES } from './tes.js';
import { cpCompare } from './text.js';
import { bindKey, evaluate, truthy, tryInt64 } from './expr.js';
import { latFromY, lonFromX } from './bundle.js';
import * as G from './geometry.js';

export class MakeMethods {

  // ---- make / convert (engine.py _make, _derive)
  make(st, ctx) {
    const items = ctx.sets.get(st.from) ?? new Set();
    const orderMatters = st.make === 'convert' || JSON.stringify(st.assigns).includes('"gcat"');
    const src = orderMatters ? this.storageOrder(items) : [...items];
    const out = new Set();
    if (st.make === 'convert') for (const r of src) { const el = this.elem(r); this.derive(st, el, null, el.tags(), ctx, out); }
    else this.derive(st, null, src.map(r => this.elem(r)), {}, ctx, out);
    return out;
  }
  derive(st, el, group, base, ctx, out) {
    const declared = new Set(st.assigns.filter(a => !a.key.startsWith('::')).map(a => a.key));
    const resolve = this.resolver(ctx);
    const ev = (expr) => evaluate(expr, el, group, ctx.val, resolve);
    const tags = new Map();
    let id = null, geom = null;
    for (const a of st.assigns) {
      if (a.key === '::=') {                         // every key, sorted, minus the declared ones
        for (const k of this.genericKeys(a.keysFrom, base, ctx)) if (!declared.has(k)) tags.set(k, ev(bindKey(a.expr, k)));
      }
      else if (a.expr === null || a.expr === undefined) continue;
      else if (a.key === '::id') { const v = tryInt64(ev(a.expr)); id = v === null ? null : Number(v); }
      else if (a.key === '::geom') geom = ev(a.expr);
      else tags.set(a.key, ev(bindKey(a.expr, a.key)));
    }
    if (id === null) id = ++ctx.derivedIds;            // dispense_derived_id(): one global 1, 2, 3, ...
    this.derived.push({ type: st.type, id, tags, geom });
    out.add(DERIVED + this.derived.length - 1);
  }
  /** set_prop.cc: `::=` takes the element's keys, `set::=` the keys of every element in the set. */
  genericKeys(keysFrom, base, ctx) {
    if (keysFrom === null || keysFrom === undefined) return Object.keys(base).sort(cpCompare);
    const keys = new Set();
    for (const r of ctx.sets.get(keysFrom) ?? []) for (const k of Object.keys(this.elem(r).tags())) keys.add(k);
    return [...keys].sort(cpCompare);
  }
  /** A derived element made elsewhere (local): { d, ref } with the next derived id. */
  addDerived(ctx, type, tags, geom) {
    const d = { type, id: ++ctx.derivedIds, tags, geom };
    this.derived.push(d);
    return { d, ref: DERIVED + this.derived.length - 1 };
  }
  isFeatureRef(r) { return !isDerived(r) && !isArea(r); }
  /** derived.set[...](if: ...): make/convert results filtered by tags and expressions (query.py _query_derived). */
  derivedQuery(q, ctx) {
    if (q.filters.some(f => f.kind === 'ids')) throw new SyntaxError('static error: For the attribute "type" of the element "id-query" the only allowed values are "node", "way", "relation", or "area".');
    if (q.filters.some(f => ['bbox', 'around', 'inArea', 'areaIds', 'poly'].includes(f.kind)) || !q.inputs.length) return new Set();
    const pools = q.inputs.map(n => ctx.sets.get(n) ?? new Set());
    const resolve = this.resolver(ctx);
    const out = new Set();
    for (const r of pools[0]) {
      if (!isDerived(r) || !pools.every(p => p.has(r))) continue;
      const el = this.elem(r);
      const ok = q.filters.every(f => {
        if (f.kind === 'if') return truthy(evaluate(f.ast, el, null, '', resolve));
        if (f.kind === 'likelike') return Object.entries(el.tags()).some(([k, v]) => f.kre.test(k) && f.vre.test(v));
        const v = el.tag(f.key);
        switch (f.kind) {
          case 'key': return v !== undefined;
          case 'nokey': return v === undefined;
          case 'eq': return v === f.value;
          case 'ne': return v !== f.value;
          case 're': return v !== undefined && f.re.test(v);
          case 'nre': return v === undefined || !f.re.test(v);
        }
        return true;
      });
      if (ok) out.add(r);
    }
    return out;
  }

  // ---- the evaluator's view of a set member (elements.py FeatureElem / AreaElem, Derived)
  elem(ref) {
    const e = this;
    const geodesk = (k) => k.startsWith('geodesk:');
    if (isDerived(ref)) {
      const d = this.derivedOf(ref);
      const geometry = () => d.geom ?? new G.Null();
      return { tag: (k) => d.tags.get(k), tags: () => Object.fromEntries(d.tags), members: () => [], etype: () => d.type,
        countTags: () => d.tags.size, angle: () => '', geometry,
        meta: (name) => {
          if (['pos', 'mtype', 'ref', 'role', 'angle'].includes(name)) return '';
          if (name === 'lat' || name === 'lon') { const g = geometry(); return g.hasCenter() ? (name === 'lat' ? g.centerLat() : g.centerLon()).toFixed(7) : 'NaN'; }
          return { length: '0', is_closed: 'NaW', type: d.type, id: String(d.id) }[name] ?? 'NaN';
        } };
    }
    if (isArea(ref)) {
      const areaId = this.idOf(ref);
      return { tag: (k) => (geodesk(k) ? undefined : e.tag(ref, k)), tags: () => e.tagObject(ref), members: () => [],
        etype: () => 'area', countTags: () => Object.keys(e.tagObject(ref)).length, angle: () => '', geometry: () => new G.Null(),
        meta: (name) => (['pos', 'mtype', 'ref', 'role', 'angle'].includes(name) ? '' :
          { type: 'area', id: String(areaId), length: '0', lat: 'NaN', lon: 'NaN', is_closed: 'NaW', count_members: '0', count_distinct_members: '0' }[name] ?? 'NaN') };
    }
    const type = this.typeOf(ref);
    let geom = null;
    const geometry = () => geom ??= this.featureGeometry(ref);
    return {
      tag: (k) => (geodesk(k) ? undefined : e.tag(ref, k)),
      tags: () => e.tagObject(ref),
      etype: () => TYPES[type],
      countTags: () => Object.keys(e.tagObject(ref)).length,
      members: () => e.evalMembers(ref),
      angle: (pos) => e.angle(ref, pos, geometry()),
      geometry,
      meta: (name) => {
        if (['pos', 'mtype', 'ref', 'role', 'angle'].includes(name)) return '';
        if (name === 'lat' || name === 'lon') {
          const g = geometry();
          if (!g.hasCenter()) return 'NaN';
          return (name === 'lat' ? g.centerLat() : g.centerLon()).toFixed(7);
        }
        if (name === 'type') return TYPES[type];
        if (name === 'id') return String(e.idOf(ref));
        if (name === 'length') return type === 0 ? '0' : G.length(geometry()).toFixed(3);
        if (name === 'is_closed') return type === 1 ? (e.wayIsClosed(ref) ? '1' : '0') : 'NaW';
        if (name === 'count_members') return type === 0 ? '0' : String(e.evalMembers(ref).length);
        if (name === 'count_distinct_members') {
          if (type === 0) return '0';
          return String(new Set(e.evalMembers(ref, true).map(m => m.join('/'))).size);
        }
        return 'NaN';
      },
    };
  }
  /** feature_geometry: a node's point, a way's line, a relation's components (decoded 1e-7 coordinates). */
  featureGeometry(r) {
    const dec = ([x, y]) => decoded(latFromY(y), lonFromX(x));
    const type = this.typeOf(r);
    if (type === 0) { const [la, lo] = dec(this.point(r)); return new G.Point(la, lo); }
    if (type === 1) return new G.Linestring(partPoints(this.parts(r)[0]).map(dec));
    const t = this.tileOf(r), i = this.indexOf(r);
    return new G.Compound(this.memberRefs(t, i).map(m => {
      const mt = this.typeOf(m.ref);
      if (mt === 0) { const [la, lo] = dec(this.point(m.ref)); return new G.Point(la, lo); }
      if (mt === 1) return new G.Linestring(partPoints(this.parts(m.ref)[0]).map(dec));
      return new G.Null();
    }));
  }
  tagObject(r) { return this.tagsOrNull(r) ?? {}; }
  /** Tags as an object (geodesk:* keys left out), null when there are none. */
  tagsOrNull(r) {
    if (isDerived(r) || isVnode(r)) { const o = Object.fromEntries(this.tags(r)); return Object.keys(o).length ? o : null; }
    const b = this.base(r);
    return this.tileOf(b).tagObject(this.indexOf(b));
  }
  /** [[type, id, role]]: a way's nodes (closing node included; id 0 without way-node IDs), or a relation's members.
   *  distinct: nodes also carry their coordinates, as count_distinct_members compares them. */
  evalMembers(r, distinct = false) {
    if (isVnode(r)) return [];
    const t = this.tileOf(r), i = this.indexOf(r), type = t.typeOf(i);
    if (type === 1) {
      const out = [], s = t.ptOff[i], e = t.ptOff[i + 1];
      const ids = t.flags[i] & F_NODE_IDS;
      for (let p = s; p < e; p++) out.push(['node', ids ? t.nodeIds[p] : 0, '', ...(distinct ? [t.xy[2 * p], t.xy[2 * p + 1]] : [])]);
      if (t.isArea(i) && out.length) out.push(out[0]);
      return out;
    }
    if (type !== 2) return [];
    return this.memberRefs(t, i).map(m => {
      const mt = this.typeOf(m.ref);
      const base = [TYPES[mt], this.idOf(m.ref), m.role];
      if (distinct) return mt === 0 ? [TYPES[mt], this.idOf(m.ref), ...this.point(m.ref)] : [TYPES[mt], this.idOf(m.ref)];
      return base;
    });
  }
  /** Angle_Eval_Task (per_member.cc) at vertex pos of a way. */
  angle(r, pos, g) {
    if (this.typeOf(r) !== 1 || !g.hasLineGeometry()) return '';
    const pts = g.line(), n = pts.length;
    if (!(pos + 1 < n || this.wayIsClosed(r))) return '';
    if (pos === 0) return '';
    const D = Math.acos(0) / 90;
    const cart = (p) => { const c = Math.cos(p[0] * D); return [Math.sin(p[0] * D), c * Math.sin(p[1] * D), c * Math.cos(p[1] * D)]; };
    const prev = cart(pts[pos - 1]), mid = cart(pts[pos]), nxt = cart(pos + 1 < n ? pts[pos + 1] : pts[1]);
    const i_ = [mid[1] * prev[2] - mid[2] * prev[1], mid[2] * prev[0] - mid[0] * prev[2], mid[0] * prev[1] - mid[1] * prev[0]];
    const o_ = [nxt[1] * mid[2] - nxt[2] * mid[1], nxt[2] * mid[0] - nxt[0] * mid[2], nxt[0] * mid[1] - nxt[1] * mid[0]];
    const li = Math.hypot(...i_), lo = Math.hypot(...o_);
    if (li < 1e-10 || lo < 1e-10) return 'NaN';
    const prod = (i_[0] * o_[0] + i_[1] * o_[1] + i_[2] * o_[2]) / li / lo;
    const cw = (mid[0] - prev[0]) * o_[0] + (mid[1] - prev[1]) * o_[1] + (mid[2] - prev[2]) * o_[2];
    if (Math.abs(prod) > 1) return '0.000';
    const v = Math.acos(prod) / Math.acos(0) * 90, neg = cw < 0 || Object.is(cw, -0);   // math.copysign(v, cw)
    return neg && v === 0 ? '-0.000' : (neg ? -v : v).toFixed(3);
  }
}
