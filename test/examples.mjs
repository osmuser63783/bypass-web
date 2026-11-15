// Runs every example in examples.js through the browser engine (tiles of a bundle around one view) and
// prints counts; with an oracle file (reference answers for test/examples-expanded.ql) also compares.
// Usage: node test/examples.mjs <bundle.gob> [--write-ql] [oracle.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { Bundle, fileSource } from '../src/bundle.js';
import { TileStore } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { expand } from '../src/turbo.js';
import { Geocoder } from '../src/geocode.js';
const [gob, ...rest] = process.argv.slice(2);
const EXAMPLES = new Function(readFileSync(new URL('../examples.js', import.meta.url), 'utf8') + '; return EXAMPLES;')();
const bbox = [55.9369909, -3.2137585, 55.9696195, -3.1627750], center = [55.9533052, -3.1882668];
// YAML front matter (styling, ui-map.js splitFrontMatter) becomes blank lines, as on the page
const stripFrontMatter = (q) => q.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, (m) => '\n'.repeat(m.split('\n').length - 1));
const queries = EXAMPLES.map(x => stripFrontMatter(x.q.replaceAll('__PLACE__', 'Edinburgh')));
let engineRef = null;
const expandAll = () => queries.map(q => expand(q, { bbox, center, geocoder: (k, t) => new Geocoder(engineRef).shortcut(k, t, []) }));

const oracleFile = rest.find(a => a.endsWith('.json'));
const oracle = oracleFile ? JSON.parse(readFileSync(oracleFile, 'utf8')) : null;
const src = await fileSource(gob);
const store = new TileStore(await Bundle.open(src));
const m = 0.05;
await store.loadBox(bbox[1] - m, bbox[0] - m, bbox[3] + m, bbox[2] + m);
const engine = new Engine(store);
engineRef = engine; engine.sync();
const expanded = expandAll();
if (rest.includes('--write-ql')) writeFileSync(new URL('./examples-expanded.ql', import.meta.url), expanded.join('\n----\n') + '\n');
let ok = 0;
for (const [k, x] of EXAMPLES.entries()) {
  let js;
  try { const t0 = performance.now(); const r = engine.run(expanded[k]); js = `${r.elements.length} elements, ${Math.round(performance.now() - t0)} ms`; ok++; }
  catch (e) { js = 'ERROR ' + e.message; }
  const o = oracle?.[k], py = !oracle ? '' : !o ? 'py –' : o.ok ? `py ${o.elements.length}` : `py ERROR ${o.error}`;
  console.log(`${js.padEnd(28)} ${py.padEnd(10)} ${x.group} / ${x.name}`);
}
console.log(`${ok}/${EXAMPLES.length} ran in the browser engine`);
await src.close();
