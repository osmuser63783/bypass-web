// SPDX-License-Identifier: AGPL-3.0-or-later
// Built from browser/src by tools-build.mjs
(() => {
const __m = {};
// ---- errors.js
__m["errors.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Errors the engine raises besides SyntaxError (kept apart so every module can import them).

/** Valid Overpass QL that the browser engine doesn't do (yet), or that needs data a bundle doesn't have. */
class Unsupported extends Error {}

/** Every way-node-ID guard ends with this. The Open Planet Data bundle has way-node IDs since its release of
 *  10 November 2026, so only areas saved from earlier releases (or custom bundles saved without -w) lack them. */
const NO_WAYNODE_IDS = 'This saved area has no way-node IDs: it was loaded from a bundle release before ' +
  '10 November 2026 (or from a bundle saved without them). Load the area again from the current bundle.';

/** An error while a parsed query runs (a timeout, filters too weak; ql.py RuntimeQLError). Overpass answers it
 *  with HTTP 200, the output so far and the error as a remark: `overpass` is the remark's text in Overpass's
 *  words, and Engine.run sets `result` to the output so far with that remark (render.js prints it). */
class RuntimeQLError extends Error {
  constructor(msg, overpass) { super(msg); this.overpass = overpass ?? msg; this.result = null; }
}

/** The answer needs data beyond the loaded tiles; `extra.bbox` = [w, s, e, n] is what to load. */
class Incomplete extends Error {
  constructor(msg, bbox) { super(msg); this.kind = 'incomplete'; this.extra = { bbox }; }
}

return { Unsupported, NO_WAYNODE_IDS, RuntimeQLError, Incomplete };
})();
// ---- text.js
__m["text.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// String helpers shared by the engine modules.

/**
 * Python's str ordering (by code point), without copying the strings. UTF-16 code units sort like code
 * points except that a surrogate (part of a character from U+10000 up) must sort after U+E000–U+FFFF.
 */
function cpCompare(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    const x = a.charCodeAt(k), y = b.charCodeAt(k);
    if (x !== y) {
      const sx = x >= 0xd800 && x <= 0xdfff, sy = y >= 0xd800 && y <= 0xdfff;
      if (sx !== sy) return sx ? 1 : -1;
      return x < y ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

return { cpCompare };
})();
// ---- bundle.js
__m["bundle.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading a GeoDesk bundle (.gob) by byte ranges: header, catalog, metadata (tile index, global strings,
// settings, indexed keys) and tile blobs. Layout from GOL Tool 2.x source (clarisma/geodesk-gol,
// src/tile/tes/TesArchive.h, src/gol/load/TileLoader.cpp) and libgeodesk (TileIndexWalker, Tile, StringTable).
// Runs unchanged in browsers and Node 18+ (fetch, DecompressionStream).

const GOB_MAGIC = 0xE0F6B060;
const HEADER_SIZE = 64;
// Limits against a hostile or broken bundle. Real bundles are far below them: the 2026
// planet has 58,689 tiles and about 0.8 MB of head, and its densest tiles inflate to tens of MB.
const MAX_TILES = 2 ** 20;
const MAX_METADATA_BYTES = 2 ** 26;               // 64 MB, compressed
const MAX_CHUNK_BYTES = 2 ** 28;                  // 256 MB, uncompressed
const VARINT_MAX_MUL = 2 ** 49;                   // the 8th byte; a 9th would pass 2^53

// ---- byte sources ---------------------------------------------------------------------------------------

/** The file behind a URL changed between two reads (Open Planet Data replaces its bundles daily). */
class BundleReplaced extends Error {
  constructor(url) { super(`${url}: the file was replaced while it was being read`); this.kind = 'replaced'; }
}

/**
 * A source reads `len` bytes at `start` and returns a Uint8Array. A URL source remembers the first answer's
 * Last-Modified (the one validator a cross-origin page can read without the server exposing more) and throws
 * BundleReplaced when a later answer has another: the old offsets would point into a different file.
 */
function urlSource(url, { headers = {} } = {}) {
  let stamp = null;
  return {
    name: url,
    async read(start, len) {
      const r = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${start + len - 1}` } });
      if (r.status !== 206 && r.status !== 200) throw new Error(`${url}: HTTP ${r.status}`);
      const lm = r.headers.get('Last-Modified');
      if (lm) { if (stamp === null) stamp = lm; else if (lm !== stamp) throw new BundleReplaced(url); }
      let b = new Uint8Array(await r.arrayBuffer());
      if (r.status === 200 && b.length > len) b = b.subarray(start, start + len); // range ignored
      if (b.length !== len) throw new Error(`${url}: short read (${b.length} of ${len} bytes at ${start})`);
      return b;
    },
  };
}

/** A Blob or File (a .gob picked in the page): slices are read lazily, so a large file costs nothing up front. */
function blobSource(blob, name = blob.name ?? 'blob') {
  return {
    name,
    async read(start, len) {
      const b = new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
      if (b.length !== len) throw new Error(`${name}: short read (${b.length} of ${len} bytes at ${start})`);
      return b;
    },
  };
}

/** Bytes already in memory (a saved bundle head). */
function bytesSource(bytes, name = 'bytes') {
  return {
    name,
    async read(start, len) {
      if (start + len > bytes.length) throw new Error(`${name}: read past the end (${start}+${len} > ${bytes.length})`);
      return bytes.subarray(start, start + len);
    },
  };
}

/** Node only: a local file. */
async function fileSource(path) {
  throw new Error('fileSource is Node-only');
  const fh = await fs.open(path, 'r');
  return {
    name: path,
    async read(start, len) {
      const b = new Uint8Array(len);
      const { bytesRead } = await fh.read(b, 0, len, start);
      if (bytesRead !== len) throw new Error(`${path}: short read`);
      return b;
    },
    close: () => fh.close(),
  };
}

// ---- checksums and compression --------------------------------------------------------------------------

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82F63B78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32c(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC32C_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Inflates raw deflate, but never past `limit` bytes: a bomb stops there instead of filling memory. */
async function inflateRaw(bytes, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) { reader.cancel().catch(() => {}); throw new Error(`chunk: inflates past its declared ${limit} bytes`); }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

/** A "sealed chunk": u32 uncompressed size, u32 CRC32C of the uncompressed data, raw deflate. */
async function unsealChunk(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = dv.getUint32(0, true), checksum = dv.getUint32(4, true);
  if (size > MAX_CHUNK_BYTES) throw new Error(`chunk: declares ${size} bytes, more than the ${MAX_CHUNK_BYTES} allowed`);
  const out = await inflateRaw(bytes.subarray(8), size);
  if (out.length !== size) throw new Error(`chunk: size ${out.length}, expected ${size}`);
  if (crc32c(out) !== checksum) throw new Error('chunk: checksum mismatch');
  return out;
}

// ---- varints and strings --------------------------------------------------------------------------------

function readVarint(buf, pos) {          // returns [value, newPos]; exact up to 2^53
  let v = 0, mul = 1, b;
  do {
    if (pos >= buf.length) throw new RangeError('varint runs past the end of its data');
    if (mul > VARINT_MAX_MUL) throw new RangeError('varint longer than 8 bytes');
    b = buf[pos++]; v += (b & 0x7f) * mul; mul *= 128;
  } while (b & 0x80);
  return [v, pos];
}

const utf8 = new TextDecoder();

/** ShortVarString: 1 or 2 length bytes (7 bits each, high bit of the first = 2 bytes), then UTF-8. */
function readShortString(buf, pos) {
  let len = buf[pos];
  let ofs = 1;
  if (len & 0x80) { len = (len & 0x7f) | (buf[pos + 1] << 7); ofs = 2; }
  if (!(pos + ofs + len <= buf.length)) throw new RangeError('string runs past the end of its data');
  return [utf8.decode(buf.subarray(pos + ofs, pos + ofs + len)), pos + ofs + len];
}

function guid(b) {
  const h = [...b].map(x => x.toString(16).padStart(2, '0'));
  const le = (a) => a.reverse().join('');
  return `${le(h.slice(0, 4))}-${le(h.slice(4, 6))}-${le(h.slice(6, 8))}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

// ---- tiles and Mercator (libgeodesk Tile.h, Mercator.h) -------------------------------------------------

// GeoDesk's own constant (libgeodesk geom/Mercator.h), not 2^32: with 2^32 a box edge can round to the next
// integer, so a point exactly on it falls outside (node 538411219 at 55.9477)
const MAP_WIDTH = 4294967294.9999;

const xFromLon = (lon) => Math.round(MAP_WIDTH * lon / 360);
const yFromLat = (lat) => Math.round(Math.log(Math.tan((lat + 90) * Math.PI / 360)) * (MAP_WIDTH / 2 / Math.PI));
const lonFromX = (x) => x * 360 / MAP_WIDTH;
const latFromY = (y) => Math.atan(Math.exp(y * 2 * Math.PI / MAP_WIDTH)) * 360 / Math.PI - 90;

const columnFromXZ = (x, z) => Math.floor((x + 2147483648) / 2 ** (32 - z));
const rowFromYZ = (y, z) => Math.floor((2147483647 - y) / 2 ** (32 - z));

function tileBounds(col, row, z) {           // inclusive integer bounds
  const extent = 2 ** (32 - z);
  const minX = (col - 2 ** (z - 1)) * extent;
  const maxY = 2147483647 - row * extent;
  return { minX, minY: maxY - extent + 1, maxX: minX + extent - 1, maxY };
}

// ---- bundle ---------------------------------------------------------------------------------------------

class Bundle {
  /** Reads header, catalog and metadata: two range requests (about 770 KB for the 2026 planet). */
  static async open(source) {
    let head;
    try { head = await source.read(0, HEADER_SIZE); }
    catch (e) { throw /short read/.test(e.message) ? new Error(`${source.name}: not a GeoDesk bundle (too short)`) : e; }
    const dv = new DataView(head.buffer, head.byteOffset, HEADER_SIZE);
    if (dv.getUint32(0, true) !== GOB_MAGIC) throw new Error(`${source.name}: not a GeoDesk bundle`);
    const h = {
      versionMajor: dv.getUint16(4, true), versionMinor: dv.getUint16(6, true),
      guid: guid(head.subarray(8, 24)),
      flags: dv.getUint32(0x18, true),
      tileCount: dv.getUint32(0x1C, true),
      baseRevision: dv.getUint32(0x20, true),
      revision: dv.getUint32(0x24, true),
      revisionTimestamp: Number(dv.getBigInt64(0x28, true)),        // ms since 1970 (clarisma DateTime)
      metadataSize: dv.getUint32(0x30, true),
    };
    if (h.versionMajor !== 2 || h.versionMinor !== 0) throw new Error(`bundle format ${h.versionMajor}.${h.versionMinor}, expected 2.0`);
    h.wayNodeIds = (h.flags & 1) !== 0;
    if (h.tileCount > MAX_TILES) throw new Error(`bundle claims ${h.tileCount} tiles, more than the ${MAX_TILES} allowed`);
    if (h.metadataSize > MAX_METADATA_BYTES) throw new Error(`bundle metadata of ${h.metadataSize} bytes, more than the ${MAX_METADATA_BYTES} allowed`);
    const catalogSize = HEADER_SIZE + 8 * h.tileCount + 4;
    // One request for the rest of the catalog plus the metadata chunk right after it.
    const rest = await source.read(HEADER_SIZE, catalogSize - HEADER_SIZE + h.metadataSize);
    const catalog = new Uint8Array(catalogSize);
    catalog.set(head, 0);
    catalog.set(rest.subarray(0, catalogSize - HEADER_SIZE), HEADER_SIZE);
    const cdv = new DataView(catalog.buffer);
    if (crc32c(catalog.subarray(0, catalogSize - 4)) !== cdv.getUint32(catalogSize - 4, true)) {
      throw new Error('bundle catalog checksum mismatch');
    }
    // Tile blobs follow the metadata in catalog order.
    const entries = new Map();                      // tip -> { offset, size }
    let ofs = catalogSize + h.metadataSize;
    for (let i = 0; i < h.tileCount; i++) {
      const tip = cdv.getUint32(HEADER_SIZE + 8 * i, true), size = cdv.getUint32(HEADER_SIZE + 8 * i + 4, true);
      entries.set(tip, { offset: ofs, size });
      ofs += size;
    }
    const meta = await unsealChunk(rest.subarray(catalogSize - HEADER_SIZE));
    const b = new Bundle(source, h, entries, parseMetadata(meta), ofs);
    // Header + catalog + sealed metadata: everything except the tiles. Saved areas keep it so they open offline.
    b.headBytes = new Uint8Array(catalogSize + h.metadataSize);
    b.headBytes.set(catalog, 0);
    b.headBytes.set(rest.subarray(catalogSize - HEADER_SIZE), catalogSize);
    b.catalogSize = catalogSize;
    return b;
  }

  constructor(source, header, entries, metadata, fileSize) {
    Object.assign(this, { source, header, entries, fileSize });
    this.tileIndex = metadata.tileIndex;
    this.settings = metadata.settings;
    this.strings = metadata.strings;
    this.indexedKeys = metadata.indexedKeys;
    this.properties = metadata.properties;
    this.tiles = walkTileIndex(this.tileIndex, this.settings.zoomLevels);
    this.byTip = new Map(this.tiles.map(t => [t.tip, t]));
  }

  /** Tiles intersecting a lon/lat box, at every level (as `gol load -b`), with their compressed sizes. */
  tilesForBox(w, s, e, n) {
    const x0 = xFromLon(w), x1 = xFromLon(e), y0 = yFromLat(s), y1 = yFromLat(n);
    return this.tiles.filter(t => {
      const b = tileBounds(t.col, t.row, t.zoom);
      return b.minX <= x1 && b.maxX >= x0 && b.minY <= y1 && b.maxY >= y0;
    }).map(t => ({ ...t, ...(this.entries.get(t.tip) ?? { offset: null, size: 0 }) }));
  }

  /** The sealed (compressed) blob of one tile, as stored in the bundle. `rawReader` can replace the source. */
  async readRaw(tip) {
    if (this.rawReader) return this.rawReader(tip);
    const e = this.entries.get(tip);
    if (!e) throw new Error(`tile ${tip} is not in the bundle`);
    return this.source.read(e.offset, e.size);
  }

  /** The uncompressed TES data of one tile. */
  async readTile(tip) {
    return unsealChunk(await this.readRaw(tip));
  }
}

function parseMetadata(buf) {
  const md = {};
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0, present = 0;
  while (p < buf.length) {
    const section = buf[p++];
    let size;
    [size, p] = readVarint(buf, p);
    present |= 1 << section;
    const body = buf.subarray(p, p + size);
    switch (section) {
      case 1: md.properties = body; break;
      case 2: md.settings = {
        zoomLevels: dv.getUint16(p, true), rtreeBranchSize: dv.getUint16(p + 4, true),
        rtreeAlgo: buf[p + 6], maxKeyIndexes: buf[p + 7], keyIndexMinFeatures: dv.getUint32(p + 8, true),
      }; break;
      case 3: md.tileIndex = new Uint32Array(body.slice().buffer); break;
      case 4: md.strings = parseStringTable(body); break;
      case 5: md.indexedKeys = body.slice(); break;
    }
    p += size;
  }
  if (present !== 0x3E) throw new Error('bundle metadata: missing sections');
  return md;
}

function parseStringTable(buf) {
  const count = buf[0] | (buf[1] << 8);
  const out = new Array(count);
  let p = 2;
  for (let i = 0; i < count; i++) [out[i], p] = readShortString(buf, p);
  return out;
}

/**
 * Every tile in a tile index (libgeodesk TileIndexWalker without a box). Entry `tip` holds the tile's
 * status/pointer; if its low two bits are 01, the tile has children and its page starts at
 * tip + ((v ^ 1) >> 2): the page's first entry is the tile itself, then a child mask (one u32 for a 4x4
 * step, two for 8x8), then one entry per child present, in row-major bit order.
 */
function walkTileIndex(index, zoomLevels) {
  const steps = [];
  for (let z = zoomLevels >> 1, zoom = 0; z; ) {
    const tz = 31 - Math.clz32(z & -z);             // trailing zeros
    const step = tz + 1;
    zoom += step;
    steps.push({ step, zoom });
    z >>>= step;
  }
  const out = [{ tip: 1, zoom: 0, col: 0, row: 0, hasChildren: false }];
  const pages = new Set();                          // a page reached twice means a loop (a hostile index)
  const visit = (tip, col, row, level, self) => {
    // `tip` is the page of a tile with children
    if (level >= steps.length) return;
    if (pages.has(tip) || !(tip + 2 < index.length)) throw new Error(`tile index: bad page ${tip}`);
    pages.add(tip);
    const { step, zoom } = steps[level];
    self.hasChildren = true;
    const mask = step === 3
      ? (BigInt(index[tip + 1]) | (BigInt(index[tip + 2]) << 32n))
      : BigInt(index[tip + 1]);
    let child = tip + (step === 3 ? 3 : 2);
    const extent = 1 << step;
    for (let n = 0; n < extent * extent; n++) {
      if (!((mask >> BigInt(n)) & 1n)) continue;
      const c = (col << step) + (n & (extent - 1)), r = (row << step) + (n >> step);
      let ctip = child++;
      const v = index[ctip];
      const t = { tip: ctip, zoom, col: c, row: r, hasChildren: false };
      if (out.length >= MAX_TILES) throw new Error(`tile index: more than ${MAX_TILES} tiles`);
      if ((v & 3) === 1) {
        ctip += (((v | 0) ^ 1) >> 2);
        t.tip = ctip;
        out.push(t);
        visit(ctip, c, r, level + 1, t);
      } else out.push(t);
    }
  };
  // The root (zoom 0) is always TIP 1 and its page starts there (TileIndexWalker: startLevel(levels_[0], 1)).
  visit(1, 0, 0, 0, out[0]);
  return out;
}

return { GOB_MAGIC, BundleReplaced, urlSource, blobSource, bytesSource, fileSource, crc32c, unsealChunk, readVarint, readShortString, xFromLon, yFromLat, lonFromX, latFromY, columnFromXZ, rowFromYZ, tileBounds, Bundle, walkTileIndex };
})();
// ---- tes.js
__m["tes.js"] = (() => {
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

const { readVarint, readShortString } = __m["bundle.js"];

// TES flags (TesFlags.h)
const TAGS_CHANGED = 1, SHARED_TAGS = 2, RELATIONS_CHANGED = 4, GEOMETRY_CHANGED = 8,
  MEMBERS_CHANGED = 16, NODE_BELONGS_TO_WAY = 16, NODE_IDS_CHANGED = 32, BBOX_CHANGED = 32,
  HAS_SHARED_LOCATION = 32, IS_AREA = 64, IS_EXCEPTION_NODE = 64;

const START_TIP = 0x4000;
const MEMBERS_START_TEX = 0x400, RELATIONS_START_TEX = 0x800, WAYNODES_START_TEX = 0x800;
const MIN_NUMBER = -256;
const TYPES = ['node', 'way', 'relation'];
const TYPE_INDEX = { node: 0, way: 1, relation: 2 };

// CompactTile.flags bits
const F_AREA = 1, F_WAYNODE = 2, F_SHARED_LOCATION = 4, F_EXCEPTION_NODE = 8, F_REMOVED = 16,
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

class CompactTile {
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
function decodeTile(buf, ctx) {
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

return { START_TIP, MEMBERS_START_TEX, RELATIONS_START_TEX, WAYNODES_START_TEX, TYPES, TYPE_INDEX, F_AREA, F_WAYNODE, F_SHARED_LOCATION, F_EXCEPTION_NODE, F_REMOVED, F_DUPLICATE, F_NODE_IDS, CompactTile, decodeTile };
})();
// ---- store.js
__m["store.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Decoded tiles of one bundle, kept compact (see CompactTile in tes.js).
//
// A feature is addressed by a number, ref = slot * 2^32 + index: `slot` numbers the tiles in load order,
// `index` is the feature's position in its tile. Features that span tiles are stored in every tile they
// touch; the copy in the earliest-loaded tile is canonical and the others are flagged F_DUPLICATE, so a
// scan over all tiles sees each feature once. Lookups by type and ID use a sorted Float64Array per type
// (id * MAX_SLOTS + slot), rebuilt after tiles are added: no per-feature objects or string keys.

const { tileBounds } = __m["bundle.js"];
const { decodeTile, F_DUPLICATE, TYPES, TYPE_INDEX } = __m["tes.js"];

const SLOT = 2 ** 32;
const MAX_SLOTS = 65536;              // id * MAX_SLOTS stays exact for IDs below 1.37e11

class TileStore {
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

function typeBegin(t, type) { return type === 0 ? 0 : type === 1 ? t.wayStart : t.relStart; }
function typeEnd(t, type) { return type === 0 ? t.wayStart : type === 1 ? t.relStart : t.n; }

/** Index of a feature in a tile (IDs ascend within each type), or -1. */
function findIn(t, type, id) {
  let lo = typeBegin(t, type), hi = typeEnd(t, type);
  const ids = t.ids;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ids[mid] < id) lo = mid + 1; else hi = mid; }
  return lo < typeEnd(t, type) && ids[lo] === id ? lo : -1;
}


return { TileStore, typeBegin, typeEnd };
})();
// ---- spatial.js
__m["spatial.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// A spatial index per tile: a grid over the tile's extent with every feature filed under the cells its
// bounding box covers (Mercator). Built lazily on the first spatial query against the tile.
//
//   - Features that reach outside the tile (multi-tile features are stored whole in each tile they touch)
//     are filed under their cells clamped to the tile and also go on an overflow list, which a query
//     checks only when its box reaches outside the tile: such a box still finds the canonical copy,
//     which may live in this tile.
//   - Features covering many cells, and nodes without a stored point, go on the "large" list, checked
//     by every query.
//   - `extent` is the union of all features' boxes: a tile whose extent misses the query box is skipped.

const MAX_CELLS_PER_FEATURE = 16;

function featureBox(t, i, out) {
  if (i < t.wayStart) {
    if (t.ptOff[i + 1] === t.ptOff[i]) return false;
    const x = t.xy[2 * t.ptOff[i]], y = t.xy[2 * t.ptOff[i] + 1];
    out[0] = x; out[1] = y; out[2] = x; out[3] = y;
    return true;
  }
  const k = 4 * (i - t.wayStart), b = t.bbox;
  out[0] = b[k]; out[1] = b[k + 1]; out[2] = b[k + 2]; out[3] = b[k + 3];
  return true;
}

function tileIndex(t) {
  if (t.grid) return t.grid;
  const n = t.n, tb = t.bounds;
  const G = Math.max(4, Math.min(64, Math.round(Math.sqrt(n / 24))));
  const w = (tb.maxX - tb.minX + 1) / G, h = (tb.maxY - tb.minY + 1) / G;
  const col = (x) => Math.max(0, Math.min(G - 1, Math.floor((x - tb.minX) / w)));
  const row = (y) => Math.max(0, Math.min(G - 1, Math.floor((y - tb.minY) / h)));
  const counts = new Int32Array(G * G + 1);
  const big = [], over = [];
  const bx = new Int32Array(4);
  let eMinX = Infinity, eMinY = Infinity, eMaxX = -Infinity, eMaxY = -Infinity;
  const cells = new Int32Array(4 * n);           // c0, r0, c1, r1 per feature, -1 = not in the grid
  for (let i = 0; i < n; i++) {
    if (!featureBox(t, i, bx)) { big.push(i); cells[4 * i] = -1; continue; }
    if (bx[0] < eMinX) eMinX = bx[0]; if (bx[1] < eMinY) eMinY = bx[1]; if (bx[2] > eMaxX) eMaxX = bx[2]; if (bx[3] > eMaxY) eMaxY = bx[3];
    const outside = bx[0] < tb.minX || bx[1] < tb.minY || bx[2] > tb.maxX || bx[3] > tb.maxY;
    if (outside) over.push(i);
    const c0 = col(bx[0]), c1 = col(bx[2]), r0 = row(bx[1]), r1 = row(bx[3]);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_FEATURE) { big.push(i); if (outside) over.pop(); cells[4 * i] = -1; continue; }
    cells[4 * i] = c0; cells[4 * i + 1] = r0; cells[4 * i + 2] = c1; cells[4 * i + 3] = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * G + c + 1]++;
  }
  for (let k = 1; k <= G * G; k++) counts[k] += counts[k - 1];
  const items = new Int32Array(counts[G * G]);
  const fill = counts.slice(0, G * G);
  for (let i = 0; i < n; i++) {
    const c0 = cells[4 * i];
    if (c0 < 0) continue;
    const r0 = cells[4 * i + 1], c1 = cells[4 * i + 2], r1 = cells[4 * i + 3];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) items[fill[r * G + c]++] = i;
  }
  t.grid = { G, col, row, start: counts, items, big: Int32Array.from(big), over: Int32Array.from(over),
    extent: { minX: eMinX, minY: eMinY, maxX: eMaxX, maxY: eMaxY }, stamp: new Int32Array(n), mark: 0 };
  return t.grid;
}

const meets = (b, minX, minY, maxX, maxY) => !(maxX < b.minX || minX > b.maxX || maxY < b.minY || minY > b.maxY);

/**
 * Calls fn(i) once for every feature of tile t whose bounding box may meet `box` (a superset: callers
 * still test exactly). Features without a box are always included.
 */
/** Does feature i's bounding box meet the box? */
function featureMeetsBox(t, i, box) {
  const bx = (featureMeetsBox.bx ??= new Int32Array(4));
  return featureBox(t, i, bx) && meets(box, bx[0], bx[1], bx[2], bx[3]);
}

/** Roughly how many of tile t's features lie in the box (its share of the tile's area). */
function featuresInBoxEstimate(t, box) {
  const tb = t.bounds;
  const w = Math.min(box.maxX, tb.maxX) - Math.max(box.minX, tb.minX), h = Math.min(box.maxY, tb.maxY) - Math.max(box.minY, tb.minY);
  if (w < 0 || h < 0) return 0;
  return t.n * Math.min(1, ((w + 1) * (h + 1)) / ((tb.maxX - tb.minX + 1) * (tb.maxY - tb.minY + 1)));
}

/** The big list's features that meet the box; those without a box (no location) always. */
function visitBig(t, g, box, visit) {
  const bx = new Int32Array(4);
  for (const i of g.big) if (!featureBox(t, i, bx) || meets(box, bx[0], bx[1], bx[2], bx[3])) visit(i);
}

function forEachInBox(t, box, fn) {
  const g = tileIndex(t);
  if (g.extent.minX === Infinity && !g.big.length) return;
  if (!meets(box, g.extent.minX, g.extent.minY, g.extent.maxX, g.extent.maxY) && !g.big.length) return;
  if (++g.mark === 2 ** 31 - 1) { g.stamp.fill(0); g.mark = 1; }
  const mark = g.mark, stamp = g.stamp;
  const visit = (i) => { if (stamp[i] !== mark) { stamp[i] = mark; fn(i); } };
  visitBig(t, g, box, visit);
  const tb = t.bounds;
  if (box.minX < tb.minX || box.minY < tb.minY || box.maxX > tb.maxX || box.maxY > tb.maxY) {
    const bx = new Int32Array(4);
    for (const i of g.over) { featureBox(t, i, bx); if (meets(box, bx[0], bx[1], bx[2], bx[3])) visit(i); }
  }
  if (!meets(box, tb.minX, tb.minY, tb.maxX, tb.maxY)) return;
  const c0 = g.col(box.minX), c1 = g.col(box.maxX), r0 = g.row(box.minY), r1 = g.row(box.maxY);
  const { start, items, G } = g;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * G + c;
      for (let k = start[cell], end = start[cell + 1]; k < end; k++) visit(items[k]);
    }
  }
}

/**
 * forEachInBox for many boxes at once (e.g. thousands of nodes): the big and overflow lists are walked
 * once (overflow features against the boxes' union) and each grid cell once. Also a superset.
 */
