// SPDX-License-Identifier: AGPL-3.0-or-later
// Decoding a GeoDesk TES tile (the tile format inside a .gob bundle) into a compact, typed-array tile.
// A port of the reading logic in GOL Tool 2.x (clarisma/geodesk-gol, AGPL-3.0-only):
// src/tile/tes/TesReader.cpp, src/tile/compiler/*TableWriter.h, and the TIP/TEX rules of libgeodesk
// (RelatedIterator.h, Tex.h, types.h). Table sizes in TES are given in GOL bytes, so the GOL encoding
// sizes are reproduced here to know where each table ends; nothing is laid out in GOL form.
//
// Memory: one object per feature (with tag arrays, coordinate arrays and reference objects) took about
// 1,400 bytes per feature, 38 times the download size. A CompactTile keeps everything in a few typed
// arrays per tile; features are addressed by their index in the tile.

import { readVarint, readShortString } from './bundle.js';

// TES flags (TesFlags.h)
const TAGS_CHANGED = 1, SHARED_TAGS = 2, RELATIONS_CHANGED = 4, GEOMETRY_CHANGED = 8,
  MEMBERS_CHANGED = 16, NODE_BELONGS_TO_WAY = 16, NODE_IDS_CHANGED = 32, BBOX_CHANGED = 32,
  HAS_SHARED_LOCATION = 32, IS_AREA = 64, IS_EXCEPTION_NODE = 64;

export const START_TIP = 0x4000;
export const MEMBERS_START_TEX = 0x400, RELATIONS_START_TEX = 0x800, WAYNODES_START_TEX = 0x800;
const MIN_NUMBER = -256;
export const TYPES = ['node', 'way', 'relation'];
export const TYPE_INDEX = { node: 0, way: 1, relation: 2 };

// CompactTile.flags bits
export const F_AREA = 1, F_WAYNODE = 2, F_SHARED_LOCATION = 4, F_EXCEPTION_NODE = 8, F_REMOVED = 16,
  F_DUPLICATE = 32,                     // set by the store: an earlier-loaded tile has this feature too
  F_NODE_IDS = 64;                      // a way whose node IDs are in nodeIds

const zigzag = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);              // exact for any safe integer
const fits = (v, bits) => v >= -(2 ** (bits - 1)) && v < 2 ** (bits - 1);

function formatDecimal(mantissa, scale) {
  if (!scale) return String(mantissa);
  const neg = mantissa < 0;
  const digits = String(Math.abs(mantissa)).padStart(scale + 1, '0');
  return (neg ? '-' : '') + digits.slice(0, -scale) + '.' + digits.slice(-scale);
}

/** A growable typed array. */
class Buf {
  constructor(Type, cap = 1024) { this.Type = Type; this.a = new Type(cap); this.n = 0; }
  push(v) { if (this.n === this.a.length) this.grow(1); this.a[this.n++] = v; }
  push2(v, w) { if (this.n + 2 > this.a.length) this.grow(2); this.a[this.n++] = v; this.a[this.n++] = w; }
  push3(u, v, w) { if (this.n + 3 > this.a.length) this.grow(3); this.a[this.n++] = u; this.a[this.n++] = v; this.a[this.n++] = w; }
  grow(k) { const b = new this.Type(Math.max(this.a.length * 2, this.n + k)); b.set(this.a); this.a = b; }
  done() { return this.a.slice(0, this.n); }       // a right-sized copy; the builder is dropped
}

/**
 * One decoded tile. Feature i (0 <= i < n) is a node below `wayStart`, a way below `relStart`, else a
 * relation; IDs ascend within each type. Strings (keys, values, roles) are codes into `strs`.
 *
 *   ids[i]                       OSM ID
 *   flags[i]                     F_* bits
 *   tagTab[i]                    tag table: pairs tagKV[2*tagOff[t] ..< 2*tagOff[t+1]] = (key, value)
 *   ptOff[i] ..< ptOff[i+1]      points in xy (x, y pairs; a node has one, a way its nodes, area rings
 *                                without the closing repeat) and, if the bundle has them, way-node IDs
 *                                in nodeIds at the same point index
 *   bbox[4*(i-wayStart)]         minX, minY, maxX, maxY of ways and relations
 *   refOff[i] ..< refOff[i+1]    references in refs, three ints each: (a, b, role). a >= 0 is a feature of
 *                                this tile; otherwise -a is a TIP and b a TEX in that tile's exports.
 *                                Relation members carry a role code; a way's feature nodes have role -1.
 *   parTab[i]                    parent relations: table t is refs entries parOff[t] ..< parOff[t+1] of
 *                                `parRefs` (same (a, b) pairs, no role); -1 = none
 *   exports[tex]                 feature index for other tiles' references, -1 = none
 */
