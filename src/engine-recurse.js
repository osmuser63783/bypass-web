// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: Following relations, ways and nodes: recursion (> >> < <<), pivot, way_cnt and parents.
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

import { FEW_POINTS, SLOT, TYPE_INDEX_OF, isArea, isDerived } from './engine-base.js';
import { F_DUPLICATE, F_NODE_IDS } from './tes.js';
import { featureMeetsBox, forEachInBoxes } from './spatial.js';

export class RecurseMethods {

  /** (pivot.set): the ways and relations an area set's areas were made from (recursion.py _pivot). */
  pivot(f, types, ctx) {
    const allowed = types.map(t => TYPE_INDEX_OF[t] ?? -1);
    const out = new Set();
    for (const r of ctx.sets.get(f.set) ?? []) {
      if (isDerived(r)) continue;
      const b = this.base(r);
      if (allowed.includes(this.typeOf(b))) out.add(b);
    }
    return out;
  }
  /** (way_cnt.s:lo-hi): nodes in that many ways of s; (way_link…): met by that many way segments. */
  wayCount(f, types, ctx) {
    if (!types.includes('node')) return new Set();
    const counts = new Map();
    for (const r of ctx.sets.get(f.set) ?? []) {
      if (isDerived(r) || isArea(r) || this.typeOf(r) !== 1) continue;
      const nodes = this.wayNodes(r);
      if (f.wc === 'way_cnt') for (const n of new Set(nodes)) counts.set(n, (counts.get(n) ?? 0) + 1);
      else nodes.forEach((n, k) => counts.set(n, (counts.get(n) ?? 0) + (k > 0) + (k < nodes.length - 1)));
    }
    return new Set([...counts].filter(([, c]) => c >= f.lo && (f.hi === null || c <= f.hi)).map(([n]) => n));
  }

  /** All parents (ways and relations, canonical) of the given elements. */
  parentsUnion(refs) {
    const out = new Set(), nodes = [];
    for (const r of refs) {
      if (this.typeOf(r) === 0) nodes.push(r);
      else for (const p of this.parentRelations(r)) out.add(p);
    }
    if (nodes.length) {
      for (const r of nodes) for (const p of this.parentRelations(r)) out.add(p);
      for (const w of this.waysOfNodes(nodes)) out.add(w);
    }
    return out;
  }

  /** The ways through any of the nodes: by way-node IDs, or else by the ways' feature-node tables. */
  waysOfNodes(nodes) {
    const want = new Set(nodes.map(r => this.idOf(r)));
    const pts = [];
    for (const r of nodes) { const b = this.box(r); if (b) pts.push(b); }
    const out = new Set();
    this.store.index();
    for (const t of this.store.slots) {
      // the ways whose box holds one of the nodes, from the spatial index (each checked once)
      const cand = new Set();
      const holdsOne = pts.length > FEW_POINTS ? () => true : (i) => pts.some(p => featureMeetsBox(t, i, p));
      forEachInBoxes(t, pts, (i) => { if (i >= t.wayStart && i < t.relStart && !(t.flags[i] & F_DUPLICATE) && holdsOne(i)) cand.add(i); });
      for (const i of cand) {
        this.tick();
        let hit = false;
        if (t.flags[i] & F_NODE_IDS) {
          for (let p = t.ptOff[i]; p < t.ptOff[i + 1]; p++) if (want.has(t.nodeIds[p])) { hit = true; break; }
        } else {
          for (let q = t.refOff[i]; q < t.refOff[i + 1]; q++) {
            const n = this.store.resolve(t, t.refs[3 * q], t.refs[3 * q + 1]);
            if (n >= 0 && want.has(this.store.id(n))) { hit = true; break; }
          }
        }
        if (hit) out.add(t.slot * SLOT + i);
      }
    }
    return out;
  }

  recurse(op, src, ctx) {
    const items = [...src].filter(r => !isArea(r) && !isDerived(r));   // areas and deriveds have no members or parents
    return op === '>' || op === '>>' ? this.recurseDown(items, op === '>>', ctx) : this.recurseUp(items, op === '<<');
  }

  recurseDown(items, deep, ctx) {
    const out = new Set(), seenRel = new Set();
    if (deep) for (const r of items) if (this.typeOf(r) === 2) { out.add(r); seenRel.add(r); }   // >> keeps the input relations
    const stack = [...items];
    while (stack.length) {
      this.tick();
      const r = stack.pop();
      const type = this.typeOf(r);
      if (type === 1) for (const n of this.wayNodes(r)) out.add(n);
      else if (type === 2) {
        const t = this.tileOf(r), i = this.indexOf(r), info = { missing: 0 };
        for (const m of this.memberRefs(t, i, info)) {
          const c = this.canon(m.ref), mt = this.typeOf(c);
          if (mt !== 2) { out.add(c); if (mt === 1) stack.push(c); }
          else if (deep && !seenRel.has(c)) { seenRel.add(c); out.add(c); stack.push(c); }
        }
        if (info.missing) ctx.notes.add('Some relation members are in tiles that are not loaded.');
      }
    }
    return out;
  }

  recurseUp(items, deep) {
    const out = new Set(), seen = new Set(items);
    let frontier = items;
    while (frontier.length) {
      const next = [];
      const climb = frontier.filter(r => deep || this.typeOf(r) !== 2);
      for (const p of this.parentsUnion(climb)) {
        if (!out.has(p)) {
          out.add(p);
          if (deep && !seen.has(p)) { seen.add(p); next.push(p); }
        }
      }
      if (!deep) for (const w of [...out].filter(p => this.typeOf(p) === 1)) for (const rel of this.parentRelations(w)) out.add(rel);
      frontier = next;
    }
    return out;
  }
}
