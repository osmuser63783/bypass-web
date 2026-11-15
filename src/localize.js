// SPDX-License-Identifier: AGPL-3.0-or-later
// `local [ll|llb][(s,w,n,e)]`: Overpass's localized representation of a set. A port of osm_bypass/localize.py,
// itself a port of Overpass API statements/localize.cc (Copyright (C) 2008-2018 Roland Olbricht et al.,
// AGPL-3.0-or-later).
//
// The input's ways are split into *links* at every node shared with another way (or used twice); tagged nodes
// become *vertices*; each relation becomes a chain of *trigraphs* (one per member, or per link of a member way,
// linked by _previous/_next). Nodes at the same position get _local_ids. Mode l keeps tagged objects only, ll
// adds untagged ways and empty members, llb adds everything plus the OSM references (_node_ref, _way_ref, …).

import * as G from './geometry.js';
import { quadtile, calcRanges, calcParents, inU31Ranges } from './ovindex.js';
import { latFromY, lonFromX } from './bundle.js';
import { NO_WAYNODE_IDS, Unsupported } from './errors.js';
import { cpCompare } from './text.js';

const MODES = { l: 0, ll: 1, llb: 2 };
const NO_POS = 100.0;                     // latitude marking "no coordinate yet"
const EPS = 5e-8;                         // bbox tolerance in degrees (localize.cc)
const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];
const cpCmp = cpCompare;
const pairCmp = (a, b) => cpCmp(a[0], b[0]) || cpCmp(a[1], b[1]);

class NodeInfo { constructor() { this.localId = 0; this.count = 0; this.lat = NO_POS; this.lon = 0.0; this.links = new Map(); } }
class Section { constructor(pos, localFrom, first) { this.pos = pos; this.id = 0; this.localFrom = localFrom; this.localTo = 0; this.pts = [first]; } }

export function localize(engine, st, ctx) {
  if (!engine.store.bundle.header.wayNodeIds) {
    throw new Unsupported('`local` splits ways at shared nodes, which needs way-node IDs. ' + NO_WAYNODE_IDS);
  }
  return new Localizer(engine, st, ctx).run();
}

class Localizer {
  constructor(engine, st, ctx) {
    this.e = engine; this.ctx = ctx;
    this.mode = MODES[st.mode];
    this.bbox = st.bbox ? new G.Bbox(...st.bbox) : null;
    const items = engine.storageOrder(ctx.sets.get(st.from) ?? new Set()).filter(r => engine.isFeatureRef(r));
    this.inNodes = items.filter(r => engine.typeOf(r) === 0);
    this.inWays = items.filter(r => engine.typeOf(r) === 1);
    this.inRels = items.filter(r => engine.typeOf(r) === 2);
    this.nodes = new Map();               // id -> node ref: every node of the relevant ways
    this.ways = new Map();                // id -> way ref
    this.info = new Map();                // node id -> NodeInfo
    this.sections = new Map();            // way id -> [Section]
    this.wayOrder = [];
    this.out = new Set();
    this.dec = (r) => { const [x, y] = engine.point(r); return G.decoded(latFromY(y), lonFromX(x)); };
    this.nodeIds = (w) => engine.wayNodes(w).map(n => engine.idOf(n));
  }

  run() {
    this.collect();
    this.numberNodes();
    this.emitVertices();
    this.splitWays();
    this.numberLinks();
    this.emitLinks();
    this.emitTrigraphs();
    return this.out;
  }

  contains(p) {
    const b = this.bbox;
    if (!b) return true;
    const [la, lo] = p;
    if (la + EPS < b.south || la - EPS > b.north) return false;
    if (b.east >= b.west) return lo + EPS >= b.west && lo - EPS <= b.east;
    return lo + EPS >= b.west || lo - EPS <= b.east;
  }
  admissible(points) {
    if (!this.bbox || points.some(p => this.contains(p))) return true;
    for (let k = 0; k + 1 < points.length; k++) if (G.bboxIntersects(this.bbox, points[k], points[k + 1])) return true;
    return false;
  }

