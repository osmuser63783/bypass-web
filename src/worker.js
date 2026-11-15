// SPDX-License-Identifier: AGPL-3.0-or-later
// The page's back end, in a module worker: saved areas (OPFS), downloads from the bundle, the decoded
// tiles and the query engine. The page sends {id, cmd, args}; the worker answers {id, ok, result | error}
// and may send {id, progress} in between. {cmd: 'cancel'} stops a running download.

import { Bundle, BundleReplaced, urlSource, blobSource, bytesSource, unsealChunk, lonFromX, latFromY, tileBounds, xFromLon, yFromLat, columnFromXZ, rowFromYZ } from './bundle.js';
import { TileStore } from './store.js';
import { Geocoder } from './geocode.js';
import { Engine, Unsupported } from './engine.js';
import { expand } from './turbo.js';
import { render } from './render.js';
import * as lib from './library.js';
import { tileIndex } from './spatial.js';

const PARALLEL = 6;
let cur = null;                 // { meta, bundle, store, engine }

/** An engine over a library's tiles, with the bundle's release time as Overpass's timestamp_osm_base. */
function openEngine(store, meta) {
  const engine = new Engine(store);
  if (meta?.timestamp) engine.dataTime = new Date(meta.timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return engine;
}
const remotes = new Map();      // url -> Promise<Bundle> (opened once per session)
const checkedAt = new Map();    // url -> when its header was last read (each read from byte 0 counts as a download)
const RECHECK_MS = 60_000;      // estimate, then create a moment later: one header read, not two
let cancelled = false;

const post = (m) => self.postMessage(m);

self.onmessage = async (ev) => {
  const { id, cmd, args = {} } = ev.data;
  if (cmd === 'cancel') { cancelled = true; return; }
  const progress = (p) => post({ id, progress: p });
  try {
    const result = await COMMANDS[cmd](args, progress);
    post({ id, ok: true, result });
    if (cur) prewarm(cur.store);
  } catch (e) {
    console.error(e);
    if (e instanceof RangeError && /call stack/i.test(e.message)) e.message = 'The query is nested too deeply.';
    post({ id, ok: false, error: e.message || String(e), kind: e.kind ?? (e instanceof Unsupported ? 'unsupported' : e instanceof SyntaxError ? 'syntax' : 'error'), extra: e.extra });
  }
};

/** Builds the ID index and each tile's grid between messages, so the first query doesn't wait for them
 *  (about 2 ms per tile). A query that comes first builds what it needs itself. */
let warmGen = 0;
function prewarm(store) {
  const gen = ++warmGen;
  let k = -1;
  const step = () => {
    if (gen !== warmGen || cur?.store !== store) return;
    if (k < 0) store.index();
    else if (k < store.slots.length) tileIndex(store.slots[k]);
    else return;
    k++;
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

/**
 * The bundle at `url`, its head read once per session. `check` first reads its 64-byte header again: if the file
 * was replaced since (BundleReplaced), the new one is opened. A replacement while the head is being read is
 * retried once.
 */
async function remote(url, { check = false } = {}) {
  if (check && remotes.has(url) && !(Date.now() - (checkedAt.get(url) ?? 0) < RECHECK_MS)) {
    try { await (await remotes.get(url)).source.read(0, 64); checkedAt.set(url, Date.now()); }
    catch (e) { if (!(e instanceof BundleReplaced)) throw e; remotes.delete(url); }
  }
  if (!remotes.has(url)) {
    const p = Bundle.open(urlSource(url)).catch(e => e instanceof BundleReplaced ? Bundle.open(urlSource(url)) : Promise.reject(e));
    p.then(() => checkedAt.set(url, Date.now()), () => { remotes.delete(url); checkedAt.delete(url); });
    remotes.set(url, p);
  }
  return remotes.get(url);
}
const REPLACED = 'The bundle was replaced by a newer one during the download. Click Load this area again to get the new data.';

function info() {
  if (!cur) return null;
  const m = cur.meta, b = cur.bundle;
  return {
    id: m.id, name: m.name, source: m.source, revision: m.revision, timestamp: m.timestamp, wayNodeIds: m.wayNodeIds,
    tiles: Object.keys(m.tiles).length, bytes: lib.librarySize(m), features: cur.store.featureCount,
    boxes: m.boxes, coverage: coverage(b, m.tiles, m.boxes), canLoad: m.source.kind === 'url',
  };
}

/**
 * Where the saved tiles hold complete data: every tile of the bundle that covers a point there is saved.
 * A saved tile with no child tiles counts whole; one with children counts where it has none, and its saved
 * children are followed down. Such gaps under coarse parents (zoom < 8, up to 600 km wide) count only
 * where they overlap a loaded box, so empty ocean far away doesn't fill the map; for imports, which have
 * no boxes, they don't count. (Sparse land such as deserts has many of these gaps.)
 * Returns cells on the finest tile grid (`z`, "col,row" keys) and the outline of their union as rings.
 */
function coverage(b, saved, boxes = []) {
  const levels = [...new Set(b.tiles.map(t => t.zoom))].sort((x, y) => x - y);
  const z = levels[levels.length - 1];
  const key = (zz, c, r) => `${zz}/${c}/${r}`;
  const byKey = new Map(b.tiles.map(t => [key(t.zoom, t.col, t.row), t]));
  const isSaved = (t) => String(t.tip) in saved || !b.entries.get(t.tip)?.size;
  const cells = new Set();
  const fill = (c, r, zz) => {
    const d = z - zz, n = 1 << d;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cells.add(`${(c << d) + i},${(r << d) + j}`);
  };
  // loaded boxes as cell ranges on the finest grid
  const ranges = boxes.map(([w, s, e, n]) => [columnFromXZ(xFromLon(w), z), rowFromYZ(yFromLat(n), z),
                                              columnFromXZ(xFromLon(e), z), rowFromYZ(yFromLat(s), z)]);
  const fillClipped = (c, r, zz) => {
    const d = z - zz, c0 = c << d, r0 = r << d, c1 = c0 + (1 << d) - 1, r1 = r0 + (1 << d) - 1;
    for (const [bc0, br0, bc1, br1] of ranges) {
      for (let i = Math.max(c0, bc0); i <= Math.min(c1, bc1); i++)
        for (let j = Math.max(r0, br0); j <= Math.min(r1, br1); j++) cells.add(`${i},${j}`);
    }
  };
  const visit = (t) => {
    const cz = levels[levels.indexOf(t.zoom) + 1];
    if (cz === undefined) { fill(t.col, t.row, t.zoom); return; }
    const d = cz - t.zoom, n = 1 << d, kids = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const c = (t.col << d) + i, r = (t.row << d) + j;
      kids.push({ k: byKey.get(key(cz, c, r)), c, r });
    }
    if (kids.every(x => !x.k)) { fill(t.col, t.row, t.zoom); return; }
    for (const x of kids) {
      if (x.k) { if (isSaved(x.k)) visit(x.k); }
      else if (t.zoom >= 8) fill(x.c, x.r, cz);
      else fillClipped(x.c, x.r, cz);
    }
  };
  for (const t of b.tiles) if (t.zoom === levels[0] && isSaved(t)) visit(t);
  return { z, cells: [...cells], rings: outline(cells, z), shade: shadeBoxes(cells, z) };
}

/**
 * Where two cells touch only at a corner, two edges leave that point. Taking the sharpest right turn (the
 * interior is on the right) keeps each ring on its own side, so rings touch there but never cross or loop
 * through each other: a ring that crosses itself makes MapLibre draw rays across the map.
 */
function rightmostTurn(outs, x, y, dx, dy) {
  let best = 0, bestScore = -Infinity;
  outs.forEach(([ox, oy], i) => {
    const cross = dx * (oy - y) - dy * (ox - x);        // rows grow southwards, so > 0 is a right turn
    const score = cross > 0 ? 2 : cross === 0 ? 1 : 0;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

const SHADE_LAT = 85.0511;                       // Web Mercator's edge

/**
 * The map outside a set of grid cells as [w, s, e, n] boxes in degrees: four around the cells' bounding box,
 * and inside it, per row, the runs of empty cells (merged down while the next row has the same run). Boxes
 * have no holes and nothing that can cross, so the shade can't fall apart into rays the way one world polygon
 * with the outline rings as holes does when cells touch only at corners.
 */
function shadeBoxes(cells, z) {
  if (!cells.size) return [[-180, -SHADE_LAT, 180, SHADE_LAT]];
  const step = 2 ** (32 - z);
  const lat = (row) => latFromY(2 ** 31 - row * step), lon = (col) => lonFromX(col * step - 2 ** 31);
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (const cell of cells) {
    const [c, r] = cell.split(',').map(Number);
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  const out = [[-180, lat(r0), 180, SHADE_LAT], [-180, -SHADE_LAT, 180, lat(r1 + 1)],
               [-180, lat(r1 + 1), lon(c0), lat(r0)], [lon(c1 + 1), lat(r1 + 1), 180, lat(r0)]];
  let open = new Map();                          // "a,b" (a run of empty columns) -> the row it started in
  const close = (key, rowEnd) => { const [a, b] = key.split(',').map(Number); out.push([lon(a), lat(rowEnd), lon(b + 1), lat(open.get(key))]); };
  for (let r = r0; r <= r1 + 1; r++) {
    const runs = new Set();
    if (r <= r1) for (let c = c0; c <= c1; c++) {
      if (cells.has(`${c},${r}`)) continue;
      const a = c; while (c + 1 <= c1 && !cells.has(`${c + 1},${r}`)) c++;
      runs.add(`${a},${c}`);
    }
    for (const key of [...open.keys()]) if (!runs.has(key)) { close(key, r); open.delete(key); }
    for (const key of runs) if (!open.has(key)) open.set(key, r);
  }
  return out;
}

/** Rings ([lat, lon] lists) around a set of grid cells "col,row" (row grows southwards). */
function outline(cells, z) {
  const has = (c, r) => cells.has(`${c},${r}`);
  const next = new Map();                         // "x,y" -> [x2, y2][], interior on the right
  const edge = (x1, y1, x2, y2) => {
    const k = `${x1},${y1}`;
    if (!next.has(k)) next.set(k, []);
    next.get(k).push([x2, y2]);
  };
  for (const cell of cells) {
    const [c, r] = cell.split(',').map(Number);
    if (!has(c, r - 1)) edge(c, r, c + 1, r);
    if (!has(c + 1, r)) edge(c + 1, r, c + 1, r + 1);
    if (!has(c, r + 1)) edge(c + 1, r + 1, c, r + 1);
    if (!has(c - 1, r)) edge(c, r + 1, c, r);
  }
  const step = 2 ** (32 - z);
  const ll = (x, y) => [latFromY(2 ** 31 - y * step), lonFromX(x * step - 2 ** 31)];
  const rings = [];
  for (const [k, outs] of next) {
    while (outs.length) {
      let [x, y] = k.split(',').map(Number);
      const pts = [[x, y]];
      let [nx, ny] = outs.pop();
      while (nx !== pts[0][0] || ny !== pts[0][1]) {
        pts.push([nx, ny]);
        const o = next.get(`${nx},${ny}`);
        if (!o?.length) break;
        const [px, py] = pts[pts.length - 2];
        [nx, ny] = o.splice(rightmostTurn(o, nx, ny, nx - px, ny - py), 1)[0];
      }
      // drop the points in the middle of straight runs
      const keep = pts.filter((p, i) => {
        const a = pts[(i - 1 + pts.length) % pts.length], c = pts[(i + 1) % pts.length];
        return !((a[0] === p[0] && p[0] === c[0]) || (a[1] === p[1] && p[1] === c[1]));
      });
      rings.push(keep.map(([px, py]) => ll(px, py)));
    }
  }
  return rings;
}

async function openMeta(meta, progress) {
  const bundle = await Bundle.open(bytesSource(await lib.readHead(meta), meta.id));
  bundle.rawReader = (tip) => lib.readTileBlob(meta, tip);
  const store = new TileStore(bundle);
  const tips = Object.keys(meta.tiles).map(Number);
  let done = 0;
  for (const tip of tips) {
    const t = bundle.byTip.get(tip);
    store.addTile(t, await bundle.readTile(tip));
    progress?.({ phase: 'open', done: ++done, total: tips.length });
  }
  cur = { meta, bundle, store, engine: openEngine(store, meta) };
  return info();
}

/** Downloads tiles into a library folder and decodes them into `store`, PARALLEL at a time. */
async function download(src, tiles, meta, guid, store, record, progress) {
  let next = 0, done = 0, bytes = 0, failed = false;    // one failed tile stops the others
  const total = tiles.length, totalBytes = tiles.reduce((a, t) => a + t.size, 0);
  const t0 = performance.now();
  cancelled = false;
  const worker = async () => {
    while (next < tiles.length && !cancelled && !failed) {
      const t = tiles[next++];
      try {
        const raw = await src.readRaw(t.tip);
        if (cancelled || failed) return;
        await lib.saveTileBlob(meta, t.tip, raw, guid);
        store.addTile(store.bundle.byTip.get(t.tip), await unsealChunk(raw));
        record(t.tip, raw.length);
        done++; bytes += raw.length;
      } catch (e) {
        failed = true;
        throw e instanceof BundleReplaced ? Object.assign(new Error(REPLACED), { kind: 'replaced' }) : e;
      }
      progress({ phase: 'download', done, total, bytes, totalBytes, elapsed: (performance.now() - t0) / 1000 });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, tiles.length) }, worker));
  return !cancelled;
}

function addBox(boxes, box) {
  const inside = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
  if (boxes.some(b => inside(box, b))) return boxes;
  return [...boxes.filter(b => !inside(b, box)), box];
}

const wsen = ([s, w, n, e]) => [w, s, e, n];
// What one saved area may hold (compressed tiles): decoded, it takes about 5 times that in this tab's memory,
// and a zoomed-out view would otherwise ask for the whole planet (57 GB).
const MAX_AREA_BYTES = 300e6;
// The largest result the page takes: its text, the elements and the map's copy come to about 9 times this.
const MAX_RESULT_BYTES = 100e6;
const SUGGEST_LIMIT = 10;
/** Features per key (key = null) or per value of one key, over all tiles of a store: tag tables are shared, so
 *  each table is counted once with the number of features that use it. */
function countTags(store, key) {
  const counts = new Map();
  for (const t of store.slots) {
    const perTable = new Int32Array(t.tagOff.length - 1);
    for (let i = 0; i < t.n; i++) perTable[t.tagTab[i]]++;
    for (let tab = 0; tab < perTable.length; tab++) {
      if (!perTable[tab]) continue;
      for (let k = 2 * t.tagOff[tab], end = 2 * t.tagOff[tab + 1]; k < end; k += 2) {
        const name = t.strs[t.tagKV[k]];
        if (key === null) counts.set(name, (counts.get(name) ?? 0) + perTable[tab]);
        else if (name === key) { const v = t.strs[t.tagKV[k + 1]]; counts.set(v, (counts.get(v) ?? 0) + perTable[tab]); }
      }
    }
  }
  return counts;
}
const savedBytes = (meta) => Object.values(meta.tiles).reduce((a, n) => a + n, 0);
function tooLarge(total) {
  return new Error(`That would make the saved area ${fmtMB(total)}, more than the ${fmtMB(MAX_AREA_BYTES)} a browser tab ` +
    'handles well. Zoom in, or start a separate saved area for the other place.');
}
const fmtMB = (n) => `${Math.round(n / 1e6).toLocaleString('en')} MB`;

/**
 * A name for a newly loaded area, from the place nodes in the data: "Neighbourhood, City" for a small
 * area, the city or town for a large one, else the coordinates. box = [w, s, e, n].
 */
function placeName(box) {
  const [w, s, e, n] = box, cx = (w + e) / 2, cy = (s + n) / 2, k = Math.cos(cy * Math.PI / 180);
  const km = (lat, lon) => Math.hypot((lon - cx) * 111.32 * k, (lat - cy) * 111.32);
  const widthKm = Math.max((e - w) * 111.32 * k, (n - s) * 111.32);
  const m = 0.15;                                    // also look a little beyond the box for the town
  let els = [];
  try { els = cur.engine.run(`[out:json];node[place][name](${s - m},${w - m},${n + m},${e + m});out;`).elements; } catch { /* none */ }
  const inBox = (el) => el.lat >= s && el.lat <= n && el.lon >= w && el.lon <= e;
  // nearest first, but places inside the box before those just outside it
  const nearest = (list) => list.sort((a, b) => (inBox(b) - inBox(a)) || km(a.lat, a.lon) - km(b.lat, b.lon))[0];
  // the city if one is within 12 km (Cramond is in Edinburgh, not South Queensferry), else a town
  const big = nearest(els.filter(el => el.tags.place === 'city' && km(el.lat, el.lon) < 12)) ||
    nearest(els.filter(el => ['city', 'town'].includes(el.tags.place) && km(el.lat, el.lon) < 25));
  // a suburb or village in or near the box first; a neighbourhood or hamlet only when there's none
  const near = (el) => inBox(el) || km(el.lat, el.lon) < Math.max(1.5, widthKm / 2);
  const local = nearest(els.filter(el => near(el) && ['suburb', 'quarter', 'borough', 'village', 'town', 'city'].includes(el.tags.place))) ||
    nearest(els.filter(el => inBox(el) && ['neighbourhood', 'hamlet', 'locality'].includes(el.tags.place)));
  if (big && widthKm > 8 && inBox(big)) return big.tags.name;
  if (local && big && local.tags.name !== big.tags.name) return `${local.tags.name}, ${big.tags.name}`;
  if (local || big) return (local || big).tags.name;
  return `Area at ${cy.toFixed(3)}, ${cx.toFixed(3)}`;
}

async function uniqueName(name, selfId) {
  const taken = new Set((await lib.listLibraries()).filter(m => m.id !== selfId).map(m => m.name));
  let out = name;
  for (let i = 2; taken.has(out); i++) out = `${name} (${i})`;
  return out;
}

const COMMANDS = {
  async libraries() {
    const list = await lib.listLibraries();
    for (const m of list) m.bytes = lib.librarySize(m);
    let storage = null;
    try { storage = await navigator.storage.estimate(); } catch { /* not available */ }
    return { libraries: list, current: cur?.meta.id ?? null, storage };
  },

  info: () => info(),

  async open({ id }, progress) {
    return openMeta(await lib.readMeta(id), progress);
  },

  /** A new, empty area. Without a name it's named after its place once the first area is loaded. */
  async create({ name, url }) {
    const bundle = await remote(url, { check: true });
    const meta = name
      ? await lib.createLibrary(await uniqueName(lib.checkName(name)), { kind: 'url', url }, bundle)
      : await lib.createLibrary('New area', { kind: 'url', url }, bundle, { autoName: true });
    return openMeta(meta);
  },

  /** The name an area of the open saved area would get (bbox = [s, w, n, e]). */
  suggestName({ bbox }) { return cur ? placeName(wsen(bbox)) : null; },

  async rename({ id, name }) {
    const meta = cur?.meta.id === id ? cur.meta : await lib.readMeta(id);
    meta.name = await uniqueName(lib.checkName(name), id);
    delete meta.autoName;
    await lib.writeMeta(meta);
    return { name: meta.name, info: info() };
  },

  async close() { cur = null; return null; },

  async delete({ id }) {
    if (cur?.meta.id === id) cur = null;
    await lib.deleteLibrary(id);
    return null;
  },

  async export({ id }) {
    const meta = cur?.meta.id === id ? cur.meta : await lib.readMeta(id);
    const file = meta.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'area';
    return { blob: await lib.exportLibrary(meta), filename: `${file}.gob` };
  },

  /** Copies every tile of a .gob file (a bundle, or a saved area exported from this page) into a new library. */
  async import({ file, name }, progress) {
    const bundle = await Bundle.open(blobSource(file));
    const meta = await lib.createLibrary(await uniqueName(lib.checkName(name)), { kind: 'file', name: file.name }, bundle);
    const tiles = [...bundle.entries].filter(([, e]) => e.size > 0).map(([tip, e]) => ({ tip, size: e.size }));
    const store = new TileStore(bundle);
    const ok = await download(bundle, tiles, meta, meta.guid, store, (tip, n) => { meta.tiles[tip] = n; }, progress);
    await lib.writeMeta(meta);
    if (!ok) { await lib.deleteLibrary(meta.id); return { cancelled: true }; }
    cur = { meta, bundle, store, engine: openEngine(store, meta) };
    return { info: info(), tiles: tiles.length };
  },

  /** What "Load this area" would fetch. bbox = [s, w, n, e]. */
  /** What loading a box would fetch. `target`: a saved area's ID, "new" for a new one, or none for the open one. */
  async estimate({ bbox, url, target }) {
    const meta = target === 'new' ? null : target ? await lib.readMeta(target) : cur?.meta ?? null;
    url = url ?? meta?.source.url;
    const src = await remote(url, { check: true });     // a tab left open across the daily replacement
    const h = src.header;
    const box = wsen(bbox);
    const res = { source: url, revision: h.revision, timestamp: h.revisionTimestamp, wayNodeIds: h.wayNodeIds };
    if (meta && meta.guid !== h.guid) {
      // the bundle has changed since the library was made: everything has to come again
      const want = new Map();
      for (const b of [...meta.boxes, box]) for (const t of src.tilesForBox(...b)) if (t.size) want.set(t.tip, t.size);
      const bytes = [...want.values()].reduce((a, n) => a + n, 0);
      return { ...res, stale: true, libRevision: meta.revision, libTimestamp: meta.timestamp,
               areas: meta.boxes.length, tiles: want.size, bytes, total: bytes, limit: MAX_AREA_BYTES };
    }
    const have = meta?.tiles ?? {};
    const want = src.tilesForBox(...box).filter(t => t.size && !(t.tip in have));
    const bytes = want.reduce((a, t) => a + t.size, 0);
    return { ...res, stale: false, tiles: want.length, bytes, total: (meta ? savedBytes(meta) : 0) + bytes, limit: MAX_AREA_BYTES };
  },

  /** Loads the tiles of a box from the library's bundle (creating the library first if `create` is given). */
  async load({ bbox, create }, progress) {
    if (!cur && create) await COMMANDS.create(create);
    if (!cur) throw new Error('No saved area is open.');
    if (cur.meta.source.kind !== 'url') throw new Error('This saved area was imported from a file: there is no bundle to download more from.');
    const src = await remote(cur.meta.source.url);
    const box = wsen(bbox);
    const meta = cur.meta;
    const t0 = performance.now();
    if (meta.guid === src.header.guid) {
      const want = src.tilesForBox(...box).filter(t => t.size && !(t.tip in meta.tiles));
      const total = savedBytes(meta) + want.reduce((a, t) => a + t.size, 0);
      if (total > MAX_AREA_BYTES) throw tooLarge(total);
      let n = 0;
      const ok = await download(src, want, meta, meta.guid, cur.store, (tip, size) => {
        meta.tiles[tip] = size;
        if (++n % 10 === 0) lib.writeMeta(meta);
      }, progress);
      if (ok) meta.boxes = addBox(meta.boxes, box);
      cur.tagCounts = null;                          // new tiles: the Wizard's counts are counted again
      if (ok && meta.autoName) { meta.name = await uniqueName(placeName(box), meta.id); delete meta.autoName; }
      await lib.writeMeta(meta);
      return { cancelled: !ok, added: n, seconds: Math.round((performance.now() - t0) / 100) / 10, info: info() };
    }
    // Update: download every saved area again from the new bundle, into a new folder.
    const guid = src.header.guid;
    const boxes = addBox(meta.boxes, box);
    const want = new Map();
    for (const b of boxes) for (const t of src.tilesForBox(...b)) if (t.size) want.set(t.tip, t);
    const total = [...want.values()].reduce((a, t) => a + t.size, 0);
    if (total > MAX_AREA_BYTES) throw tooLarge(total);
    await lib.saveHead(meta, guid, src.headBytes);
    const store = new TileStore(src);
    const tiles = {};
    let ok;
    try { ok = await download(src, [...want.values()], meta, guid, store, (tip, size) => { tiles[tip] = size; }, progress); }
    catch (e) { await lib.removeFolder(meta.id, guid); throw e; }
    if (!ok) { await lib.removeFolder(meta.id, guid); return { cancelled: true, info: info() }; }
    const old = meta.guid;
    Object.assign(meta, lib.bundleInfo(src), { tiles, boxes });
    await lib.writeMeta(meta);
    await lib.removeFolder(meta.id, old);
    const bundle = await Bundle.open(bytesSource(src.headBytes, meta.id));
    bundle.rawReader = (tip) => lib.readTileBlob(meta, tip);
    store.bundle = bundle;
    cur = { meta, bundle, store, engine: openEngine(store, meta) };
    return { updated: true, added: want.size, seconds: Math.round((performance.now() - t0) / 100) / 10, info: info() };
  },

  /** Runs a query on the open library. bbox = [s, w, n, e] and center = [lat, lon] are the map view. */
  /**
   * For the Wizard's suggestions: keys (key = null), or one key's values, in the open saved area that start with
   * `prefix`, most common first, with roughly how many features have them (a feature spread over several tiles
   * counts once per tile). Counted once per key and kept until the area changes.
   */
  tagSuggest({ key = null, prefix = '', limit = SUGGEST_LIMIT }) {
    if (!cur) return [];
    cur.tagCounts ??= new Map();
    const slot = key ?? '';
    if (!cur.tagCounts.has(slot)) cur.tagCounts.set(slot, countTags(cur.store, key));
    const p = prefix.toLowerCase(), out = [];
    for (const [s, n] of cur.tagCounts.get(slot)) if (s && s.toLowerCase().startsWith(p)) out.push([s, n]);
    return out.sort((a, b) => b[1] - a[1]).slice(0, limit);
  },

  async run({ query, bbox, center }) {
    if (!cur) throw new Error('No saved area is open: pan to your area and click Load this area.');
    const t0 = performance.now();
    const geoNotes = [];
    cur.engine.sync();
    const geo = new Geocoder(cur.engine);
    const geocoder = (kind, text) => geo.shortcut(kind, text, geoNotes);
    const expanded = expand(query, { bbox, center, geocoder });
    const res = cur.engine.run(expanded);
    const ms = Math.round(performance.now() - t0);
    const notes = [...geoNotes, ...(res.bypass?.notes ?? [])];
    // the format the query asks for; without [out:…] Overpass answers in XML, and so do we
    const { format, contentType, body } = render(res, res.settings, 'xml');
    const asked = Number(res.settings.maxsize), limit = Math.min(MAX_RESULT_BYTES, asked > 0 ? asked : Infinity);
    if (body.length > limit) {
      throw new Error(`The result is ${fmtMB(body.length)}, more than ${limit === MAX_RESULT_BYTES ? `the ${fmtMB(limit)} this page handles`
        : `the query's [maxsize:${res.settings.maxsize}]`}. Narrow it down (a smaller area, more tags), or ask for less: out count, out center or out tags.`);
    }
    return { elements: res.elements, notes, ms, body, format, contentType, csv: res.settings.csv ?? null,
             expanded: expanded !== query ? expanded : null };
  },
};

// Every module loaded: the page counts errors from here on as a call's, not as a failed start.
post({ ready: true });
