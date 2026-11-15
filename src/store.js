// SPDX-License-Identifier: AGPL-3.0-or-later
// Decoded tiles of one bundle, kept compact (see CompactTile in tes.js).
//
// A feature is addressed by a number, ref = slot * 2^32 + index: `slot` numbers the tiles in load order,
// `index` is the feature's position in its tile. Features that span tiles are stored in every tile they
// touch; the copy in the earliest-loaded tile is canonical and the others are flagged F_DUPLICATE, so a
// scan over all tiles sees each feature once. Lookups by type and ID use a sorted Float64Array per type
// (id * MAX_SLOTS + slot), rebuilt after tiles are added: no per-feature objects or string keys.

import { tileBounds } from './bundle.js';
import { decodeTile, F_DUPLICATE, TYPES, TYPE_INDEX } from './tes.js';

const SLOT = 2 ** 32;
const MAX_SLOTS = 65536;              // id * MAX_SLOTS stays exact for IDs below 1.37e11

export class TileStore {
  constructor(bundle) {
    this.bundle = bundle;
    this.tiles = new Map();          // tip -> CompactTile
    this.slots = [];                 // slot -> CompactTile
    this.keys = null;                // [nodes, ways, relations]: sorted id * MAX_SLOTS + slot
    this.unique = 0;
  }

  /** Fetches and decodes tiles (all levels intersecting the box, as `gol load -b`). */
  async loadBox(w, s, e, n, { onTile } = {}) {
    const want = this.bundle.tilesForBox(w, s, e, n).filter(t => t.size && !this.tiles.has(t.tip));
    for (const t of want) {
      const buf = await this.bundle.readTile(t.tip);
      this.addTile(t, buf);
      onTile?.(t, buf.length);
    }
    return want.length;
  }

  async loadAll() {
    for (const t of this.bundle.tiles) {
      if (!this.bundle.entries.get(t.tip)?.size || this.tiles.has(t.tip)) continue;
      this.addTile(t, await this.bundle.readTile(t.tip));
    }
  }

  addTile(t, buf) {
    if (this.slots.length >= MAX_SLOTS) throw new Error(`more than ${MAX_SLOTS} tiles loaded`);
    const bounds = tileBounds(t.col, t.row, t.zoom);
    const tile = decodeTile(buf, { tip: t.tip, strings: this.bundle.strings, bounds,
      wayNodeIds: this.bundle.header.wayNodeIds });
    tile.zoom = t.zoom; tile.col = t.col; tile.row = t.row; tile.bounds = bounds;
    tile.slot = this.slots.length;
    this.slots.push(tile);
    this.tiles.set(t.tip, tile);
    this.keys = null;
    return tile;
  }

  /** Builds the ID index and flags duplicate copies (lazily, after tiles were added). */
  index() {
    if (this.keys) return this.keys;
    this.keys = [];
    this.unique = 0;
    for (let type = 0; type < 3; type++) {
      let total = 0;
      for (const t of this.slots) total += typeEnd(t, type) - typeBegin(t, type);
      const keys = new Float64Array(total);
      let k = 0;
      for (const t of this.slots) {
        const ids = t.ids, slot = t.slot;
        for (let i = typeBegin(t, type), end = typeEnd(t, type); i < end; i++) keys[k++] = ids[i] * MAX_SLOTS + slot;
      }
      keys.sort();
      let prev = -1;
      for (let j = 0; j < total; j++) {
        const id = Math.floor(keys[j] / MAX_SLOTS);
        if (id === prev) {
          const t = this.slots[keys[j] - id * MAX_SLOTS];
          t.flags[findIn(t, type, id)] |= F_DUPLICATE;
        } else this.unique++;
        prev = id;
      }
      this.keys.push(keys);
    }
    return this.keys;
  }

  /** Number of distinct features loaded. */
  get featureCount() { this.index(); return this.unique; }

  /** The canonical ref of a feature, or -1 if it isn't loaded. */
  find(type, id) {
    const ti = typeof type === 'number' ? type : TYPE_INDEX[type];
    const keys = this.index()[ti];
    const want = id * MAX_SLOTS;
    let lo = 0, hi = keys.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (keys[mid] < want) lo = mid + 1; else hi = mid; }
    if (lo === keys.length || Math.floor(keys[lo] / MAX_SLOTS) !== id) return -1;
    const t = this.slots[keys[lo] - want];
    return t.slot * SLOT + findIn(t, ti, id);
  }

  tileOf(ref) { return this.slots[Math.floor(ref / SLOT)]; }
  indexOf(ref) { return ref % SLOT; }
  ref(tile, i) { return tile.slot * SLOT + i; }
  typeOf(ref) { return this.tileOf(ref).typeOf(ref % SLOT); }
  type(ref) { return TYPES[this.typeOf(ref)]; }
  id(ref) { return this.tileOf(ref).ids[ref % SLOT]; }
  /** The canonical copy of a feature (a reference may point at a copy in any tile). */
  canonical(ref) { return this.find(this.typeOf(ref), this.id(ref)); }

  /** A reference stored in a tile ((a, b) from refs or parRefs): the feature's ref, or -1 if its tile isn't loaded. */
  resolve(tile, a, b) {
    if (a >= 0) return tile.slot * SLOT + a;
    const t = this.tiles.get(-a);
    if (!t) return -1;
    const i = t.exports[b];
    return i === undefined || i < 0 ? -1 : t.slot * SLOT + i;
  }

  /** Bytes held in typed arrays (strings and small objects not counted). */
  bytes() {
    let n = 0;
    for (const t of this.slots) for (const v of Object.values(t)) if (ArrayBuffer.isView(v)) n += v.byteLength;
    for (const k of this.keys ?? []) n += k.byteLength;
    return n;
  }
}

export function typeBegin(t, type) { return type === 0 ? 0 : type === 1 ? t.wayStart : t.relStart; }
export function typeEnd(t, type) { return type === 0 ? t.wayStart : type === 1 ? t.relStart : t.n; }

/** Index of a feature in a tile (IDs ascend within each type), or -1. */
function findIn(t, type, id) {
  let lo = typeBegin(t, type), hi = typeEnd(t, type);
  const ids = t.ids;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ids[mid] < id) lo = mid + 1; else hi = mid; }
  return lo < typeEnd(t, type) && ids[lo] === id ? lo : -1;
}

