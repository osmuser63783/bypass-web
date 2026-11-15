// Canonical per-feature dump of every distinct feature in a bundle (one JSON line each, sorted by
// "type/id"), for comparing decoder versions: node xy; way points, area flag, bbox, node IDs and feature
// nodes; relation bbox, area flag and members with roles; parent relations.
// Usage: node test/dump-features.mjs <bundle.gob> <out.jsonl>
import { createWriteStream } from 'node:fs';
import { Bundle, fileSource } from '../src/bundle.js';
import { TileStore } from '../src/store.js';
import { F_DUPLICATE, F_NODE_IDS } from '../src/tes.js';
const [gob, out] = process.argv.slice(2);
const s = new TileStore(await Bundle.open(await fileSource(gob)));
await s.loadAll();
s.index();
const rid = (t, a, b) => { const r = s.resolve(t, a, b); return r < 0 ? 'null' : `${s.type(r)[0]}${s.id(r)}`; };
const lines = [];
for (const t of s.slots) for (let i = 0; i < t.n; i++) {
  if (t.flags[i] & F_DUPLICATE) continue;
  const type = t.type(i), k = `${type}/${t.ids[i]}`;
  const d = { k, tags: t.tags(i).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) };
  const p0 = t.ptOff[i], p1 = t.ptOff[i + 1], r0 = t.refOff[i], r1 = t.refOff[i + 1], b = 4 * (i - t.wayStart);
  const bb = () => ({ minX: t.bbox[b], minY: t.bbox[b + 1], maxX: t.bbox[b + 2], maxY: t.bbox[b + 3] });
  if (type === 'node') d.xy = [t.x(i), t.y(i)];
  else if (type === 'way') {
    d.c = [...t.xy.subarray(2 * p0, 2 * p1)]; d.a = t.isArea(i); d.bb = bb();
    if (t.flags[i] & F_NODE_IDS) d.ids = [...t.nodeIds.subarray(p0, p1)];
    d.fn = []; for (let r = r0; r < r1; r++) d.fn.push(rid(t, t.refs[3 * r], t.refs[3 * r + 1]));
  } else {
    d.bb = bb(); d.a = t.isArea(i);
    d.m = []; for (let r = r0; r < r1; r++) d.m.push([rid(t, t.refs[3 * r], t.refs[3 * r + 1]), t.role(t.refs[3 * r + 2])]);
  }
  d.p = [];
  const pt = t.parTab[i];
  if (pt >= 0) for (let r = t.parOff[pt]; r < t.parOff[pt + 1]; r++) d.p.push(rid(t, t.parRefs[2 * r], t.parRefs[2 * r + 1]));
  d.p.sort();
  lines.push([k, JSON.stringify(d)]);
}
lines.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const w = createWriteStream(out);
for (const [, l] of lines) w.write(l + '\n');
w.end();
console.log(lines.length, 'features,', s.featureCount, 'unique,', Math.round(s.bytes() / 1e6), 'MB in typed arrays');