function forEachInBoxes(t, boxes, fn) {
  if (boxes.length === 1) return forEachInBox(t, boxes[0], fn);
  if (!boxes.length) return;
  const g = tileIndex(t);
  const u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const b of boxes) {
    if (b.minX < u.minX) u.minX = b.minX; if (b.minY < u.minY) u.minY = b.minY;
    if (b.maxX > u.maxX) u.maxX = b.maxX; if (b.maxY > u.maxY) u.maxY = b.maxY;
  }
  if (!g.big.length && (g.extent.minX === Infinity || !meets(u, g.extent.minX, g.extent.minY, g.extent.maxX, g.extent.maxY))) return;
  if (++g.mark === 2 ** 31 - 1) { g.stamp.fill(0); g.mark = 1; }
  const mark = g.mark, stamp = g.stamp;
  const visit = (i) => { if (stamp[i] !== mark) { stamp[i] = mark; fn(i); } };
  visitBig(t, g, u, visit);
  const tb = t.bounds, { start, items, G } = g;
  if (u.minX < tb.minX || u.minY < tb.minY || u.maxX > tb.maxX || u.maxY > tb.maxY) {
    const bx = new Int32Array(4);
    for (const i of g.over) { featureBox(t, i, bx); if (meets(u, bx[0], bx[1], bx[2], bx[3])) visit(i); }
  }
  if (!meets(u, tb.minX, tb.minY, tb.maxX, tb.maxY)) return;
  const seen = new Uint8Array(G * G);
  for (const b of boxes) {
    if (!meets(b, tb.minX, tb.minY, tb.maxX, tb.maxY)) continue;
    const c0 = g.col(b.minX), c1 = g.col(b.maxX), r0 = g.row(b.minY), r1 = g.row(b.maxY);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const cell = r * G + c;
      if (seen[cell]) continue;
      seen[cell] = 1;
      for (let k = start[cell], end = start[cell + 1]; k < end; k++) visit(items[k]);
    }
  }
}

return { tileIndex, featureMeetsBox, featuresInBoxEstimate, forEachInBox, forEachInBoxes };
})();
// ---- ovindex.js
__m["ovindex.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass's quadtile index arithmetic, ported from osm_bypass/overpass_index.py, itself a port of Overpass
// API core/index_computations.h (Copyright (C) 2008-2018 Roland Olbricht et al., AGPL-3.0-or-later).
// Nodes are stored by a 32-bit quadtile of their position, ways and relations by calc_index of their
// nodes' quadtiles; that is Overpass's storage order (`out qt`). All values are unsigned 32-bit.

const u = (x) => x >>> 0;

function spread(x) {
  x = u(x & 0xffff0000);
  x = u(x | (x >>> 8)); x = u(x & 0xff00ff00);
  x = u(x | (x >>> 4)); x = u(x & 0xf0f0f0f0);
  x = u(x | (x >>> 2)); x = u(x & 0xcccccccc);
  x = u(x | (x >>> 1)); x = u(x & 0xaaaaaaaa);
  return x;
}

const llUpper = (ilat, ilon) => u(spread(u(ilat)) | (spread(u(ilon)) >>> 1));

/** Overpass's ll_upper_(lat, lon) ^ 0x40000000: the node index `out qt` sorts by. */
function quadtile(lat, lon) {
  const ilat = Math.trunc((lat + 91.0) * 10000000 + 0.5);
  const ilon = Math.trunc(lon * 10000000 + (lon > 0 ? 0.5 : -0.5));
  return u(llUpper(ilat, ilon) ^ 0x40000000);
}

function upper(q, shift) {
  let r = u((q >>> shift) & 0x55555555);
  r = u(r | (r >>> 1)); r = u(r & 0x33333333);
  r = u(r | (r >>> 2)); r = u(r & 0x0f0f0f0f);
  r = u(r | (r >>> 4)); r = u(r & 0x00ff00ff);
  r = u(r | (r >>> 8));
  return r & 0xffff;
}
const upperIlat = (q) => upper(u(q & 0xaaaaaaaa), 1);
const upperIlon = (q) => upper(u(q & 0x55555555), 0);

const LEVELS = [[0x01, 0x2aaaaaa8, 0x55555554, 0x3], [0x02, 0x2aaaaa80, 0x55555540, 0xf],
  [0x04, 0x2aaaa800, 0x55555400, 0x3f], [0x08, 0x2aaa8000, 0x55554000, 0xff],
  [0x10, 0x2aa80000, 0x55540000, 0x3ff], [0x20, 0x2a800000, 0x55400000, 0xfff],
  [0x40, 0x28000000, 0x54000000, 0x3fff]];

function flaggedBox(i) {
  for (const [bit, lam, lom, add] of LEVELS) {
    if (i & bit) {
      const la = u(i & lam), lo = u(i & lom);
      return [la, lo, llUpper(u((upperIlat(la) + add) * 65536), 0), llUpper(0, u((upperIlon(lo) + add) * 65536))];
    }
  }
  return null;
}

const STEPS = [[0xfffe, 4, 0xfffffffc, 0x80000001], [0xfff8, 0x10, 0xffffffc0, 0x80000002],
  [0xffe0, 0x40, 0xfffffc00, 0x80000004], [0xff80, 0x100, 0xffffc000, 0x80000008],
  [0xfe00, 0x400, 0xfffc0000, 0x80000010], [0xf800, 0x1000, 0xffc00000, 0x80000020],
  [0xe000, 0x4000, 0xfc000000, 0x80000040]];

/** Port of Overpass's calc_index(): the storage index of a way or relation from its nodes' indexes. */
function calcIndex(idxs) {
  if (!idxs.length) return 0xfe;
  const first = idxs[0];
  let latMin, lonMin, latMax, lonMax;
  if (first & 0x80000000) {
    const b = flaggedBox(first);
    if (!b) return 0x80000080;
    [latMin, lonMin, latMax, lonMax] = b;
  } else {
    latMin = latMax = u(first & 0x2aaaaaaa);
    lonMin = lonMax = u(first & 0x55555555);
  }
  for (let k = 1; k < idxs.length; k++) {
    const i = idxs[k];
    if (i & 0x80000000) {
      const b = flaggedBox(i);
      if (!b) return 0x80000080;
      const [la, lo, laU, loU] = b;
      latMin = Math.min(latMin, la); latMax = Math.max(latMax, laU);
      lonMin = Math.min(lonMin, lo); lonMax = Math.max(lonMax, loU);
    } else {
      const la = u(i & 0x2aaaaaaa), lo = u(i & 0x55555555);
      if (la < latMin) latMin = la; else if (la > latMax) latMax = la;
      if (lo < lonMin) lonMin = lo; else if (lo > lonMax) lonMax = lo;
    }
  }
  if (latMax === latMin && lonMax === lonMin) return first;
  const a = upperIlat(latMin), b = upperIlat(latMax), c = upperIlon(lonMin), d = upperIlon(lonMax);
  const base = u(lonMin | latMin);
  for (const [m, lim, keep, flag] of STEPS) {
    if ((b & m) - (a & m) < lim && (d & m) - (c & m) < lim) return u(u(base & keep) | flag);
  }
  return 0x80000080;
}

// ---- index ranges for a bbox (calc_ranges, calc_parents), used by `out geom(bbox)` to pick member ways

const i32 = (x) => x | 0;
const llu = (ilat, ilon) => u(llUpper(u(ilat), u(ilon)) ^ 0x40000000);

function recRanges(south, north, west, east, bitlevel, out) {
  let dist = u(u(0xffff0000 >>> bitlevel) & 0xffff0000);
  if (u(south + dist) === north && i32(west + dist) === i32(east)) { out.push([llu(south, west), u(llu(north, east) + 1)]); return; }
  dist = u(u(dist >>> 1) & 0xffff0000);
  if (u(north | dist) !== u(south | dist)) {
    if (u(u(east) | dist) !== u(u(west) | dist)) {
      recRanges(south, u(south | dist), west, i32(west | dist), bitlevel + 1, out);
      recRanges(south, u(south | dist), i32((west | dist) + 0x10000), east, bitlevel + 1, out);
      recRanges(u(u(south | dist) + 0x10000), north, west, i32(west | dist), bitlevel + 1, out);
      recRanges(u(u(south | dist) + 0x10000), north, i32((west | dist) + 0x10000), east, bitlevel + 1, out);
    } else {
      recRanges(south, u(south | dist), west, east, bitlevel + 1, out);
      recRanges(u(u(south | dist) + 0x10000), north, west, east, bitlevel + 1, out);
    }
  } else if (u(u(east) | dist) !== u(u(west) | dist)) {
    recRanges(south, north, west, i32(west | dist), bitlevel + 1, out);
    recRanges(south, north, i32((west | dist) + 0x10000), east, bitlevel + 1, out);
  } else recRanges(south, north, west, east, bitlevel + 1, out);
}

function mergeRanges(rs, key = (v) => v) {
  rs = [...rs].sort((a, b) => key(a[0]) - key(b[0]) || key(a[1]) - key(b[1]));
  const out = [];
  for (const [lo, hi] of rs) {
    if (out.length && !(key(out[out.length - 1][1]) < key(lo))) { if (key(hi) > key(out[out.length - 1][1])) out[out.length - 1] = [out[out.length - 1][0], hi]; }
    else out.push([lo, hi]);
  }
  return out;
}

function calcRanges(south, north, west, east) {
  const s = u(u(Math.trunc((south + 91.0) * 10000000 + 0.5)) & 0xffff0000);
  const n = u(u(Math.trunc((north + 91.0) * 10000000 + 0.5)) & 0xffff0000);
  const w = i32(Math.trunc(west * 10000000 + (west > 0 ? 0.5 : -0.5)) & 0xffff0000);
  const e = i32(Math.trunc(east * 10000000 + (east > 0 ? 0.5 : -0.5)) & 0xffff0000);
  const out = [];
  if (west <= east) {
    if (west < 0 && 0 <= east) { recRanges(s, n, 0, e, 1, out); recRanges(s, n, w, i32(0xffff0000), 1, out); }
    else recRanges(s, n, w, e, 1, out);
  } else {
    const e180 = i32(Math.trunc(180.0 * 10000000 + 0.5) & 0xffff0000), w180 = i32(Math.trunc(-180.0 * 10000000 - 0.5) & 0xffff0000);
    if (west < 0) { recRanges(s, n, w, i32(0xffff0000), 1, out); recRanges(s, n, 0, e180, 1, out); }
    else recRanges(s, n, w, e180, 1, out);
    if (east > 0) { recRanges(s, n, w180, i32(0xffff0000), 1, out); recRanges(s, n, 0, e, 1, out); }
    else recRanges(s, n, w180, e, 1, out);
  }
  return mergeRanges(out);
}

function decomp(lo, hi, out) {
  const steps = [0x3, 0xf, 0x3f, 0xff, 0x3ff, 0xfff, 0x3fff, 0xffff, 0x3ffff, 0xfffff, 0x3fffff, 0xffffff, 0x3ffffff, 0xfffffff, 0x3fffffff];
  while (lo < hi) {
    let up = null, size = 1;
    for (const mask of steps) {
      if ((lo % (mask + 1)) !== 0 || lo + mask + 1 > hi) { up = lo + size; break; }
      size = mask + 1;
    }
    if (up === null) up = lo + 0x40000000;
    out.push([lo, up]);
    lo = up;
  }
}

const u31key = (v) => (v & 0x7fffffff) * 4294967296 + u(v);

function blur(distance, bitmask, lower, upper, out) {
  const sb = 0x10000 - distance;
  const minLat = upperIlat(lower) & sb, minLon = upperIlon(lower) & sb, maxLat = upperIlat(upper) & sb, maxLon = upperIlon(upper) & sb;
  const push = (idx) => out.push([idx, (idx + 1) & 0x7fffffff]);
  let lat = u(minLat - distance);
  while (lat <= maxLat) {
    push(u(llUpper(u(lat * 65536), u((minLon - distance) * 65536)) | bitmask));
    lat = u(lat + distance);
    if (lat === 0) break;
  }
  for (let lon = minLon; lon <= maxLon; lon += distance) push(u(llUpper(u((minLat - distance) * 65536), u(lon * 65536)) | bitmask));
  push(u(llUpper(u(maxLat * 65536), u(maxLon * 65536)) | bitmask));
}

function calcParents(nodeRanges) {
  const dec = [];
  for (const [lo, hi] of nodeRanges) decomp(lo, hi, dec);
  const out = [[0x80000080, 0x80000081]];
  for (const [lo, hi] of dec) {
    out.push([lo, hi]);
    for (const [dist, bit, mask] of [[2, 0x80000001, 0x7ffffffc], [8, 0x80000002, 0x7fffffc0], [0x20, 0x80000004, 0x7ffffc00],
      [0x80, 0x80000008, 0x7fffc000], [0x200, 0x80000010, 0x7ffc0000], [0x800, 0x80000020, 0x7fc00000], [0x2000, 0x80000040, 0x7c000000]]) {
      blur(dist, bit, u(lo & mask), u(u(hi - 1) & mask), out);
    }
  }
  return mergeRanges(out, u31key);
}

function inU31Ranges(idx, ranges) {
  const k = u31key(idx);
  return ranges.some(([lo, hi]) => u31key(lo) <= k && k < u31key(hi));
}

return { quadtile, calcIndex, calcRanges, calcParents, inU31Ranges };
})();
// ---- areas.js
__m["areas.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Area tests for `(area)` filters, `is_in` and the geocoder.
//
// ClosedWayArea is a port of osm_bypass/area_tests.py, itself a port of the point and segment tests in
// Overpass API data/tilewise_geometry.h and statements/area_query.cc (Copyright (C) 2008-2018 Roland
// Olbricht et al., AGPL-3.0-or-later): closed ways as areas, in Overpass's integer coordinates
// (ilat = (lat + 91)·10⁷, ilon = lon·10⁷), with the same double arithmetic as the Python port.
//
// PolygonArea stands in for what the Python engine does with shapely on GeoDesk's assembled relation
// polygons (Mercator): rings joined from the member ways, even-odd containment, and
//   - a point meets the area when it is inside or on the border (shapely intersects);
//   - a line meets it when its interior meets the area's interior (relate "T********"): a vertex strictly
//     inside, a proper crossing of the border, or a stretch between touching points that lies inside.

const OUTSIDE = 0, INSIDE = 1, BORDER = 2;

// ---- closed ways, Overpass's own tests -----------------------------------------------------------------

const segment = (a, b) => (a[1] < b[1] ? [a[0], a[1], b[0], b[1]] : [b[0], b[1], a[0], a[1]]);
const cdiv2 = (v) => (v >= 0 ? Math.floor(v / 2) : -Math.floor(-v / 2));

class ClosedWayArea {
  /** pts: the closed way's points as [ilat, ilon], the closing point included. */
  constructor(pts) {
    this.segments = [];
    for (let k = 0; k + 1 < pts.length; k++) this.segments.push(segment(pts[k], pts[k + 1]));
    if (pts.length) {
      let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
      for (const [la, lo] of pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
      this.bounds = [s, w, n, e];
    } else this.bounds = [0, 0, -1, -1];
  }

  near(lat, lon) { const [s, w, n, e] = this.bounds; return s <= lat && lat <= n && w <= lon && lon <= e; }

  /** rel_pos_ilat_ilon: a vertical ray from the point southwards, edges half-open [west, east). */
  point(latP, lonP) {
    let inside = false;
    for (const [latW, lonW, latE, lonE] of this.segments) {
      if (lonW === lonP) {
        if (latW === latP) return BORDER;
        if (lonW === lonE) {
          if (Math.min(latW, latE) <= latP && latP <= Math.max(latW, latE)) return BORDER;
        } else inside = inside !== (latW < latP);
      } else if (lonE === lonP) {
        if (latE === latP) return BORDER;
      } else if (lonW < lonP && lonP < lonE) {
        const isect = latW + (lonP - lonW) * (latE - latW) / (lonE - lonW);
        if (isect - 0.5 < latP) {
          if (latP < isect + 0.5) return BORDER;
          inside = !inside;
        }
      }
    }
    return inside ? INSIDE : OUTSIDE;
  }

  /** rel_position(idx, segment, block): a proper crossing, or a touching midpoint strictly inside. */
  segmentInside(seg) {
    const [sLatW, sLonW, sLatE, sLonE] = seg;
    const dLon = sLonE - sLonW, dLat = sLatE - sLatW;
    const touching = [];
    for (const [aLatW, aLonW, aLatE, aLonE] of this.segments) {
      if (!(aLonW <= sLonE && sLonW <= aLonE)) continue;
      const scalAW = (aLatW - sLatW) * dLon - (aLonW - sLonW) * dLat;
      const scalAE = (aLatE - sLatW) * dLon - (aLonE - sLonW) * dLat;
      if (scalAE * scalAW > 0) continue;
      const aDLon = aLonE - aLonW, aDLat = aLatE - aLatW;
      const scalSW = (sLatW - aLatW) * aDLon - (sLonW - aLonW) * aDLat;
      const scalSE = (sLatE - aLatW) * aDLon - (sLonE - aLonW) * aDLat;
      if (scalSE * scalSW > 0) continue;
      if (scalAW === 0) {
        touching.push([aLatW, aLonW]);
        if (scalAE === 0) touching.push([aLatE, aLonE]);
      } else if (scalAE === 0) touching.push([aLatE, aLonE]);
      else if (scalSW === 0) touching.push([sLatW, sLonW]);
      else if (scalSE !== 0) return true;
    }
    if (!touching.length) return false;
    const uniq = new Map();
    for (const p of [...touching, [sLatW, sLonW], [sLatE, sLonE]]) uniq.set(p[0] + ',' + p[1], p);
    const pts = [...uniq.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      if (this.point(Math.floor((a[0] + b[0]) / 2), cdiv2(a[1] + b[1])) === INSIDE) return true;
    }
    return false;
  }

  containsNode(lat, lon, acceptBorder) {
    if (!this.near(lat, lon)) return false;
    const pos = this.point(lat, lon);
    return pos === INSIDE || (acceptBorder && pos === BORDER);
  }

  /** pts: the way's integer points. ways_contained_in: endpoints, then edges. */
  containsWay(pts) {
    if (!pts.length) return false;
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const [la, lo] of pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
    const [bs, bw, bn, be] = this.bounds;
    if (n < bs || s > bn || e < bw || w > be) return false;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      if (this.point(a[0], a[1]) === INSIDE || this.point(b[0], b[1]) === INSIDE) return true;
      if (this.segmentInside(segment(a, b))) return true;
    }
    return pts.length === 1 && this.point(pts[0][0], pts[0][1]) === INSIDE;
  }
}

// ---- relation areas: polygons from member ways -----------------------------------------------------------

/** Joins lines ([[x, y], ...]) into closed rings by their end points; lines that don't close are dropped. */
function assembleRings(lines) {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const rings = [], open = [];
  for (const l of lines) {
    if (l.length < 2) continue;
    if (same(l[0], l[l.length - 1])) { if (l.length >= 4) rings.push(l); } else open.push(l.slice());
  }
  const key = (p) => p[0] + ',' + p[1];
  while (open.length) {
    let cur = open.pop();
    let grown = true;
    while (grown && !same(cur[0], cur[cur.length - 1])) {
      grown = false;
      const end = key(cur[cur.length - 1]), start = key(cur[0]);
      for (let k = 0; k < open.length; k++) {
        const l = open[k], a = key(l[0]), b = key(l[l.length - 1]);
        if (a === end) cur = cur.concat(l.slice(1));
        else if (b === end) cur = cur.concat(l.slice(0, -1).reverse());
        else if (b === start) cur = l.concat(cur.slice(1));
        else if (a === start) cur = l.slice().reverse().concat(cur.slice(1));
        else continue;
        open.splice(k, 1); grown = true; break;
      }
    }
    if (same(cur[0], cur[cur.length - 1]) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

/** Signed area of a ring (shoelace), in coordinate units squared. */
function ringArea(r) {
  let a = 0;
  for (let k = 0; k + 1 < r.length; k++) a += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
  return a / 2;
}

const BANDS = 256;

class PolygonArea {
  /** rings: closed rings of [x, y] (Mercator), outer and inner alike (even-odd). */
  constructor(rings) {
    this.rings = rings;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const edges = [];
    for (const r of rings) {
      for (let k = 0; k + 1 < r.length; k++) {
        const [x1, y1] = r[k], [x2, y2] = r[k + 1];
        if (x1 === x2 && y1 === y2) continue;
        edges.push([x1, y1, x2, y2]);
        minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2); minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
      }
    }
    this.box = { minX, minY, maxX, maxY };
    // edges by horizontal band, so a point or segment only looks at the edges at its height
    this.h = Math.max(1, (maxY - minY) / BANDS);
    this.bands = Array.from({ length: BANDS }, () => []);
    for (const e of edges) {
      const b0 = this.band(Math.min(e[1], e[3])), b1 = this.band(Math.max(e[1], e[3]));
      for (let b = b0; b <= b1; b++) this.bands[b].push(e);
    }
  }

  band(y) { return Math.max(0, Math.min(BANDS - 1, Math.floor((y - this.box.minY) / this.h))); }

  inBox(x, y) { const b = this.box; return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY; }

  /** OUTSIDE, INSIDE or BORDER (even-odd over all rings; a horizontal ray to the east). */
  pointPos(px, py) {
    if (!this.inBox(px, py)) return OUTSIDE;
    let inside = false;
    for (const [x1, y1, x2, y2] of this.bands[this.band(py)]) {
      const ax = x1 - px, ay = y1 - py, bx = x2 - px, by = y2 - py;   // relative: keeps products exact
      const cross = ax * by - ay * bx;
      if (cross === 0 && Math.min(ax, bx) <= 0 && Math.max(ax, bx) >= 0 && Math.min(ay, by) <= 0 && Math.max(ay, by) >= 0) return BORDER;
      if ((ay > 0) !== (by > 0)) {
        // x of the crossing > 0  <=>  cross has the sign of (by - ay)
        if ((by > ay) ? cross > 0 : cross < 0) inside = !inside;
      }
    }
    return inside ? INSIDE : OUTSIDE;
  }

  /** Does a polyline's interior meet the area's interior? pts: [[x, y], ...] (one point: is it strictly inside). */
  lineInterior(pts) {
    if (pts.length === 1) return this.pointPos(pts[0][0], pts[0][1]) === INSIDE;
    for (const [x, y] of pts) if (this.pointPos(x, y) === INSIDE) return true;
    const b = this.box;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      if (Math.max(ax, bx) < b.minX || Math.min(ax, bx) > b.maxX || Math.max(ay, by) < b.minY || Math.min(ay, by) > b.maxY) continue;
      const dx = bx - ax, dy = by - ay;
      const ts = [0, 1];
      const b0 = this.band(Math.min(ay, by)), b1 = this.band(Math.max(ay, by));
      const seen = new Set();
      for (let bb = b0; bb <= b1; bb++) {
        for (const e of this.bands[bb]) {
          if (seen.has(e)) continue;
          seen.add(e);
          const [x1, y1, x2, y2] = e;
          if (Math.max(x1, x2) < Math.min(ax, bx) || Math.min(x1, x2) > Math.max(ax, bx)) continue;
          // relative to the segment's start
          const px = x1 - ax, py = y1 - ay, qx = x2 - ax, qy = y2 - ay;
          const c1 = dx * py - dy * px, c2 = dx * qy - dy * qx;           // edge ends vs the segment's line
          if (c1 * c2 > 0) continue;
          const ex = qx - px, ey = qy - py;
          const c3 = ex * (0 - py) - ey * (0 - px), c4 = ex * (dy - py) - ey * (dx - px);   // segment ends vs edge line
          if (c3 * c4 > 0) continue;
          if (c1 !== 0 && c2 !== 0 && c3 !== 0 && c4 !== 0) return true;   // a proper crossing
          const len2 = dx * dx + dy * dy;
          const tOf = (x, y) => (x * dx + y * dy) / len2;
          if (c1 === 0 && c2 === 0) {                                      // collinear: overlap ends
            ts.push(tOf(px, py), tOf(qx, qy));
          } else if (c1 === 0) ts.push(tOf(px, py));
          else if (c2 === 0) ts.push(tOf(qx, qy));
          // c3 or c4 = 0: a segment end on the edge, already in ts
        }
      }
      const sorted = ts.filter(t => t >= 0 && t <= 1).sort((p, q) => p - q);
      for (let j = 0; j + 1 < sorted.length; j++) {
        if (sorted[j + 1] - sorted[j] < 1e-12) continue;
        const t = (sorted[j] + sorted[j + 1]) / 2;
        if (this.pointPos(ax + dx * t, ay + dy * t) === INSIDE) return true;
      }
    }
    return false;
  }

  /** Does a polyline touch the area at all (inside or on the border; shapely intersects)? */
  lineMeets(pts) {
    for (const [x, y] of pts) if (this.pointPos(x, y) !== OUTSIDE) return true;
    const b = this.box;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      if (Math.max(ax, bx) < b.minX || Math.min(ax, bx) > b.maxX || Math.max(ay, by) < b.minY || Math.min(ay, by) > b.maxY) continue;
      const dx = bx - ax, dy = by - ay;
      for (let bb = this.band(Math.min(ay, by)), b1 = this.band(Math.max(ay, by)); bb <= b1; bb++) {
        for (const [x1, y1, x2, y2] of this.bands[bb]) {
          if (Math.max(x1, x2) < Math.min(ax, bx) || Math.min(x1, x2) > Math.max(ax, bx)) continue;
          const px = x1 - ax, py = y1 - ay, qx = x2 - ax, qy = y2 - ay;
          const c1 = dx * py - dy * px, c2 = dx * qy - dy * qx;
          if (c1 * c2 > 0) continue;
          const ex = qx - px, ey = qy - py;
          const c3 = ex * (0 - py) - ey * (0 - px), c4 = ex * (dy - py) - ey * (dx - px);
          if (c3 * c4 > 0) continue;
          if (c1 === 0 && c2 === 0) {                    // collinear: do the projections overlap?
            if (Math.max(Math.min(px, qx), Math.min(0, dx)) <= Math.min(Math.max(px, qx), Math.max(0, dx)) &&
                Math.max(Math.min(py, qy), Math.min(0, dy)) <= Math.min(Math.max(py, qy), Math.max(0, dy))) return true;
            continue;
          }
          return true;
        }
      }
    }
    return false;
  }

  /** Area with holes: rings inside an odd number of other rings count negative. */
  area() {
    let total = 0;
    for (const r of this.rings) {
      const depth = this.rings.filter(o => o !== r && new PolygonArea([o]).pointPos(r[0][0], r[0][1]) === INSIDE).length;
      total += (depth % 2 ? -1 : 1) * Math.abs(ringArea(r));
    }
    return total;
  }
}

return { OUTSIDE, INSIDE, BORDER, ClosedWayArea, assembleRings, ringArea, PolygonArea };
})();
// ---- geometry.js
__m["geometry.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass's geometry model: a port of osm_bypass/geometry.py, itself a port of Overpass API
// core/geometry.cc and core/four_field_index.cc (Copyright (C) 2008-2018 Roland Olbricht et al.,
// AGPL-3.0-or-later). Geometries are what geom(), center(), trace(), hull(), gcat(), pt(), lstr() and poly()
// produce, what make/convert store under ::geom, and what lat(), lon(), length() and angle() read.
// Points are [lat, lon] arrays; [100, 200] marks an invalid point. The algorithms, thresholds and C
// integer arithmetic follow the C++ (and the Python port) line by line, so outputs are identical.

const INVALID = [100.0, 200.0];
const DEG = Math.acos(0) / 90.0;

// ---- C integer helpers
const u32 = (x) => x >>> 0;
const i32 = (x) => x | 0;
const ilat = (lat) => u32(Math.trunc((lat + 91.0) * 10000000 + 0.5));
const ilon = (lon) => i32(Math.trunc(lon * 10000000 + (lon > 0 ? 0.5 : -0.5)));
const latOf = (v) => u32(v) / 10000000 - 91.0;
const lonOf = (v) => i32(v) / 10000000;
const decoded = (lat, lon) => [latOf(ilat(lat)), lonOf(ilon(lon))];
const epsEqual = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const ptKey = (p) => p[0] + ',' + p[1];
const ptCmp = (a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : 0);

// ---- bounds
class Bbox {
  constructor(s, w, n, e) { this.south = s; this.west = w; this.north = n; this.east = e; }
  valid() { return -90 <= this.south && this.south <= this.north && this.north <= 90 && -180 <= this.east && this.east <= 180 && -180 <= this.west && this.west <= 180; }
  centerLat() { return (this.south + this.north) / 2; }
  centerLon() {
    if (this.west <= this.east) return (this.west + this.east) / 2;
    if ((this.west + this.east) / 2 <= 0) return (this.west + this.east) / 2 + 180.0;
    return (this.west + this.east) / 2 - 180.0;
  }
}
const invalidBbox = () => new Bbox(100.0, 200.0, 100.0, 200.0);

function boundsOfPoints(pts) {
  let s = 100.0, w = 200.0, n = -100.0, e = -200.0;
  for (const [la, lo] of pts) if (la < 100) { s = Math.min(s, la); w = Math.min(w, lo); n = Math.max(n, la); e = Math.max(e, lo); }
  if (n === -100.0) return invalidBbox();
  if (e - w > 180.0) {
    let ww = 180.0, we = -180.0;
    for (const [la, lo] of pts) if (la < 100) { if (lo > 0) ww = Math.min(ww, lo); else we = Math.max(we, lo); }
    if (ww - we > 180.0) return new Bbox(s, ww, n, we);
    return new Bbox(s, -180.0, n, 180.0);
  }
  return new Bbox(s, w, n, e);
}
const boundsOfLines = (lines) => boundsOfPoints(lines.flat());

function boundsOfComponents(comps) {
  let s = 100.0, w = 200.0, n = -100.0, e = -200.0, wrapped = false;
  for (const c of comps) if (c.hasBbox()) {
    s = Math.min(s, c.south()); n = Math.max(n, c.north()); w = Math.min(w, c.west()); e = Math.max(e, c.east());
    wrapped ||= c.east() < c.west();
  }
  if (n === -100.0) return invalidBbox();
  if (!wrapped && e - w <= 180) return new Bbox(s, w, n, e);
  w = 200; e = -200;
  for (const c of comps) {
    if (!c.hasBbox()) continue;
    if (c.east() <= 0) { e = Math.max(e, c.east()); if (c.west() >= 0) w = Math.min(w, c.west()); }
    else if (c.west() >= 0) w = Math.min(w, c.west());
    else return new Bbox(s, -180.0, n, 180.0);
  }
  if (w - e > 180) return new Bbox(s, w, n, e);
  return new Bbox(s, -180.0, n, 180.0);
}

// ---- geometry classes
class Geometry {
  get kind() { return 'null'; }
  hasCenter() { return false; } centerLat() { return 0.0; } centerLon() { return 0.0; }
  hasBbox() { return false; } south() { return 0.0; } north() { return 0.0; } west() { return 0.0; } east() { return 0.0; }
  hasLineGeometry() { return false; } line() { return null; }
  hasMultilineGeometry() { return false; } multiline() { return null; }
  hasComponents() { return false; } components() { return null; }
  hasFaithfulWayGeometry() { return false; } waySize() { return 0; } wayPosIsValid() { return false; } wayPos() { return [0, 0]; }
}
class Null extends Geometry {}
class Point extends Geometry {
  constructor(lat, lon) { super(); this.pt = [lat, lon]; }
  get kind() { return 'point'; }
  hasCenter() { return true; } centerLat() { return this.pt[0]; } centerLon() { return this.pt[1]; }
  hasBbox() { return true; } south() { return this.pt[0]; } north() { return this.pt[0]; } west() { return this.pt[1]; } east() { return this.pt[1]; }
}
class Bounded extends Geometry {
  b() { return this._b ??= this.bounds(); }
  centerLat() { return this.b().centerLat(); } centerLon() { return this.b().centerLon(); }
  south() { return this.b().south; } north() { return this.b().north; } west() { return this.b().west; } east() { return this.b().east; }
}
class Linestring extends Bounded {
  constructor(points) { super(); this.points = [...points]; }
  get kind() { return 'linestring'; }
  bounds() { return boundsOfPoints(this.points); }
  hasCenter() { return true; } hasBbox() { return true; }
  hasLineGeometry() { return true; } line() { return this.points; }
  hasFaithfulWayGeometry() { return true; } waySize() { return this.points.length; }
  wayPosIsValid(i) { return i < this.points.length; } wayPos(i) { return this.points[i]; }
}
class PartialWay extends Bounded {
  constructor(points = []) { super(); this.points = []; this.segments = []; this.hasCoords = false; for (const p of points) this.addPoint(p); }
  get kind() { return 'partial_way'; }
  addPoint(p) {
    this._b = undefined;
    if (p[0] < 100) {
      if (!this.points.length || this.points[this.points.length - 1][0] >= 100) this.segments.push([]);
      this.segments[this.segments.length - 1].push(p);
      this.hasCoords = true;
    }
    this.points.push(p);
  }
  bounds() { return boundsOfPoints(this.points); }
  hasCenter() { return this.hasCoords; }
  centerLat() { return this.hasCoords ? this.b().centerLat() : 0.0; } centerLon() { return this.hasCoords ? this.b().centerLon() : 0.0; }
  hasBbox() { return this.hasCoords; }
  hasLineGeometry() { return this.segments.length === 1; } line() { return this.segments.length === 1 ? this.segments[0] : null; }
  hasMultilineGeometry() { return true; } multiline() { return this.segments; }
  hasFaithfulWayGeometry() { return true; } waySize() { return this.points.length; }
  wayPosIsValid(i) { return i < this.points.length && this.points[i][0] < 100; } wayPos(i) { return this.points[i]; }
}
class FreePolygon extends Bounded {
  constructor(lines = []) { super(); this.lines = []; for (const ln of lines) this.addLinestring(ln, true); }
  get kind() { return 'free_polygon'; }
  addLinestring(ln, always = false) {
    if (!always && ln.length < 2) return;
    this._b = undefined;
    ln = [...ln];
    if (!same(ln[0], ln[ln.length - 1])) ln.push(ln[0]);
    this.lines.push(ln);
  }
  bounds() { return boundsOfLines(this.lines); }
  hasCenter() { return true; } hasBbox() { return true; }
  hasMultilineGeometry() { return true; } multiline() { return this.lines; }
}
class Compound extends Bounded {
  constructor(comps = []) { super(); this.comps = [...comps]; }
  get kind() { return 'compound'; }
  addComponent(g) { this._b = undefined; this.comps.push(g); }
  bounds() { return boundsOfComponents(this.comps); }
  hasCenter() { return this.b().valid(); } hasBbox() { return this.b().valid(); }
  hasComponents() { return true; } components() { return this.comps; }
}
class PartialRelation extends Compound {
  constructor() { super(); this.hasCoords = false; }
  get kind() { return 'partial_relation'; }
  addPlaceholder() { this.comps.push(new Null()); }
  addPoint(p) { this._b = undefined; if (p[0] < 100) { this.hasCoords = true; this.comps.push(new Point(p[0], p[1])); } else this.comps.push(new Null()); }
  startWay() { this.comps.push(new PartialWay()); }
  addWayPoint(p) { this._b = undefined; const c = this.comps[this.comps.length - 1]; if (c instanceof PartialWay) { this.hasCoords = true; c.addPoint(p); } }
  addWayPlaceholder() { const c = this.comps[this.comps.length - 1]; if (c instanceof PartialWay) c.addPoint(INVALID); }
  hasCenter() { return this.hasCoords && this.b().valid(); }
  centerLat() { return this.hasCoords ? this.b().centerLat() : 0.0; } centerLon() { return this.hasCoords ? this.b().centerLon() : 0.0; }
  hasBbox() { return this.hasCoords && this.b().valid(); }
}
class RHRPolygon extends Bounded {
  constructor(lines) { super(); this.lines = lines; }
  get kind() { return 'rhr_polygon'; }
  bounds() { return boundsOfLines(this.lines); }
  hasCenter() { return true; } hasBbox() { return true; }
  hasMultilineGeometry() { return true; } multiline() { return this.lines; }
}

const ZERO_QUAD = [-91.0, -214.7483648];   // what ::lat/::lon decode Quad_Coord(0, 0) -- a dropped point -- to

/** Bbox_Double::intersects (segment against box, 5e-8 tolerance). */
function bboxIntersects(bb, from, to) {
  const s = bb.south, w = bb.west, n = bb.north, e = bb.east;
  let flon = from[1], tlon = to[1];
  if (from[1] < 0 && to[1] - from[1] > 180) flon += 360;
  if (to[1] < 0 && from[1] - to[1] > 180) tlon += 360;
  let df = 0.0;
  if (from[0] + 5e-8 < s) {
    if (to[0] + 5e-8 < s) return false;
    if (to[0] - 5e-8 > from[0]) df = (tlon - flon) * (s - from[0]) / (to[0] - from[0]);
  } else if (from[0] - 5e-8 > n) {
    if (to[0] - 5e-8 > n) return false;
    if (to[0] + 5e-8 < from[0]) df = (tlon - flon) * (n - from[0]) / (to[0] - from[0]);
  }
  if (to[0] + 5e-8 < s && from[0] - 5e-8 > to[0]) tlon += (flon - tlon) * (s - to[0]) / (from[0] - to[0]);
  else if (to[0] - 5e-8 > n && from[0] + 5e-8 < to[0]) tlon += (flon - tlon) * (n - to[0]) / (from[0] - to[0]);
  flon += df;
  const lo = Math.min(flon, tlon), hi = Math.max(flon, tlon);
  if (w <= e) {
    if (hi < 180) return lo - 5e-8 <= e && hi + 5e-8 >= w;
    if (lo > 180) return lo - 5e-8 - 360 <= e && hi + 5e-8 - 360 >= w;
    return lo - 5e-8 <= e && hi + 5e-8 - 360 >= w;
  }
  if (hi < 180) return lo - 5e-8 <= e || hi + 5e-8 >= w;
  if (lo > 180) return lo - 5e-8 - 360 <= e || hi + 5e-8 - 360 >= w;
  return true;
}

// ---- length, trace, hull
function greatCircleDist(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0.0;
  let sp = Math.cos((lat2 - lat1) * DEG) + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * (Math.cos((lon2 - lon1) * DEG) - 1);
  if (sp > 1) sp = 1.0;
  return Math.acos(sp) * (10 * 1000 * 1000 / Math.acos(0));
}

function length(g) {
  let r = 0.0;
  if (g.hasComponents()) { for (const c of g.components()) r += c ? length(c) : 0.0; }
  else if (g.hasLineGeometry()) { const ln = g.line(); for (let k = 0; k + 1 < ln.length; k++) r += greatCircleDist(ln[k][0], ln[k][1], ln[k + 1][0], ln[k + 1][1]); }
  else if (g.hasFaithfulWayGeometry()) {
    for (let i = 1; i < g.waySize(); i++) if (g.wayPosIsValid(i - 1) && g.wayPosIsValid(i)) {
      const a = g.wayPos(i - 1), b = g.wayPos(i);
      r += greatCircleDist(a[0], a[1], b[0], b[1]);
    }
  }
  return r;
}

function collect(nodes, lines, g) {
  if (g.hasComponents()) { for (const c of g.components()) if (c) collect(nodes, lines, c); }
  else if (g.hasLineGeometry()) lines.push([...g.line()]);
  else if (g.hasMultilineGeometry()) for (const x of g.multiline()) lines.push([...x]);
  else if (g.hasCenter()) nodes.push([g.centerLat(), g.centerLon()]);
}

/** Linestring_Geometry_Ptr ordering key: size, then the points read from the smaller end. */
function lstrKey(pts) {
  const seq = ptCmp(pts[pts.length - 1], pts[0]) < 0 ? [...pts].reverse() : pts;
  return pts.length + '|' + seq.map(ptKey).join(';');
}

function makeTrace(g) {
  const nodes0 = [], lines = [];
  collect(nodes0, lines, g);
  const uniq = new Map();
  for (const p of nodes0) uniq.set(ptKey(p), p);
  const nodes = [...uniq.values()].sort(ptCmp);
  const count = new Map();
  const inc = (p, k) => count.set(ptKey(p), (count.get(ptKey(p)) ?? 0) + k);
  for (const p of nodes) inc(p, 1);
  for (const ln of lines) {
    if (!ln.length) continue;
    inc(ln[0], 2); inc(ln[ln.length - 1], 2);
    for (const p of ln.slice(1, -1)) inc(p, 1);
  }
  const res = new Compound();
  for (const p of nodes) res.addComponent(new Point(p[0], p[1]));
  const seen = new Set();
  const emit = (pts) => { const k = lstrKey(pts); if (!seen.has(k)) { seen.add(k); res.addComponent(new Linestring(pts)); } };
  for (const ln of lines) {
    if (!ln.length) continue;
    let pts = [ln[0]];
    for (const p of ln.slice(1, -1)) {
      if ((count.get(ptKey(p)) ?? 0) > 1) { pts.push(p); emit(pts); pts = []; }
      pts.push(p);
    }
    pts.push(ln[ln.length - 1]);
    emit(pts);
  }
  return res;
}

function collectPoints(nodes, g) {
  if (g.hasComponents()) { for (const c of g.components()) if (c) collectPoints(nodes, c); }
  else if (g.hasLineGeometry()) nodes.push(...g.line());
  else if (g.hasMultilineGeometry()) for (const ln of g.multiline()) nodes.push(...ln);
  else if (g.hasCenter()) nodes.push([g.centerLat(), g.centerLon()]);
}

class SV {                                         // Spherical_Vector
  constructor(x = 0.0, y = 0.0, z = 0.0) { this.x = x; this.y = y; this.z = z; }
  static of(pt) { const c = Math.cos(pt[0] * DEG); return new SV(Math.sin(pt[0] * DEG), c * Math.sin(pt[1] * DEG), c * Math.cos(pt[1] * DEG)); }
  static cross(a, b) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    const ln = Math.sqrt(x * x + y * y + z * z);
    if (ln === 0) return new SV(NaN, NaN, NaN);
    return new SV(x / ln, y / ln, z / ln);
  }
  dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
}
class Seg { constructor(ll, s) { this.ll = ll; this.s = s ?? SV.of(ll); this.edge = new SV(); } }

