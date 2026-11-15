// Builds data/tag2link.json (key -> URL template with $1) from tag2link (vendor-src/tag2link/index.json, ISC,
// https://github.com/JOSM/tag2link), choosing one URL per key the way openstreetmap.org does
// (openstreetmap-website lib/tag2link.rb): drop deprecated entries, third-party Wikidata formatters (P3303) and
// non-http(s) URLs; prefer the "preferred" rank; between the OSM wiki and Wikidata, the OSM wiki; skip keys
// that stay ambiguous. Usage: node tools-tag2link.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const items = JSON.parse(readFileSync('vendor-src/tag2link/index.json', 'utf8'));
const byKey = new Map();
for (const it of items) {
  if (it.rank === 'deprecated' || it.source === 'wikidata:P3303' || !/^https?:\/\//.test(it.url)) continue;
  const key = it.key.replace(/^Key:/, '');
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(it);
}
function best(list) {
  if (list.length === 1) return list[0];
  const top = list.some(i => i.rank === 'preferred') ? list.filter(i => i.rank === 'preferred') : list;
  const uniq = [...new Map(top.map(i => [i.url, i])).values()];
  if (uniq.length === 1) return uniq[0];
  const bySource = new Map();
  for (const i of uniq) { if (!bySource.has(i.source)) bySource.set(i.source, []); bySource.get(i.source).push(i); }
  if (bySource.size > 2) return null;
  const groups = [...bySource.values()];
  if (groups.every(g => g.length === 1)) return (bySource.get('osmwiki:P8') ?? groups[0])[0];
  const single = groups.filter(g => g.length === 1);
  return single.length === 1 ? single[0][0] : null;
}
const out = {};
for (const [key, list] of [...byKey].sort()) { const b = best(list); if (b) out[key] = b.url; }
writeFileSync('data/tag2link.json', JSON.stringify(out));
console.log(`data/tag2link.json: ${Object.keys(out).length} keys`);
