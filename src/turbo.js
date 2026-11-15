// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass Turbo's query shortcuts ({{bbox}}, {{center}}, {{date:…}}, constants), ported from
// osm_bypass/turbo.py, itself a port of overpass-turbo js/query.ts and js/shortcuts.ts
// (Copyright (c) 2012 Martin Raifer, MIT licence, see NOTICE.md).
// Geocoding shortcuts go to the caller's `geocoder(kind, text)` (src/geocode.js looks names up in the saved
// data), as in turbo.py: nominatimId/Area add a ';', nominatimBbox/Coords are the geocode ones.

import { Unsupported } from './engine.js';

const CONSTANT = /{{([A-Za-z0-9_]+)=(.+?)}}/;
const STATEMENT = /{{([A-Za-z0-9_]+)(:([\s\S]*?))?}}/;
const MUSTACHE = /{{[\S\s]*?}}/;
const REL_TIME = /(-?[0-9]+) ?(seconds?|minutes?|hours?|days?|weeks?|months?|years?)?/;
const INTERVAL = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2628000, year: 31536000 };
const GEOCODE = ['geocodeId', 'geocodeArea', 'geocodeBbox', 'geocodeCoords',
                 'nominatimId', 'nominatimArea', 'nominatimBbox', 'nominatimCoords'];

const coord = (v, limit) => Math.max(-limit, Math.min(limit, Number(v))).toFixed(7);
const lineCount = (s) => s.split(/\r?\n|\r/).length;

export function relativeTime(instr, now = new Date()) {
  const m = REL_TIME.exec((instr || '0 seconds').toLowerCase());
  if (!m) return '';
  const unit = (m[2] || 'day').replace(/s$/, '');
  return new Date(now.getTime() - Number(m[1]) * (INTERVAL[unit] ?? 86400) * 1000).toISOString();
}

/** bbox = [s, w, n, e], center = [lat, lon]. Returns the expanded query (line numbers preserved). */
export function expand(query, { bbox = null, center = null, now = new Date(), geocoder = null } = {}) {
  if (!query.includes('{{')) return query;
  const need = (what, v) => {
    if (!v) throw new SyntaxError(`{{${what}}} needs the map view`);
    return v;
  };
  const shortcuts = {
    bbox: () => { const b = need('bbox', bbox); return [coord(b[0], 90), coord(b[1], 180), coord(b[2], 90), coord(b[3], 180)].join(','); },
    wsen: () => { const b = need('wsen', bbox); return [coord(b[1], 180), coord(b[0], 90), coord(b[3], 180), coord(b[2], 90)].join(','); },
    center: () => { const c = need('center', center); return `${coord(c[0], 90)},${coord(c[1], 180)}`; },
  };
  const constants = {};
  let m;
  while ((m = CONSTANT.exec(query))) {
    constants[m[1]] = m[2];
    query = query.slice(0, m.index) + query.slice(m.index + m[0].length);
  }
  while ((m = STATEMENT.exec(query))) {
    const name = m[1], instr = m[3] ?? '';
    let rep;
    if (name in constants) rep = constants[name];
    else if (name === 'date') rep = relativeTime(instr, now);
    else if (GEOCODE.includes(name)) {
      if (!geocoder) throw new Unsupported(`{{${name}:${instr}}} needs a geocoder`);
      const kind = { nominatimId: 'geocodeId', nominatimArea: 'geocodeArea', nominatimBbox: 'geocodeBbox', nominatimCoords: 'geocodeCoords' }[name] ?? name;
      rep = geocoder(kind, instr) + (name === 'nominatimId' || name === 'nominatimArea' ? ';' : '');
    }
    else if (name in shortcuts) rep = shortcuts[name]();
    else rep = '';                                   // e.g. {{style:…}}, {{data:…}}: Turbo-only
    query = query.slice(0, m.index) + rep + '\n'.repeat(lineCount(instr) - 1) + query.slice(m.index + m[0].length);
  }
  while ((m = MUSTACHE.exec(query))) {
    query = query.slice(0, m.index) + '\n'.repeat(lineCount(m[0]) - 1) + query.slice(m.index + m[0].length);
  }
  return query;
}