function makeHull(g) {
  const nodes0 = [];
  collectPoints(nodes0, g);
  nodes0.sort((a, b) => (a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const nodes = [];
  for (const p of nodes0) if (!nodes.length || !same(nodes[nodes.length - 1], p)) nodes.push(p);
  if (!nodes.length) return new Null();
  if (nodes.length === 1) return new Point(nodes[0][0], nodes[0][1]);
  if (nodes.length === 2) return new Linestring([...nodes, nodes[0]]);
  let minLat = [100, 0], maxLat = [-100, 0];
  for (const p of nodes) { if (p[0] < minLat[0]) minLat = p; if (p[0] > maxLat[0]) maxLat = p; }
  let maxDelta = nodes[0][1] + 360 - nodes[nodes.length - 1][1];
  let westEnd = nodes[0], eastEnd = nodes[nodes.length - 1];
  for (let i = 1; i < nodes.length; i++) {
    if (maxDelta < nodes[i][1] - nodes[i - 1][1]) { maxDelta = nodes[i][1] - nodes[i - 1][1]; westEnd = nodes[i]; eastEnd = nodes[i - 1]; }
  }
  let segs = [];
  const s = minLat, w = westEnd, n = maxLat, e = eastEnd;
  if (w[1] !== e[1]) segs = [new Seg(w), new Seg(e)];
  else if (n[0] !== s[0]) segs = [new Seg(s), new Seg(n)];
  if (segs.length) { segs[1].edge = SV.cross(segs[0].s, segs[1].s); segs[0].edge = SV.cross(segs[1].s, segs[0].s); }
  for (const rhs of nodes) {
    const sp = SV.of(rhs);
    let fi = 0;
    while (fi < segs.length && segs[fi].edge.dot(sp) < 1e-8) fi++;
    if (!(fi < segs.length && segs[fi].edge.dot(sp) >= 1e-8)) continue;
    let ti;
    if (segs[0].edge.dot(sp) >= 0) {
      fi = segs.length - 1;
      while (fi !== 0 && segs[fi].edge.dot(sp) >= 0) fi--;
      fi++;
      segs.splice(fi);
      ti = 0;
      while (ti < segs.length && segs[ti].edge.dot(sp) >= 0) ti++;
      ti--;
      fi = 0;
      segs[ti].edge = SV.cross(sp, segs[ti].s);
      if (fi === ti) segs.splice(fi, 0, new Seg(rhs, sp));
      else { fi++; segs.splice(fi, ti - fi); fi--; segs[fi] = new Seg(rhs, sp); }
    } else {
      ti = fi;
      while (ti < segs.length && segs[ti].edge.dot(sp) >= 0) ti++;
      ti--;
      while (fi !== 0 && segs[fi].edge.dot(sp) >= 0) fi--;
      fi++;
      segs[ti].edge = SV.cross(sp, segs[ti].s);
      if (fi === ti) segs.splice(fi, 0, new Seg(rhs, sp));
      else { fi++; segs.splice(fi, ti - fi); fi--; segs[fi] = new Seg(rhs, sp); }
    }
    if (fi === 0) segs[0].edge = SV.cross(segs[segs.length - 1].s, sp);
    else segs[fi].edge = SV.cross(segs[fi - 1].s, sp);
  }
  const line = segs.map(x => x.ll);
  if (line.length < 3) return new Linestring(line);
  return rhrPolygon(new FreePolygon([line]));
}

// ---- RHR polygon
function interpolationPoint(ox, oy, oz, lx, lz, factor, llon) {
  const sf = Math.sin(factor), cf = Math.cos(factor);
  const nx = sf * ox + cf * lx, ny = sf * oy, nz = sf * oz + cf * lz;
  const nlat = Math.asin(Math.max(-1.0, Math.min(1.0, nx))) / DEG;
  let nlon = Math.atan2(ny, nz) / DEG + llon;
  if (nlon < -180) nlon += 360; else if (nlon > 180) nlon -= 360;
  return [nlat, nlon];
}

class Collector {
  constructor(ox, oy, oz, lx, lz, dist, llon, target) {
    Object.assign(this, { ox, oy, oz, lx, lz, llon, target });
    const center = lx === 0 ? dist : Math.atan(ox / lx);
    const bounded = Math.max(Math.min(center, dist), 0);
    const ex = interpolationPoint(ox, oy, oz, lx, lz, bounded, llon);
    this.exGcLat = ex[0];
    this.acc = 0.0065536 * Math.cos(ex[0] * DEG);
    if (this.acc < 0.0016384 && center !== bounded) this.exGcLat = interpolationPoint(ox, oy, oz, lx, lz, center, llon)[0];
    this.center = bounded;
  }
  point(d) { this.target.push(interpolationPoint(this.ox, this.oy, this.oz, this.lx, this.lz, d, this.llon)); }
  sequence(from, to, step) {
    const n = Math.trunc((to - from) / step) + 1;
    for (let j = 1; j < n; j++) this.point(from + (to - from) * j / n);
  }
  collectCenter(from, to, divisor) {
    const thr = 0.0065536 / divisor;
    if (this.acc < thr && divisor < 65536) {
      const d = Math.acos(Math.sqrt(1 - 1 / divisor / divisor) / Math.sin(this.exGcLat * DEG));
      const bl = Math.max(Math.min(this.center - d, to), from);
      const br = Math.max(Math.min(this.center + d, to), from);
      this.sequence(from, bl, thr * DEG);
      if (0 < bl && bl < to) this.point(bl);
      this.collectCenter(bl, br, divisor * 4);
      if (0 < br && br < to) this.point(br);
      this.sequence(br, to, thr * DEG);
    } else {
      if (this.acc < 1e-9) this.acc = 1e-9;
      this.acc *= DEG;
      this.sequence(from, this.center, this.acc);
      if (from < this.center && this.center < to) this.point(this.center);
      this.sequence(this.center, to, this.acc);
    }
  }
}

function interpolateSegment(llat, llon, rlat, rlon, target) {
  if (Math.abs(rlat - llat) < 0.0065536 && Math.abs(rlon - llon) < 0.0065536) { target.push([rlat, rlon]); return; }
  if (Math.abs(rlon - llon) > 180) rlon = llon < 0 ? rlon - 360 : rlon + 360;
  if (Math.abs(rlon - llon) > 179.999999) {
    const pole = llat + rlat >= 0 ? 90.0 : -90.0;
    let n = Math.trunc(Math.abs(pole - llat) / 0.0065536) + 1;
    for (let j = 1; j < n; j++) target.push([llat + (pole - llat) * j / n, llon]);
    target.push([pole, llon]);
    n = Math.trunc(Math.abs(rlon - llon) / 0.0065536) + 1;
    for (let j = 1; j < n; j++) target.push([pole, llon + (rlon - llon) * j / n]);
    target.push([pole, rlon]);
    n = Math.trunc(Math.abs(rlat - pole) / 0.0065536) + 1;
    for (let j = 1; j < n; j++) target.push([pole + (rlat - pole) * j / n, rlon]);
  } else {
    const lcos = Math.cos(llat * DEG);
    const lx = Math.sin(llat * DEG), lz = lcos;
    const rcos = Math.cos(rlat * DEG);
    const rx = Math.sin(rlat * DEG);
    const ry = Math.sin((rlon - llon) * DEG) * rcos;
    const rz = Math.cos((rlon - llon) * DEG) * rcos;
    const prod = lx * rx + lz * rz;
    const dist = Math.acos(Math.max(-1.0, Math.min(1.0, prod)));
    let ox = rx - prod * lx, oy = ry, oz = rz - prod * lz;
    const lg = Math.sqrt(ox * ox + oy * oy + oz * oz);
    ox /= lg; oy /= lg; oz /= lg;
    new Collector(ox, oy, oz, lx, lz, dist, llon, target).collectCenter(0, dist, 4);
  }
  if (rlon < -180) rlon += 360; else if (rlon > 180) rlon -= 360;
  target.push([rlat, rlon]);
}

const idx = (p) => u32((ilat(p[0]) & 0xffff0000) | (u32(ilon(p[1])) >>> 16));
const spiGet = (spi, k) => { let l = spi.get(k); if (!l) { l = []; spi.set(k, l); } return l; };

function addSegment(spi, from, to, pos) {
  const la = ilat(from[0]), lo = ilon(from[1]), ra = ilat(to[0]), ro = ilon(to[1]);
  spiGet(spi, u32((la & 0xffff0000) | (u32(lo) >>> 16))).push(pos);
  if ((lo & 0xffff0000) !== (ro & 0xffff0000)) spiGet(spi, u32((la & 0xffff0000) | (u32(ro) >>> 16))).push(pos);
  if ((la & 0xffff0000) !== (ra & 0xffff0000)) {
    spiGet(spi, u32((ra & 0xffff0000) | (u32(lo) >>> 16))).push(pos);
    if ((lo & 0xffff0000) !== (ro & 0xffff0000)) spiGet(spi, u32((ra & 0xffff0000) | (u32(ro) >>> 16))).push(pos);
  }
}
const replaceIn = (lst, old, nw) => { for (let i = 0; i < lst.length; i++) if (lst[i] === old) lst[i] = nw; };

function replaceSegment(spi, from, via, to, old, nw) {
  const la = u32(ilat(from[0]) & 0xffff0000), lo = i32(ilon(from[1]) & 0xffff0000);
  const ra = u32(ilat(to[0]) & 0xffff0000), ro = i32(ilon(to[1]) & 0xffff0000);
  const va = u32(ilat(via[0]) & 0xffff0000), vo = i32(ilon(via[1]) & 0xffff0000);
  const key = (a, o) => u32(a | (u32(o) >>> 16));
  if (va === la && vo === lo) nw += 1;
  replaceIn(spiGet(spi, key(la, lo)), old, nw);
  if (lo !== ro) replaceIn(spiGet(spi, key(la, ro)), old, nw);
  if (la !== ra) {
    replaceIn(spiGet(spi, key(ra, lo)), old, nw);
    if (lo !== ro) {
      if ((va === la && vo === lo) || (va === ra && vo === ro)) replaceIn(spiGet(spi, key(ra, ro)), old, nw);
      else {
        spiGet(spi, key(la, ro)).push(nw + 1);
        spiGet(spi, key(ra, lo)).push(nw + 1);
        replaceIn(spiGet(spi, key(ra, ro)), old, nw + 1);
      }
    }
  }
  if (va === la && vo === lo) spiGet(spi, key(la, lo)).push(nw - 1);
  else if (va === ra && vo === ro) spiGet(spi, key(ra, ro)).push(nw + 1);
}

function tryIntersect(lf, lt, rf, rt) {
  const rfmltLat = rf[0] - lt[0], rfmltLon = rf[1] - lt[1];
  if (!rfmltLat && !rfmltLon) return null;
  if (same(lf, rt) || same(lf, rf) || same(lt, rt)) return null;
  const lfmltLat = lf[0] - lt[0], lfmltLon = lf[1] - lt[1];
  const rfmrtLat = rf[0] - rt[0], rfmrtLon = rf[1] - rt[1];
  const det = lfmltLat * rfmrtLon - rfmrtLat * lfmltLon;
  if (det === 0) {
    if (lfmltLat * rfmltLon - lfmltLon * rfmltLat !== 0) return null;
    const c = Math.abs(rfmltLat) > Math.abs(rfmltLon) ? 0 : 1;
    if (lf[c] < lt[c]) {
      if (rf[c] < rt[c]) { if (lt[c] < rf[c] || rt[c] < lf[c]) return null; return lf[c] < rf[c] ? rf : lf; }
      if (lt[c] < rt[c] || rf[c] < lf[c]) return null;
      return lf[c] < rt[c] ? rt : lf;
    }
    if (rf[c] < rt[c]) { if (lf[c] < rf[c] || rt[c] < lt[c]) return null; return lt[c] < rf[c] ? rf : lt; }
    if (lf[c] < rt[c] || rf[c] < lt[c]) return null;
    return lt[c] < rt[c] ? rt : lt;
  }
  const x = (rfmrtLon * rfmltLat - rfmrtLat * rfmltLon) / det;
  const y = (lfmltLat * rfmltLon - lfmltLon * rfmltLat) / det;
  if (x <= -1e-7 || x >= 1 + 1e-7 || y <= -1e-7 || y >= 1 + 1e-7) return null;
  return [lt[0] + x * lfmltLat, lt[1] + x * lfmltLon];
}

function bisectLeft(a, v) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }

function splitSegments(segs, gaps, spi) {
  // std::map iteration: keys inserted during the loop are visited if they sort after the current one
  const nextKey = (after) => { let best = null; for (const k of spi.keys()) if ((after === null || k > after) && (best === null || k < best)) best = k; return best; };
  let key = nextKey(null);
  while (key !== null) { splitOne(segs, gaps, spi, key); key = nextKey(key); }
}

function splitOne(segs, gaps, spi, key) {
  let lst = spi.get(key);
  for (let i = 1; i < lst.length; i++) {
    for (let j = 0; j < i; j++) {
      const lj = lst[j], li = lst[i];
      let isect = tryIntersect(segs[lj], segs[lj + 1], segs[li], segs[li + 1]);
      if (isect === null) continue;
      if (idx(isect) !== key) continue;
      for (let k = 0; k < lst.length; k++) {
        if (epsEqual(isect, segs[lst[k]])) isect = segs[lst[k]];
        if (epsEqual(isect, segs[lst[k] + 1])) isect = segs[lst[k] + 1];
      }
      for (const m of [j, i]) {
        const s = lst[m];
        if (!same(isect, segs[s]) && !same(isect, segs[s + 1])) {
          segs.push(segs[s]); segs.push(isect); segs.push(segs[s + 1]);
          gaps.splice(bisectLeft(gaps, s + 1), 0, s + 1);
          gaps.push(segs.length);
          replaceSegment(spi, segs[s], isect, segs[s + 1], s, segs.length - 3);
          lst = spi.get(key);
        }
      }
    }
  }
}

const UMAX = 0xffffffff;
const divIdx = (i, remote) => i * 2 + Math.trunc((remote - i - 1) / 2);

function collectDivertions(segs, key, lst, divs) {
  const pos = [];
  for (const s of lst) {
    if (idx(segs[s]) === key) pos.push([segs[s], s, s + 1]);
    if (idx(segs[s + 1]) === key) pos.push([segs[s + 1], s + 1, s]);
  }
  if (!pos.length) return;
  pos.sort((a, b) => ptCmp(a[0], b[0]) || a[1] - b[1]);
  let sameAt = 0;
  for (let i = 0; i <= pos.length; i++) {
    if (i === pos.length || !same(pos[i][0], pos[sameAt][0])) {
      if (i - sameAt === 2) {
        const a = pos[sameAt], b = pos[sameAt + 1];
        divs[divIdx(a[1], a[2])] = [b[1], b[2]];
        divs[divIdx(b[1], b[2])] = [a[1], a[2]];
      } else {
        const grad = [];
        for (let j = sameAt; j < i; j++) grad.push([Math.atan2(segs[pos[j][2]][1] - segs[pos[j][1]][1], segs[pos[j][2]][0] - segs[pos[j][1]][0]), j]);
        grad.sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] - y[1]));
        for (let j = 0; j < grad.length; ) {
          if (j + 3 < grad.length && grad[j + 1][0] === grad[j + 2][0]) {
            const [p0, p1, p2, p3] = [0, 1, 2, 3].map(k => pos[grad[j + k][1]]);
            divs[divIdx(p0[1], p0[2])] = [p3[1], p3[2]];
            divs[divIdx(p1[1], p1[2])] = [p2[1], p2[2]];
            divs[divIdx(p2[1], p2[2])] = [p1[1], p1[2]];
            divs[divIdx(p3[1], p3[2])] = [p0[1], p0[2]];
            j += 2;
          } else if (j + 1 < grad.length) {
            const p0 = pos[grad[j][1]], p1 = pos[grad[j + 1][1]];
            divs[divIdx(p0[1], p0[2])] = [p1[1], p1[2]];
            divs[divIdx(p1[1], p1[2])] = [p0[1], p0[2]];
          }
          j += 2;
        }
      }
      sameAt = i;
    }
  }
}

