// SPDX-License-Identifier: AGPL-3.0-or-later
// Rendering a result as XML or CSV: a port of osm_bypass/render.py, whose parts are ports of Overpass API
// output_formats/output_{xml,csv}.cc (Copyright (C) 2008-2018 Roland Olbricht et al., AGPL-3.0-or-later).

import { Unsupported } from './engine.js';
import { COPYRIGHT } from './engine-base.js';

export { COPYRIGHT };
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
export function toXml(res, bbox = null) {
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

export function toCsv(res, spec) {
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
export function toPopup(res, cats) {
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
export function render(res, settings, defaultFormat = 'json') {
  const fmt = settings.outGiven ? settings.out : defaultFormat;
  if (fmt === 'xml') return { format: 'xml', contentType: 'application/osm3s+xml', body: toXml(res, settings.bbox) };
  if (fmt === 'csv') return { format: 'csv', contentType: 'text/csv', body: toCsv(res, settings.csv) };
  if (fmt === 'popup') return { format: 'popup', contentType: 'text/html; charset=utf-8', body: toPopup(res, settings.popup) };
  const clean = { version: res.version, generator: res.generator, osm3s: res.osm3s ?? { copyright: COPYRIGHT },
                  elements: res.elements };
  if (res.remark != null) clean.remark = res.remark;            // a runtime error, after the elements (output_json.cc)
  return { format: 'json', contentType: 'application/json', body: JSON.stringify(clean, null, 2) };
}
