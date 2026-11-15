// Builds the query builder's two files from the vendored sources in vendor-src/:
//   vendor/overpass-wizard.js  overpass-wizard 0.0.9 (MIT, Martin Raifer) as one classic script that
//                              defines the global OverpassWizard(search, options); its CommonJS files
//                              (parser.js, free.js, index.js) are wrapped unchanged.
//   data/presets-en.json       name, terms, tags and geometry of every searchable iD preset, from
//                              @openstreetmap/id-tagging-schema 7.3.0 (ISC), for free-form input such
//                              as "Drinking Water".
// Usage: node tools-wizard.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const W = 'vendor-src/overpass-wizard/pkg/package/';
const mod = (name, file) => `  __def(${JSON.stringify(name)}, function (module, exports, require) {\n${readFileSync(W + file, 'utf8')}\n  });\n`;
const licence = readFileSync(W + 'package.json', 'utf8').includes('"MIT"') ? 'MIT' : '?';
const js = `// overpass-wizard 0.0.9 by Martin Raifer, ${licence} licence (https://github.com/tyrasd/overpass-wizard).
// Bundled for the browser by tools-wizard.mjs; the module sources are unchanged.
var OverpassWizard = (function () {
  var __mods = {}, __cache = {};
  function __def(name, fn) { __mods[name] = fn; }
  function require(name) {
    name = name.replace(/^\\.\\//, '').replace(/\\.js$/, '');
    if (!(name in __cache)) { var m = { exports: {} }; __cache[name] = m; __mods[name](m, m.exports, require); }
    return __cache[name].exports;
  }
${mod('parser', 'parser.js')}${mod('free', 'free.js')}${mod('index', 'index.js')}
  var wizard = require('index');
  wizard.presetSearch = require('free');   // presetSearch(presets).fuzzy_search({ free: text }) -> preset name
  return wizard;
})();
`;
mkdirSync('vendor', { recursive: true });
writeFileSync('vendor/overpass-wizard.js', js);

const S = 'vendor-src/id-tagging-schema/package/dist/';
const presets = JSON.parse(readFileSync(S + 'presets.min.json', 'utf8'));
const en = JSON.parse(readFileSync(S + 'translations/en.min.json', 'utf8')).en.presets.presets;
const out = {};
for (const [id, p] of Object.entries(presets)) {
  const t = en[id];
  if (!t?.name || p.searchable === false || id.startsWith('@')) continue;
  const terms = [...(t.aliases ?? []), ...(t.terms ?? [])];
  out[id] = { name: t.name, terms, tags: p.tags, geometry: p.geometry };
}
mkdirSync('data', { recursive: true });
writeFileSync('data/presets-en.json', JSON.stringify(out));
console.log('vendor/overpass-wizard.js', js.length, 'bytes; data/presets-en.json', Object.keys(out).length, 'presets,',
  JSON.stringify(out).length, 'bytes');
