// Fetch and decode the planet tiles for a box from a bundle URL; print counts and a sample.
import { Bundle, urlSource, fileSource } from '../src/bundle.js';
import { TileStore } from '../src/store.js';
const [src, box] = process.argv.slice(2);
const source = /^https?:/.test(src) ? urlSource(src, { headers: { 'User-Agent': 'osm-bypass-web-dev/0.1' } }) : await fileSource(src);
const store = new TileStore(await Bundle.open(source));
const [w, s, e, n] = box.split(',').map(Number);
let bytes = 0; const t0 = performance.now();
const count = await store.loadBox(w, s, e, n, { onTile: (t, len) => { bytes += len; } });
console.log(`${count} tiles, ${(bytes / 1e6).toFixed(1)} MB uncompressed, ${Math.round(performance.now() - t0)} ms`);
const { Engine } = await import('../src/engine.js');
const engine = new Engine(store);
const c = engine.run(`[out:json]; nwr(${s},${w},${n},${e}); out count;`).elements[0].tags;
console.log('features in the box', c, 'distinct loaded', store.featureCount, Math.round(store.bytes() / 1e6), 'MB in typed arrays');
const pubs = engine.run(`[out:json]; nwr[amenity=pub](${s},${w},${n},${e}); out tags;`).elements;
console.log('amenity=pub', pubs.length, pubs.slice(0, 2));
const rel = engine.run(`[out:json]; rel[type](${s},${w},${n},${e}); out body 1;`).elements[0];
console.log('relation', rel?.id, rel?.tags?.type, rel?.members?.slice(0, 4));
source.close?.();