function assemble(segs, divs, out) {
  let pos = 0;
  let count = 0;
  for (let i = 0; i < divs.length; i += 2) if (divs[i + 1][0] === UMAX) count++;
  while (count < segs.length) {
    while (divs[2 * pos][0] === UMAX) { pos++; if (pos === segs.length - 1) pos = 0; }
    const cur = [];
    out.push(cur);
    let d = 1;
    while (divs[2 * pos + d][0] !== UMAX) {
      if (cur.length >= 2 && epsEqual(segs[pos], cur[cur.length - 2])) cur.pop();
      else if (!cur.length || !epsEqual(segs[pos], cur[cur.length - 1])) cur.push(segs[pos]);
      const oldI = 2 * pos + d;
      const dv = divs[2 * pos + Math.floor((3 * d - 1) / 2)];
      d = dv[1] - dv[0];
      pos = dv[0];
      count++;
      divs[oldI] = [UMAX, divs[oldI][1]];
    }
    pos++;
    if (pos === segs.length - 1) pos = 0;
    if (cur.length <= 2) out.pop(); else cur.push(cur[0]);
  }
}

/** toggle_if_inside; state = [isInside, onVertex, onSegment]. */
function toggle(state, borderLat, borderLon, pt, lhs0, rhs0) {
  const lhs = [...lhs0], rhs = [...rhs0];
  if (pt[1] < -179.9) { lhs[1] -= lhs[1] > 0 ? 360 : 0; rhs[1] -= rhs[1] > 0 ? 360 : 0; }
  else if (pt[1] > 179.9) { lhs[1] += lhs[1] < 0 ? 360 : 0; rhs[1] += rhs[1] < 0 ? 360 : 0; }
  const [plat, plon] = pt;
  if (lhs[0] === rhs[0]) {
    if (lhs[0] < plat) state[0] = state[0] !== ((lhs[1] - plon) * (rhs[1] - plon) < 0);
    else if (lhs[0] === plat) {
      if (plon === lhs[1] || plon === rhs[1]) state[1] = true;
      else state[2] = state[2] || ((lhs[1] - plon) * (rhs[1] - plon) < 0);
    }
  } else if (lhs[1] === rhs[1]) {
    if ((plat === lhs[0] && plon === lhs[1]) || (plat === rhs[0] && plon === rhs[1])) state[1] = true;
    else if (plon === lhs[1] && (plat - lhs[0]) * (plat - rhs[0]) < 0) state[2] = true;
    else if (lhs[1] < plon && (lhs[0] < borderLat || rhs[0] < borderLat)) state[0] = !state[0];
  } else if ((lhs[0] - rhs[0]) * (lhs[1] - rhs[1]) < 0) {
    if ((plat === lhs[0] && plon === lhs[1]) || (plat === rhs[0] && plon === rhs[1])) state[1] = true;
    else if ((plon - lhs[1]) * (plon - rhs[1]) < 0) {
      const il = lhs[0] + (rhs[0] - lhs[0]) * (plon - lhs[1]) / (rhs[1] - lhs[1]);
      if (il < plat) state[0] = !state[0]; else if (il === plat) state[2] = true;
    } else if (plon === lhs[1] && rhs[1] < plon) { if (lhs[0] < plat) state[0] = !state[0]; }
    else if (plon === rhs[1] && lhs[1] < plon) { if (rhs[0] < plat) state[0] = !state[0]; }
    else if ((borderLat - lhs[0]) * (borderLat - rhs[0]) < 0) {
      const io = lhs[1] + (rhs[1] - lhs[1]) * (borderLat - lhs[0]) / (rhs[0] - lhs[0]);
      if (borderLon < io && io < plon) state[0] = !state[0];
    }
  } else {
    if ((borderLat - lhs[0]) * (borderLat - rhs[0]) < 0) {
      const io = lhs[1] + (rhs[1] - lhs[1]) * (borderLat - lhs[0]) / (rhs[0] - lhs[0]);
      if ((lhs[1] <= plon || rhs[1] <= plon) && borderLon < io) state[0] = !state[0];
    }
    if ((plat === lhs[0] && plon === lhs[1]) || (plat === rhs[0] && plon === rhs[1])) { state[1] = true; return; }
    if ((plon - lhs[1]) * (plon - rhs[1]) < 0) {
      const il = lhs[0] + (rhs[0] - lhs[0]) * (plon - lhs[1]) / (rhs[1] - lhs[1]);
      if (il < plat) state[0] = !state[0]; else if (il === plat) state[2] = true;
    } else if (plon === lhs[1] && rhs[1] < plon) { if (lhs[0] < plat) state[0] = !state[0]; }
    else if (plon === rhs[1] && lhs[1] < plon) { if (rhs[0] < plat) state[0] = !state[0]; }
  }
}

class Oracle {                                     // RHR_Polygon_Area_Oracle
  constructor(segs, spi) { this.segs = segs; this.spi = spi; this.inside = new Set(); }

  buildArea(sw, value, seRef, nwRef) {
    const lst = this.spi.get(u32(value));
    if (lst === undefined) return;
    const segs = this.segs;
    if (sw) this.inside.add(u32(value));
    const v16 = i32(value << 16);
    const vlat = u32(u32(value) & 0xffff0000);
    const vlon = lonOf(value << 16);
    if (vlon > -179.99) {
      if (nwRef) {
        let nw = sw;
        for (const s of lst) {
          const lo1 = i32(ilon(segs[s][1]) & 0xffff0000), lo2 = i32(ilon(segs[s + 1][1]) & 0xffff0000);
          if ((lo1 < v16 && lo2 === v16) || (lo1 === v16 && lo2 < v16)) {
            const il = segs[s][0] + (segs[s + 1][0] - segs[s][0]) * (vlon - segs[s][1]) / (segs[s + 1][1] - segs[s][1]);
            if (u32(ilat(il) & 0xffff0000) === vlat) nw = !nw;
          }
        }
        nwRef[0] = nw;
      }
      if (seRef) {
        let se = sw;
        for (const s of lst) {
          const la1 = u32(ilat(segs[s][0]) & 0xffff0000), la2 = u32(ilat(segs[s + 1][0]) & 0xffff0000);
          if ((la1 < vlat && la2 === vlat) || (la1 === vlat && la2 < vlat)) {
            const io = segs[s][1] + (segs[s + 1][1] - segs[s][1]) * (latOf(vlat) - segs[s][0]) / (segs[s + 1][0] - segs[s][0]);
            if (u32(ilon(io) & 0xffff0000) === u32(value << 16)) se = !se;
          }
        }
        seRef[0] = se;
      }
    } else {
      if (nwRef) {
        let nw = sw;
        for (const s of lst) {
          const l1 = segs[s][1] - (segs[s][1] > 0 ? 360 : 0), l2 = segs[s + 1][1] - (segs[s + 1][1] > 0 ? 360 : 0);
          if (vlon > -180) {
            const lo1 = i32(ilon(l1) & 0xffff0000), lo2 = i32(ilon(l2) & 0xffff0000);
            if ((lo1 < v16 && lo2 === v16) || (lo1 === v16 && lo2 < v16)) {
              const il = segs[s][0] + (segs[s + 1][0] - segs[s][0]) * (vlon - segs[s][1]) / (segs[s + 1][1] - segs[s][1]);
              if (u32(ilat(il) & 0xffff0000) === vlat) nw = !nw;
            }
          } else if ((l1 <= -180 && -180 < l2) || (l2 <= -180 && -180 < l1)) {
            const il = segs[s][0] + (segs[s + 1][0] - segs[s][0]) * (-180 - segs[s][1]) / (segs[s + 1][1] - segs[s][1]);
            if (u32(ilat(il) & 0xffff0000) === vlat) nw = !nw;
          }
        }
        nwRef[0] = nw;
      }
      if (seRef) {
        let se = sw;
        for (const s of lst) {
          const la1 = u32(ilat(segs[s][0]) & 0xffff0000), la2 = u32(ilat(segs[s + 1][0]) & 0xffff0000);
          if ((la1 < vlat && la2 === vlat) || (la1 === vlat && la2 < vlat)) {
            const io = segs[s][1] + (segs[s + 1][1] - segs[s][1]) * (latOf(vlat) - segs[s][0]) / (segs[s + 1][0] - segs[s][0]);
            if (io >= -180 && u32(ilon(io) & 0xffff0000) === u32(value << 16)) se = !se;
          }
        }
        seRef[0] = se;
      }
    }
  }

  pointStatus(value, lat, lon) {
    if (value === 1) return 1;
    const lst = this.spi.get(u32(value));
    if (lst === undefined) return 0;
    const borderLon = Math.max(lonOf(value << 16), -180);
    const borderLat = latOf(u32(value) & 0xffff0000);
    const st = [this.inside.has(u32(value)), false, false];
    for (const s of lst) toggle(st, borderLat, borderLon, [lat, lon], this.segs[s], this.segs[s + 1]);
    if (st[1]) return 0x20 + 2 * st[0];
    if (st[2]) return 0x10 + 2 * st[0];
    return 2 * st[0];
  }
}

class FourField {                                  // Four_Field_Index; entries are [sw, se, nw, ne]
  constructor(oracle) { this.tree = []; this.baseLat = 0; this.baseLon = u32(2000000000); this.bits = 0; this.oracle = oracle; this.minLon = ilon(-180); }
  static slot(la, lo) { return (la & 0x00010000 ? 2 : 0) + (lo & 0x00010000 ? 1 : 0); }
  addPoint(lat, lon, value) {
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return 0;
    const la = ilat(lat), lo = ilon(lon);
    const e = this.makeAvailable(u32(la & 0xfffe0000), u32(u32(lo) & 0xfffe0000), 15);
    const k = FourField.slot(la, u32(lo));
    const old = e[k];
    e[k] = i32(value);
    return old;
  }
  makeAvailable(lat, lon, sig) {
    const t = this.tree;
    if (!t.length) { this.baseLat = lat; this.baseLon = lon; this.bits = sig; t.push([0, 0, 0, 0]); return t[t.length - 1]; }
    let mask = u32(~(0xffffffff >>> this.bits));
    while (u32(lat & mask) !== u32(this.baseLat & mask) || u32(lon & mask) !== u32(this.baseLon & mask)) {
      this.bits -= 1;
      t.push(t[0]);
      t[0] = [0, 0, 0, 0];
      const bit = 0x80000000 >>> this.bits;
      const k = (this.baseLat & bit ? 2 : 0) + (this.baseLon & bit ? 1 : 0);
      t[0][k] = -t.length + 1;
      mask = u32(~(0xffffffff >>> this.bits));
      this.baseLat = u32(this.baseLat & mask);
      this.baseLon = u32(this.baseLon & mask);
    }
    let cur = this.bits, pos = 0;
    while (cur < sig) {
      const bit = 0x80000000 >>> cur;
      const k = (lat & bit ? 2 : 0) + (lon & bit ? 1 : 0);
      if (t[pos][k] < 0) pos = -t[pos][k];
      else { t[pos][k] = -t.length; pos = t.length; t.push([0, 0, 0, 0]); }
      if (pos === t.length) t.push([0, 0, 0, 0]);
      cur++;
    }
    return t[pos];
  }
  computeInsideParts() { if (this.oracle && this.tree.length) this.cip(this.baseLat, this.baseLon, this.bits, 0, false, null, null); }
  cip(lat, lon, sig, pos, sw, rSe, rNw) {
    const t = this.tree, o = this.oracle;
    const half = sig < 32 ? 0x80000000 >>> sig : 0;
    if (!sig || this.minLon <= i32(i32(lon) + i32(half))) {
      const se = [false], nw = [false], ne = [false];
      const e = t[pos];
      if (e[0] < 0) this.cip(lat, lon, sig + 1, -e[0], sw, se, nw);
      else if (e[0] > 0) o.buildArea(sw, e[0], se, nw);
      else { e[0] = +sw; se[0] = sw; nw[0] = sw; }
      if (e[1] < 0) this.cip(lat, u32(lon + half), sig + 1, -e[1], se[0], rSe, null);
      else if (e[1] > 0) o.buildArea(se[0], e[1], rSe, null);
      else { e[1] = +se[0]; if (rSe) rSe[0] = se[0]; }
      if (e[2] < 0) this.cip(u32(lat + half), lon, sig + 1, -e[2], nw[0], ne, rNw);
      else if (e[2] > 0) o.buildArea(nw[0], e[2], ne, rNw);
      else { e[2] = +nw[0]; ne[0] = nw[0]; if (rNw) rNw[0] = nw[0]; }
      if (e[3] < 0) this.cip(u32(lat + half), u32(lon + half), sig + 1, -e[3], ne[0], null, null);
      else if (e[3] > 0) o.buildArea(ne[0], e[3], null, null);
      else e[3] = +ne[0];
    } else {
      const ne = [false];
      const e = t[pos];
      if (e[1] < 0) this.cip(lat, u32(lon + half), sig + 1, -e[1], sw, rSe, ne);
      else if (e[1] > 0) o.buildArea(sw, e[1], rSe, ne);
      else { e[1] = +sw; if (rSe) rSe[0] = sw; }
      if (e[3] < 0) this.cip(u32(lat + half), u32(lon + half), sig + 1, -e[3], ne[0], null, rNw);
      else if (e[3] > 0) o.buildArea(ne[0], e[3], null, rNw);
      else { e[3] = +ne[0]; if (rNw) rNw[0] = ne[0]; }
    }
  }
  pointStatus(lat, lon) {
    if (!this.oracle || !this.tree.length) return 0;
    const la = ilat(lat), lo = u32(ilon(lon));
    let cur = this.bits, pos = 0;
    while (cur < 32) {
      const bit = 0x80000000 >>> cur;
      const k = (la & bit ? 2 : 0) + (lo & bit ? 1 : 0);
      const v = this.tree[pos][k];
      if (v < 0) pos = -v; else if (v > 0) return this.oracle.pointStatus(v, lat, lon); else return 0;
      cur++;
    }
    return 0;
  }
}

const strictlyWest = (a, b) => (a - b > 180 ? a - 360 < b : a < b);
const weaklyWest = (a, b) => (a - b > 180 ? a - 360 <= b : a <= b);

function rhrPolygon(free) {
  const segs = [], gaps = [0];
  for (const ln of free.lines) {
    segs.push(ln[0]);
    for (let k = 0; k + 1 < ln.length; k++) interpolateSegment(ln[k][0], ln[k][1], ln[k + 1][0], ln[k + 1][1], segs);
    gaps.push(segs.length);
  }
  const spi = new Map();
  let gi = 0;
  for (let i = 0; i < segs.length; i++) {
    if (gaps[gi] === i) gi++;
    else addSegment(spi, segs[i - 1], segs[i], i - 1);
  }
  splitSegments(segs, gaps, spi);
  const divs = Array.from({ length: 2 * segs.length }, () => [UMAX, UMAX]);
  for (const g of gaps.slice(1)) { divs[g * 2 - 2] = [UMAX, UMAX]; divs[g * 2 - 1] = [UMAX, UMAX]; }
  const keys = [...spi.keys()].sort((a, b) => a - b);
  for (const key of keys) collectDivertions(segs, key, spi.get(key), divs);
  const lines = [];
  assemble(segs, divs, lines);
  const oracle = new Oracle(segs, spi);
  const ff = new FourField(oracle);
  for (const key of keys) ff.addPoint(latOf(u32(key | 0x8000)), lonOf(u32(key << 16) | 0x8000), key);
  ff.computeInsideParts();
  for (const ln of lines) {
    if (ln.length <= 2) continue;
    const [a, b, c] = ln;
    const ins = Boolean(ff.pointStatus(b[0], b[1]) & 0x3);
    let rev;
    if (strictlyWest(a[1], b[1])) {
      if (weaklyWest(b[1], c[1])) rev = ins;
      else rev = ins !== ((b[0] - a[0]) / (b[1] - a[1]) < (c[0] - b[0]) / (c[1] - b[1]));
    } else if (strictlyWest(c[1], b[1])) rev = !ins;
    else if (a[1] === b[1]) rev = ins !== (a[0] < b[0]);
    else if (c[1] === b[1]) rev = ins !== (b[0] < c[0]);
    else rev = ins !== ((b[0] - a[0]) / (b[1] - a[1]) < (c[0] - b[0]) / (c[1] - b[1]));
    if (rev) ln.reverse();
  }
  return new RHRPolygon(lines);
}

// ---- output (output_json.cc)
/** round(v, 7) as Python and toFixed do it. Away from a tie, Math.round(v·1e7) is the right integer and
 *  r / 1e7 the same double as parsing its decimal; near a tie the exact (slow) path decides. */
function round7(v) { const y = v * 1e7, r = Math.round(y); return Math.abs(y - r) < 0.4999 ? r / 1e7 : Number(v.toFixed(7)); }

function toGeoJSON(g) {
  if (g.hasComponents()) return { type: 'GeometryCollection', geometries: g.components().filter(c => c && c.hasCenter()).map(toGeoJSON) };
  if (g.hasLineGeometry()) return { type: 'LineString', coordinates: g.line().map(([la, lo]) => [round7(lo), round7(la)]) };
  if (g.hasMultilineGeometry()) return { type: 'Polygon', coordinates: g.multiline().map(ln => ln.map(([la, lo]) => [round7(lo), round7(la)])) };
  if (g.hasCenter()) return { type: 'Point', coordinates: [round7(g.centerLon()), round7(g.centerLat())] };
  return null;
}

/** print_geometry(geometry, mode) for a derived element: mode in geom/bb/center. */
function derivedGeometry(g, mode) {
  if (mode === 'geom' && g.hasCenter()) return toGeoJSON(g);
  if (mode === 'bb' && g.hasBbox()) {
    const w = round7(g.west()), s = round7(g.south()), e = round7(g.east()), n = round7(g.north());
    return { type: 'Polygon', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] };
  }
  if (mode === 'center' && g.hasCenter()) return { type: 'Point', coordinates: [round7(g.centerLon()), round7(g.centerLat())] };
  return null;
}

