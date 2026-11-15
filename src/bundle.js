// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading a GeoDesk bundle (.gob) by byte ranges: header, catalog, metadata (tile index, global strings,
// settings, indexed keys) and tile blobs. Layout from GOL Tool 2.x source (clarisma/geodesk-gol,
// src/tile/tes/TesArchive.h, src/gol/load/TileLoader.cpp) and libgeodesk (TileIndexWalker, Tile, StringTable).
// Runs unchanged in browsers and Node 18+ (fetch, DecompressionStream).

export const GOB_MAGIC = 0xE0F6B060;
const HEADER_SIZE = 64;
// Limits against a hostile or broken bundle. Real bundles are far below them: the 2026
// planet has 58,689 tiles and about 0.8 MB of head, and its densest tiles inflate to tens of MB.
const MAX_TILES = 2 ** 20;
const MAX_METADATA_BYTES = 2 ** 26;               // 64 MB, compressed
const MAX_CHUNK_BYTES = 2 ** 28;                  // 256 MB, uncompressed
const VARINT_MAX_MUL = 2 ** 49;                   // the 8th byte; a 9th would pass 2^53

// ---- byte sources ---------------------------------------------------------------------------------------

/** The file behind a URL changed between two reads (Open Planet Data replaces its bundles daily). */
export class BundleReplaced extends Error {
  constructor(url) { super(`${url}: the file was replaced while it was being read`); this.kind = 'replaced'; }
}

/**
 * A source reads `len` bytes at `start` and returns a Uint8Array. A URL source remembers the first answer's
 * Last-Modified (the one validator a cross-origin page can read without the server exposing more) and throws
 * BundleReplaced when a later answer has another: the old offsets would point into a different file.
 */
export function urlSource(url, { headers = {} } = {}) {
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
export function blobSource(blob, name = blob.name ?? 'blob') {
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
export function bytesSource(bytes, name = 'bytes') {
  return {
    name,
    async read(start, len) {
      if (start + len > bytes.length) throw new Error(`${name}: read past the end (${start}+${len} > ${bytes.length})`);
      return bytes.subarray(start, start + len);
    },
  };
}

/** Node only: a local file. */
export async function fileSource(path) {
  const fs = await import('node:fs/promises');
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

export function crc32c(bytes) {
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
export async function unsealChunk(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = dv.getUint32(0, true), checksum = dv.getUint32(4, true);
  if (size > MAX_CHUNK_BYTES) throw new Error(`chunk: declares ${size} bytes, more than the ${MAX_CHUNK_BYTES} allowed`);
  const out = await inflateRaw(bytes.subarray(8), size);
  if (out.length !== size) throw new Error(`chunk: size ${out.length}, expected ${size}`);
  if (crc32c(out) !== checksum) throw new Error('chunk: checksum mismatch');
  return out;
}

// ---- varints and strings --------------------------------------------------------------------------------

export function readVarint(buf, pos) {          // returns [value, newPos]; exact up to 2^53
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
export function readShortString(buf, pos) {
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

export const xFromLon = (lon) => Math.round(MAP_WIDTH * lon / 360);
export const yFromLat = (lat) => Math.round(Math.log(Math.tan((lat + 90) * Math.PI / 360)) * (MAP_WIDTH / 2 / Math.PI));
export const lonFromX = (x) => x * 360 / MAP_WIDTH;
export const latFromY = (y) => Math.atan(Math.exp(y * 2 * Math.PI / MAP_WIDTH)) * 360 / Math.PI - 90;

export const columnFromXZ = (x, z) => Math.floor((x + 2147483648) / 2 ** (32 - z));
export const rowFromYZ = (y, z) => Math.floor((2147483647 - y) / 2 ** (32 - z));

export function tileBounds(col, row, z) {           // inclusive integer bounds
  const extent = 2 ** (32 - z);
  const minX = (col - 2 ** (z - 1)) * extent;
  const maxY = 2147483647 - row * extent;
  return { minX, minY: maxY - extent + 1, maxX: minX + extent - 1, maxY };
}

// ---- bundle ---------------------------------------------------------------------------------------------

export class Bundle {
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
export function walkTileIndex(index, zoomLevels) {
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
