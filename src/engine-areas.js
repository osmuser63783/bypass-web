// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: Areas: which features make Overpass areas, the area test, is_in and map_to_area.
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

import { AREA, REL_AREA_OFFSET, SLOT, WAY_AREA_OFFSET, ipoint, isArea, isDerived, isVnode, partPoints, px, py } from './engine-base.js';
import { BORDER, ClosedWayArea, OUTSIDE, PolygonArea, assembleRings } from './areas.js';
import { F_DUPLICATE, F_NODE_IDS } from './tes.js';
import { Incomplete } from './errors.js';
import { forEachInBox } from './spatial.js';
import { xFromLon, yFromLat } from './bundle.js';

export class AreaMethods {

  // ---- areas (areas.py)
  /** rules/areas.osm3s: which relations Overpass builds an area for (and whose member ways close into rings). */
  /** Tags Overpass builds an area for (areas.py area_tags), whether or not the rings close. */
  hasAreaTags(r) {
    const tg = Object.fromEntries(this.tags(r));
    const name = tg.name !== undefined;
    return ((tg.type === 'multipolygon' || tg.type === 'boundary') && name) || (tg.admin_level !== undefined && name) ||
      tg.postal_code !== undefined || tg['addr:postcode'] !== undefined;
  }
  /** A relation's area, or Incomplete when its rings don't close because members lie in tiles that aren't
   *  loaded (partial.py _area_or_incomplete); in a bundle made from an extract, a relation the extract cut
   *  gets query.py's note. An area query or map_to_area says so rather than finding nothing. */
  areaOrIncomplete(r, ctx) {
    if (this.hasOverpassArea(r)) return true;
    if (!this.hasAreaTags(r)) return false;
    this.requireComplete(r, 'Area');
    if (this.tag(r, 'geodesk:missing_members') !== undefined) {
      const name = this.tag(r, 'name');
      ctx.notes.add(`relation ${this.idOf(r)}${name ? ` (${name})` : ''} matches but is cut by the edge of this GOL's ` +
        "extract, so it has no area here; use a GOL that contains all of it.");
    }
    return false;
  }
  hasOverpassArea(r) {
    let v = this.hasAreaCache.get(r);
    if (v !== undefined) return v;
    v = this.hasAreaTags(r);
    if (v) {                                            // _rings_closed: every way end met an even number of times
      const t = this.tileOf(r), i = this.indexOf(r), ends = new Map();
      let nways = 0;
      for (const m of this.memberRefs(t, i)) {
        const mt = this.tileOf(m.ref), mi = this.indexOf(m.ref);
        if (mt.typeOf(mi) !== 1) continue;
        nways++;
        const s = mt.ptOff[mi], e = mt.ptOff[mi + 1];
        if (e <= s) { v = false; break; }
        if (mt.isArea(mi)) continue;                    // closed: both ends the same
        const end = (p) => (mt.flags[mi] & F_NODE_IDS && mt.nodeIds[p]) ? 'n' + mt.nodeIds[p] : mt.xy[2 * p] + ',' + mt.xy[2 * p + 1];
        const ka = end(s), kb = end(e - 1);
        if (ka !== kb) { ends.set(ka, (ends.get(ka) ?? 0) + 1); ends.set(kb, (ends.get(kb) ?? 0) + 1); }
      }
      v = v && nways > 0 && [...ends.values()].every(c => c % 2 === 0);
    }
    this.hasAreaCache.set(r, v);
    return v;
  }
  /** The polygon of an area source: a GeoDesk area relation's rings, or a closed way's ring (null otherwise). */
  polygon(r) {
    if (this.polyCache.has(r)) return this.polyCache.get(r);
    const t = this.tileOf(r), i = this.indexOf(r);
    let poly = null;
    if (t.typeOf(i) === 1) {
      if (this.wayIsClosed(r)) poly = new PolygonArea([partPoints(this.ownPart(t, i))]);
    } else if (t.typeOf(i) === 2 && t.isArea(i)) {
      const lines = [];
      for (const m of this.memberRefs(t, i)) {
        const mt = this.tileOf(m.ref), mi = this.indexOf(m.ref);
        if (mt.typeOf(mi) === 1) lines.push(partPoints(this.ownPart(mt, mi)));
      }
      const rings = assembleRings(lines);
      if (rings.length) poly = new PolygonArea(rings);
    }
    this.polyCache.set(r, poly);
    return poly;
  }
  /** A relation Overpass's rules make an area of but GeoDesk doesn't (a church's type=building relation with an
   *  address): its rings from the member ways (areas.py relation_rings), as Overpass tests nodes (on any ring's
   *  border, or inside an odd number of rings) and an even-odd polygon for ways and relations. */
  assembled(r) {
    this.asmCache ??= new Map();
    if (this.asmCache.has(r)) return this.asmCache.get(r);
    const t = this.tileOf(r), i = this.indexOf(r);
    const lines = [];
    for (const m of this.memberRefs(t, i)) {
      const mt = this.tileOf(m.ref), mi = this.indexOf(m.ref);
      if (mt.typeOf(mi) === 1) lines.push(partPoints(this.ownPart(mt, mi)));
    }
    const rings = assembleRings(lines);
    const v = rings.length ? { rings: rings.map(g => new ClosedWayArea(g.map(ipoint))), poly: new PolygonArea(rings) } : null;
    if (v) v.containsNode = (la, lo) => {
      let inside = 0;
      for (const a of v.rings) {
        const p = a.point(la, lo);
        if (p === BORDER) return true;
        if (p !== OUTSIDE) inside++;
      }
      return inside % 2 === 1;
    };
    this.asmCache.set(r, v);
    return v;
  }
  closedWayArea(r) {
    if (this.ringCache.has(r)) return this.ringCache.get(r);
    const t = this.tileOf(r), i = this.indexOf(r);
    const v = this.wayIsClosed(r) ? new ClosedWayArea(partPoints(this.ownPart(t, i)).map(ipoint)) : null;
    this.ringCache.set(r, v);
    return v;
  }
  /** An area's outline is broken when members are in tiles that aren't loaded (partial.py _require_complete). */
  requireComplete(r, what) {
    const t = this.tileOf(r), i = this.indexOf(r);
    if (t.typeOf(i) !== 2) return;
    const info = { missing: 0 };
    this.memberRefs(t, i, info);
    if (info.missing) {
      const name = this.tag(r, 'name');
      throw new Incomplete(`${what} relation ${t.ids[i]}${name ? ` (${name})` : ''} has members in tiles that aren't loaded, ` +
        'so its outline is incomplete and the answer would be wrong. Load the area it covers.', this.wsen(r));
    }
  }

