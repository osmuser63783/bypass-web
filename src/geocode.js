// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass Turbo's geocoding shortcuts ({{geocodeArea:…}}, {{geocodeCoords:…}}, {{geocodeId:…}},
// {{geocodeBbox:…}}) answered from the saved data instead of Nominatim: a port of the Geocoder in
// osm_bypass/turbo.py. Exact (case-insensitive) name matches, ranked roughly as Nominatim would: places
// linked to their boundary, admin level, Wikipedia presence, size.

import { latFromY, lonFromX } from './bundle.js';
import { F_DUPLICATE } from './tes.js';
import { INSIDE } from './areas.js';
import { Unsupported, WAY_AREA_OFFSET, REL_AREA_OFFSET } from './engine.js';

const NAME_KEYS = ['name', 'name:en', 'int_name', 'official_name', 'short_name', 'alt_name', 'loc_name'];
const PLACE_RANK = { continent: 0, country: 1, state: 2, region: 3, province: 3, county: 4, district: 5, municipality: 5,
  city: 6, borough: 7, town: 7, suburb: 8, quarter: 9, village: 9, neighbourhood: 10, hamlet: 10, locality: 11 };
const TYPE = ['node', 'way', 'relation'];
const SETTLEMENTS = new Set(['city', 'town', 'village']);   // before other areas of the same name (turbo.py _SETTLEMENTS)

const title = (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());   // Python str.title()
const coord = (v, limit) => Math.max(-limit, Math.min(limit, Number(v))).toFixed(7);
const jsNumber = (v) => String(Number(v.toFixed(7)));

export class Geocoder {
  constructor(engine) { this.e = engine; this.cache = new Map(); this.linked = new Map(); }

  variants(s) {
    const out = [];
    for (const v of [s, title(s), s.toLowerCase(), s.toUpperCase(), s.slice(0, 1).toUpperCase() + s.slice(1)]) if (!out.includes(v)) out.push(v);
    return out;
  }

  /** Features with tag k = v exactly (canonical refs). */
  withTag(k, v) {
    const e = this.e, out = [];
    e.store.index();
    for (const t of e.store.slots) {
      const kc = t.code(k), vc = t.code(v);
      if (kc < 0 || vc < 0) continue;
      for (let i = 0; i < t.n; i++) if (!(t.flags[i] & F_DUPLICATE) && t.value(i, kc) === vc) out.push(e.store.ref(t, i));
    }
    return out;
  }