return { INVALID, u32, i32, ilat, ilon, latOf, lonOf, decoded, epsEqual, Bbox, Geometry, Null, Point, Linestring, PartialWay, FreePolygon, Compound, PartialRelation, RHRPolygon, ZERO_QUAD, bboxIntersects, greatCircleDist, length, makeTrace, makeHull, rhrPolygon, round7, toGeoJSON, derivedGeometry };
})();
// ---- expr.js
__m["expr.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass QL evaluator expressions (`if:` filters): a port of osm_bypass/expr.py, whose parts are ports of
// Overpass API statements/*_operators.cc, string_endomorphisms.cc, aggregators.cc, set_list_operators.cc and
// data/utils.h (Copyright (C) 2008-2018 Roland Olbricht et al., AGPL-3.0-or-later).
//
// Values are strings, as in Overpass; arithmetic and ordered comparison use int64 (BigInt here) when both
// sides parse as integers, else doubles, else text. Geometry functions (geom(), center(), trace(), hull(),
// gcat(), pt(), lstr(), poly()) return geometry objects from geometry.js, for make/convert's ::geom.

const { Unsupported } = __m["errors.js"];
const { cpCompare } = __m["text.js"];
const G = __m["geometry.js"];

// AST (arrays): ['lit', s] ['tag', e] ['call', name, args] ['setcall', set, name, args] ['un', op, e]
//               ['bin', op, a, b] ['cond', c, a, b] ['val', set]
//               ['prop', set, key] (any other set key: '') ['generic'] (`::` in make/convert, see bindKey)

const UNSUPPORTED_FUNCS = new Set(['version', 'timestamp', 'changeset', 'uid', 'user']);
const GEOM_FUNCS = { geom: 'eval-geometry', center: 'eval-center', trace: 'eval-trace', hull: 'eval-hull',
  gcat: 'eval-geom-concat', pt: 'eval-point', lstr: 'eval-linestring', poly: 'eval-polygon' };
const GEOM_ARGS = new Set(['center', 'trace', 'hull', 'gcat', 'lstr', 'poly']);
const COUNT_TYPES = new Set(['nodes', 'ways', 'relations', 'deriveds', 'nwr', 'nw', 'wr', 'nr']);
const TYPE_WORDS = new Set(['nodes', 'ways', 'relations', 'rels', 'deriveds', 'areas', 'nwr', 'nw', 'wr', 'nr']);
const RAW_TOKEN_ARG = new Set(['is_tag', 'count_by_role', 'count_distinct_by_role']);
const SCALARS = new Set(['id', 'type', 'lat', 'lon', 'length', 'is_closed', 'is_tag', 'number', 'is_number', 'count_tags',
  'count_members', 'count_distinct_members', 'lrs_in', 'lrs_isect', 'lrs_union', 'lrs_min', 'lrs_max', 'keys',
  'per_member', 'pos', 'mtype', 'ref', 'role', 'abs', 'suffix', 'date', 'is_date', 'count_by_role',
  'count_distinct_by_role', 'geom', 'center', 'trace', 'hull', 'pt', 'lstr', 'poly', 'per_vertex', 'angle']);
const PURE = new Set(['number', 'is_number', 'abs', 'suffix', 'date', 'is_date', 'lrs_in', 'lrs_isect', 'lrs_union',
  'lrs_min', 'lrs_max', 'center', 'trace', 'hull', 'pt', 'lstr', 'poly']);
const AGGREGATES = new Set(['min', 'max', 'sum', 'set', 'count', 'u', 'gcat']);
// Overpass's static errors for a call without arguments (checked against 0.7.62): aggregates "need an
// argument", these "must have one or more arguments"
const NEED_ARGUMENT = new Set(['min', 'max', 'sum', 'set', 'u', 'gcat']);
const ONE_OR_MORE = new Set(['hull', 'trace', 'center', 'lstr', 'poly', 'pt', 'number', 'is_number', 'suffix', 'date',
  'is_date', 'abs', 'per_member', 'per_vertex', 'lrs_in', 'lrs_isect', 'lrs_union', 'lrs_min', 'lrs_max', 'is_tag']);
// Overpass's other argument rules (0.7.62, tests/data/overpass_errors.tsv), as in expr.py: checked while parsing ...
const NO_ARGUMENTS = new Set(['angle', 'geom', 'id', 'is_closed', 'lat', 'length', 'lon', 'mtype', 'pos', 'ref', 'role',
  'type', 'keys']);
const ONE_ARGUMENT = new Set(['abs', 'date', 'is_date', 'is_number', 'number', 'suffix', 'lrs_max', 'lrs_min', 'center',
  'hull', 'trace', 'gcat', 'max', 'min', 'set', 'sum', 'u']);
const TWO_ARGUMENTS = new Set(['lrs_in', 'lrs_isect', 'lrs_union', 'pt']);
// ... and after the context: functions that need an element, or a member (inside per_member, per_vertex)
const MEMBER_FUNCS = new Set(['angle', 'mtype', 'pos', 'ref', 'role']);
const OBJECT_TYPES = ['nodes', 'ways', 'relations'];
// The evaluators' names in Overpass's type errors
const EVAL_NAMES = { abs: 'eval-abs', center: 'eval-center', count_by_role: 'eval-prop-count',
  count_distinct_by_role: 'eval-prop-count', count_distinct_members: 'eval-prop-count', count_members: 'eval-prop-count',
  count_tags: 'eval-prop-count', date: 'eval-date', gcat: 'eval-geom-concat', geom: 'eval-geometry', hull: 'eval-hull',
  id: 'eval-id', is_closed: 'eval-is-closed', is_date: 'eval-is-date', is_number: 'eval-is-number', is_tag: 'eval-is-tag',
  keys: 'eval-all-keys', lat: 'eval-lat', length: 'eval-length', lon: 'eval-lon', lrs_in: 'eval-lrs-in',
  lrs_isect: 'eval-lrs-isect', lrs_max: 'eval-lrs-max', lrs_min: 'eval-lrs-min', lrs_union: 'eval-lrs-union',
  lstr: 'eval-linestring', max: 'eval-umax', min: 'eval-min', number: 'eval-number', per_member: 'eval-per-member',
  per_vertex: 'eval-per-vertex', poly: 'eval-polygon', pt: 'eval-point', set: 'eval-set', suffix: 'eval-suffix',
  sum: 'eval-sum', trace: 'eval-trace', type: 'eval-type', u: 'eval-union', count: 'eval-set-count' };
const OP_NAMES = { '+': 'eval-plus', '-': 'eval-minus', '*': 'eval-times', '/': 'eval-divided-by', '==': 'eval-equal',
  '!=': 'eval-not-equal', '<': 'eval-less', '<=': 'eval-less-equal', '>': 'eval-greater', '>=': 'eval-greater-equal',
  '&&': 'eval-and', '||': 'eval-or' };
const MULTIPLE = '< multiple values found >';

const SKIP = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
const TOK = /(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\|\||&&|==|!=|<=|>=|::|[<>+\-*/%!?:(),[\].])|([A-Za-z_][A-Za-z_0-9:]*)/y;

/** Parse an expression from text[pos:]; returns { ast, end }. Stops at a `)` or `,` at depth 0, or at `->`.
 *  `element`: evaluated per element (convert, if:, for) or once (make, the if statement). Overpass checks the
 *  context, the argument words and the types statically, after the argument counts, in that order. */
function parseExpr(text, pos, want = 'string', containerOk = false, element = true) {
  const toks = [];
  let i = pos, depth = 0;
  for (;;) {
    SKIP.lastIndex = i; SKIP.exec(text); const j = SKIP.lastIndex;
    if (text.startsWith('->', j)) break;
    TOK.lastIndex = j;
    const m = TOK.exec(text);
    if (!m) break;
    const kind = m[1] !== undefined ? 'num' : m[2] !== undefined ? 'str' : m[3] !== undefined ? 'op' : 'id';
    const val = m[0];
    if (kind === 'op') {
      if (val === '(' || val === '[') depth++;
      else if (val === ')' || val === ']') { if (depth === 0) break; depth--; }
      else if (val === ',' && depth === 0) break;
    }
    toks.push([kind, val, j]);
    i = TOK.lastIndex;
  }
  const p = new P(toks, i, text);
  const ast = p.ternary();
  if (p.k !== toks.length) p.fail('unexpected token');
  checkContext(ast, element, false);
  if (hasContainer(ast) && !(containerOk && ast[0] === 'call' && ast[1] === 'keys')) {
    throw new SyntaxError(`static error: Evaluator for ${want} expected, but function "eval-all-keys" is an evaluator for container.`);
  }
  if (containerOk && ast[0] === 'call' && ast[1] === 'keys') return { ast, end: i };
  typecheck(ast, want);
  return { ast, end: i };
}

function hasContainer(ast) {
  if (!Array.isArray(ast)) return false;
  if (ast[0] === 'call' && ast[1] === 'keys') return true;
  return ast.slice(1).some(x => Array.isArray(x) && (x.length && typeof x[0] === 'string' ? hasContainer(x) : x.some(hasContainer)));
}

/** Overpass's static checks after the argument counts: functions that need an element (or a member) where
 *  there's none, then the word and role arguments; top-down. */
function checkContext(ast, element, member) {
  if (!Array.isArray(ast) || !ast.length || typeof ast[0] !== 'string') return;
  const k = ast[0];
  const fail = msg => { throw new SyntaxError(`parse error: ${msg}`); };
  if (k === 'tag' && !element) fail('t[...] must be called in a context where it can evaluate an element');
  if (k === 'call' || k === 'setcall') {
    const [name, args] = k === 'call' ? [ast[1], ast[2]] : [ast[2], ast[3]];
    if (k === 'call' && MEMBER_FUNCS.has(name) && !member) fail(`${name}(...) must be called in a context where it can evaluate an element's member`);
    if (k === 'call' && SCALARS.has(name) && !PURE.has(name) && !element) fail(`${name}(...) must be called in a context where it can evaluate an element`);
    const words = args.map(a => (a[0] === 'lit' ? a[1] : null));
    if ((name === 'count_members' || name === 'count_distinct_members') && words.some(w => !OBJECT_TYPES.includes(w))) {
      fail(`${name}(...) can only have one of the words nodes, ways, or relations as an argument`);
    }
    if (name === 'count_by_role' || name === 'count_distinct_by_role') {
      if (!args.length) fail(`${name}() must have the name of the wanted role as argument`);
      if (args.length > 2 || args[0][0] !== 'lit') fail(`${name}() needs a single literal expression as argument for the wanted role`);
      if (args.length === 2 && (!OBJECT_TYPES.includes(words[1]) || args[1][2] === 'quoted')) fail(`${name}(...) can only have one of the words nodes, ways, or relations as second argument`);
    }
    if (name === 'is_tag' && args.length > 1) fail('is_tag(key) needs a simple string as argument');
    if (name === 'count_tags' && args.length) fail('count_tags(...) does not accept any arguments');
    if ((name === 'per_member' || name === 'per_vertex') && args.length > 1) fail('"," cannot be used as binary operator');
    const inner = element || k === 'setcall' || AGGREGATES.has(name);
    for (const a of args) checkContext(a, inner, member || name === 'per_member' || name === 'per_vertex');
    return;
  }
  for (const a of ast.slice(1)) checkContext(a, element, member);
}

/** The Overpass evaluator an expression is, as its type errors name it. */
function evalName(ast) {
  const k = ast[0];
  if (k === 'call') return EVAL_NAMES[ast[1]] ?? `eval-${ast[1].replace(/_/g, '-')}`;
  if (k === 'setcall') return EVAL_NAMES[ast[2]] ?? `eval-${ast[2].replace(/_/g, '-')}`;
  if (k === 'lit') return 'eval-fixed';
  if (k === 'un') return ast[1] === '!' ? 'eval-not' : ast[2][0] === 'lit' ? 'eval-fixed' : 'eval-negate';
  if (k === 'bin') return OP_NAMES[ast[1]] ?? 'eval-fixed';
  if (k === 'cond') return 'eval-ternary';
  if (k === 'tag') return 'eval-value';
  if (k === 'generic') return 'eval-generic';
  return 'eval-set-key';                                  // _.val, x.key
}

/** Overpass's static type check: the arguments first, then the expression against what its place wants. */
function typecheck(ast, want) {
  const k = ast[0];
  if (k === 'call' || k === 'setcall') {
    const [name, args] = k === 'call' ? [ast[1], ast[2]] : [ast[2], ast[3]];
    const sub = GEOM_ARGS.has(name) ? 'geometry' : 'string';
    for (const x of args) { if (x[0] === 'lit' && TYPE_WORDS.has(x[1])) continue; typecheck(x, sub); }
    const got = name in GEOM_FUNCS ? 'geometry' : 'string';
    if (got !== want) throw new SyntaxError(`static error: Evaluator for ${want} expected, but function "${evalName(ast)}" is an evaluator for ${got}.`);
    return;
  }
  if (k === 'tag') typecheck(ast[1], 'string');
  else if (k === 'un') typecheck(ast[2], 'string');
  else if (k === 'bin') { typecheck(ast[2], 'string'); typecheck(ast[3], 'string'); }
  else if (k === 'cond') for (const x of ast.slice(1)) typecheck(x, 'string');
  if (want === 'geometry') throw new SyntaxError(`static error: Evaluator for geometry expected, but function "${evalName(ast)}" is an evaluator for string.`);
}

const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/']];

class P {
  constructor(toks, end, src) { this.toks = toks; this.k = 0; this.end = end; this.src = src; }
  fail(msg) { throw new SyntaxError(`${msg} in an if: expression`); }
  peek() { return this.toks[this.k] ?? [null, null, null]; }
  take(val) {
    const [kind, v] = this.peek();
    if (kind === null || (val !== undefined && v !== val)) return null;
    this.k++;
    return [kind, v];
  }
  expect(val) { if (!this.take(val)) this.fail(`expected '${val}'`); }
  /** Overpass's token tree (tokenizer_utils.cc) gives `?` priority 3 and `:` 4, left-associative:
   *  `a ? b : c ? d : e` is `(a ? b : c) ? d : e`, and a `?` can't stand between `?` and `:`. */
  ternary() {
    let c = this.binop(0);
    while (this.take('?')) {
      const a = this.binop(0);
      if (!this.take(':')) this.fail('parse error: Operator "?" must have a ":" operator as right-hand-side argument');
      c = ['cond', c, a, this.binop(0)];
    }
    if (this.peek()[1] === ':') this.fail('parse error: ":" cannot be used as binary operator');
    return c;
  }
  binop(lvl) {
    if (lvl === LEVELS.length) return this.unary();
    let a = this.binop(lvl + 1);
    for (;;) {
      const [kind, v] = this.peek();
      if (kind === 'op' && v === '%') this.fail('parse error: "%" cannot be used as binary operator');  // no evaluator has it
      if (kind === 'op' && LEVELS[lvl].includes(v)) {
        this.k++;
        if (this.peek()[0] === null) this.fail(`parse error: "${v}" needs a right hand side argument`);
        a = ['bin', v, a, this.binop(lvl + 1)];
      } else return a;
    }
  }
  unary() {
    const [kind, v] = this.peek();
    if (kind === 'op' && (v === '!' || v === '-')) {
      this.k++;
      this.noOperatorAfter(v);
      return ['un', v, this.unary()];
    }
    return this.primary();
  }
  /** Overpass's token tree reads `!` or a lone `-` right after a unary operator as a binary operator with an
   *  empty left side (`!!1`, `! -1`, `- -1`); `-!1` nests, and a minus glued to a number is part of the number. */
  noOperatorAfter(op) {
    const [kind, v, pos] = this.peek();
    if (kind !== 'op') return;
    if (v === '!' && op === '!') this.fail('parse error: "!" cannot be used as binary operator');
    if (v === '-' && !/^-\.?\d/.test(this.src.slice(pos, pos + 3))) {
      this.fail(`parse error: Put quotation marks around "${op}" if it should be a constant and not a tag evaluation.`);
    }
  }
  primary() {
    const t = this.take();
    if (!t) this.fail('parse error: Evaluator expected, but empty token found.');
    const [kind, v] = t;
    if (kind === 'num') return ['lit', v];
    if (kind === 'str') return ['lit', v.slice(1, -1).replace(/\\(.)/gs, '$1')];
    if (kind === 'op' && v === '(') { const e = this.ternary(); this.expect(')'); return e; }
    if (kind === 'op' && v === '::') return ['generic'];        // the current key's value in make/convert (bindKey)
    if (kind === 'op' && v === '.' && this.peek()[0] === 'id') {
      const e = this.primary();                       // `.b.count(ways)` parses, evaluates over an empty set
      if (e[0] !== 'setcall') this.fail('Property assignment needs a right-hand-side value');
      return ['setcall', null, e[2], e[3]];
    }
    if (kind === 'id') return this.name(v);
    this.fail(`unexpected token '${v}'`);
  }
  name(v) {
    if (v === 't' && this.peek()[1] === '[') return this.tagValue();
    let setName = null;
    if (this.peek()[1] === '.' && this.toks[this.k + 1]?.[0] === 'id') {
      this.k++;
      setName = v; v = this.take()[1];
      if (v === 'val') return ['val', setName];
    }
    if (this.take('(')) return this.functionCall(v, setName);
    if (setName !== null) return ['prop', setName, v];        // eval-set-key: only `for` sets a key (val)
    if (TYPE_WORDS.has(v)) return ['lit', v];
    this.fail(`unexpected word '${v}'`);
  }
  tagValue() {
    this.expect('[');
    const nxt = this.toks[this.k + 1]?.[1];
    if (this.peek()[0] === 'id' && nxt !== '.' && nxt !== '(') this.fail(`parse error: Put quotation marks around "${this.peek()[1]}" if it should be a constant and not a tag evaluation.`);
    const k = this.ternary();
    this.expect(']');
    return ['tag', k];
  }
  functionCall(v, setName) {
    const args = this.args(v);
    if (UNSUPPORTED_FUNCS.has(v)) throw new Unsupported(`${v}(): version, timestamp, changeset and user are not in a bundle`);
    if (!SCALARS.has(v) && !AGGREGATES.has(v)) this.fail(`parse error: Function "${v}" not known`);
    if (setName !== null && !AGGREGATES.has(v)) this.fail(`parse error: ${v}(...) cannot have an input set`);
    if (args.length && NO_ARGUMENTS.has(v)) this.fail(`parse error: ${v}(...) does not accept any arguments`);
    if ((args.length > 1 && ONE_ARGUMENT.has(v)) || (args.length > 2 && TWO_ARGUMENTS.has(v))) this.fail('parse error: "," cannot be used as binary operator');
    if (args.length === 1 && TWO_ARGUMENTS.has(v)) this.fail(`parse error: ${v}(...) needs two arguments`);
    if (!args.length && NEED_ARGUMENT.has(v)) this.fail(`parse error: ${v}(...) needs an argument`);
    if (!args.length && ONE_OR_MORE.has(v)) this.fail(`parse error: ${v}(...) must have one or more arguments`);
    if (v === 'count') {
      if (!args.length) this.fail('parse error: count(...) must have one or more arguments');
      if (args.length !== 1 || args[0][0] !== 'lit' || !COUNT_TYPES.has(args[0][1])) {
        this.fail('parse error: "count" accepts only one of "nodes", "ways", "relations", "deriveds", "nwr", "nw", "wr", or "nr" as type argument.');
      }
    }
    if (setName === null) return ['call', v, args];
    if (!AGGREGATES.has(v)) this.fail(`${v}() cannot be applied to a set`);
    return ['setcall', setName, v, args];
  }
  args(v) {
    const args = [];
    if (this.take(')')) return args;
    for (;;) {
      if (RAW_TOKEN_ARG.has(v) && !args.length && ['id', 'num'].includes(this.peek()[0]) && [')', ','].includes(this.toks[this.k + 1]?.[1])) {
        args.push(['lit', this.take()[1]]);
      } else if (RAW_TOKEN_ARG.has(v) && args.length === 1 && this.peek()[0] === 'str') {
        args.push([...this.primary(), 'quoted']);               // the type is a word: "ways" is refused (checkContext)
      } else args.push(this.ternary());
      if (this.take(')')) return args;
      this.expect(',');
    }
  }
}

// ---- C number parsing, as Overpass's data/utils.h uses it (strtoll base 0, strtod)

const CSPACE = ' \t\n\v\f\r';
const STRTOD = /[+-]?(?:0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?|[nN][aA][nN](?:\([0-9A-Za-z_]*\))?)/y;
const STRTOLL = /[+-]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)/y;
const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;

function hexFloat(body) {                         // "1a.8p3" (no 0x, no sign)
  const [mant, exp] = body.toLowerCase().split('p');
  const [ip, fp = ''] = mant.split('.');
  let v = 0;
  for (const c of ip) v = v * 16 + parseInt(c, 16);
  let scale = 1 / 16;
  for (const c of fp) { v += parseInt(c, 16) * scale; scale /= 16; }
  return v * 2 ** Number(exp ?? 0);
}

/** [value, end, erange] like C strtod; end = 0 when nothing was parsed. */
function strtod(s) {
  let i = 0;
  while (i < s.length && CSPACE.includes(s[i])) i++;
  STRTOD.lastIndex = i;
  const m = STRTOD.exec(s);
  if (!m) return [0, 0, false];
  const t = m[0], end = STRTOD.lastIndex;
  const neg = t.startsWith('-'), body = t.replace(/^[+-]/, ''), low = body.toLowerCase();
  if (low.startsWith('inf')) return [neg ? -Infinity : Infinity, end, false];
  if (low.startsWith('nan')) return [NaN, end, false];
  const v = low.startsWith('0x') ? (neg ? -1 : 1) * hexFloat(body.slice(2)) : Number(t);
  const mant = body.split(/[eEpP]/)[0];
  const nonzero = [...mant].some(c => !'0.xX'.includes(c));
  const erange = !Number.isFinite(v) || (nonzero && (v === 0 || Math.abs(v) < 2.2250738585072014e-308));
  return [v, end, erange];
}

/** strtoll(s, &end, 0) consuming the whole string (leading blanks allowed); saturates. BigInt or null. */
function tryInt64(s) {
  if (/^\d{1,18}$/.test(s) && (s[0] !== '0' || s.length === 1)) return BigInt(s);
  if (s === '') return null;
  let i = 0;
  while (i < s.length && CSPACE.includes(s[i])) i++;
  STRTOLL.lastIndex = i;
  const m = STRTOLL.exec(s);
  if (!m || STRTOLL.lastIndex !== s.length) return null;
  const t = m[0], neg = t.startsWith('-'), b = t.replace(/^[+-]/, '');
  let v = b.slice(0, 2).toLowerCase() === '0x' ? BigInt(b) : b.length > 1 && b[0] === '0' ? BigInt('0o' + b.slice(1)) : BigInt(b);
  if (neg) v = -v;
  return v < I64_MIN ? I64_MIN : v > I64_MAX ? I64_MAX : v;
}

/** strtod consuming the whole string. */
function tryDouble(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '') return null;
  const [v, end] = strtod(s);
  return end && end === s.length ? v : null;
}

function tryStartsWithDouble(s) {
  if (s === '') return null;
  const [v, end, erange] = strtod(s);
  return end && !erange ? v : null;
}

function doubleSuffix(s) {
  if (s === '') return '';
  const [, end, erange] = strtod(s);
  if (end && !erange) { let r = s.slice(end); while (r && CSPACE.includes(r[0])) r = r.slice(1); return r; }
  return '';
}

/** Overpass's to_string(double): ostream << setprecision(14), i.e. C's %.14g. */
function fmt(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const [mant, expStr] = x.toExponential(13).split('e');
  const exp = Number(expStr);
  if (exp < -4 || exp >= 14) {
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    return `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  const f = x.toFixed(13 - exp);
  return f.includes('.') ? f.replace(/0+$/, '').replace(/\.$/, '') : f;
}

/** string_represents_boolean_true(). */
function truthy(s) {
  const d = tryDouble(s);
  return d !== null ? d !== 0 : s !== '';
}

const wrap64 = (v) => BigInt.asIntN(64, v);

function arith(op, a, b) {
  if (op !== '/') {
    const ia = tryInt64(a), ib = tryInt64(b);
    if (ia !== null && ib !== null) return String(wrap64(op === '+' ? ia + ib : op === '-' ? ia - ib : ia * ib));
  }
  const da = tryDouble(a), db = tryDouble(b);
  if (da !== null && db !== null) {
    if (op === '+') return fmt(da + db);
    if (op === '-') return fmt(da - db);
    if (op === '*') return fmt(da * db);
    if (db === 0) return fmt(da !== 0 && !Number.isNaN(da) ? Math.sign(da) * (Object.is(db, -0) ? -1 : 1) * Infinity : NaN);
    return fmt(da / db);
  }
  return op === '+' ? a + b : 'NaN';
}

const ENC = new TextEncoder();
/** std::string comparison: bytes (UTF-8). */
function byteCmp(a, b) {
  if (/^[\x00-\x7f]*$/.test(a) && /^[\x00-\x7f]*$/.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = ENC.encode(a), y = ENC.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length < 0 ? -1 : x.length > y.length ? 1 : 0;
}
/** Python's str ordering: by code point. */
const cpCmp = cpCompare;

function compare(op, a, b) {
  let c;
  const ia = tryInt64(a), ib = tryInt64(b);
  if (ia !== null && ib !== null) c = ia < ib ? -1 : ia > ib ? 1 : 0;
  else {
    const da = tryDouble(a), db = tryDouble(b);
    if (da !== null && db !== null) {
      if (Number.isNaN(da) || Number.isNaN(db)) return op === '!=';
      c = da < db ? -1 : da > db ? 1 : 0;
    } else c = byteCmp(a, b);
  }
  return { '==': c === 0, '!=': c !== 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[op];
}

const B = (x) => (x ? '1' : '0');

/**
 * Evaluates an AST. el: the element view (see Engine.elem), group: element views for aggregates,
 * sets(name) -> [element views, val] for `name.count(…)` / `name.val`.
 */
/** The expression for one key of a make/convert assignment: Overpass passes the key down the evaluator tree
 *  (set_prop.cc), and `::` (Evaluator_Generic) is that key's value in the element evaluated: t["key"]. */
function bindKey(ast, key) {
  if (!Array.isArray(ast)) return ast;
  if (ast[0] === 'generic') return ['tag', ['lit', key]];
  if (!hasGeneric(ast)) return ast;
  return ast.map((x, i) => (i === 0 ? x : Array.isArray(x) && typeof x[0] !== 'string' ? x.map(a => bindKey(a, key)) : bindKey(x, key)));
}

function hasGeneric(ast) {
  if (!Array.isArray(ast)) return false;
  if (ast[0] === 'generic') return true;
  return ast.some((x, i) => i > 0 && Array.isArray(x) && (typeof x[0] === 'string' ? hasGeneric(x) : x.some(hasGeneric)));
}

function evaluate(ast, el, group = null, val = '', sets = null) {
  switch (ast[0]) {
    case 'lit': return ast[1];
    case 'prop': case 'generic': return '';             // bindKey replaces `::` where a key is set
    case 'val': {
      const name = ast[1] ?? '_';
      return name === '_' || !sets ? val : sets(name)[1];
    }
    case 'setcall': {
      if (!sets) throw new Unsupported(`${ast[1]}.${ast[2]}(): set-qualified aggregates need a query context`);
      const [members, v] = ast[1] !== null ? sets(ast[1]) : [[], ''];
      return call(ast[2], ast[3], null, members, v, sets);
    }
    case 'tag': {
      const key = evaluate(ast[1], el, group, val, sets);
      const v = el ? el.tag(key) : undefined;
      return v === undefined || v === null ? '' : v;
    }
    case 'un': {
      const v = evaluate(ast[2], el, group, val, sets);
      if (ast[1] === '!') return B(!truthy(v));
      const i = tryInt64(v);
      if (i !== null) return String(i !== I64_MIN ? -i : i);
      const d = tryDouble(v);
      return d !== null ? fmt(-d) : 'NaN';
    }
    case 'cond': return evaluate(truthy(evaluate(ast[1], el, group, val, sets)) ? ast[2] : ast[3], el, group, val, sets);
    case 'bin': {
      const op = ast[1], a = evaluate(ast[2], el, group, val, sets);
      if (op === '&&') return B(truthy(a) && truthy(evaluate(ast[3], el, group, val, sets)));
      if (op === '||') return B(truthy(a) || truthy(evaluate(ast[3], el, group, val, sets)));
      const b = evaluate(ast[3], el, group, val, sets);
      if (['==', '!=', '<', '<=', '>', '>='].includes(op)) return B(compare(op, a, b));
      return arith(op, a, b);
    }
    case 'call': return call(ast[1], ast[2], el, group, val, sets);
  }
  throw new Error(`bad expression ${ast[0]}`);
}

const DBL_MAX = 1.7976931348623157e308;

/** aggregators.cc (min/max/sum) and set_list_operators.cc (lrs_min/lrs_max), as in expr.py. */
function numericAggregate(name, vals, start = 'void') {
  if (name === 'sum') {
    let typ = 'int', rl = 0n, rd = 0;
    for (const v of vals) {
      if (typ === 'int') { const i = tryInt64(v); if (i !== null) rl = wrap64(rl + i); else typ = 'dbl'; }
      if (typ === 'int' || typ === 'dbl') { const d = tryDouble(v); if (d !== null) rd += d; else typ = 'str'; }
    }
    return typ === 'int' ? String(rl) : typ === 'dbl' ? fmt(rd) : 'NaN';
  }
  const lo = name === 'min';
  let typ = start;
  let rl = lo ? I64_MAX : I64_MIN, rd = lo ? DBL_MAX : -DBL_MAX, rs = '';
  const pick = lo ? (a, b) => (b < a ? b : a) : (a, b) => (a < b ? b : a);
  for (const v of vals) {
    if (typ === 'void') typ = 'int';
    if (typ === 'int') { const i = tryInt64(v); if (i !== null) rl = pick(rl, i); else typ = 'dbl'; }
    if (typ === 'int' || typ === 'dbl') { const d = tryDouble(v); if (d !== null) rd = pick(rd, d); else typ = 'str'; }
    if (v !== '') rs = rs === '' ? v : (lo ? (byteCmp(v, rs) < 0 ? v : rs) : (byteCmp(rs, v) < 0 ? v : rs));
  }
  return typ === 'void' ? '' : typ === 'int' ? String(rl) : typ === 'dbl' ? fmt(rd) : rs;
}

/** Overpass's trim() in set_list_operators.cc, quirks included. */
function trim(x) {
  let frm = 0;
  while (frm < x.length && /\s/.test(x[frm])) frm++;
  if (frm === x.length) return ' ';
  let to = x.length - 1;
  while (/\s/.test(x[to])) to--;
  return x.substr(frm, to + 1);
}

const lrs = (s) => (s === '' ? [] : [...new Set(s.split(';').map(trim))].sort(cpCmp));

function date(s, isDate) {
  const parts = [];
  let pos = 0;
  for (let k = 0; k < 6; k++) {
    while (pos < s.length && !/\d/.test(s[pos])) pos++;
    let v = 0;
    while (pos < s.length && /\d/.test(s[pos])) { v = 10 * v + Number(s[pos]); pos++; }
    parts.push(v);
  }
  const [y, mo, d, h, mi, se] = parts;
  const bad = y < 1000 || mo > 12 || d > 31 || h > 23 || mi > 59 || se > 60;
  if (isDate) return bad ? '0' : '1';
  if (bad) return 'NaD';
  return fmt(y + mo / 16 + d / (16 * 32) + h / (16 * 32 * 32) + mi / (16 * 32 * 32 * 64) + se / (16 * 32 * 32 * 64 * 64));
}

const MTYPES = { nodes: 'node', ways: 'way', relations: 'relation', rels: 'relation' };

/** Evaluator_Properties_Count (tag_value.cc). */
function propCount(name, args, a, el) {
  const byRole = name.endsWith('by_role');
  const role = byRole && a.length ? a[0] : null;
  const word = byRole && args.length > 1 ? args[1] : !byRole && args.length ? args[0] : null;
  const mtype = word && word[0] === 'lit' ? MTYPES[word[1]] ?? null : null;
  const t = el.meta('type');
  if (t === 'way' && !byRole && mtype === null) return el.meta(name);
  if (t !== 'relation') return '0';
  const ms = el.members().filter(m => (mtype === null || m[0] === mtype) && (role === null || m[2] === role));
  if (name === 'count_members' || name === 'count_by_role') return String(ms.length);
  return String(new Set(ms.map(m => m[0] + '/' + m[1])).size);
}

const COUNT_KINDS = { nodes: ['node'], ways: ['way'], relations: ['relation'], nwr: ['node', 'way', 'relation'],
  nw: ['node', 'way'], wr: ['way', 'relation'], nr: ['node', 'relation'] };

function call(name, args, el, group, val, sets) {
  if (AGGREGATES.has(name)) return aggregate(name, args, group, val, sets);
  if (name === 'per_member' || name === 'per_vertex') return perMemberOrVertex(name, args, el, group, val, sets);
  if (el === null && !PURE.has(name)) throw new Error(`parse error: ${name}(...) must be called in a context where it can evaluate an element`);
  const a = args.map(x => evaluate(x, el, group, val, sets));
  if (name === 'angle') return el.meta('angle');
  if (name in GEOM_FUNCS) return geomCall(name, a, el);
  const f = SCALAR_FUNCS[name];
  return f ? f(a, el, args) : el.meta(name);
}

function aggregate(name, args, group, val, sets) {
  if (group === null) throw new Unsupported(`${name}() outside make/for: aggregate functions work over a set (make and for aren't in the browser engine yet)`);
  if (name === 'count') {
    const kinds = COUNT_KINDS[args[0]?.[0] === 'lit' ? args[0][1] : ''];
    const tally = {};
    for (const e of group) { const t = e.etype(); tally[t] = (tally[t] ?? 0) + 1; }
    if (!kinds) return String(Object.entries(tally).filter(([t]) => !['node', 'way', 'relation', 'area'].includes(t)).reduce((s, [, n]) => s + n, 0));
    return String(kinds.reduce((s, t) => s + (tally[t] ?? 0), 0));
  }
  if (name === 'gcat') {
    let comp = null;
    for (const e of group) { const g = evaluate(args[0], e, null, val, sets); if (g) { comp ??= new G.Compound(); comp.addComponent(g); } }
    return comp;
  }
  const vals = group.map(e => evaluate(args[0], e, null, val, sets));
  if (name === 'min' || name === 'max' || name === 'sum') return numericAggregate(name, vals);
  const distinct = [...new Set(vals.filter(v => v !== ''))];
  if (name === 'set') return distinct.sort(cpCmp).join(';');
  return !distinct.length ? '' : distinct.length === 1 ? distinct[0] : MULTIPLE;          // u()
}

/** The element seen from one member position inside per_member()/per_vertex(). */
class MemberView {
  constructor(el, i, m) { this.el = el; this.i = i; this.m = m; }
  tag(k) { return this.el.tag(k); }
  tags() { return this.el.tags(); }
  members() { return this.el.members(); }
  etype() { return this.el.etype(); }
  countTags() { return this.el.countTags(); }
  meta(name) {
    if (name === 'pos') return String(this.i + 1);
    if (name === 'mtype') return this.m[0];
    if (name === 'ref') return String(this.m[1]);
    if (name === 'role') return this.m[2];
    if (name === 'angle') return this.el.angle(this.i);
    return this.el.meta(name);
  }
}

function perMemberOrVertex(name, args, el, group, val, sets) {
  if (el === null) throw new Error(`parse error: ${name}(...) must be called in a context where it can evaluate an element`);
  const ms = el.members();
  let idx;
  if (name === 'per_member') idx = ms.map((_, i) => i);
  else {
    if (el.meta('type') !== 'way' || ms.length <= 2) return '';
    idx = [...Array(ms.length - 2).keys()].map(i => i + 1);
    if (el.meta('is_closed') === '1') idx.push(ms.length - 1);
  }
  return idx.map(i => evaluate(args[0], new MemberView(el, i, ms[i]), group, val, sets)).join(';');
}

function numberOrAbs(s, absolute) {
  const i = tryInt64(s);
  if (i !== null) return String(absolute && i < 0n && i !== I64_MIN ? -i : i);
  const d = tryStartsWithDouble(s);
  if (d === null) return 'NaN';
  return fmt(absolute ? Math.abs(d) : d);
}

/** expr.py _geom_call. */
function geomCall(name, a, el) {
  if (name === 'geom') return el.geometry();
  if (name === 'pt') {
    const la = tryDouble(a[0]), lo = tryDouble(a[1]);
    if (la !== null && la >= -90 && la <= 90 && lo !== null && lo >= -180 && lo <= 180) return new G.Point(la, lo);
    return new G.Null();
  }
  if (name === 'lstr') return new G.Linestring(a.filter(g => g && g.hasCenter()).map(g => [g.centerLat(), g.centerLon()]));
  if (name === 'poly') {
    const fp = new G.FreePolygon();
    for (const g of a) if (g && g.hasLineGeometry()) fp.addLinestring(g.line());
    return G.rhrPolygon(fp);
  }
  const g = a[0];
  if (!g) return null;
  if (name === 'center') return g.hasCenter() ? new G.Point(g.centerLat(), g.centerLon()) : new G.Null();
  if (name === 'trace') return G.makeTrace(g);
  if (name === 'hull') return G.makeHull(g);
  throw new Error(`bad geometry function ${name}`);
}

const lrsMinMax = (name) => (a) => (a[0] === '' ? '' : numericAggregate(name === 'lrs_min' ? 'min' : 'max', a[0].split(';').map(trim), 'int'));

const SCALAR_FUNCS = {
  lrs_in: (a) => (a[1] === '' ? '0' : B(new Set(a[1].split(';').map(trim)).has(trim(a[0])))),
  lrs_isect: (a) => { const y = new Set(lrs(a[1])); return lrs(a[0]).filter(x => y.has(x)).join(';'); },
  lrs_union: (a) => [...new Set([...lrs(a[0]), ...lrs(a[1])])].sort(cpCmp).join(';'),
  lrs_min: lrsMinMax('lrs_min'),
  lrs_max: lrsMinMax('lrs_max'),
  is_tag: (a, el) => B(el.tag(a[0]) !== undefined),
  number: (a) => numberOrAbs(a[0], false),
  abs: (a) => numberOrAbs(a[0], true),
  is_number: (a) => B(tryInt64(a[0]) !== null || tryStartsWithDouble(a[0]) !== null),
  suffix: (a) => doubleSuffix(a[0]),
  date: (a) => date(a[0], false),
  is_date: (a) => date(a[0], true),
  count_tags: (a, el) => String(el.countTags()),
  count_members: (a, el, args) => propCount('count_members', args, a, el),
  count_distinct_members: (a, el, args) => propCount('count_distinct_members', args, a, el),
  count_by_role: (a, el, args) => propCount('count_by_role', args, a, el),
  count_distinct_by_role: (a, el, args) => propCount('count_distinct_by_role', args, a, el),
  keys: (a, el) => [...new Set(Object.keys(el.tags()))].sort(cpCmp).join(';'),
};

return { parseExpr, strtod, tryInt64, tryDouble, fmt, truthy, bindKey, evaluate };
})();
// ---- localize.js
__m["localize.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// `local [ll|llb][(s,w,n,e)]`: Overpass's localized representation of a set. A port of osm_bypass/localize.py,
// itself a port of Overpass API statements/localize.cc (Copyright (C) 2008-2018 Roland Olbricht et al.,
// AGPL-3.0-or-later).
//
// The input's ways are split into *links* at every node shared with another way (or used twice); tagged nodes
// become *vertices*; each relation becomes a chain of *trigraphs* (one per member, or per link of a member way,
// linked by _previous/_next). Nodes at the same position get _local_ids. Mode l keeps tagged objects only, ll
// adds untagged ways and empty members, llb adds everything plus the OSM references (_node_ref, _way_ref, …).

const G = __m["geometry.js"];
const { quadtile, calcRanges, calcParents, inU31Ranges } = __m["ovindex.js"];
const { latFromY, lonFromX } = __m["bundle.js"];
const { NO_WAYNODE_IDS, Unsupported } = __m["errors.js"];
const { cpCompare } = __m["text.js"];

const MODES = { l: 0, ll: 1, llb: 2 };
const NO_POS = 100.0;                     // latitude marking "no coordinate yet"
const EPS = 5e-8;                         // bbox tolerance in degrees (localize.cc)
const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];
const cpCmp = cpCompare;
const pairCmp = (a, b) => cpCmp(a[0], b[0]) || cpCmp(a[1], b[1]);