  // ---- relevant objects (add_nw_member_objects + collect_ways)
  collect() {
    const e = this.e;
    let nodeOk = () => true, wayOk = () => true;
    if (this.bbox) {
      const b = this.bbox, r32 = calcRanges(b.south, b.north, b.west, b.east), r31 = calcParents(r32);
      nodeOk = (n) => { const [x, y] = e.point(n); const q = quadtile(latFromY(y), lonFromX(x)); return r32.some(([lo, hi]) => lo <= q && q < hi); };
      wayOk = (w) => inU31Ranges(e.ovidx(w), r31);
    }
    const memberWays = new Map();
    for (const r of this.inRels) {
      const t = e.tileOf(r), i = e.indexOf(r);
      for (const m of e.memberRefs(t, i)) {
        const c = e.canon(m.ref), mt = e.typeOf(c);
        if (mt === 0 && nodeOk(c)) this.nodes.set(e.idOf(c), c);
        else if (mt === 1 && wayOk(c)) memberWays.set(e.idOf(c), c);
      }
    }
    for (const w of this.inWays) this.ways.set(e.idOf(w), w);
    for (const [id, w] of memberWays) if (!this.ways.has(id)) this.ways.set(id, w);
    for (const w of this.ways.values()) for (const n of e.wayNodes(w)) if (!this.nodes.has(e.idOf(n))) this.nodes.set(e.idOf(n), n);
    for (const w of e.waysOfNodes([...this.nodes.values()])) if (!this.ways.has(e.idOf(w))) this.ways.set(e.idOf(w), w);
    for (const n of this.inNodes) if (!this.nodes.has(e.idOf(n))) this.nodes.set(e.idOf(n), n);
  }

  node(id) { let c = this.info.get(id); if (!c) { c = new NodeInfo(); this.info.set(id, c); } return c; }