  candidates(name) {
    const key = name.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key);
    const e = this.e, found = new Map();
    for (const k of NAME_KEYS) {                     // name first; other name keys only if nothing matched
      for (const v of this.variants(name)) {
        if (v.includes('"') || v.includes('\\')) continue;
        for (const r of this.withTag(k, v)) if (String(e.tag(r, k)).trim().toLowerCase() === key) found.set(r, r);
      }
      if (found.size) break;
    }
    // a place node that is the label/admin_centre of a boundary stands for that boundary
    for (const r of [...found.values()]) {
      if (e.typeOf(r) === 0 && e.tag(r, 'place') !== undefined) {
        for (const p of e.parentRelations(r)) {
          if (e.tag(p, 'boundary') !== undefined && this.linkedPlace(p, r)) { found.set(p, p); this.linked.set(p, r); }
        }
      }
    }
    const res = [...found.values()].sort((a, b) => cmp(this.rank(a), this.rank(b)));
    this.cache.set(key, res);
    return res;
  }

  /** Nominatim links a place node to a boundary that has it as label, or as admin_centre of the same place. */
  linkedPlace(rel, node) {
    const e = this.e, t = e.tileOf(rel), i = e.indexOf(rel), nid = e.idOf(node);
    for (const m of e.memberRefs(t, i)) {
      if (e.typeOf(m.ref) !== 0 || e.idOf(m.ref) !== nid) continue;
      if (m.role === 'label') return true;
      if (m.role === 'admin_centre') {
        const wr = e.tag(rel, 'wikidata'), wn = e.tag(node, 'wikidata');
        if (wr !== undefined && wr === wn) return true;
        const rn = String(e.tag(rel, 'name') ?? '').toLowerCase(), nn = String(e.tag(node, 'name') ?? '').toLowerCase();
        if (nn && rn.includes(nn)) return true;
      }
    }
    return false;
  }

  /** Size of an area feature (0 for points and lines), for ranking only. */
  size(r) {
    const e = this.e, type = e.typeOf(r);
    if (type === 0) return 0;
    const t = e.tileOf(r), i = e.indexOf(r);
    if (!t.isArea(i)) return 0;
    const p = e.polygon(r);
    return p ? p.area() : 0;
  }

  rank(r) {
    const e = this.e, tg = Object.fromEntries(e.tags(r));
    const wiki = tg.wikidata !== undefined || tg.wikipedia !== undefined ? 0 : 1;
    const admin = tg.boundary === 'administrative';
    const place = tg.place;
    const cls = admin || place !== undefined ? 0 : 1;
    let lvl = 99;
    if (tg.admin_level !== undefined && /^\s*[-+]?\d+\s*$/.test(tg.admin_level)) lvl = parseInt(tg.admin_level, 10);
    const prank = place !== undefined ? (PLACE_RANK[place] ?? 50) : 50;
    const type = e.typeOf(r);
    // a settlement, or the boundary its node stands for: Kraków the city before the county of the same name
    const node = this.linked.get(r);
    const settlement = SETTLEMENTS.has(place) || (node !== undefined && SETTLEMENTS.has(e.tag(node, 'place')));
    return [cls, settlement ? 0 : 1, wiki, admin ? Math.min(lvl, prank + 2) : prank + 2, type === 0 ? 0 : -this.size(r),
      type === 2 ? 0 : 1, e.idOf(r)];
  }

  /** "Leith, Edinburgh": candidates for the first part that lie in an area of each further part. */
  qualified(instr) {
    const parts = instr.split(',').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return [];
    let cands = this.candidates(parts[0]);
    for (const q of parts.slice(1)) {
      const outer = this.candidates(q).filter(a => this.e.typeOf(a) !== 0).map(a => [a, this.e.polygon(a)]).filter(([, g]) => g);
      if (!outer.length) return [];
      // inside another area, not itself ("Durham, County Durham": turbo.py _qualified)
      cands = cands.filter(c => { const p = this.point(c); return outer.some(([a, g]) => a !== c && g.pointPos(p[0], p[1]) === INSIDE); });
    }
    return cands;
  }

  /** A point of the feature (an interior point for areas). */
  point(r) {
    const e = this.e;
    if (e.typeOf(r) === 0) return e.point(r);
    const poly = e.tileOf(r).isArea(e.indexOf(r)) ? e.polygon(r) : null;
    const b = e.box(r);
    if (poly && b) {                                   // midpoint of the first inside stretch on the middle line
      const y = (b.minY + b.maxY) / 2;
      const xs = [];
      for (const ring of poly.rings) for (let k = 0; k + 1 < ring.length; k++) {
        const [x1, y1] = ring[k], [x2, y2] = ring[k + 1];
        if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
      }
      xs.sort((a, c) => a - c);
      if (xs.length >= 2) return [(xs[0] + xs[1]) / 2, y];
    }
    const q = e.parts(r)[0];
    return q && q.n ? [q.xy[2 * q.s], q.xy[2 * q.s + 1]] : [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }

  best(instr, areasOnly) {
    for (const c of this.qualified(instr)) {
      if (areasOnly && this.e.typeOf(c) === 0) continue;
      return c;
    }
    return null;
  }

  /** The text a shortcut expands to; notes say which object was chosen. */
  shortcut(kind, instr, notes) {
    const e = this.e;
    const f = this.best(instr, kind === 'geocodeArea');
    if (f === null) throw new Unsupported(`{{${kind}:${instr}}}: no object named “${instr}” in the saved area (names are looked up in the saved data, not with Nominatim)`);
    const typ = TYPE[e.typeOf(f)], id = e.idOf(f), name = e.tag(f, 'name');
    notes.push(`{{${kind}:${instr}}} is ${typ} ${id}${name ? ` (${name})` : ''}, found in the saved data. Overpass Turbo asks Nominatim, which may pick a different object.`);
    if (kind === 'geocodeId') return `${typ}(${id})`;
    if (kind === 'geocodeArea') return typ === 'way' ? `area(id:${WAY_AREA_OFFSET + id},${id})` : `area(id:${REL_AREA_OFFSET + id})`;
    const b = e.box(f);
    const s = latFromY(b.minY), w = lonFromX(b.minX), n = latFromY(b.maxY), ea = lonFromX(b.maxX);
    if (kind === 'geocodeBbox') return [coord(s, 90), coord(w, 180), coord(n, 90), coord(ea, 180)].join(',');
    const anchor = typ === 'node' ? f : typ === 'relation' ? this.linked.get(f) ?? null : null;
    if (anchor !== null) { const [x, y] = e.point(anchor); return `${jsNumber(latFromY(y))},${jsNumber(lonFromX(x))}`; }
    return `${jsNumber((s + n) / 2)},${jsNumber((w + ea) / 2)}`;
  }
}

function cmp(a, b) {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return 0;
}