class NodeInfo { constructor() { this.localId = 0; this.count = 0; this.lat = NO_POS; this.lon = 0.0; this.links = new Map(); } }
class Section { constructor(pos, localFrom, first) { this.pos = pos; this.id = 0; this.localFrom = localFrom; this.localTo = 0; this.pts = [first]; } }

function localize(engine, st, ctx) {
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

return { localize };
})();
// ---- parse.js
__m["parse.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Overpass QL parser (a port of ql.py, piece by piece): settings, tokens, statements -> a statement list
// for Engine.run. Split out of engine.js; the engine imports parse().

const { Unsupported } = __m["errors.js"];
const { parseExpr, strtod } = __m["expr.js"];

function tokenize(src) {
  const toks = [];
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(->|::|!=|!~|==|<=|>=|&&|\|\||~|=|[()\[\];,.:!<>{}+\-*\/%?|&^])/y;
  // ql.py string(): a backslash keeps the next character (\n and \t are newline and tab)
  const unescape = (s) => s.replace(/\\(.)/gs, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  let m;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    if (!(m = re.exec(src))) {                    // any other character is a token of its own, as in Overpass
      toks.push({ t: 'p', v: String.fromCodePoint(src.codePointAt(at)), at, end: at + String.fromCodePoint(src.codePointAt(at)).length });
      re.lastIndex = toks.at(-1).end;
      continue;
    }
    if (m[1] !== undefined) toks.push({ t: 'str', v: unescape(m[1]), at, end: re.lastIndex });
    else if (m[2] !== undefined) toks.push({ t: 'str', v: unescape(m[2]), at, end: re.lastIndex });
    else if (m[3] !== undefined) toks.push({ t: 'num', v: m[3], at, end: re.lastIndex });
    else if (m[4] !== undefined) toks.push({ t: 'id', v: m[4], at, end: re.lastIndex });
    else if (m[5] !== undefined) toks.push({ t: 'p', v: m[5], at, end: re.lastIndex });
  }
  return toks;
}

// Overpass compiles regexes as POSIX ERE: Perl-only syntax is a static error there, and POSIX bracket
// classes need translating (ql.py _regex, _posix_classes)
const POSIX = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t', punct: '!-/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: ' -~', graph: '!-~' };
function regex(pattern, ci) {
  if (pattern.includes('(?')) throw new SyntaxError(`static error: Invalid regular expression: "${pattern}"`);
  const p = pattern.replace(/\[:([a-z]+):\]/g, (m, c) => POSIX[c] ?? m);
  try { return new RegExp(p, ci ? 'i' : ''); } catch (e) { throw new SyntaxError(`static error: Invalid regular expression: "${pattern}"`); }
}

const QUERY_TYPES = { node: ['node'], way: ['way'], relation: ['relation'], rel: ['relation'],
  nwr: ['node', 'way', 'relation'], nw: ['node', 'way'], wr: ['way', 'relation'], nr: ['node', 'relation'], area: ['area'], derived: ['derived'] };
// ql.py _RECURSION_RESULTS: what each recursion filter can produce
const RECURSION_RESULTS = { r: [null, 'nodes, ways, or relations'], w: [['node'], 'nodes'], br: [['relation'], 'relations'],
  bw: [['relation'], 'relations'], bn: [['way', 'relation'], 'ways or relations'] };

// ---- settings ([out:…][timeout:…][bbox:…];), from the raw text as ql.py _settings does -----------------

const UNSUPPORTED_SETTINGS = { date: "historical queries need OSM's edit history, which the local copy doesn't keep",
  diff: "diff queries need OSM's edit history, which the local copy doesn't keep",
  adiff: "diff queries need OSM's edit history, which the local copy doesn't keep" };

/** Index of the ']' closing a setting, skipping brackets and quotes inside it (ql.py _setting_end). */
function settingEnd(t, i) {
  let depth = 0, q = null;
  for (; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { if (depth === 0 && c === ']') return i; depth--; }
  }
  return -1;
}

/** Overpass's decode_json for a quoted token: \n \t \uXXXX, and \x for any other character x. */
function decodeJson(t) {
  return t.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (m, c) => c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' ? '\n' : c === 't' ? '\t' : c);
}

