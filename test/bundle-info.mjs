// Usage: node test/bundle-info.mjs <bundle file or URL> [W,S,E,N]
import { Bundle, fileSource, urlSource } from '../src/bundle.js';
const [src, box] = process.argv.slice(2);
const source = /^https?:/.test(src) ? urlSource(src, { headers: { 'User-Agent': 'osm-bypass-web-dev/0.1' } }) : await fileSource(src);
const t0 = performance.now();
const b = await Bundle.open(source);
const h = b.header;
console.log({ guid: h.guid, tiles: h.tileCount, revision: h.revision, date: new Date(h.revisionTimestamp).toISOString(),
  wayNodeIds: h.wayNodeIds, metadataBytes: h.metadataSize, ms: Math.round(performance.now() - t0) });
console.log('settings', b.settings, 'strings', b.strings.length, b.strings.slice(0, 12));
const byZoom = {};
for (const t of b.tiles) byZoom[t.zoom] = (byZoom[t.zoom] ?? 0) + 1;
const missing = b.tiles.filter(t => !b.entries.has(t.tip)).length;
console.log('index tiles', b.tiles.length, 'by zoom', byZoom, 'index tiles not in catalog', missing,
  'catalog tips not in index', [...b.entries.keys()].filter(k => !b.byTip.has(k)).length);
if (box) {
  const [w, s, e, n] = box.split(',').map(Number);
  const ts = b.tilesForBox(w, s, e, n);
  console.log('box', box, 'tiles', ts.length, 'compressed MB', (ts.reduce((a, t) => a + t.size, 0) / 1e6).toFixed(1),
    ts.slice(0, 5).map(t => `${t.zoom}/${t.col}/${t.row} tip ${t.tip} ${t.size}B`));
}
source.close?.();