/** Above any tile's string count: withTag's cache key is key code * span + value code + 1. */
const TAG_INDEX_SPAN = 2 ** 26;
/** Tag lists kept per tile before the cache starts over. */
const TAG_INDEX_MAX = 256;

export class CompactTile {
  typeOf(i) { return i < this.wayStart ? 0 : i < this.relStart ? 1 : 2; }
  type(i) { return TYPES[this.typeOf(i)]; }
  /** Code of a string in this tile, or -1 when no feature here uses it. */
  code(s) { const c = this.strIndex.get(s); return c === undefined ? -1 : c; }
  /** Value code of a key code on feature i, or -1. */
  value(i, keyCode) {
    const t = this.tagTab[i], kv = this.tagKV;
    for (let k = 2 * this.tagOff[t], end = 2 * this.tagOff[t + 1]; k < end; k += 2) if (kv[k] === keyCode) return kv[k + 1];
    return -1;
  }
  /** Tags of feature i as [[key, value], ...], in stored order. */
  tags(i) {
    const t = this.tagTab[i], kv = this.tagKV, s = this.strs, out = [];
    for (let k = 2 * this.tagOff[t], end = 2 * this.tagOff[t + 1]; k < end; k += 2) out.push([s[kv[k]], s[kv[k + 1]]]);
    return out;
  }
  /** Tags of feature i as an object without GeoDesk's own geodesk:* keys, or null when there are none. */
  tagObject(i) {
    const t = this.tagTab[i], kv = this.tagKV, s = this.strs;
    let out = null;
    for (let k = 2 * this.tagOff[t], end = 2 * this.tagOff[t + 1]; k < end; k += 2) {
      const key = s[kv[k]];
      if (key.charCodeAt(0) === 103 && key.startsWith('geodesk:')) continue;
      (out ??= {})[key] = s[kv[k + 1]];
    }
    return out;
  }
  /**
   * Features that have the key code (with the value code, if one is given), ascending; built on first
   * use and kept, so a tag query walks these instead of every feature of the tile.
   */
  withTag(keyCode, valCode = -1) {
    const cache = (this.tagIdx ??= new Map()), id = keyCode * TAG_INDEX_SPAN + valCode + 1;
    let list = cache.get(id);
    if (list) return list;
    const nTab = this.tagOff.length - 1, kv = this.tagKV, has = new Uint8Array(nTab);
    for (let t = 0; t < nTab; t++) {
      for (let k = 2 * this.tagOff[t], end = 2 * this.tagOff[t + 1]; k < end; k += 2) {
        if (kv[k] === keyCode) { has[t] = valCode < 0 || kv[k + 1] === valCode ? 1 : 0; break; }
      }
    }
    const tab = this.tagTab, hits = [];
    for (let i = 0; i < this.n; i++) if (has[tab[i]]) hits.push(i);
    list = Int32Array.from(hits);
    if (cache.size >= TAG_INDEX_MAX) cache.clear();
    cache.set(id, list);
    return list;
  }
  x(i) { return this.xy[2 * this.ptOff[i]]; }
  y(i) { return this.xy[2 * this.ptOff[i] + 1]; }
  isArea(i) { return (this.flags[i] & F_AREA) !== 0; }
  role(c) { return c < 0 ? '' : this.strs[c]; }
}

/**
 * Decodes one tile.
 * @param {Uint8Array} buf  uncompressed TES (Bundle.readTile)
 * @param {{tip:number, strings:string[], wayNodeIds?:boolean, bounds:{minX,minY}}} ctx
 * @returns {CompactTile}
 */
