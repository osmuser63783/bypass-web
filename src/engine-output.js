// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: out: elements as Overpass prints them (ids, tags, geometry, center, bounds, clipping, sorting).
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

import { DERIVED, bboxMatcher, clipMemberWay, clipWayPoints, clippedCenterOrBounds, clippedPoint, isDerived, isVnode, lat7, lon7, overpassCenter, partCount, partPoints, px, py, verbatimRelGeom } from './engine-base.js';
import { F_NODE_IDS, TYPES } from './tes.js';
import { NO_WAYNODE_IDS } from './errors.js';
import { calcIndex, calcParents, calcRanges, inU31Ranges, quadtile } from './ovindex.js';
import { latFromY, lonFromX } from './bundle.js';
import * as G from './geometry.js';

export class OutputMethods {

  // ---- output (output.py)
  elementClipped(d, type, ref, o, ctx, full) {
    const dec = ([x, y]) => G.decoded(latFromY(y), lonFromX(x));
    const t = this.tileOf(ref), i = this.indexOf(ref);
    let groups;
    if (type === 1) groups = [clipWayPoints(partPoints(this.ownPart(t, i)).map(dec), o.bbox)];
    else {
      const inside = bboxMatcher(o.bbox);
      const key = o.bbox.join(',');
      this.rangeCache ??= new Map();
      if (!this.rangeCache.has(key)) this.rangeCache.set(key, calcParents(calcRanges(o.bbox[0], o.bbox[2], o.bbox[1], o.bbox[3])));
      const ranges = this.rangeCache.get(key);
      groups = this.memberRefs(t, i).map(m => {
        const mt = this.typeOf(m.ref);
        if (mt === 0) { const p = dec(this.point(m.ref)); return [inside(p) ? p : null]; }
        if (mt === 1) {
          const pts = partPoints(this.parts(m.ref)[0]);
          if (!inU31Ranges(calcIndex(pts.map(([x, y]) => quadtile(latFromY(y), lonFromX(x)))), ranges)) return [];
          return clipMemberWay(pts.map(dec), inside);
        }
        return [];
      });
    }
    if (o.geom === 'geom') {
      const g = type === 1 ? (groups[0].every(p => p) ? new G.Linestring(groups[0]) : new G.PartialWay(groups[0].map(p => p ?? G.INVALID))) : verbatimRelGeom(groups);
      if (g.hasBbox()) d.bounds = { minlat: G.round7(g.south()), minlon: G.round7(g.west()), maxlat: G.round7(g.north()), maxlon: G.round7(g.east()) };
    } else clippedCenterOrBounds(d, type, groups, o);
    if (type === 1) {
      if (full && t.flags[i] & F_NODE_IDS) { const s0 = t.ptOff[i], ids = Array.from(t.nodeIds.subarray(s0, t.ptOff[i + 1])); d.nodes = t.isArea(i) && ids.length ? [...ids, ids[0]] : ids; }
      if (o.geom === 'geom') d.geometry = groups[0].map(clippedPoint);
    } else if (full) {
      const ms = this.memberRefs(t, i);
      d.members = ms.map((m, k) => {
        const mt = this.typeOf(m.ref), grp = groups[k];
        const md = { type: TYPES[mt], ref: this.idOf(m.ref), role: m.role };
        if (o.geom === 'geom') {
          if (mt === 0) { if (grp.length && grp[0]) { md.lat = G.round7(grp[0][0]); md.lon = G.round7(grp[0][1]); } }
          else if (mt === 1) md.geometry = grp.map(clippedPoint);
        }
        return md;
      });
    }
    return d;
  }

  /** Overpass's storage index (nodes: quadtile; ways and relations: calc_index of their nodes). */
  ovidx(r) {
    let v = this.idxCache.get(r);
    if (v !== undefined) return v;
    const type = this.typeOf(r);
    if (type === 0) { const [x, y] = this.point(r); v = quadtile(latFromY(y), lonFromX(x)); }
    else if (type === 1) v = calcIndex(partPoints(this.parts(r)[0]).map(([x, y]) => quadtile(latFromY(y), lonFromX(x))));
    else {
      const t = this.tileOf(r), i = this.indexOf(r);
      v = calcIndex(this.memberRefs(t, i).filter(m => this.typeOf(m.ref) !== 2).map(m => this.ovidx(m.ref)));
    }
    this.idxCache.set(r, v);
    return v;
  }