/** [out:csv(fields; header; separator)] (ql.py _csv_spec). */
function csvSpec(raw) {
  raw = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const m = /^csv\s*\(([\s\S]*)\)\s*$/.exec(raw);
  if (!m) throw new SyntaxError('expected [out:csv(fields; header; separator)]');
  const parts = [];
  let cur = '', q = null;
  for (const c of m[1]) {
    if (q) { cur += c; if (c === q) q = null; }
    else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === ';') { parts.push(cur); cur = ''; }
    else cur += c;
  }
  parts.push(cur);
  if (/[\u201c\u201d\u2018\u2019]/.test(parts[0])) throw new SyntaxError('CSV format specification expected (typographic quotes are not quotes)');
  const fields = [];
  for (let f of parts[0].split(',')) {
    f = f.trim();
    const pre = f.startsWith('::') ? '::' : '';
    f = f.slice(pre.length).trim();
    if (f && (f[0] === '"' || f[0] === "'") && f.at(-1) === f[0] && f.length >= 2) f = decodeJson(f.slice(1, -1));
    else if (pre && f.includes(':')) throw new SyntaxError("parse error: ',', ';', or ')'  expected - ':' found.");   // ::"count:nodes" needs quotes
    f = pre + f;
    if (f) fields.push(f);
  }
  if (!fields.length) throw new SyntaxError("parse error: CSV format specification expected - ')' found.");      // the field list is empty
  let header = true;
  if (parts.length > 1 && parts[1].trim()) header = parts[1].trim().toLowerCase() !== 'false';
  let sep = '\t';
  if (parts.length > 2 && parts[2].trim()) sep = parts[2].trim().replace(/^["']+|["']+$/g, '').replace(/\\t/g, '\t');
  return { fields, header, sep };
}

/** output_popup_factory.cc: ("title"; [k=v][k2~re]; [k3]; "title key";) ... (ql.py _popup_spec). */
function popupSpec(raw) {
  const toks = [];
  const re = /\s*(?:("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(!=|[()\[\];!~=])|([^\s()\[\];!~="']+))/g;
  let m;
  while ((m = re.exec(raw)) && m[0] !== '') {
    if (m[1]) toks.push(['s', m[1].slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'")]);
    else if (m[2]) toks.push(['p', m[2]]);
    else if (m[3]) toks.push(['s', m[3]]);
  }
  let k = 0;
  const peek = () => toks[k] ?? ['', ''];
  const isTok = (t, v) => peek()[0] === t && peek()[1] === v;
  const until = (stops, consume = true) => {
    while (k < toks.length && !(toks[k][0] === 'p' && stops.includes(toks[k][1]))) k++;
    if (consume && k < toks.length) k++;
  };
  const cats = [];
  until(['(', ']'], false);
  while (isTok('p', '(')) {
    k++;
    const cat = { title: peek()[1], conjs: [], titleKey: '' };
    k++;
    if (isTok('p', ';')) until([';', ')'], true); else until([';', ')']);
    while (isTok('p', '[')) {
      const conj = [];
      while (isTok('p', '[')) {
        k++;
        if (peek()[0] !== 's') throw new SyntaxError(`parse error: Key expected - '${peek()[1]}' found.`);
        const key = peek()[1];
        k++;
        let value = '.', straight = true;
        until(['!', '~', '=', '!=', ']'], false);
        if (isTok('p', '!')) { straight = false; k++; until(['~', '=', ']'], false); }
        if ((peek()[1] === '=' || peek()[1] === '!=') && peek()[0] === 'p') { straight = peek()[1] === '='; k++; value = '^' + peek()[1] + '$'; k++; }
        else if (isTok('p', '~')) { k++; value = peek()[1]; k++; }
        until([']']);
        conj.push([key, value, straight]);
      }
      until([';']);
      cat.conjs.push(conj);
    }
    if (!isTok('p', ')')) { cat.titleKey = peek()[1]; k++; until([';']); }
    until([')']);
    cats.push(cat);
  }
  return cats;
}

/** eval_number_with_suffix (ql.py limits.number_with_suffix): C strtoll base 0, then ki/Mi/Gi or k/M/G; 0 for
 *  anything Overpass can't read. */
function numberWithSuffix(text) {
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)/.exec(text);
  if (!m) return 0;
  const digits = m[2];
  const v = (m[1] === '-' ? -1 : 1) * (/^0[xX]/.test(digits) ? parseInt(digits, 16) : digits.length > 1 && digits[0] === '0' ? parseInt(digits, 8) : Number(digits));
  let rest = text.slice(m[0].length);
  if (!rest) return v;
  if (rest.startsWith(' ')) rest = rest.slice(1);
  const f = { ki: 1024, Mi: 1 << 20, Gi: 1 << 30, k: 1000, M: 1e6, G: 1e9 }[rest];
  return f ? v * f : 0;
}

// A token as Overpass's tokenizer reads it (for "X expected - Y found" and unquoted setting values)
const FOUND = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z_0-9]*|[-+]?(?:\d+\.?\d*|\.\d+)|->|::|\S/;

const SETTING_NUMBER_ERROR = a => `static error: For the attribute "${a}" of the element "osm-script" the only allowed values are positive integers optionally with suffix "ki", "Mi", or "Gi".`;

function parseSettings(src) {
  let i = 0, seen = false;
  const settings = { out: 'json', outGiven: false };
  const skip = () => {
    for (;;) {
      const m = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(src.slice(i, i + 100000));
      if (!m) return;
      i += m[0].length;
    }
  };
  const expectChar = (c) => {
    skip();
    if (src[i] !== c) throw new SyntaxError(`parse error: '${c}' expected - '${src.slice(i).match(FOUND)?.[0] ?? ''}' found.`);
    i++;
  };
  skip();
  while (src[i] === '[') {
    seen = true;
    i++; skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) throw new SyntaxError('expected a setting name');
    const name = m[0];
    i += name.length;
    expectChar(':');
    if (name in UNSUPPORTED_SETTINGS) throw new Unsupported(`[${name}:…]: ${UNSUPPORTED_SETTINGS[name]}`);
    if (!['out', 'timeout', 'maxsize', 'bbox'].includes(name)) throw new SyntaxError(`static error: Unknown attribute "${name}" in element "osm-script".`);
    if (name === 'bbox') {
      const j = settingEnd(src, i);
      const vals = src.slice(i, j).split(',').map(v => Number(v.trim()));
      if (vals.length < 4) throw new SyntaxError('static error: A bounding box needs four comma-separated values.');
      if (vals.length > 4) throw new SyntaxError("parse error: ']' expected - ',' found.");
      if (vals.some(Number.isNaN)) throw new SyntaxError('expected [bbox:south,west,north,east]');
      if (!(vals[0] >= -90 && vals[0] <= 90 && vals[2] >= -90 && vals[2] <= 90)) throw new SyntaxError('static error: Latitudes in bounding boxes must be between -90.0 and 90.0.');
      if (!(vals[1] >= -180 && vals[1] <= 180 && vals[3] >= -180 && vals[3] <= 180)) throw new SyntaxError('static error: Longitudes in bounding boxes must be between -180.0 and 180.0.');
      const [sv, w, n, e] = vals;
      settings.bbox = { kind: 'bbox', s: sv, w, n, e };
      i = j;
    } else {
      const j = settingEnd(src, i);
      if (j < 0) throw new SyntaxError("expected ']'");
      const raw = src.slice(i, j).trim();
      settings[name] = raw.replace(/^["']+|["']+$/g, '');
      // parse_setup joins the tokens with blanks: 1Gi is "1 Gi", 0x10 is "0 x10" (refused); quoted, strtoll base 0
      if ((name === 'timeout' || name === 'maxsize') && !/^["']/.test(raw)) settings[name] = (raw.match(new RegExp(FOUND.source, 'g')) ?? []).join(' ');
      if ((name === 'timeout' || name === 'maxsize') && numberWithSuffix(settings[name]) <= 0) {
        throw new SyntaxError(SETTING_NUMBER_ERROR(name === 'timeout' ? 'timeout' : 'element-limit'));
      }
      if (name === 'out') settings.outGiven = true;
      i = j;
    }
    expectChar(']');
    skip();
  }
  if (seen) expectChar(';');
  const fmt = settings.out;
  if (fmt.startsWith('csv')) { settings.csv = csvSpec(fmt); settings.out = 'csv'; }
  else if (fmt.startsWith('popup')) { settings.popup = popupSpec(fmt.slice(5)); settings.out = 'popup'; }
  else if (fmt.startsWith('custom')) throw new Unsupported('[out:custom]: it fills templates stored on the Overpass server');
  else if (fmt !== 'json' && fmt !== 'xml') throw new SyntaxError(`parse error: Unknown output format: ${fmt.split('(')[0]}`);
  return { settings, rest: i };
}

const AROUND_RADIUS_ERROR = 'static error: For the attribute "radius" of the element "around" the only allowed ' +
  'values are nonnegative floats.';
const AROUND_LAT_ERROR = 'static error: For the attribute "lat" of the element "around" the only ' +
  'allowed values are floats between -90.0 and 90.0 or an empty value.';
const AROUND_LON_ERROR = 'static error: For the attribute "lon" of the element "around" the only ' +
  'allowed values are floats between -1800.0 and 180.0 or an empty value.';          // sic, as Overpass says it

/** `istream >> double`: [value, position, stream still good]. A failed read gives 0 and a bad stream; reaching
 *  the end of the text also leaves it not good (eofbit) (ql.py _stream_double). */
function streamDouble(text, pos) {
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(pos));
  if (!m) return [0, pos, false];
  return [Number(m[0]), pos + m[0].length, pos + m[0].length < text.length];
}

function aroundPoint(lat, lon) {
  if (!(lat >= -90 && lat <= 90)) throw new SyntaxError(AROUND_LAT_ERROR);
  if (!(lon >= -180 && lon <= 180)) throw new SyntaxError(AROUND_LON_ERROR);
  return [lat, lon];
}

function parse(src) {
  const { settings, rest } = parseSettings(src);
  const body = src.slice(rest);
  const toks = tokenize(body);
  let i = 0;
  const peek = (k = 0) => toks[i + k];
  const isP = (v, k = 0) => peek(k)?.t === 'p' && peek(k).v === v;
  const isId = (v, k = 0) => peek(k)?.t === 'id' && peek(k).v === v;
  const found = () => { const t = peek() ?? toks.at(-1); return t ? body.slice(t.at, t.end) : ''; };
  const expect = (v) => { if (!isP(v)) throw new SyntaxError(`parse error: '${v}' expected - '${found()}' found.`); i++; };
  const word = () => { const t = toks[i++]; if (!t || t.t === 'p') throw new SyntaxError(`expected a value near token ${i}`); return t.v; };
  const num = () => {
    const neg = isP('-') ? (i++, -1) : 1;
    if (isP('.') && peek(1)?.t === 'num' && peek(1).at === peek().end && /^\d/.test(peek(1).v)) { i++; return neg * Number('.' + word()); }
    return neg * Number(word());
  };
  /** A set name after `.`: Overpass wants an identifier (`.1` and `."x"` are refused). */
  const setName = () => {
    if (peek()?.t !== 'id') throw new SyntaxError(`parse error: Variable expected - '${found()}' found.`);
    return word();
  };
  // around.cc reads its arguments through C atof: a placeholder such as `latNode1` is 0 (ql.py _atof)
  const atof = () => { const neg = isP('-') ? (i++, -1) : 1; const [v, end] = strtod(word()); return end ? neg * v : 0; };
  // Unquoted keys and values are letters, digits and '_' only, as in Overpass: ["addr:street"] needs the
  // quotes, and [addr:street] is a parse error there too (ql.py _UNQUOTED).
  const tagWord = () => {
    const v = word();
    if (isP(':')) throw new SyntaxError("parse error: '!', '~', '=', '!=', or ']'  expected - ':' found.");      // sic: two blanks, as Overpass
    return v;
  };
  const intList = () => { const out = [num()]; while (isP(',')) { i++; out.push(num()); } return out; };
  // > >> < << (two adjacent tokens for the doubled forms)
  const recOp = () => {
    const a = toks[i++].v;
    if (isP(a) && peek().at === toks[i - 1].end) { i++; return a + a; }
    return a;
  };

  // Overpass requires ';' after every statement, the last one too; after a block's closing bracket it's optional
  const endStatement = (st) => {
    if (st.block) { if (isP(';')) i++; return; }
    if (!isP(';')) throw new SyntaxError(`parse error: ';' expected - '${found()}' found.`);
    i++;
  };
  const statements = () => {
    const out = [];
    while (i < toks.length && !isP(')') && !isP('}')) {
      const st = statement();
      endStatement(st);
      out.push(st);
    }
    return out;
  };
  /** The statements of a block: `{ … }` or `( … )` (a block left open at the end of the query still runs). */
  const blockBody = () => {
    const close = isP('{') ? '}' : isP('(') ? ')' : null;
    if (!close) throw new SyntaxError(`parse error: '(' or '{' expected - '${found()}' found.`);
    i++;
    const out = [];
    while (!isP(close)) {
      if (!peek()) return out;
      const st = statement();
      endStatement(st);
      out.push(st);
    }
    i++;
    return out;
  };
  /** make/convert <type> key=expr, ... (ql.py _make), read from the raw text. */
  function makeStatement(from) {
    const kind = word();
    if (!peek() || isP(';') || isP('->')) throw new SyntaxError('static error: The attribute type must be set to a nonempty string.');
    if (peek().t !== 'id') throw new SyntaxError(`parse error: Element class name expected - '${found()}' found.`);
    const type = word();
    let pos = toks[i - 1].end;
    const ws = () => { const m = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(body.slice(pos)); pos += m[0].length; };
    const stringlike = (stop) => {
      ws();
      if (body[pos] === '"' || body[pos] === "'") {
        const q = body[pos]; let j = pos + 1, out = '';
        while (j < body.length && body[j] !== q) { if (body[j] === '\\' && j + 1 < body.length) { out += body[j + 1] === 'n' ? '\n' : body[j + 1] === 't' ? '\t' : body[j + 1]; j += 2; } else out += body[j++]; }
        if (j >= body.length) throw new SyntaxError('unterminated string');
        pos = j + 1;
        return out;
      }
      let j = pos;
      while (j < body.length && !/\s/.test(body[j]) && !stop.includes(body[j])) j++;
      if (j === pos) throw new SyntaxError('expected a value');
      const v = body.slice(pos, j); pos = j; return v;
    };
    /** The expression right of `=`; `::` in it is the value of the key being set. */
    const assignedValue = (want) => {
      ws();
      if (pos >= body.length || ';,'.includes(body[pos])) throw new SyntaxError('parse error: To set a property it must have a value to the right of the equal sign');
      const { ast, end } = parseExpr(body, pos, want, false, kind === 'convert');
      pos = end;
      return ast;
    };
    const assigns = [];
    ws();
    while (!(body[pos] === ';' || body.startsWith('->', pos))) {
      // `::=…` (every key of the element) or `set::=…` (every key in that set), blanks allowed between the
      // tokens; `::id=` and `::geom=` are special properties instead (set_prop.cc)
      const generic = /^(?:([A-Za-z_][A-Za-z_0-9]*)\s*)?::\s*=/.exec(body.slice(pos));
      if (generic) {
        const keysFrom = generic[1] ?? null;
        if (kind === 'make' && keysFrom === null) throw new SyntaxError('parse error: The generic tag set property can only be called from convert');
        pos += generic[0].length;
        if (assigns.some(a => a.key === '::=')) throw new SyntaxError(`static error: A ${kind} statement can have at most one any-key set-prop statement.`);
        assigns.push({ key: '::=', expr: assignedValue('string'), keysFrom });
      } else if (body[pos] === '!') {
        pos++;
        assigns.push({ key: stringlike('=,;-'), expr: null });
      } else {
        let key;
        if (body.startsWith('::', pos)) { pos += 2; ws(); const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(pos)); if (!m) throw new SyntaxError('expected a name after ::'); key = '::' + m[0]; pos += m[0].length; }
        else {
          ws();
          const quoted = body[pos] === '"' || body[pos] === "'";
          key = stringlike('=,;');
          const special = /[^A-Za-z0-9_]/.exec(key);
          if (special && !quoted) throw new SyntaxError(`parse error: if special character "${special[0]}" is present in property name then the property name must be in quotes`);
        }
        ws();
        if (body[pos] !== '=') throw new SyntaxError(`parse error: '=' expected - '${body.slice(pos).match(FOUND)?.[0] ?? ''}' found.`);
        pos++;
        if (key.startsWith('::') && key !== '::id' && key !== '::geom') throw new SyntaxError('parse error: The only allowed special properties are "id" and "geometry"');
        const ast = assignedValue(key === '::geom' ? 'geometry' : 'string');
        if ((key === '::id' || key === '::geom') && assigns.some(a => a.key === key)) {     // Overpass says "make" for convert's ::geom
          throw new SyntaxError(`static error: A ${key === '::id' ? kind : 'make'} statement can have at most one set-prop statement of subtype setting ${key === '::id' ? 'the id' : 'the geometry'}.`);
        }
        if (!key.startsWith('::') && assigns.some(a => a.key === key && a.expr)) throw new SyntaxError(`static error: A key cannot be added twice to an element: "${key}"`);
        assigns.push({ key, expr: ast });
      }
      ws();
      if (body[pos] === ',') { pos++; ws(); } else break;
    }
    while (i < toks.length && toks[i].at < pos) i++;
    return { kind: 'make', make: kind, type, from, assigns, into: target() };
  }

  /** An expression in parentheses after for/if, read from the raw text. */
  const parenExpr = (containerOk) => {
    expect('(');
    const { ast, end } = parseExpr(body, toks[i - 1].end, 'string', containerOk, containerOk);   // for: per element; if: once
    while (i < toks.length && toks[i].at < end) i++;
    expect(')');
    return ast;
  };

  const target = () => {
    if (isP('->')) {
      i++; expect('.');
      return setName();
    }
    return '_';
  };

  function outStatement(from) {
    const o = { kind: 'out', from, verbosity: 'body', geom: null, sort: 'asc', limit: null, ids: true };
    while (peek() && !isP(';')) {
      if (isP('(')) {                                   // (s,w,n,e): clip printed geometry to this box
        i++;
        const v = [num()]; for (let k = 0; k < 3; k++) { expect(','); v.push(num()); }
        expect(')');
        const [so, we, no, ea] = v;
        if (!(so >= -90 && so <= 90 && no >= -90 && no <= 90 && no >= so && we >= -180 && we <= 180 && ea >= -180 && ea <= 180)) throw new SyntaxError('static error: invalid bbox for print');
        o.bbox = v;
        continue;
      }
      if (peek().t === 'p' || peek().t === 'str') throw new SyntaxError(`parse error: Invalid parameter for print: "${found()}"`);
      const t = word();
      if (['ids', 'skel', 'body', 'tags'].includes(t)) { o.verbosity = t; o.count = false; }       // the last one counts
      else if (t === 'quirks') throw new SyntaxError('static error: For the attribute "mode" of the element "print" the only allowed values are "ids_only", "skeleton", "body", "tags",  "count", or "meta".');
      else if (['center', 'bb', 'geom'].includes(t)) o.geom = t;
      else if (t === 'asc' || t === 'qt') o.sort = t;
      else if (t === 'noids') o.ids = false;
      else if (t === 'meta' || t === 'attribution') {
        throw new Unsupported(`out ${t}: version, timestamp, changeset and user are not in a bundle. ` +
          'For editing, load the objects you found from the OSM API (e.g. JOSM load_object)');
      } else if (t === 'count') o.count = true;
      else if (/^\d+$/.test(t)) o.limit = Number(t);
      else throw new SyntaxError(`parse error: Invalid parameter for print: "${t}"`);
    }
    return o;
  }

  // ---- statements: statement() looks at the first tokens and hands over to the parser for that kind
  /** One statement, with `line` (where it starts; not enumerable) for runtime errors: Overpass names the
   *  statement and its line ('Query timed out in "query" at line 3 …', ql.py _statement). */
  function statement() {
    const at = rest + (peek()?.at ?? 0);
    let line = 1;
    for (let j = src.indexOf('\n'); j !== -1 && j < at; j = src.indexOf('\n', j + 1)) line++;
    const st = statementBody();
    Object.defineProperty(st, 'line', { value: line, enumerable: false });
    return st;
  }
  function statementBody() {
    if (isP('(')) return unionStatement();
    if (!peek()) throw new SyntaxError('parse error: Unexpected end of input.');
    if (isId('foreach') || isId('for')) return loopStatement();
    if (isId('if')) return ifStatement();
    let from = '_';
    if (isP('.')) {                                          // .set out | .set > | .set; | .set is_in | .set map_to_area
      i++; from = setName();
      if (isP(';') || isP('->') || !peek()) return { kind: 'copy', from, into: target() };
    }
    if (isP('<') || isP('>')) return { kind: 'recurse', op: recOp(), from, into: target() };
    if (isId('out')) { i++; return outStatement(from); }
    if (isId('is_in')) return isInStatement(from);
    if (isId('map_to_area')) { i++; return { kind: 'map_to_area', from, into: target() }; }
    if (isId('local')) return localStatement(from);
    if (isId('make') || isId('convert')) {
      if (isId('make') && from !== '_') throw new SyntaxError('static error: Unknown attribute "from" in element "make".');
      return makeStatement(from);
    }
    if (isId('complete')) return completeStatement(from);
    if (from !== '_' || isP('.')) {
      if (peek()?.t === 'id' && ['retro', 'compare'].includes(peek().v)) {
        throw new Unsupported(`'${peek().v}' compares the map at two dates, and a bundle holds one date only`);
      }
      throw new SyntaxError(`expected out, a recursion or ';' after .${from}`);
    }
    if (peek().t !== 'id') throw new SyntaxError(`parse error: Unknown type "${found()}"`);
    return queryStatement();
  }

  /** ( A; B; … )  a union; a difference is exactly ( A; - B; ) */
  function unionStatement() {
    i++;
    const items = [];
    let sign = '+', diff = false;
    while (!isP(')')) {
      if (!peek()) throw new SyntaxError(diff ? 'parse error: difference always requires two operands' : 'parse error: Unexpected end of input.');   // left open
      if (isP('-')) {
        if (items.length !== 1 || diff) throw new SyntaxError(diff ? 'parse error: difference always requires two operands' : 'parse error: Unknown type "-"');
        i++; sign = '-'; diff = true; continue;
      }
      if (diff && items.length === 2) throw new SyntaxError('parse error: difference always requires two operands');
      const st = statement();
      endStatement(st);
      items.push({ sign, st });
      sign = '+';
    }
    expect(')');
    return { kind: 'union', items, into: target() };
  }

  /** foreach[.in][->.var] { … }   for[.in][->.var] (expr) { … } */
  function loopStatement() {
    const kw = word();
    let from = '_';
    if (isP('.')) { i++; from = setName(); }
    const into = target();
    if (kw === 'foreach') return { kind: 'foreach', from, into, body: blockBody(), block: true };
    const key = parenExpr(true);
    return { kind: 'for', from, into, key, body: blockBody(), block: true };
  }

  /** if (expr) { … } else { … } */
  function ifStatement() {
    i++;
    const cond = parenExpr(false);
    const then = blockBody();
    let orelse = [];
    if (isId('else')) { i++; orelse = blockBody(); }
    return { kind: 'if', cond, then, orelse, into: '_', block: true };
  }

  /** [.in] is_in[(lat, lon)][->.out] */
  function isInStatement(from) {
    i++;
    let coords = null;
    if (isP('(')) {
      i++;
      const lat = num();
      const lon = isP(',') ? (i++, num()) : 1000;               // Overpass: is_in(1) is a bad longitude
      expect(')');
      for (const [n, v, lim] of [['lat', lat, 90], ['lon', lon, 180]]) {
        if (!(v >= -lim && v <= lim)) throw new SyntaxError(`static error: For the attribute "${n}" of the element "coord-query" the only allowed values are floats between -${lim}.0 and ${lim}.0.`);
      }
      coords = [lat, lon];
    }
    return { kind: 'is_in', from: coords ? null : from, coords, into: target() };
  }

  /** [.in] local [l|ll|llb][(s,w,n,e)][->.out] */
  function localStatement(from) {
    i++;
    let mode = 'l', bbox = null;
    if (peek() && peek().t !== 'p') {
      mode = word();
      if (!['l', 'll', 'llb'].includes(mode)) throw new SyntaxError('static error: Localize must have one of the values "l", "ll", or "llb". "l" is the default value.');
    }
    if (isP('(')) {
      i++;
      const v = [num()];
      for (let k = 0; k < 3; k++) { expect(','); v.push(num()); }
      expect(')');
      const [so, we, no, ea] = v;
      if (!(so >= -90 && so <= 90 && no >= -90 && no <= 90 && no >= so && we >= -180 && we <= 180 && ea >= -180 && ea <= 180)) throw new SyntaxError('static error: invalid bbox for local');
      bbox = v;
    }
    return { kind: 'local', from, mode, bbox, into: target() };
  }

  /** [.in] complete[(max)][.in][->.out] { … } */
  function completeStatement(from) {
    i++;
    let into = '_', maxnum = 4096;
    for (let k = 0; k < 3; k++) {
      if (isP('->')) into = target();
      else if (isP('.') && from === '_') { i++; from = setName(); }
      else if (isP('(')) {
        i++;
        if (peek() && !isP(')', 1)) { i++; expect(')'); }
        const t = peek();
        if (!t || t.t !== 'num' || !/^\d+$/.test(t.v) || Number(t.v) < 1 || Number(t.v) > 1048576 || !isP(')', 1)) {
          throw new SyntaxError('static error: Maximum loop number for complete must be an integer between "1" and "1048576".');
        }
        maxnum = Math.trunc(num()); expect(')');
      }
    }
    return { kind: 'complete', from, into, maxnum, body: blockBody(), block: true };
  }

  /** type[.in…][filter…][->.out]: a query, its filters in brackets or parentheses */
  function queryStatement() {
    const type = word();
    const types = QUERY_TYPES[type];
    if (!types) {
      if (['retro', 'compare', 'timeline'].includes(type)) {
        throw new Unsupported(`'${type}' needs the map's history, and a bundle holds one date only`);
      }
      throw new SyntaxError(`parse error: Unknown type "${type}"`);
    }
    const q = { kind: 'query', types, typeName: type, filters: [], inputs: [] };
    while (isP('[') || isP('(') || isP('.')) {
      if (isP('.')) { i++; q.inputs.push(setName()); }
      else if (isP('[')) tagFilter(q);
      else parenFilter(q);
    }
    if (type === 'derived' && q.filters.some(f => f.kind === 'ids')) {
      throw new SyntaxError('static error: For the attribute "type" of the element "id-query" the only allowed values are "node", "way", "relation", or "area".');
    }
    q.into = target();
    if (!q.filters.length && !q.inputs.length && !settings.bbox) throw new SyntaxError('parse error: An empty query is not allowed');
    return q;
  }

  /** [k] [!k] [k=v] [k!=v] [k~re] [k!~re] (,i) and [~"key"~"value"(,i)] */
  function tagFilter(q) {
    i++;
    let neg = false;
    if (isP('!')) { i++; neg = true; }
    if (isP('~')) {                                         // [~"key"~"value"(,i)]
      i++;
      const kre = word();
      expect('~');
      const vre = word();
      let ci = false;
      if (isP(',')) { i++; if (word() !== 'i') throw new SyntaxError("expected 'i' after ','"); ci = true; }
      expect(']');
      q.filters.push({ kind: 'likelike', kre: regex(kre, ci), vre: regex(vre, ci) });
      return;
    }
    const key = tagWord();
    if (isP(']')) { i++; q.filters.push({ kind: neg ? 'nokey' : 'key', key }); return; }
    if (neg) throw new SyntaxError('[!k=…] is invalid');
    if (!['=', '!=', '~', '!~'].some(o => isP(o))) throw new SyntaxError(`parse error: '!', '~', '=', '!=', or ']'  expected - '${found()}' found.`);
    const op = toks[i++].v;
    const value = tagWord();
    let ci = false;
    if (isP(',')) { i++; if (word() !== 'i') throw new SyntaxError('expected i'); ci = true; }
    expect(']');
    if (op === '=' || op === '!=') {
      if (value === '') return;                                    // [k=""] adds no filter (3.1)
      q.filters.push({ kind: op === '=' ? 'eq' : 'ne', key, value });
    } else if (op === '~' || op === '!~') {
      q.filters.push({ kind: op === '~' ? 're' : 'nre', key, re: regex(value, ci) });
    } else throw new SyntaxError(`operator ${op}`);
  }

  /** ( … ): an input set, a recursion, or the filter named by its first word (PAREN_FILTERS), else a bbox or IDs */
  function parenFilter(q) {
    i++;                                                           // '('
    if (isP('.')) { i++; q.inputs.push(word()); expect(')'); return; }      // (.set): an input set
    if (isP('<') || isP('>')) {                                    // (<) (>>.w): recursion as a filter
      const op = recOp();
      let set = '_';
      if (isP('.')) { i++; set = word(); }
      expect(')');
      q.filters.push({ kind: 'recurse', op, set });
      return;
    }
    const w = peek()?.t === 'id' ? peek().v : null;
    const named = w && (w.startsWith('around') ? aroundFilter : Object.hasOwn(RECURSION_RESULTS, w) ? relationFilter
      : Object.hasOwn(PAREN_FILTERS, w) ? PAREN_FILTERS[w] : null);           // own keys only: not (constructor)
    if (named) { named(q, w); return; }
    if (['user', 'uid', 'newer', 'changed', 'user_touched', 'uid_touched'].includes(w)) {
      throw new Unsupported(`filter (${w} …): bundles have no metadata (users, changesets, timestamps), so this can't be answered from them`);
    }
    if (peek()?.t === 'num' || isP('-')) {
      const vals = intList();
      expect(')');
      if (vals.length !== 1 && vals.length !== 4) throw new SyntaxError('expected one id or four bbox values');
      if (vals.length === 4) {
        const [s, ww, n, e] = vals;
        for (const [name, v, lim] of [['s', s, 90], ['w', ww, 180], ['n', n, 90], ['e', e, 180]]) {
          if (!(v >= -lim && v <= lim)) throw new SyntaxError(`static error: For the attribute "${name}" of the element "bbox-query" the only allowed values are floats between -${lim}.0 and ${lim}.0.`);
        }
        if (n < s) throw new SyntaxError('static error: The value of attribute "n" of the element "bbox-query" must always be greater or equal than the value of attribute "s".');
        q.filters.push({ kind: 'bbox', s, w: ww, n, e }); return;
      }
      q.filters.push({ kind: 'ids', ids: positiveIds(vals) }); return;
    }
    if (!peek()) throw new SyntaxError('unexpected end of the query');
    throw new SyntaxError(`unknown filter (${peek().v} …)`);
  }

  const positiveIds = (ids) => {
    if (ids.some(v => v === 0)) throw new SyntaxError('static error: For the attribute "ref" of the element "id-query" the only allowed values are positive integers.');
    return ids;
  };

  /** (around[.set]:r[,lat,lon…]) */
  function aroundFilter(q) {
    i++;
    let set = null;
    if (isP('.')) { i++; set = word(); }
    if (isP(':')) i++;
    if (!peek() || isP(')')) throw new SyntaxError('parse error: around requires the radius as first argument');
    const r = atof();
    if (r < 0) throw new SyntaxError(AROUND_RADIUS_ERROR);
    const nums = [];
    while (isP(',')) { i++; nums.push(atof()); }
    if (nums.length % 2) throw new SyntaxError('parse error: around requires an odd number of arguments');
    const coords = [];
    for (let k = 0; k < nums.length; k += 2) coords.push(aroundPoint(nums[k], nums[k + 1]));
    expect(')');
    q.filters.push({ kind: 'around', radius: r, coords, set: set ?? (coords.length ? null : '_') });   // (around:r): around `_`
  }

  /** (r) (w) (bn) (bw) (br) (n) …[.set][:role | :positions]: members or parents of a set */
  function relationFilter(q, w) {
    i++;
    let set = '_', role = null, positions = null;
    if (isP('.')) { i++; set = word(); }
    if (isP(':')) {
      i++;
      const typeName = q.types.length === 1 ? q.types[0] : q.typeName;
      if (w === 'r' || typeName === 'relation') role = word();          // recurse.cc: a role for relations ...
      else if (w === 'w' || typeName === 'way') {                      // ... node positions for ways
        positions = [];
        do {
          if (peek()?.t === 'str' || peek()?.t === 'id') {           // atoll: 0 (refused) or the leading digits
            const tok = word(), m = /^\s*[-+]?\d+/.exec(tok);
            if (!m || Number(m[0]) === 0) throw new SyntaxError(`static error: Invalid pos '${tok}' in positions list.`);
            positions.push([Number(m[0]), Number(m[0])]);
            continue;
          }
          const raw = (isP('-') ? '-' : '') + (peek(isP('-') ? 1 : 0)?.v ?? '');
          const a = num();
          if (a === 0) throw new SyntaxError(`static error: Invalid pos '${raw}' in positions list.`);
          let b = a;
          if (isP('-') && peek(1)?.t === 'num') { i++; b = num(); }                      // 2--1
          else if (peek()?.t === 'num' && peek().v.startsWith('-')) b = Number(word().slice(1));   // 2-3 (tokenized as 2, -3)
          positions.push([a, b]);
        } while (isP(',') && (i++, true));
      } else word();                                              // neither (bn on wr): Overpass ignores it
    }
    expect(')');
    const ok = RECURSION_RESULTS[w][0];
    const typeNames = ['nwr', 'nw', 'wr', 'nr'].includes(q.typeName) ? [q.typeName] : q.types;
    if (ok && !typeNames.every(t => ok.includes(t) || (w === 'bn' && t === 'wr'))) {
      throw new SyntaxError(`parse error: A recursion of type '${w}' produces ${RECURSION_RESULTS[w][1]}.`);
    }
    q.filters.push({ kind: 'rel', rel: w, set, role, positions });
  }

  /** The parenthesised filters named by their first word (around and the recursion results are matched apart). */
  const PAREN_FILTERS = {
    id(q) { i++; expect(':'); if (peek()?.t !== 'num' && !isP('-')) positiveIds([0]); q.filters.push({ kind: 'ids', ids: positiveIds(intList()) }); expect(')'); },
    area(q) {                                                    // (area:id,…) or (area[.set])
      i++;
      if (isP(':')) { i++; q.filters.push({ kind: 'areaIds', ids: intList() }); }
      else { let set = '_'; if (isP('.')) { i++; set = word(); } q.filters.push({ kind: 'inArea', set }); }
      expect(')');
    },
    if(q) {                                                      // (if: expression): parsed from the raw text
      i++;
      expect(':');
      const { ast, end } = parseExpr(body, toks[i - 1].end);
      while (i < toks.length && toks[i].at < end) i++;
      expect(')');
      q.filters.push({ kind: 'if', ast });
    },
    pivot(q) { i++; let set = '_'; if (isP('.')) { i++; set = word(); } expect(')'); q.filters.push({ kind: 'pivot', set }); },
    poly(q) {                                                    // (poly:"lat lon lat lon …")
      i++; expect(':');
      const text = word();
      const bounds = 'static error: For the attribute "bounds" of the element "polygon-query" ';
      const coords = [];
      for (let pos = 0; ;) {                                       // while (in.good()) { in >> lat; …; in >> lon; }
        const [lat, p1, good] = streamDouble(text, pos);
        if (!good) throw new SyntaxError(bounds + 'an even number of float values must be provided.');
        const [lon, p2, more] = streamDouble(text, p1);
        coords.push([lat, lon]);
        pos = p2;
        if (!more) break;
      }
      if (coords.length < 3) throw new SyntaxError(bounds + 'at least 3 lat/lon float value pairs must be provided.');
      if (!coords.every(([la]) => la >= -90 && la <= 90)) throw new SyntaxError(bounds + 'the only allowed values for latitude are floats between -90.0 and 90.0.');
      if (!coords.every(([, lo]) => lo >= -180 && lo <= 180)) throw new SyntaxError(bounds + 'the only allowed values for longitude are floats between -180.0 and 180.0.');
      expect(')');
      q.filters.push({ kind: 'poly', coords });
    },
    way_cnt: wayCountFilter,
    way_link: wayCountFilter,
  };

  /** (way_cnt[.set]:lo[-hi]) (way_link[.set]:lo[-hi]): nodes in that many ways of a set */
  function wayCountFilter(q, w) {
    i++;
    let set = '_'; if (isP('.')) { i++; set = word(); }
    expect(':');
    const lowError = 'static error: lower must be an integer greater or equal 1';
    if (peek()?.t !== 'num' && !isP('-')) throw new SyntaxError(lowError);
    const lo = Math.trunc(num());
    if (!(lo >= 1)) throw new SyntaxError(lowError);
    let hi = lo;
    if (peek()?.t === 'num' && peek().v.startsWith('-')) hi = Math.trunc(Math.abs(Number(word())));      // 2-4 (tokenized as 2, -4)
    else if (isP('-')) { i++; hi = peek()?.t === 'num' ? Math.trunc(Number(word())) : null; }
    if (hi !== null && hi < lo) throw new SyntaxError('static error: upper must be an integer greater or equal lower');
    expect(')');
    if (!q.types.every(t => t === 'node')) throw new SyntaxError(`parse error: A recursion of type '${w}' produces nodes.`);
    q.filters.push({ kind: 'waycount', wc: w, set, lo, hi });
  }

  const prog = statements();
  if (i < toks.length) throw new SyntaxError(`unexpected '${peek().v}' near token ${i}`);
  return { settings, statements: prog };
}

return { parse };
})();
// ---- engine-base.js
__m["engine-base.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers and constants the Engine and its method files share: coordinates, great-circle maths, references
// (slots, areas, derived), outlines, out … geom clipping and tag filters. Split out of engine.js.

const { latFromY, lonFromX } = __m["bundle.js"];
const G = __m["geometry.js"];

/** Up to this many nodes, waysOfNodes checks each candidate way's box against every node before its node list. */
const FEW_POINTS = 8;

/** around: an element box over more grid cells than this skips the quick no-source check. */
const ANY_NEAR_MAX_CELLS = 64;
/** Overpass's copyright line (osm3s in JSON, <note> in XML). */
const COPYRIGHT = 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.';

// ---- coordinates ------------------------------------------------------------------------------------------

/** round(v, 7) as Python and toFixed do it. Away from a tie, Math.round(v·1e7) is the right integer and
 *  r / 1e7 the same double as parsing its decimal; near a tie the exact (slow) path decides. */
const round7 = (v) => { const y = v * 1e7, r = Math.round(y); return Math.abs(y - r) < 0.4999 ? r / 1e7 : Number(v.toFixed(7)); };
const lat7 = (y) => round7(latFromY(y));
const lon7 = (x) => round7(lonFromX(x));
const ilat = (lat) => Math.trunc((lat + 91) * 1e7 + 0.5);
const ilon = (lon) => Math.trunc(lon * 1e7 + (lon > 0 ? 0.5 : -0.5));
const decoded = (lat, lon) => [ilat(lat) / 1e7 - 91, ilon(lon) / 1e7];       // geometry.py decoded()

// ---- Overpass spherical maths (spherical.py) --------------------------------------------------------------

const EARTH_R = 2e7 / Math.PI;
const A0 = Math.acos(0);
const cartesian = (lat, lon) => [Math.sin(lat / 90 * A0), Math.cos(lat / 90 * A0) * Math.sin(lon / 90 * A0),
  Math.cos(lat / 90 * A0) * Math.cos(lon / 90 * A0)];
const cross = (v, w) => [v[1] * w[2] - v[2] * w[1], v[2] * w[0] - v[0] * w[2], v[0] * w[1] - v[1] * w[0]];
const dot = (v, w) => v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
function lineDistance(norm, c) {
  const nn = Math.sqrt(dot(norm, norm));
  if (nn === 0) return Infinity;
  let sp = Math.abs(dot(c, norm)) / nn;
  if (sp > 1) sp = 1;
  return Math.asin(sp) * (10 * 1000 * 1000 / A0);
}
function segmentsIntersect(sa, na, sb, nb) {
  let ip = cross(na, nb);
  const ln = Math.sqrt(dot(ip, ip));
  if (ln === 0) return false;
  ip = [ip[0] / ln, ip[1] / ln, ip[2] / ln];
  const asum = [sa[0][0] + sa[1][0], sa[0][1] + sa[1][1], sa[0][2] + sa[1][2]];
  const bsum = [sb[0][0] + sb[1][0], sb[0][1] + sb[1][1], sb[0][2] + sb[1][2]];
  return Math.abs(dot(asum, ip)) >= dot(asum, sa[0]) && Math.abs(dot(bsum, ip)) >= dot(bsum, sb[0]);
}
function gcd(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0;
  const d = Math.PI / 180;
  const sp = Math.cos((lat2 - lat1) * d) + Math.cos(lat1 * d) * Math.cos(lat2 * d) * (Math.cos((lon2 - lon1) * d) - 1);
  return Math.acos(Math.min(sp, 1)) * EARTH_R;
}

// ---- references -------------------------------------------------------------------------------------------
// Set members are numbers. A feature is the store's ref (slot · 2^32 + index, below 2^48). An untagged way
// node, which isn't a feature, is VNODE + slot · 2^32 + its point index in a way of that tile (one canonical
// ref per node ID, see Engine.nodeRef). An Overpass area is AREA + the ref of its relation or closed way.

const SLOT = 2 ** 32, VNODE = 2 ** 49, AREA = 2 ** 50, DERIVED = 2 ** 51;
const WAY_AREA_OFFSET = 2400000000, REL_AREA_OFFSET = 3600000000;
const TYPE_ORDER = { node: 0, way: 1, relation: 2, area: 3, derived: 4 };
const isArea = (r) => r >= AREA && r < DERIVED;
// a derived element (make/convert) is DERIVED + its index in the run's list of derived elements
const isDerived = (r) => r >= DERIVED;
const isVnode = (r) => r >= VNODE && r < AREA;

// A part is a run of points in a tile's xy array: { xy, s, n, closed }. Area rings are stored without the
// closing point; `closed` adds it back (point n is point 0).
const partCount = (q) => q.n + (q.closed && q.n ? 1 : 0);
const px = (q, k) => q.xy[2 * (q.s + (k === q.n ? 0 : k))];
const py = (q, k) => q.xy[2 * (q.s + (k === q.n ? 0 : k)) + 1];
const partPoints = (q) => { const out = []; for (let k = 0, c = partCount(q); k < c; k++) out.push([px(q, k), py(q, k)]); return out; };
const ipoint = ([x, y]) => [ilat(latFromY(y)), ilon(lonFromX(x))];

const POSITIVE_TAG_KINDS = ['key', 'nokey', 'eq', 're', 'nre', 'likelike'];      // [!k] and !~ count; != alone doesn't
const acceptsUntagged = (tags) => tags.every(t => t.kind === 'nokey' || t.kind === 'ne' || t.kind === 'nre');
// query.py STANDALONE_CRITERIA: a statement with this single filter (no tags, no input) isn't a query
// statement, so the global [bbox:] doesn't apply to it
const STANDALONE = { ids: (t) => ['node', 'way', 'relation'].includes(t), bbox: (t) => t === 'node',
  around: (t) => t === 'node', poly: (t) => t === 'node', pivot: (t) => t === 'node', rel: (t) => t !== 'nwr' };
const TYPE_INDEX_OF = { node: 0, way: 1, relation: 2 };

// ---- out … geom(s,w,n,e) (output.py)
/** Is a point inside the bbox, in Overpass's integer coordinates (east < west wraps the antimeridian)? */
function bboxMatcher(bb) {
  const so = G.ilat(bb[0]), we = G.ilon(bb[1]), no = G.ilat(bb[2]), ea = G.ilon(bb[3]);
  return (p) => {
    if (no < so) return true;
    const la = G.ilat(p[0]), lo = G.ilon(p[1]);
    return so <= la && la <= no && ((we <= lo && lo <= ea) || (ea < we && (lo >= we || lo <= ea)));
  };
}
/** Way_Bbox_Geometry_Store::get_geometry: a point is kept while it, a neighbour or an adjacent segment touches the bbox. */
function clipWayPoints(pts, bb) {
  const inside = bboxMatcher(bb);
  const box = new G.Bbox(bb[0], bb[1], bb[2], bb[3]);
  const res = [...pts];
  const n = res.length;
  let i = 0, lastDropped = false;
  while (i < n) {
    if (i < n - 1 && inside(res[i + 1])) i += 3;
    else if (!lastDropped && inside(res[i])) i += 2;
    else if (!lastDropped && i > 0 && inside(res[i - 1])) i += 1;
    else if (i < n - 1 && G.bboxIntersects(box, res[i], res[i + 1])) i += 2;
    else if (!lastDropped && i > 0 && G.bboxIntersects(box, res[i - 1], res[i])) i += 1;
    else { res[i] = null; lastDropped = true; i += 1; continue; }
    lastDropped = false;
  }
  return res;
}
/** Relation_Geometry_Store: a member way's point is dropped when it and its neighbours are outside. */
function clipMemberWay(pts, inside) {
  if (pts.length === 1) return [inside(pts[0]) ? pts[0] : null];
  if (!pts.length) return pts;
  const ok = pts.map(inside), keep = [...pts];
  if (!ok[0] && !ok[1]) keep[0] = null;
  for (let k = 1; k < pts.length - 1; k++) if (!ok[k - 1] && !ok[k] && !ok[k + 1]) keep[k] = null;
  if (!ok[ok.length - 2] && !ok[ok.length - 1]) keep[keep.length - 1] = null;
  return keep;
}
const clippedPoint = (p) => (p ? { lat: G.round7(p[0]), lon: G.round7(p[1]) } : null);
function verbatimRelGeom(groups) {
  if (groups.every(g => g.length && g.every(p => p))) return new G.Compound(groups.map(g => (g.length === 1 ? new G.Point(g[0][0], g[0][1]) : new G.Linestring(g))));
  if (!groups.length) return new G.Null();
  const pr = new G.PartialRelation();
  for (const g of groups) {
    if (!g.length) pr.addPlaceholder();
    else if (g.length === 1 && g[0]) pr.addPoint(g[0]);
    else { pr.startWay(); for (const p of g) { if (p) pr.addWayPoint(p); else pr.addWayPlaceholder(); } }
  }
  return pr;
}
/** Clipped out center/bb(…): over every position, dropped ones decoding to G.ZERO_QUAD (an Overpass quirk). */
function clippedCenterOrBounds(d, type, groups, o) {
  const flat = groups.flat().map(p => p ?? G.ZERO_QUAD);
  let mnla = 100, mxla = -100, mnlo = 200, mxlo = -200;
  for (const [la, lo] of flat) { mnla = Math.min(mnla, la); mxla = Math.max(mxla, la); mnlo = Math.min(mnlo, lo); mxlo = Math.max(mxlo, lo); }
  if (mnla > mxla) return;
  if (type === 2 && mxlo - mnlo >= 180) { mnlo = 200; mxlo = -200; for (const [, lo] of flat) { if (lo < 0) mxlo = Math.max(mxlo, lo); else mnlo = Math.min(mnlo, lo); } }
  if (o.geom === 'bb') d.bounds = { minlat: G.round7(mnla), minlon: G.round7(mnlo), maxlat: G.round7(mxla), maxlon: G.round7(mxlo) };
  else d.center = { lat: G.round7((mnla + mxla) / 2), lon: G.round7((mnlo + mxlo) / 2) };
}

/**
 * Tag filters compiled for one tile: a test of feature indexes, or null when no feature of the tile can
 * match (a required key or value doesn't occur there). Regex results are cached per value code.
 */
/** Tag filters that need a key */
const KEY_REQUIRED = new Set(['key', 'eq', 're']);

/**
 * The tile's features with the rarest key (or key=value) a filter requires ([k], [k=v], [k~v]), or null when no
 * filter requires one. Called after compileTags, which has already skipped tiles lacking such a key.
 */
function keyedFeatures(t, filters) {
  let best = null;
  for (const f of filters) {
    if (!KEY_REQUIRED.has(f.kind) || f.key === undefined) continue;
    const list = t.withTag(t.code(f.key), f.kind === 'eq' ? t.code(f.value) : -1);
    if (!best || list.length < best.length) best = list;
  }
  return best;
}

function compileTags(t, filters) {
  const tests = [];
  for (const f of filters) {
    const key = f.key === undefined ? -1 : t.code(f.key);
    switch (f.kind) {
      case 'key': if (key < 0) return null; tests.push(i => t.value(i, key) >= 0); break;
      case 'nokey': if (key >= 0) tests.push(i => t.value(i, key) < 0); break;
      case 'eq': {
        const val = t.code(f.value);
        if (key < 0 || val < 0) return null;
        tests.push(i => t.value(i, key) === val); break;
      }
      case 'ne': {
        const val = t.code(f.value);
        if (key >= 0 && val >= 0) tests.push(i => t.value(i, key) !== val); break;
      }
      case 'likelike': {                           // [~"k"~"v"]: some tag whose key and value both match
        const kc = new Map(), vc = new Map(), strs = t.strs, kv = t.tagKV;
        const keyOk = (c) => { let m = kc.get(c); if (m === undefined) { const k = strs[c]; m = !k.startsWith('geodesk:') && f.kre.test(k); kc.set(c, m); } return m; };
        const valOk = (c) => { let m = vc.get(c); if (m === undefined) { m = f.vre.test(strs[c]); vc.set(c, m); } return m; };
        if (!strs.some((k, c) => keyOk(c))) return null;
        tests.push(i => {
          const tt = t.tagTab[i];
          for (let k = 2 * t.tagOff[tt], end = 2 * t.tagOff[tt + 1]; k < end; k += 2) if (keyOk(kv[k]) && valOk(kv[k + 1])) return true;
          return false;
        });
        break;
      }
      case 're': case 'nre': {
        if (key < 0) { if (f.kind === 're') return null; break; }
        const cache = new Map(), strs = t.strs, re = f.re;
        const matches = (c) => { let m = cache.get(c); if (m === undefined) { m = re.test(strs[c]); cache.set(c, m); } return m; };
        if (f.kind === 're') tests.push(i => { const c = t.value(i, key); return c >= 0 && matches(c); });
        else tests.push(i => { const c = t.value(i, key); return c < 0 || !matches(c); });
        break;
      }
    }
  }
  if (!tests.length) return () => true;
  if (tests.length === 1) return tests[0];
  return (i) => { for (const test of tests) if (!test(i)) return false; return true; };
}

/** Does a part (polyline or single point) touch an axis-aligned box (boundary included)? */
function partMeetsBox(q, b) {
  const c = partCount(q);
  for (let k = 0; k < c; k++) {
    const x = px(q, k), y = py(q, k);
    if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return true;
  }
  for (let k = 0; k + 1 < c; k++) if (segmentMeetsBox(px(q, k), py(q, k), px(q, k + 1), py(q, k + 1), b)) return true;
  return false;
}

function segmentMeetsBox(x1, y1, x2, y2, b) {
  // Liang-Barsky clipping on exact integer-valued doubles.
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x1 - b.minX) && clip(dx, b.maxX - x1) && clip(-dy, y1 - b.minY) && clip(dy, b.maxY - y1) && t0 <= t1;
}

function overpassCenter(s, w, n, e) {                    // output.py _overpass_center
  const la1 = Math.round((s + 91) * 1e7) / 1e7 - 91, la2 = Math.round((n + 91) * 1e7) / 1e7 - 91;
  const lo1 = Math.round(w * 1e7) / 1e7, lo2 = Math.round(e * 1e7) / 1e7;
  return { lat: Number(((la1 + la2) / 2).toFixed(7)), lon: Number(((lo1 + lo2) / 2).toFixed(7)) };
}



return { COPYRIGHT, FEW_POINTS, ANY_NEAR_MAX_CELLS, round7, lat7, lon7, ilat, ilon, decoded, EARTH_R, A0, cartesian, cross, dot, lineDistance, segmentsIntersect, gcd, SLOT, VNODE, AREA, DERIVED, WAY_AREA_OFFSET, REL_AREA_OFFSET, TYPE_ORDER, isArea, isDerived, isVnode, partCount, px, py, partPoints, ipoint, POSITIVE_TAG_KINDS, acceptsUntagged, STANDALONE, TYPE_INDEX_OF, bboxMatcher, clipWayPoints, clipMemberWay, clippedPoint, verbatimRelGeom, clippedCenterOrBounds, KEY_REQUIRED, keyedFeatures, compileTags, partMeetsBox, segmentMeetsBox, overpassCenter };
})();
// ---- engine-query.js
__m["engine-query.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: Query statements: tag filters, the spatial tests (bbox, around, poly) and scanning tiles.
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

const { ANY_NEAR_MAX_CELLS, AREA, POSITIVE_TAG_KINDS, SLOT, STANDALONE, TYPE_INDEX_OF, acceptsUntagged, cartesian, compileTags, cross, decoded, gcd, isArea, isDerived, isVnode, keyedFeatures, lineDistance, partMeetsBox, partPoints, px, py, segmentsIntersect } = __m["engine-base.js"];
const { F_DUPLICATE, F_NODE_IDS } = __m["tes.js"];
const { OUTSIDE, PolygonArea } = __m["areas.js"];
const { NO_WAYNODE_IDS, RuntimeQLError, Unsupported } = __m["errors.js"];
const { evaluate, truthy } = __m["expr.js"];
const { featureMeetsBox, featuresInBoxEstimate, forEachInBox } = __m["spatial.js"];
const { latFromY, lonFromX, xFromLon, yFromLat } = __m["bundle.js"];
const { typeBegin, typeEnd } = __m["store.js"];

class QueryMethods {

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

return { QueryMethods };
})();
// ---- engine-areas.js
__m["engine-areas.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: Areas: which features make Overpass areas, the area test, is_in and map_to_area.
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

const { AREA, REL_AREA_OFFSET, SLOT, WAY_AREA_OFFSET, ipoint, isArea, isDerived, isVnode, partPoints, px, py } = __m["engine-base.js"];
const { BORDER, ClosedWayArea, OUTSIDE, PolygonArea, assembleRings } = __m["areas.js"];
const { F_DUPLICATE, F_NODE_IDS } = __m["tes.js"];
const { Incomplete } = __m["errors.js"];
const { forEachInBox } = __m["spatial.js"];
const { xFromLon, yFromLat } = __m["bundle.js"];

class AreaMethods {

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

return { AreaMethods };
})();
// ---- engine-recurse.js
__m["engine-recurse.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: Following relations, ways and nodes: recursion (> >> < <<), pivot, way_cnt and parents.
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

const { FEW_POINTS, SLOT, TYPE_INDEX_OF, isArea, isDerived } = __m["engine-base.js"];
const { F_DUPLICATE, F_NODE_IDS } = __m["tes.js"];
const { featureMeetsBox, forEachInBoxes } = __m["spatial.js"];

class RecurseMethods {

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

return { RecurseMethods };
})();
// ---- engine-make.js
__m["engine-make.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: make and convert: derived objects and what their expressions read from elements.
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

const { DERIVED, decoded, isArea, isDerived, isVnode, partPoints } = __m["engine-base.js"];
const { F_NODE_IDS, TYPES } = __m["tes.js"];
const { cpCompare } = __m["text.js"];
const { bindKey, evaluate, truthy, tryInt64 } = __m["expr.js"];
const { latFromY, lonFromX } = __m["bundle.js"];
const G = __m["geometry.js"];

class MakeMethods {

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

return { MakeMethods };
})();
// ---- engine-output.js
__m["engine-output.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine methods: out: elements as Overpass prints them (ids, tags, geometry, center, bounds, clipping, sorting).
// Split out of engine.js; engine.js copies these methods onto Engine, so `this` is the Engine.

const { DERIVED, bboxMatcher, clipMemberWay, clipWayPoints, clippedCenterOrBounds, clippedPoint, isDerived, isVnode, lat7, lon7, overpassCenter, partCount, partPoints, px, py, verbatimRelGeom } = __m["engine-base.js"];
const { F_NODE_IDS, TYPES } = __m["tes.js"];
const { NO_WAYNODE_IDS } = __m["errors.js"];
const { calcIndex, calcParents, calcRanges, inU31Ranges, quadtile } = __m["ovindex.js"];
const { latFromY, lonFromX } = __m["bundle.js"];
const G = __m["geometry.js"];

class OutputMethods {

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

return { OutputMethods };
})();
// ---- engine.js
__m["engine.js"] = (() => {
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

const { AREA, COPYRIGHT, DERIVED, REL_AREA_OFFSET, SLOT, VNODE, WAY_AREA_OFFSET, isArea, isDerived, isVnode } = __m["engine-base.js"];
const { F_NODE_IDS, TYPES } = __m["tes.js"];
const { NO_WAYNODE_IDS, RuntimeQLError, Unsupported, Incomplete } = __m["errors.js"];
const { cpCompare } = __m["text.js"];
const { evaluate, truthy } = __m["expr.js"];
const { latFromY, lonFromX } = __m["bundle.js"];
const { localize } = __m["localize.js"];
const { parse } = __m["parse.js"];
const { QueryMethods } = __m["engine-query.js"];
const { AreaMethods } = __m["engine-areas.js"];
const { RecurseMethods } = __m["engine-recurse.js"];
const { MakeMethods } = __m["engine-make.js"];
const { OutputMethods } = __m["engine-output.js"];


// Overpass's statement names (each statement's get_name()), which its runtime errors quote (engine.py)
const STATEMENT_NAMES = { query: 'query', union: 'union', recurse: 'recurse', copy: 'item', foreach: 'foreach', for: 'for',
  if: 'if', complete: 'complete', is_in: 'coord-query', map_to_area: 'map-to-area', out: 'print', local: 'localize' };

class Engine {
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

return { Engine, Unsupported, Incomplete, RuntimeQLError, WAY_AREA_OFFSET, REL_AREA_OFFSET, parse };
})();
// ---- render.js
__m["render.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Rendering a result as XML or CSV: a port of osm_bypass/render.py, whose parts are ports of Overpass API
// output_formats/output_{xml,csv}.cc (Copyright (C) 2008-2018 Roland Olbricht et al., AGPL-3.0-or-later).

const { Unsupported } = __m["engine.js"];
const { COPYRIGHT } = __m["engine-base.js"];


const META_FIELDS = new Set(['::version', '::timestamp', '::changeset', '::uid', '::user']);
const COORD_KEYS = new Set(['lat', 'lon', 'minlat', 'minlon', 'maxlat', 'maxlon']);

/** Coordinates as Overpass prints them in XML and CSV: fixed 7 decimals. */
const c7 = (v) => Number(v).toFixed(7);

/** Python's xml.sax.saxutils.quoteattr. */
function quoteattr(s) {
  s = s.replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;')
    .replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
  if (s.includes('"')) return s.includes("'") ? `"${s.replace(/"/g, '&quot;')}"` : `'${s}'`;
  return `"${s}"`;
}

/** Python's xml.sax.saxutils.escape. */
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;');

const attrs = (kw) => Object.entries(kw).filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => ` ${k}=${quoteattr(COORD_KEYS.has(k) ? c7(v) : String(v))}`).join('');

/** print_geometry() in output_xml.cc, for derived elements. */
function xmlGeometry(g, mode, indent) {
  if (mode === 'geom' && g.hasComponents()) {
    const out = [];
    for (const c of g.components()) if (c) { out.push(`${indent}<group>`, ...xmlGeometry(c, mode, indent + '  '), `${indent}</group>`); }
    return out;
  }
  if (mode === 'geom' && g.hasLineGeometry()) return g.line().map(([la, lo]) => `${indent}<vertex${attrs({ lat: la, lon: lo })}/>`);
  if (mode === 'geom' && g.hasMultilineGeometry()) {
    const out = [];
    for (const ln of g.multiline()) out.push(`${indent}<linestring>`, ...ln.map(([la, lo]) => `${indent}  <vertex${attrs({ lat: la, lon: lo })}/>`), `${indent}</linestring>`);
    return out;
  }
  if (mode === 'geom' && g.hasCenter()) return [`${indent}<point${attrs({ lat: g.centerLat(), lon: g.centerLon() })}/>`];
  if ((mode === 'geom' || mode === 'bb') && g.hasBbox()) return [`    <bounds${attrs({ minlat: g.south(), minlon: g.west(), maxlat: g.north(), maxlon: g.east() })}/>`];
  if ((mode === 'geom' || mode === 'bb' || mode === 'center') && g.hasCenter()) return [`${indent}<center${attrs({ lat: g.centerLat(), lon: g.centerLon() })}/>`];
  return [];
}

/** Overpass's XML (output_xml.cc). A valid global [bbox:] is printed as <bounds> first, as
 *  Osm_Script_Statement::execute does (print_global_bbox; the other formats leave it out). */
function toXml(res, bbox = null) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<osm${attrs({ version: res.version, generator: res.generator })}>`,
    `  <note>${COPYRIGHT}</note>`];
  const base = res.osm3s?.timestamp_osm_base, areas = res.osm3s?.timestamp_areas_base;
  if (base) out.push(`  <meta${attrs({ osm_base: base, areas })}/>`);   // after the note, before a global bbox
  if (bbox && -90 <= bbox.s && bbox.s <= bbox.n && bbox.n <= 90 && -180 <= bbox.w && bbox.w <= 180
      && -180 <= bbox.e && bbox.e <= 180) {
    out.push(`  <bounds minlat="${c7(bbox.s)}" minlon="${c7(bbox.w)}" maxlat="${c7(bbox.n)}" maxlon="${c7(bbox.e)}"/>`);
  }
  for (const e of res.elements) {
    const t = e.type;
    const a = attrs({ id: e.id, lat: e.lat, lon: e.lon });
    const kids = [];
    const b = e.bounds;
    if (b) kids.push(`    <bounds${attrs({ minlat: b.minlat, minlon: b.minlon, maxlat: b.maxlat, maxlon: b.maxlon })}/>`);
    if (e.center) kids.push(`    <center${attrs({ lat: e.center.lat, lon: e.center.lon })}/>`);
    if (t === 'way') {
      const geo = e.geometry, refs = e.nodes;
      const n = Math.max(refs?.length ?? 0, geo?.length ?? 0);
      for (let i = 0; i < n; i++) {
        const g = geo && i < geo.length ? geo[i] : null;
        kids.push(`    <nd${attrs({ ref: refs ? refs[i] : undefined, lat: g ? g.lat : undefined, lon: g ? g.lon : undefined })}/>`);
      }
    }
    for (const m of e.members ?? []) {
      if (m.geometry) {
        const inner = m.geometry.map(p => (p ? `<nd${attrs({ lat: p.lat, lon: p.lon })}/>` : '<nd/>')).join('');
        kids.push(`    <member${attrs({ type: m.type, ref: m.ref, role: m.role })}>${inner}</member>`);
      } else kids.push(`    <member${attrs({ type: m.type, ref: m.ref, role: m.role, lat: m.lat, lon: m.lon })}/>`);
    }
    if (e._geom) kids.push(...xmlGeometry(e._geom[0], e._geom[1], '    '));
    for (const [k, v] of Object.entries(e.tags ?? {})) kids.push(`    <tag${attrs({ k, v })}/>`);
    if (kids.length) { out.push(`  <${t}${a}>`, ...kids, `  </${t}>`); } else out.push(`  <${t}${a}/>`);
  }
  if (res.remark != null) out.push(`<remark> ${escapeXml(res.remark)} </remark>`);   // a runtime error, last (output_xml.cc)
  out.push('</osm>');
  return out.join('\n') + '\n';
}

/** Overpass's escape_csv: quote when the value has a comma, a quote or a newline. */
const csvEscape = (v) => (/[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function toCsv(res, spec) {
  for (const f of spec.fields) {
    if (META_FIELDS.has(f)) throw new Unsupported(`csv field ${f}: version, timestamp, changeset and user are not in a bundle`);
  }
  const rows = [];
  for (const e of res.elements) {
    const row = [];
    for (const f of spec.fields) {
      const tags = e.tags ?? {};
      let v;
      if (f === '::id') v = e.id;
      else if (f === '::type') v = e.type;
      else if (f === '::lat' || f === '::lon') {
        const key = f === '::lat' ? 'lat' : 'lon';
        v = e[key] ?? e.center?.[key];
        if (v === undefined && e._geom && e._geom[0].hasCenter()) v = key === 'lat' ? e._geom[0].centerLat() : e._geom[0].centerLon();   // derived with ::geom
        v = v !== undefined ? c7(v) : undefined;
      } else if (f === '::count') v = e.type === 'count' ? tags.total : undefined;
      else if (f.startsWith('::count:')) v = e.type === 'count' ? tags[f.slice('::count:'.length)] : undefined;
      else v = tags[f];                                    // out count rows too: Overpass prints their tags by name
      row.push(v === undefined || v === null ? '' : csvEscape(String(v)));
    }
    rows.push(row.join(spec.sep));
  }
  const head = spec.header ? [spec.fields.map(f => csvEscape(f.startsWith('::') ? '@' + f.slice(2) : f)).join(spec.sep)] : [];
  const lines = [...head, ...rows];
  return lines.length ? lines.join('\n') + '\n' : '';    // Overpass: no header, no rows -> nothing
}

const HTML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"\n' +
  '    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">\n' +
  '<head>\n  <meta http-equiv="content-type" content="text/html; charset=utf-8" lang="en"/>\n  <title>OSM3S Response</title>\n</head>\n<body>\n';

/** output_popup.cc: elements go into the first category with a matching filter group. Quirk kept: a group
 *  of [..][..] filters matches when any one of them matches (render.py to_popup). */
function toPopup(res, cats) {
  const outs = cats.map(c => '\n<h2>' + c.title + '</h2>');
  const comp = cats.map(c => c.conjs.map(conj => conj.map(([k, v, st]) => [k, new RegExp(v), st])));
  const tf = ([k, rx, st], tags) => {
    if (tags === null) return false;
    for (const [tk, tv] of tags) if (tk === k && rx.test(tv)) return st;
    return !st;
  };
  for (const e of res.elements) {
    const t = e.type;
    if (!['node', 'way', 'relation'].includes(t)) continue;
    const tags = e.tags ? Object.entries(e.tags).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)) : null;
    for (let i = 0; i < cats.length; i++) {
      if (comp[i].some(conj => conj.some(f => tf(f, tags)))) { outs[i] += popupItem(t, e.id, tags, cats[i].titleKey); break; }
    }
  }
  return HTML_HEAD + outs.join('') + '\n</body>\n</html>\n';
}

function popupItem(t, id, tags, titleKey) {
  let link = '';
  if (tags) {
    for (const [, v] of tags) if (v.includes('www.')) link = 'http://' + v;
    for (const [, v] of tags) if (v.includes('http://')) link = v;
    for (const [, v] of tags) if (v.includes('https://')) link = v;
  }
  let r = '\n<p>';
  if (tags) {
    for (const [k, v] of tags) {
      if (k === titleKey) {
        if (link) r += `<a href="${link}" target="_blank">`;
        r += `<strong>${v}</strong>`;
        if (link) r += '</a>';
        r += '<br/>\n';
        break;
      }
    }
  }
  if (r === '\n<p>') {
    if (link) r += `<a href="${link}" target="_blank">`;
    r += `<strong>${t[0].toUpperCase() + t.slice(1)} ${id}</strong>`;
    if (link) r += '</a>';
    r += '<br/>\n';
  }
  for (const [k, v] of tags ?? []) r += `${k}: ${v}<br/>\n`;
  return r + '<p/>\n';
}

/** The body and content type a query asks for ([out:json] if it says nothing, unlike Overpass's XML default). */
function render(res, settings, defaultFormat = 'json') {
  const fmt = settings.outGiven ? settings.out : defaultFormat;
  if (fmt === 'xml') return { format: 'xml', contentType: 'application/osm3s+xml', body: toXml(res, settings.bbox) };
  if (fmt === 'csv') return { format: 'csv', contentType: 'text/csv', body: toCsv(res, settings.csv) };
  if (fmt === 'popup') return { format: 'popup', contentType: 'text/html; charset=utf-8', body: toPopup(res, settings.popup) };
  const clean = { version: res.version, generator: res.generator, osm3s: res.osm3s ?? { copyright: COPYRIGHT },
                  elements: res.elements };
  if (res.remark != null) clean.remark = res.remark;            // a runtime error, after the elements (output_json.cc)
  return { format: 'json', contentType: 'application/json', body: JSON.stringify(clean, null, 2) };
}

return { toXml, toCsv, toPopup, render, COPYRIGHT };
})();
// ---- turbo.js
__m["turbo.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass Turbo's query shortcuts ({{bbox}}, {{center}}, {{date:…}}, constants), ported from
// osm_bypass/turbo.py, itself a port of overpass-turbo js/query.ts and js/shortcuts.ts
// (Copyright (c) 2012 Martin Raifer, MIT licence, see NOTICE.md).
// Geocoding shortcuts go to the caller's `geocoder(kind, text)` (src/geocode.js looks names up in the saved
// data), as in turbo.py: nominatimId/Area add a ';', nominatimBbox/Coords are the geocode ones.

const { Unsupported } = __m["engine.js"];

const CONSTANT = /{{([A-Za-z0-9_]+)=(.+?)}}/;
const STATEMENT = /{{([A-Za-z0-9_]+)(:([\s\S]*?))?}}/;
const MUSTACHE = /{{[\S\s]*?}}/;
const REL_TIME = /(-?[0-9]+) ?(seconds?|minutes?|hours?|days?|weeks?|months?|years?)?/;
const INTERVAL = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2628000, year: 31536000 };
const GEOCODE = ['geocodeId', 'geocodeArea', 'geocodeBbox', 'geocodeCoords',
                 'nominatimId', 'nominatimArea', 'nominatimBbox', 'nominatimCoords'];

const coord = (v, limit) => Math.max(-limit, Math.min(limit, Number(v))).toFixed(7);
const lineCount = (s) => s.split(/\r?\n|\r/).length;

function relativeTime(instr, now = new Date()) {
  const m = REL_TIME.exec((instr || '0 seconds').toLowerCase());
  if (!m) return '';
  const unit = (m[2] || 'day').replace(/s$/, '');
  return new Date(now.getTime() - Number(m[1]) * (INTERVAL[unit] ?? 86400) * 1000).toISOString();
}

/** bbox = [s, w, n, e], center = [lat, lon]. Returns the expanded query (line numbers preserved). */
function expand(query, { bbox = null, center = null, now = new Date(), geocoder = null } = {}) {
  if (!query.includes('{{')) return query;
  const need = (what, v) => {
    if (!v) throw new SyntaxError(`{{${what}}} needs the map view`);
    return v;
  };
  const shortcuts = {
    bbox: () => { const b = need('bbox', bbox); return [coord(b[0], 90), coord(b[1], 180), coord(b[2], 90), coord(b[3], 180)].join(','); },
    wsen: () => { const b = need('wsen', bbox); return [coord(b[1], 180), coord(b[0], 90), coord(b[3], 180), coord(b[2], 90)].join(','); },
    center: () => { const c = need('center', center); return `${coord(c[0], 90)},${coord(c[1], 180)}`; },
  };
  const constants = {};
  let m;
  while ((m = CONSTANT.exec(query))) {
    constants[m[1]] = m[2];
    query = query.slice(0, m.index) + query.slice(m.index + m[0].length);
  }
  while ((m = STATEMENT.exec(query))) {
    const name = m[1], instr = m[3] ?? '';
    let rep;
    if (name in constants) rep = constants[name];
    else if (name === 'date') rep = relativeTime(instr, now);
    else if (GEOCODE.includes(name)) {
      if (!geocoder) throw new Unsupported(`{{${name}:${instr}}} needs a geocoder`);
      const kind = { nominatimId: 'geocodeId', nominatimArea: 'geocodeArea', nominatimBbox: 'geocodeBbox', nominatimCoords: 'geocodeCoords' }[name] ?? name;
      rep = geocoder(kind, instr) + (name === 'nominatimId' || name === 'nominatimArea' ? ';' : '');
    }
    else if (name in shortcuts) rep = shortcuts[name]();
    else rep = '';                                   // e.g. {{style:…}}, {{data:…}}: Turbo-only
    query = query.slice(0, m.index) + rep + '\n'.repeat(lineCount(instr) - 1) + query.slice(m.index + m[0].length);
  }
  while ((m = MUSTACHE.exec(query))) {
    query = query.slice(0, m.index) + '\n'.repeat(lineCount(m[0]) - 1) + query.slice(m.index + m[0].length);
  }
  return query;
}

return { relativeTime, expand };
})();
// ---- geocode.js
__m["geocode.js"] = (() => {
// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass Turbo's geocoding shortcuts ({{geocodeArea:…}}, {{geocodeCoords:…}}, {{geocodeId:…}},
// {{geocodeBbox:…}}) answered from the saved data instead of Nominatim: a port of the Geocoder in
// osm_bypass/turbo.py. Exact (case-insensitive) name matches, ranked roughly as Nominatim would: places
// linked to their boundary, admin level, Wikipedia presence, size.

const { latFromY, lonFromX } = __m["bundle.js"];
const { F_DUPLICATE } = __m["tes.js"];
const { INSIDE } = __m["areas.js"];
const { Unsupported, WAY_AREA_OFFSET, REL_AREA_OFFSET } = __m["engine.js"];

const NAME_KEYS = ['name', 'name:en', 'int_name', 'official_name', 'short_name', 'alt_name', 'loc_name'];
const PLACE_RANK = { continent: 0, country: 1, state: 2, region: 3, province: 3, county: 4, district: 5, municipality: 5,
  city: 6, borough: 7, town: 7, suburb: 8, quarter: 9, village: 9, neighbourhood: 10, hamlet: 10, locality: 11 };
const TYPE = ['node', 'way', 'relation'];
const SETTLEMENTS = new Set(['city', 'town', 'village']);   // before other areas of the same name (turbo.py _SETTLEMENTS)

const title = (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());   // Python str.title()
const coord = (v, limit) => Math.max(-limit, Math.min(limit, Number(v))).toFixed(7);
const jsNumber = (v) => String(Number(v.toFixed(7)));

class Geocoder {
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

return { Geocoder };
})();
globalThis.Bypass = { ...__m["bundle.js"], ...__m["store.js"], ...__m["engine.js"], ...__m["tes.js"], expand: __m["turbo.js"].expand, Geocoder: __m["geocode.js"].Geocoder, render: __m["render.js"].render };
})();
