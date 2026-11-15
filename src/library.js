// SPDX-License-Identifier: AGPL-3.0-or-later
// Saved areas ("libraries") in the browser's origin-private file system (OPFS).
//
//   bypass/<id>/meta.json           id, display name, source, bundle GUID/revision, saved tiles, boxes
//   bypass/<id>/<guid>/head.bin     header + catalog + sealed metadata of the bundle (opens offline)
//   bypass/<id>/<guid>/<tip>        sealed tile blobs exactly as in the bundle
//
// The folder name is a fixed ID; the name people see is `meta.name` and can be anything (renaming only
// rewrites meta.json). Areas saved before IDs existed use their old name as the ID.
//
// Tiles live in a folder per bundle GUID: tiles of two bundle revisions can't be mixed (cross-tile
// references point into the other tile's export table), so an update downloads into a new folder and
// switches over only when it's complete.

import { crc32c } from './bundle.js';

const ROOT = 'bypass';

let rootReady = null;
async function root() {                     // the saved areas' folder
  rootReady ??= navigator.storage.getDirectory().then(r => r.getDirectoryHandle(ROOT, { create: true }));
  return rootReady;
}

async function dir(...path) {               // creates missing folders: for writing
  let d = await root();
  for (const p of path) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}

async function existing(...path) {          // for reading: a missing folder is an error, not created
  let d = await root();
  for (const p of path) d = await d.getDirectoryHandle(p);
  return d;
}

async function writeFile(d, name, bytes) {
  const fh = await d.getFileHandle(name, { create: true });
  if (fh.createSyncAccessHandle) {                    // workers: fastest, and Safari's only writable path
    const h = await fh.createSyncAccessHandle();
    try { h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); } finally { h.close(); }
  } else {
    const w = await fh.createWritable();
    await w.write(bytes); await w.close();
  }
}

async function readFile(d, name) {
  const fh = await d.getFileHandle(name);
  return new Uint8Array(await (await fh.getFile()).arrayBuffer());
}

export function checkName(name) {
  name = String(name ?? '').trim();
  if (!name) throw new Error('The name is empty.');
  if (name.length > 80) throw new Error('Use at most 80 characters.');
  return name;
}

// The layout of meta.json and the folders. Raise it when either changes, and convert older areas in metaIn
// (areas from before this field are format 1). An area of a higher format comes from a newer copy of the page
// (another tab not yet reloaded): it's listed but left alone, so this copy can't overwrite what it doesn't know.
export const FORMAT = 1;

const newId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export async function listLibraries() {
  const out = [];
  for await (const [name, h] of (await root()).entries()) {
    if (h.kind !== 'directory') continue;
    try { out.push({ id: name, ...await metaIn(h) }); }
    catch (e) { out.push({ id: name, name: e.areaName ?? name, broken: true, newer: !!e.newer }); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


export function librarySize(meta) {
  return (meta.headSize ?? 0) + Object.values(meta.tiles ?? {}).reduce((a, n) => a + n, 0);
}

/** A new, empty library for a bundle (its head is saved right away, so it opens offline). */
export async function createLibrary(name, source, bundle, extra = {}) {
  name = checkName(name);
  const now = Date.now();
  const meta = { id: newId(), name, source, ...bundleInfo(bundle), tiles: {}, boxes: [], created: now, modified: now, ...extra };
  await writeFile(await dir(meta.id, meta.guid), 'head.bin', bundle.headBytes);
  await writeMeta(meta);
  return meta;
}

export function bundleInfo(bundle) {
  const h = bundle.header;
  return { guid: h.guid, revision: h.revision, timestamp: h.revisionTimestamp, wayNodeIds: h.wayNodeIds,
           bundleTiles: bundle.tiles.length, headSize: bundle.headBytes.length };
}

// A worker writes in place (truncate, then write), so a tab closed mid-write could leave meta.json empty or
// cut short. Each write therefore goes to meta.new.json first, then meta.json: one of the two is always whole.
const SPARE = 'meta.new.json';

export async function writeMeta(meta) {
  meta.format = FORMAT;
  meta.modified = Date.now();
  const d = await dir(meta.id), bytes = new TextEncoder().encode(JSON.stringify(meta));
  await writeFile(d, SPARE, bytes);
  await writeFile(d, 'meta.json', bytes);
}

async function metaIn(d) {
  const parse = async (name) => JSON.parse(new TextDecoder().decode(await readFile(d, name)));
  let m;
  try { m = await parse('meta.json'); } catch (e) {
    try { m = await parse(SPARE); } catch { throw e; }
  }
  m.format ??= 1;
  if (m.format > FORMAT) {
    throw Object.assign(new Error(`${m.name} was saved by a newer version of this page: reload the page to open it.`),
      { newer: true, areaName: m.name });
  }
  return m;
}

export async function readMeta(id) {
  return { id, ...await metaIn(await existing(id)) };
}

export async function readHead(meta, guid = meta.guid) { return readFile(await existing(meta.id, guid), 'head.bin'); }
export async function readTileBlob(meta, tip, guid = meta.guid) { return readFile(await existing(meta.id, guid), String(tip)); }
export async function saveTileBlob(meta, tip, bytes, guid = meta.guid) { await writeFile(await dir(meta.id, guid), String(tip), bytes); }
export async function saveHead(meta, guid, bytes) { await writeFile(await dir(meta.id, guid), 'head.bin', bytes); }

export async function removeFolder(id, guid) {
  try { await (await existing(id)).removeEntry(guid, { recursive: true }); } catch { /* already gone */ }
}

/** Removes meta.json (and its spare) first, so an interrupted delete leaves an area that lists as unreadable, not a half one. */
export async function deleteLibrary(id) {
  for (const name of [SPARE, 'meta.json']) {
    try { await (await existing(id)).removeEntry(name); } catch { /* already gone */ }
  }
  await (await root()).removeEntry(id, { recursive: true });
}

/**
 * A partial bundle: the original header with only the saved tiles in the catalog, the same metadata,
 * then those tiles. This page opens it again (Import); it is not checked against GOL Tool.
 */
export async function exportLibrary(meta) {
  const head = await readHead(meta);
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tileCount = dv.getUint32(0x1C, true);
  const catalogSize = 64 + 8 * tileCount + 4;
  const metadata = head.subarray(catalogSize);
  const tips = Object.keys(meta.tiles).map(Number).filter(t => meta.tiles[t] > 0);
  // keep the original catalog order (tiles follow it in the file)
  const order = new Map();
  for (let i = 0; i < tileCount; i++) order.set(dv.getUint32(64 + 8 * i, true), i);
  tips.sort((a, b) => order.get(a) - order.get(b));
  const cat = new Uint8Array(64 + 8 * tips.length + 4);
  cat.set(head.subarray(0, 64), 0);
  const cdv = new DataView(cat.buffer);
  cdv.setUint32(0x1C, tips.length, true);
  const parts = [cat, metadata];
  for (let i = 0; i < tips.length; i++) {
    const blob = await readTileBlob(meta, tips[i]);
    cdv.setUint32(64 + 8 * i, tips[i], true);
    cdv.setUint32(64 + 8 * i + 4, blob.length, true);
    parts.push(blob);
  }
  cdv.setUint32(cat.length - 4, crc32c(cat.subarray(0, cat.length - 4)), true);
  return new Blob(parts, { type: 'application/octet-stream' });
}