  out(o, set, ctx) {
    if (o.count) {
      const c = [0, 0, 0, 0, 0];
      for (const r of set) c[this.typeOf(r)]++;
      const tags = { nodes: String(c[0]), ways: String(c[1]), relations: String(c[2]) };
      if (c[3] || ctx.usedAreas) tags.areas = String(c[3]);
      tags.total = String(c[0] + c[1] + c[2] + c[3]);
      ctx.result.elements.push(o.ids ? { type: 'count', id: 0, tags } : { type: 'count', tags });
      return;
    }
    let refs;
    if (o.sort === 'qt') refs = this.storageOrder(set);
    else {                                          // by type, then id (deriveds by their own id, then creation)
      refs = [...set].map(r => (isDerived(r) ? [4, this.idOf(r), r - DERIVED, r] : [this.typeOf(r), 0, this.idOf(r), r]))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map(x => x[3]);
    }
    if (o.limit !== null) refs = refs.slice(0, o.limit);
    for (const r of refs) ctx.result.elements.push(this.element(r, o, ctx));
  }

  element(ref, o, ctx) {
    if (isDerived(ref)) {                           // output.py _derived_element
      const dv = this.derivedOf(ref);
      const d = { type: dv.type, id: dv.id };
      if (!o.ids) delete d.id;
      if (dv.geom && o.geom) {
        const gj = G.derivedGeometry(dv.geom, o.geom);
        if (gj) { d.geometry = gj; Object.defineProperty(d, '_geom', { value: [dv.geom, o.geom], enumerable: false }); }
      }
      if (o.verbosity !== 'ids' && dv.tags.size) d.tags = Object.fromEntries(dv.tags);
      return d;
    }
    const type = this.typeOf(ref);
    const d = { type: this.typeName(ref), id: this.idOf(ref) };
    if (!o.ids) delete d.id;
    const addTags = () => {
      if (o.verbosity === 'body' || o.verbosity === 'tags') {
        const tags = this.tagsOrNull(ref);
        if (tags) d.tags = tags;
      }
      return d;
    };
    if (o.verbosity === 'ids' && !o.geom) return d;
    if (type === 3) return addTags();
    const full = o.verbosity === 'body' || o.verbosity === 'skel';
    const latlon = (q) => partPoints(q).map(([x, y]) => ({ lat: lat7(y), lon: lon7(x) }));
    if (type === 0) {
      if (full || o.geom) { const [x, y] = this.point(ref); d.lat = lat7(y); d.lon = lon7(x); }
      if (isVnode(ref)) return d;
      return addTags();
    }
    const t = this.tileOf(ref), i = this.indexOf(ref);
    if (o.bbox && o.geom) return addTags(this.elementClipped(d, type, ref, o, ctx, full));
    if (full || o.geom) {
      const parts = this.parts(ref);
      if (parts.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const q of parts) for (let k = 0, c = partCount(q); k < c; k++) {
          const x = px(q, k), y = py(q, k);
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const s = lat7(minY), w = lon7(minX), n = lat7(maxY), e = lon7(maxX);
        if (o.geom === 'center') d.center = overpassCenter(s, w, n, e);
        if (o.geom === 'bb' || o.geom === 'geom') d.bounds = { minlat: s, minlon: w, maxlat: n, maxlon: e };
      }
    }
    if (type === 1) {
      if (full) {
        if (t.flags[i] & F_NODE_IDS) {
          const s0 = t.ptOff[i], ids = Array.from(t.nodeIds.subarray(s0, t.ptOff[i + 1]));
          d.nodes = t.isArea(i) && ids.length ? [...ids, ids[0]] : ids;
        } else if (o.geom !== 'geom') ctx.notes.add("Way 'nodes' lists omitted. " + NO_WAYNODE_IDS);
      }
      if (o.geom === 'geom') d.geometry = latlon(this.ownPart(t, i));
    } else if (full) {
      d.members = [];
      const info = { missing: 0 };
      for (const m of this.memberRefs(t, i, info)) {
        const mt = this.tileOf(m.ref), mi = this.indexOf(m.ref), mtype = mt.typeOf(mi);
        const md = { type: TYPES[mtype], ref: mt.ids[mi], role: m.role };
        if (o.geom === 'geom') {
          if (mtype === 0) { md.lat = lat7(mt.y(mi)); md.lon = lon7(mt.x(mi)); }
          else if (mtype === 1) md.geometry = latlon(this.ownPart(mt, mi));
        }
        d.members.push(md);
      }
      if (info.missing) ctx.notes.add('Some relation members are in tiles that are not loaded.');
    }
    return addTags();
  }
}