  numberNodes() {
    const byPos = new Map();               // same position = same index and ll_lower; ordered by id
    for (const [id, n] of this.nodes) {
      const [la, lo] = this.dec(n);
      const k = G.ilat(la) + ',' + G.ilon(lo);
      if (!byPos.has(k)) byPos.set(k, []);
      byPos.get(k).push(id);
    }
    for (const ids of byPos.values()) if (ids.length > 1) [...ids].sort((a, b) => a - b).forEach((id, j) => { this.node(id).localId = j + 1; });
    for (const [id, n] of this.nodes) { const c = this.node(id); [c.lat, c.lon] = this.dec(n); }
    const e = this.e;
    this.wayOrder = [...this.ways.values()].map(w => [e.ovidx(w), e.idOf(w), w])
      .sort((a, b) => (a[0] & 0x7fffffff) - (b[0] & 0x7fffffff) || a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
    for (const w of this.wayOrder) {
      const nds = this.nodeIds(w);
      if (!nds.length) continue;
      this.node(nds[0]).count += 2;
      for (const id of nds.slice(1, -1)) this.node(id).count += 1;
      this.node(nds[nds.length - 1]).count += 2;
    }
  }

  // ---- output elements
  emit(name, geom, tags, extra) {
    const t = Object.entries(tags).map(([k, v]) => [k.startsWith('_') ? '_' + k : k, v]).sort(pairCmp);
    const all = [...t, ...[...extra].sort(pairCmp)].sort(pairCmp);
    const { d, ref } = this.e.addDerived(this.ctx, name, new Map(all), geom);
    this.out.add(ref);
    return d;
  }
  wanted(tags) { return this.mode === 2 || Object.keys(tags).length > 0; }

  emitVertices() {
    for (const n of this.inNodes) {
      const tags = this.e.tagObject(n);
      if (!this.wanted(tags)) continue;
      const c = this.node(this.e.idOf(n));
      if (Object.keys(tags).length) c.count += 1;
      if (this.contains([c.lat, c.lon])) {
        const extra = c.localId ? [['_local_id', String(c.localId)]] : [];
        if (this.mode === 2) extra.push(['_node_ref', String(this.e.idOf(n))]);
        const [la, lo] = this.dec(n);
        this.emit('vertex', new G.Point(la, lo), tags, extra);
      }
    }
  }

  // ---- links: every relevant way, partitioned at nodes used more than once
  splitWays() {
    const e = this.e;
    for (const w of this.wayOrder) {
      const nds = this.nodeIds(w);
      const wid = e.idOf(w);
      if (!this.sections.has(wid)) this.sections.set(wid, []);
      const secs = this.sections.get(wid);
      const cs = nds.map(id => this.info.get(id));
      if (!nds.length || cs.some(c => !c || c.lat === NO_POS)) continue;
      let start = 0;
      let sec = new Section(0, cs[0].localId, [cs[0].lat, cs[0].lon]);
      secs.push(sec);
      const link = (c, from) => { if (!c.links.has(from)) c.links.set(from, []); c.links.get(from).push(wid); };
      for (let k = 1; k < nds.length - 1; k++) {
        const c = cs[k];
        sec.pts.push([c.lat, c.lon]);
        if (c.localId || c.count > 1) {
          link(c, nds[start]);
          start = k;
          sec.localTo = c.localId;
          this.dropOutside(sec);
          sec = new Section(start, c.localId, [c.lat, c.lon]);
          secs.push(sec);
        }
      }
      const c = cs[cs.length - 1];
      sec.pts.push([c.lat, c.lon]);
      sec.localTo = c.localId;
      link(c, nds[start]);
      this.dropOutside(sec);
    }
    for (const c of this.info.values()) for (const v of c.links.values()) v.sort((a, b) => a - b);
  }
  dropOutside(sec) { if (!this.admissible(sec.pts)) sec.pts = []; }

  /** Parallel links between the same two nodes get _local_id 1, 2, … in way-id order. */
  numberLinks() {
    for (const w of this.wayOrder) {
      const nds = this.nodeIds(w), wid = this.e.idOf(w);
      const secs = this.sections.get(wid) ?? [];
      if (!nds.length) continue;
      const seenPairs = [];
      secs.forEach((sec, k) => {
        const target = k + 1 < secs.length ? nds[secs[k + 1].pos] : nds[nds.length - 1];
        const parallel = this.info.get(target).links.get(nds[sec.pos]) ?? [];
        if (parallel.length <= 1) return;
        let pp = 0;
        while (pp < parallel.length && parallel[pp] !== wid) pp++;
        if (pp + 1 < parallel.length && parallel[pp + 1] === wid) {          // the same way twice
          pp += seenPairs.filter(([a, b]) => a === nds[sec.pos] && b === target).length;
          seenPairs.push([nds[sec.pos], target]);
        }
        sec.id = pp + 1;
      });
    }
  }

  emitLinks() {
    const e = this.e;
    for (const w of this.inWays) {
      const tags = e.tagObject(w);
      if (!this.wanted(tags)) continue;
      for (const sec of this.sections.get(e.idOf(w)) ?? []) {
        if (!sec.pts.length) continue;
        const extra = [];
        if (sec.localFrom) extra.push(['_local_from', String(sec.localFrom)]);
        if (sec.localTo) extra.push(['_local_to', String(sec.localTo)]);
        if (sec.id) extra.push(['_local_id', String(sec.id)]);
        if (this.mode === 2) extra.push(['_way_ref', String(e.idOf(w))]);
        this.emit('link', new G.Linestring(sec.pts), tags, extra);
      }
    }
    if (this.mode >= 1) {                    // ways without nodes
      for (const w of this.inWays) {
        const tags = e.tagObject(w);
        if (this.wanted(tags) && !e.wayNodes(w).length) this.emit('link', new G.Null(), tags, this.mode === 2 ? [['_way_ref', String(e.idOf(w))]] : []);
      }
    }
  }

  // ---- trigraphs: relation members in order, chained by _previous/_next
  emitTrigraphs() {
    for (const r of this.inRels) {
      const tags = this.e.tagObject(r);
      if (this.wanted(tags)) new TrigraphChain(this, r, tags).run();
    }
  }
}

class TrigraphChain {
  constructor(loc, rel, tags) {
    this.loc = loc; this.rel = rel; this.tags = tags;
    const e = loc.e;
    this.mems = e.memberRefs(e.tileOf(rel), e.indexOf(rel)).map(m => e.canon(m.ref));
    this.last = null;
    this.lastPt = [NO_POS, 0.0];
  }
  run() {
    const e = this.loc.e, relId = String(e.idOf(this.rel));
    this.mems.forEach((m, mi) => {
      const mt = e.typeOf(m);
      if (mt === 0) this.nodeMember(m);
      else if (mt === 1) this.wayMember(mi, m);
      else if (this.loc.mode >= 1) {
        const refs = [['_child_relation_ref', String(e.idOf(m))], ['_relation_ref', relId]];
        this.chain(this.loc.emit('trigraph', new G.Null(), this.tags, this.loc.mode === 2 ? refs : []));
      } else this.last = null;
    });
  }
  chain(d) {
    if (this.last !== null) {
      this.last.tags.set('_next', String(d.id));
      d.tags.set('_previous', String(this.last.id));
      d.tags = new Map([...d.tags].sort(pairCmp));
    }
    this.last = d;
  }
  nodeMember(m) {
    const e = this.loc.e;
    const c = this.loc.info.get(e.idOf(m)) ?? new NodeInfo();
    if (!this.loc.contains([c.lat, c.lon])) { this.last = null; return; }
    const extra = c.localId ? [['_local_ref', String(c.localId)]] : [];
    if (this.loc.mode === 2) extra.push(['_child_node_ref', String(e.idOf(m))], ['_relation_ref', String(e.idOf(this.rel))]);
    this.chain(this.loc.emit('trigraph', new G.Point(c.lat, c.lon), this.tags, extra));
  }
  wayMember(mi, m) {
    const e = this.loc.e;
    const secs = this.loc.sections.get(e.idOf(m)) ?? [];
    if (!secs.length) { this.last = null; return; }
    const backwards = this.orientation(mi, secs) === 2;
    for (const sec of backwards ? [...secs].reverse() : secs) {
      if (!sec.pts.length) { this.last = null; continue; }
      const pts = backwards ? [...sec.pts].reverse() : sec.pts;
      const [a, b] = backwards ? [sec.localTo, sec.localFrom] : [sec.localFrom, sec.localTo];
      const extra = [];
      if (a) extra.push(['_vertex_local_from', String(a)]);
      if (b) extra.push(['_vertex_local_to', String(b)]);
      if (sec.id) extra.push(['_local_ref', String(sec.id)]);
      if (this.loc.mode === 2) extra.push(['_child_way_ref', String(e.idOf(m))], ['_relation_ref', String(e.idOf(this.rel))]);
      this.chain(this.loc.emit('trigraph', new G.Linestring(pts), this.tags, extra));
    }
    const endSec = backwards ? secs[0] : secs[secs.length - 1];
    if (!endSec.pts.length) this.lastPt = [NO_POS, 0.0];
    else this.lastPt = backwards ? endSec.pts[0] : endSec.pts[endSec.pts.length - 1];
  }
  /** 0 either way, 1 forwards, 2 backwards: continue from the previous member, else meet the next. */
  orientation(mi, secs) {
    const e = this.loc.e;
    const first = secs[0].pts.length ? secs[0].pts[0] : null;
    const fin = secs[secs.length - 1].pts.length ? secs[secs.length - 1].pts[secs[secs.length - 1].pts.length - 1] : null;
    if (this.last !== null && this.lastPt[0] <= 90) {
      if (first && samePt(this.lastPt, first)) return 1;
      if (fin && samePt(this.lastPt, fin)) return 2;
    }
    if (mi + 1 < this.mems.length && e.typeOf(this.mems[mi + 1]) === 1) {
      const nxt = this.loc.sections.get(e.idOf(this.mems[mi + 1])) ?? [];
      if (nxt.length) {
        const nf = nxt[0].pts.length ? nxt[0].pts[0] : null, nb = nxt[nxt.length - 1].pts.length ? nxt[nxt.length - 1].pts[nxt[nxt.length - 1].pts.length - 1] : null;
        if (fin && ((nf && samePt(nf, fin)) || (nb && samePt(nb, fin)))) return 1;
        if (first && ((nf && samePt(nf, first)) || (nb && samePt(nb, first)))) return 2;
      }
    }
    return 0;
  }
}