  /** The `(area.set)` / `(area:IDs)` test (spatial.py _area_test): relation areas by outline, closed ways by Overpass's tests. */
  areaTest(flt, ctx) {
    ctx.usedAreas = true;
    const rels = [], ways = [];
    const add = (kind, r) => {
      if (kind === 'way' && !this.wayIsClosed(r)) return;
      this.requireComplete(r, 'Area');
      (kind === 'way' ? ways : rels).push(r);
    };
    if (flt.kind === 'areaIds') {
      for (const r of this.areaFeatures(flt.ids)) add(this.typeOf(r) === 1 ? 'way' : 'area', r);
    } else {
      for (const r of ctx.sets.get(flt.set) ?? []) {
        if (isDerived(r)) continue;
        if (isArea(r)) add('area', r - AREA);
        else if (!isVnode(r) && this.typeOf(r) === 1) add('way', r);
      }
    }
    const relArea = (r) => this.tileOf(r).isArea(this.indexOf(r));
    const asms = rels.filter(r => !relArea(r)).map(r => this.assembled(r)).filter(Boolean);
    const nodePolys = rels.filter(relArea).map(r => this.polygon(r)).filter(Boolean);
    const polys = [...nodePolys, ...asms.map(a => a.poly)];             // for ways and relations
    const closed = ways.map(r => this.closedWayArea(r)).filter(Boolean);
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const r of [...rels, ...ways]) {
      const b = this.box(r);
      if (b) { box.minX = Math.min(box.minX, b.minX); box.minY = Math.min(box.minY, b.minY); box.maxX = Math.max(box.maxX, b.maxX); box.maxY = Math.max(box.maxY, b.maxY); }
    }
    // a grid over the closed ways' bounds (in Overpass's integer coordinates), like the STRtree in
    // area_tests.py ClosedWayAreas, so a candidate meets only the areas near it
    const CELL = 20000;                                   // 0.002°
    const grid = new Map(), big = [];
    closed.forEach((a, k) => {
      const [s, w, n, e] = a.bounds;
      const r0 = Math.floor(s / CELL), r1 = Math.floor(n / CELL), c0 = Math.floor(w / CELL), c1 = Math.floor(e / CELL);
      if ((r1 - r0 + 1) * (c1 - c0 + 1) > 64) { big.push(k); return; }
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const key = r + ',' + c; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(k); }
    });
    const nearAreas = (pts) => {
      if (closed.length <= 8) return closed;
      let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
      for (const [la, lo] of pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
      const ks = new Set(big);
      const r0 = Math.floor(s / CELL), r1 = Math.floor(n / CELL), c0 = Math.floor(w / CELL), c1 = Math.floor(e / CELL);
      if ((r1 - r0 + 1) * (c1 - c0 + 1) > 4096) return closed;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) for (const k of grid.get(r + ',' + c) ?? []) ks.add(k);
      return [...ks].sort((x, y) => x - y).map(k => closed[k]);
    };
    const nodeInClosed = (p, border) => { const ip = ipoint(p); return nearAreas([ip]).some(a => a.containsNode(ip[0], ip[1], border)); };
    const wayInClosed = (q) => { const pts = partPoints(q).map(ipoint); return pts.length > 0 && nearAreas(pts).some(a => a.containsWay(pts)); };
    const test = (r) => {
      const type = this.typeOf(r);
      if (type === 0) {
        const p = this.point(r);
        if (asms.length) { const ip = ipoint(p); if (asms.some(a => a.containsNode(ip[0], ip[1]))) return true; }
        return nodePolys.some(a => a.pointPos(p[0], p[1]) !== OUTSIDE) || nodeInClosed(p, true);
      }
      if (type === 1) {
        const q = this.parts(r)[0];
        return polys.some(a => a.lineInterior(partPoints(q))) || wayInClosed(q);
      }
      for (const q of this.parts(r)) {                   // relations: node members (strictly, for closed ways) or way members
        if (q.isNode) {
          const p = [px(q, 0), py(q, 0)];
          if (polys.some(a => a.pointPos(p[0], p[1]) !== OUTSIDE) || nodeInClosed(p, false)) return true;
        } else if (polys.some(a => a.lineInterior(partPoints(q))) || wayInClosed(q)) return true;
      }
      return false;
    };
    return { box, test, empty: !polys.length && !closed.length };
  }

  /** The features behind area IDs (2400000000 + way id, 3600000000 + relation id). */
  areaFeatures(ids) {
    const out = [];
    for (const id of ids) {
      const r = id >= REL_AREA_OFFSET ? this.store.find(2, id - REL_AREA_OFFSET) : id >= WAY_AREA_OFFSET ? this.store.find(1, id - WAY_AREA_OFFSET) : -1;
      if (r >= 0) out.push(r);
    }
    return out;
  }

  // ---- is_in, map_to_area (areas.py)
  isIn(s, ctx) {
    ctx.usedAreas = true;
    const pts = [];
    if (s.coords) pts.push([xFromLon(s.coords[1]), yFromLat(s.coords[0])]);
    else for (const r of ctx.sets.get(s.from) ?? []) if (!isArea(r) && !isDerived(r) && this.typeOf(r) === 0) pts.push(this.point(r));
    const out = new Set();
    const keys = new Set(pts.map(p => p.join(',')));
    const beyond = new Set();                      // areas cut by the edge of the loaded tiles (partial.py)
    const cut = new Map();                         // relations cut by an extract's edge (areas.py _note_cut_areas)
    this.store.index();
    let seen = 0;
    for (const k of keys) {
      if (this.isInCache.size > 200000) this.isInCache.clear();
      let hit = this.isInCache.get(k);              // per point: foreach loops ask for the same points again
      if (!hit) { hit = this.isInPoint(k); this.isInCache.set(k, hit); }
      for (const r of hit.refs) out.add(r);
      for (const n of hit.beyond) beyond.add(n);
      if (seen++ < 20) for (const [id, n] of hit.cut) cut.set(id, n);   // they are big: the first points tell (areas.py)
    }
    if (beyond.size) {
      const names = [...beyond].sort();
      ctx.notes.add(`is_in can't test ${names.length} area(s) that extend beyond the loaded tiles, e.g. ${names.slice(0, 5).join(', ')}; they are left out. Load more of the map to include them.`);
    }
    if (cut.size) {
      const names = [...cut].sort((a, b) => a[0] - b[0]).map(([id, n]) => `relation ${id}` + (n ? ` (${n})` : ''));
      ctx.notes.add(`is_in leaves out ${cut.size} area(s) cut by the edge of this GOL's extract, as Overpass would on ` +
        `the same extract: ${names.slice(0, 5).join(', ')}; ` +
        (cut.size === 1 ? 'a GOL that holds it whole lists it.' : 'a GOL that holds them whole lists them.'));
    }
    return out;
  }

  /** The areas around one point ("x,y" in Mercator): { refs, beyond, cut } (names of areas cut by the edge of the
   *  loaded tiles; [id, name] of relations an extract's edge cut). */
  isInPoint(k) {
    const refs = [], beyondNames = [], cut = [];
    const out = { add: (r) => refs.push(r) }, beyond = { add: (n) => beyondNames.push(n) };
    const [x, y] = k.split(',').map(Number);
    const [la, lo] = ipoint([x, y]);
    for (const t of this.store.slots) {
      const cand = [];
      forEachInBox(t, { minX: x, minY: y, maxX: x, maxY: y }, (i) => { if (i >= t.wayStart) cand.push(i); });
      cand.sort((p, q) => p - q);
      for (const i of cand) {
        if (t.flags[i] & F_DUPLICATE) continue;
        this.tick();
        const b = 4 * (i - t.wayStart);
        if (x < t.bbox[b] || x > t.bbox[b + 2] || y < t.bbox[b + 1] || y > t.bbox[b + 3]) continue;
        const r = t.slot * SLOT + i;
        if (i < t.relStart) {                       // every closed way (GeoDesk "wa" = ways or areas): Overpass's own test, border included
          const ring = this.closedWayArea(r);
          if (ring && ring.point(la, lo) !== OUTSIDE) out.add(r);
        } else if (!t.isArea(i)) {                  // Overpass's rules, but no GeoDesk area: rings assembled here
          const tg = Object.fromEntries(this.tags(r));
          if (tg['geodesk:missing_members'] !== undefined && this.hasAreaTags(r)) { cut.push([t.ids[i], tg.name]); continue; }
          if (tg['addr:postcode'] === undefined && tg.postal_code === undefined && !(tg.admin_level !== undefined && tg.name !== undefined)) continue;
          if (!this.hasOverpassArea(r)) continue;
          const asm = this.assembled(r);
          if (asm && asm.containsNode(la, lo)) out.add(AREA + r);
        } else if (t.isArea(i)) {
          const info = { missing: 0 };
          this.memberRefs(t, i, info);
          if (info.missing) { beyond.add(this.tag(r, 'name') ?? `relation ${t.ids[i]}`); continue; }
          if (!this.hasOverpassArea(r)) continue;
          const poly = this.polygon(r);
          if (poly && poly.pointPos(x, y) !== OUTSIDE) out.add(AREA + r);
        }
      }
    }
    return { refs, beyond: beyondNames, cut };
  }

  mapToArea(src, ctx) {
    const out = new Set();
    for (const r of src) {
      if (isArea(r) || isVnode(r) || isDerived(r)) continue;
      const type = this.typeOf(r);
      if (type === 1 && this.wayIsClosed(r)) out.add(r);
      else if (type === 2 && this.areaOrIncomplete(r, ctx)) out.add(AREA + r);
    }
    return out;
  }
}