export function decodeTile(buf, ctx) {
  let p = 0;
  const v = () => { let x; [x, p] = readVarint(buf, p); return x; };
  // A count of items that take at least a byte each: more than the bytes left means a broken or hostile tile
  const fitting = (c, what) => { if (c > buf.length - p) throw new RangeError(`TES tile ${ctx.tip}: ${what} count ${c} exceeds the tile`); return c; };
  const count = (what) => fitting(v(), what);
  const sv = () => zigzag(v());
  const global = ctx.strings;

  // Strings of this tile: global and local strings and formatted numbers, each once.
  const strs = [], strIndex = new Map();
  const code = (s) => {
    let c = strIndex.get(s);
    if (c === undefined) { c = strs.length; strs.push(s); strIndex.set(s, c); }
    return c;
  };

  // 1. Feature index: delta-coded (id << 1 | changed), node/way/relation groups separated by 0.
  const n = count('feature');
  const ids = new Float64Array(n);
  const changed = new Uint8Array(n);
  const typeStart = [0, n, n];
  readFeatureIndex();
  const [, wayStart, relStart] = typeStart;
  function readFeatureIndex() {
    let type = 0, prevId = 0, i = 0;
    while (i < n) {
      const ref = v();
      if (ref === 0) { type++; typeStart[type] = i; prevId = 0; continue; }
      const id = Math.floor(ref / 2) + prevId;
      ids[i] = id; changed[i] = ref % 2;
      i++;
      prevId = id;
    }
    for (let t = type + 1; t < 3; t++) typeStart[t] = n;
  }

  // 2. Local strings (codes assigned lazily, so unused ones cost nothing).
  const localCount = count('local string');
  const local = new Array(localCount);
  for (let i = 0; i < localCount; i++) [local[i], p] = readShortString(buf, p);

  const valueCode = (flags, value) => {
    switch (flags) {
      case 0: return code(String(value + MIN_NUMBER));                             // narrow number
      case 1: return code(global[value]);                                          // global string
      case 2: return code(formatDecimal(Math.floor(value / 4) + MIN_NUMBER, value & 3)); // wide number
      default: return code(local[value]);                                          // local string
    }
  };

  // 3. Tag tables (TesReader::readTagTable). Local tags take 4 bytes of key plus 2 or 4 of value in
  //    the GOL; global tags 2 bytes of key plus 2 or 4 of value. Table 0 is the empty table.
  const tagKV = new Buf(Int32Array, 4096), tagOff = new Buf(Int32Array, 256);
  tagOff.push(0); tagOff.push(0);
  const readTagTable = () => {
    const tagged = v();
    const size = tagged & ~1;
    let localSize = 0;
    if (tagged & 1) localSize = v() * 2;
    // GeoDesk iterates global-key tags first, then local-key ones; TES stores the local ones first
    const locals = [];
    for (let used = 0; used < localSize; ) {
      const keyBits = v(), value = v(), flags = keyBits & 3;
      locals.push(code(local[keyBits >>> 2]), valueCode(flags, value));
      used += 4 + (flags & 2 ? 4 : 2);
    }
    let prevKeyShifted = 0;
    for (let used = 0; used < size - localSize; ) {
      const keyBits = v() + prevKeyShifted;
      prevKeyShifted = keyBits & 0xfffc;
      const flags = keyBits & 3, value = v();
      const key = global[keyBits >>> 2];
      if (!(key === '' && flags === 1 && value === 0)) tagKV.push2(code(key), valueCode(flags, value)); // empty-table marker
      used += 2 + (flags & 2 ? 4 : 2);
    }
    for (let k = 0; k < locals.length; k += 2) tagKV.push2(locals[k], locals[k + 1]);
    tagOff.push(tagKV.n / 2);
    return tagOff.n - 2;                            // index of the table just closed
  };
  const sharedTags = new Int32Array(count('tag table'));
  for (let i = 0; i < sharedTags.length; i++) sharedTags[i] = readTagTable();

  // 4. Relation tables (parent relations): local 4 bytes; foreign TEX 2 or 4 (12-bit narrow),
  //    plus TIP 2 or 4 (15-bit narrow) when in a different tile. Running TIP/TEX per table.
  const parRefs = new Buf(Int32Array, 1024), parOff = new Buf(Int32Array, 256);
  parOff.push(0);
  const readRelationTable = (size) => {
    let foreign = false, tip = START_TIP, tex = RELATIONS_START_TEX;
    for (let used = 0; used < size; ) {
      const rel = v();
      if (rel & 1) {
        const tipDelta = sv(), texDelta = zigzag(Math.floor(rel / 2));
        foreign = true; tip += tipDelta; tex += texDelta;
        parRefs.push2(-tip, tex);
        used += (fits(texDelta, 12) ? 2 : 4) + (fits(tipDelta, 15) ? 2 : 4);
      } else if (foreign) {
        const texDelta = zigzag(Math.floor(rel / 2));
        tex += texDelta;
        parRefs.push2(-tip, tex);
        used += fits(texDelta, 12) ? 2 : 4;
      } else {
        parRefs.push2(relStart + Math.floor(rel / 2), 0);
        used += 4;
      }
    }
    parOff.push(parRefs.n / 2);
    return parOff.n - 2;
  };
  const sharedRels = new Int32Array(count('relation table'));
  for (let i = 0; i < sharedRels.length; i++) sharedRels[i] = readRelationTable(v());

  // 5. Feature changes.
  const flagsOut = new Uint8Array(n);
  const tagTab = new Int32Array(n);                 // 0 = the empty table
  const parTab = new Int32Array(n).fill(-1);
  const ptOff = new Int32Array(n + 1), refOff = new Int32Array(n + 1);
  const bbox = new Int32Array(4 * (n - wayStart));
  const xy = new Buf(Int32Array, 8192), refs = new Buf(Int32Array, 1024);
  let nodeIds = null;                               // Buf(Float64Array), parallel to points, if present
  let prevX = ctx.bounds.minX, prevY = ctx.bounds.minY;

  for (let i = 0; i < n; i++) {
    ptOff[i] = xy.n / 2; refOff[i] = refs.n / 3;
    if (!changed[i]) continue;
    const flags = buf[p++];
    if (flags & TAGS_CHANGED) tagTab[i] = flags & SHARED_TAGS ? sharedTags[v()] : readTagTable();
    if (flags & RELATIONS_CHANGED) {
      const r = v();
      parTab[i] = r === 0 ? -1 : (r & 1 ? sharedRels[r >>> 1] : readRelationTable(r));
    }
    if (i < wayStart) readNode(i, flags);
    else if (i < relStart) readWay(i, flags);
    else readRelation(i, flags);
  }

  function readNode(i, flags) {
    if (flags & GEOMETRY_CHANGED) { prevX += sv(); prevY += sv(); xy.push2(prevX, prevY); nodeIds?.push(0); }
    flagsOut[i] = (flags & NODE_BELONGS_TO_WAY ? F_WAYNODE : 0) | (flags & HAS_SHARED_LOCATION ? F_SHARED_LOCATION : 0) |
      (flags & IS_EXCEPTION_NODE ? F_EXCEPTION_NODE : 0);
  }
  function readWay(i, flags) {
    if (flags & GEOMETRY_CHANGED) readWayGeometry(i, flags);
    if (flags & IS_AREA) flagsOut[i] |= F_AREA;
    if (flags & MEMBERS_CHANGED) readWayNodes();
  }
  /** A way's points (delta-coded), its bbox, and its node IDs if the bundle has them. */
  function readWayGeometry(i, flags) {
    const b = 4 * (i - wayStart);
    const count = v();
    prevX += sv(); prevY += sv();
    let x = prevX, y = prevY, minX = x, minY = y, maxX = x, maxY = y;
    xy.push2(x, y);
    for (let k = 1; k < count; k++) {
      x += sv(); y += sv();
      xy.push2(x, y);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    bbox[b] = minX; bbox[b + 1] = minY; bbox[b + 2] = maxX; bbox[b + 3] = maxY;
    if (flags & NODE_IDS_CHANGED) {
      if (ctx.wayNodeIds !== false) {
        if (!nodeIds) {                         // first way with IDs: pad the points so far
          nodeIds = new Buf(Float64Array, Math.max(1024, xy.a.length / 2));
          nodeIds.n = xy.n / 2 - count;
        }
        let id = 0;
        for (let k = 0; k < count; k++) { id += sv(); nodeIds.push(id); }
        flagsOut[i] |= F_NODE_IDS;
      } else for (let k = 0; k < count; k++) sv();
    } else if (nodeIds) for (let k = 0; k < count; k++) nodeIds.push(0);
  }
  /** A way's feature nodes (NodeTableWriter: the same sizes as relation tables). */
  function readWayNodes() {
    const size = v();
    let tip = START_TIP, tex = WAYNODES_START_TEX;
    for (let used = 0; used < size; ) {
      const node = v();
      if (node & 1) {
        const texDelta = zigzag(Math.floor(node / 4));
        tex += texDelta;
        if (node & 2) {
          const tipDelta = sv();
          tip += tipDelta;
          used += (fits(texDelta, 12) ? 2 : 4) + (fits(tipDelta, 15) ? 2 : 4);
        } else used += fits(texDelta, 12) ? 2 : 4;
        refs.push3(-tip, tex, -1);
      } else {
        refs.push3(Math.floor(node / 2), 0, -1);
        used += 4;
      }
    }
  }
  function readRelation(i, flags) {
    const b = 4 * (i - wayStart);
    if (flags & BBOX_CHANGED) {
      prevX += sv(); prevY += sv();
      const w = v(), h = v();
      bbox[b] = prevX; bbox[b + 1] = prevY; bbox[b + 2] = prevX + w; bbox[b + 3] = prevY + h;
    }
    if (flags & IS_AREA) flagsOut[i] = F_AREA;
    if (flags & MEMBERS_CHANGED) readMembers();
  }
  /** A relation's members (MemberTableWriter: 11-bit narrow TEX); a role carries over until it changes. */
  function readMembers() {
    const size = v();
    let tip = START_TIP, tex = MEMBERS_START_TEX, role = -1;
    for (let used = 0; used < size; ) {
      const m = v();
      let a, t = 0;
      if (m & 1) {
        const texDelta = zigzag(Math.floor(m / 8));
        tex += texDelta;
        if (m & 4) {
          const tipDelta = sv();
          tip += tipDelta;
          used += (fits(texDelta, 11) ? 2 : 4) + (fits(tipDelta, 15) ? 2 : 4);
        } else used += fits(texDelta, 11) ? 2 : 4;
        a = -tip; t = tex;
      } else {
        a = Math.floor(m / 4);
        used += 4;
      }
      if (m & 2) {                              // DIFFERENT_ROLE
        const r = v();
        if (r & 1) { role = code(global[r >>> 1]); used += 2; } else { role = code(local[r >>> 1]); used += 4; }
      }
      refs.push3(a, t, role);
    }
  }
  ptOff[n] = xy.n / 2; refOff[n] = refs.n / 3;

  // 6. Removed features (not expected in a full tile; marked, not dropped).
  {
    let left = count('removed feature'), type = 0, prevId = 0;
    while (left) {
      const ref = v();
      if (ref === 0) { type++; prevId = 0; continue; }
      const id = Math.floor(ref / 2) + prevId;
      for (let i = typeStart[type], end = type < 2 ? typeStart[type + 1] : n; i < end; i++) {
        if (ids[i] === id) { flagsOut[i] |= F_REMOVED; break; }
      }
      prevId = id;
      left--;
    }
  }

  // 7. Exports: TEX -> feature, used by other tiles' foreign references.
  let exports;
  {
    const tagged = v();
    const v2 = (tagged & 1) === 1;
    const replace = !v2 || (tagged & 2) !== 0;
    const nExports = fitting(Math.floor(tagged / (v2 ? 4 : 2)), 'export');
    if (!replace) throw new Error('TES export patch in a bundle tile (not supported)');
    exports = new Int32Array(nExports);
    for (let i = 0; i < nExports; i++) exports[i] = v() + (v2 ? 0 : 1) - 1;
  }
  if (p !== buf.length) throw new Error(`TES tile ${ctx.tip}: ${buf.length - p} bytes left over`);

  return Object.assign(new CompactTile(), {
    tip: ctx.tip, n, wayStart, relStart, ids, flags: flagsOut, strs, strIndex,
    tagTab, tagKV: tagKV.done(), tagOff: tagOff.done(), parTab, parRefs: parRefs.done(), parOff: parOff.done(),
    ptOff, xy: xy.done(), nodeIds: nodeIds ? nodeIds.done() : null, bbox, refOff, refs: refs.done(), exports,
  });
}
