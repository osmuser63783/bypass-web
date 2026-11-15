// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/results.js: Results: the Data and Table tabs, drawing and popups, JOSM, map-app links, tag values as links, Similar.
// An ES module, loaded through app/main.js; it imports what it uses from the other modules and ui-map.js.
import { button, esc, flash, fmtBytes, JOSM_LIMIT, MAP_LIMIT, setStatus, TABLE_LIMIT } from "./core.js";
import { cm, TOUCH } from "./editor.js";
import { outsideCoverage, rmap } from "./map.js";
import { run } from "./run.js";
import { toGeoJSON } from "../ui-map.js";

// ---- results: raw data, table, exports
let last = null;                       // the last successful result, for exports
/** run.js sets the result: an imported binding can't be assigned from another module. */
function setLast(r) { last = r; }
function osmIds(els) { return [...new Set(els.filter(e => OSM_TYPES[e.type] && e.id).map(e => OSM_TYPES[e.type] + e.id))]; }
const PRETTY_LIMIT = 2e6;              // JSON up to this size is shown indented (the engine renders it compact, for speed)
const SHOWN_LIMIT = 3e6;               // characters of raw data shown in the Data tab (Download has all of it)
const RESULT_EXT = { json: "json", xml: "osm", csv: "csv" };
function displayText(res) {
  let txt = res.body;
  if (res.format === "json" && txt.length <= PRETTY_LIMIT) {
    try { txt = JSON.stringify(JSON.parse(txt), null, 1); } catch (e) { /* show it as it came */ }
  }
  return txt.length > SHOWN_LIMIT ? txt.slice(0, SHOWN_LIMIT) + "\n… (cut short here; Download has all of it)" : txt;
}
function showData(res) {
  const box = document.getElementById("data");
  const label = { json: "JSON", xml: "XML (Overpass's default without [out:json])", csv: "CSV" }[res.format] ?? res.format;
  box.innerHTML = `<div class="dbar"><span class="muted" style="flex:1">${fmtBytes(res.body.length)} of ${esc(label)}</span></div><pre>${esc(displayText(res))}</pre>`;
  const bar = box.firstChild;
  bar.appendChild(button("Download", () => downloadText(res.body, res.contentType, "bypass-result." + (RESULT_EXT[res.format] ?? "txt"))));
  bar.appendChild(button("Copy", async (ev) => {
    try { await navigator.clipboard.writeText(res.body); flash(ev.currentTarget, "Copied"); setStatus("Copied the result.", "ok"); } catch (e) { setStatus("Couldn't copy: " + e.message, "err"); }
  }));
  bar.appendChild(button("GeoJSON", () => downloadText(JSON.stringify(cleanGeoJSON(res.elements)), "application/geo+json", "bypass-result.geojson"),
                         "The results as GeoJSON, with the tags as properties"));
  bar.appendChild(button("Load in JOSM", () => josmLoad(osmIds(res.elements), res.elements), "Load these objects into JOSM to edit them (current versions from the OSM API)"));
}
function cleanGeoJSON(els) {
  const { fc } = toGeoJSON(els, { showUntagged: true });
  for (const f of fc.features) { delete f.id; for (const k of ["@i", "@dim", "@tagged", "@geometry"]) delete f.properties[k]; }
  return { type: fc.type, copyright: OSM_COPYRIGHT, features: fc.features };   // the ODbL notice, as Overpass Turbo's GeoJSON has it
}
function parseCsvLine(l, sep) {               // Overpass's escape_csv quotes values with the separator, " or newlines
  const out = []; let cur = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (l.startsWith(sep, i)) { out.push(cur); cur = ""; i += sep.length - 1; } else cur += ch;
  }
  out.push(cur); return out;
}
function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
/** Rows for the Table tab and its CSV: a CSV result's own columns, else type, id, name, lat, lon and one column per tag key (most common first). */
function tableOf(res) {
  if (res.format === "csv" && res.csv) {
    const lines = res.body.replace(/\n$/, "").split("\n").filter(l => l !== "").map(l => parseCsvLine(l, res.csv.sep));
    const head = res.csv.header ? lines.shift() ?? [] : res.csv.fields.map(f => f.startsWith("::") ? "@" + f.slice(2) : f);
    return { head, rows: lines };
  }
  const freq = new Map();
  for (const e of res.elements) for (const k of Object.keys(e.tags || {})) if (k !== "name") freq.set(k, (freq.get(k) || 0) + 1);
  const keys = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const head = ["type", "id", "name", "lat", "lon", ...keys];
  const rows = res.elements.map(e => {
    const p = e.lat !== undefined ? e : e.center || {};
    return [e.type, e.id ?? "", (e.tags || {}).name ?? "", p.lat ?? "", p.lon ?? "", ...keys.map(k => (e.tags || {})[k] ?? "")];
  });
  return { head, rows };
}
const TABLE_PLAIN = new Set(["type", "id", "lat", "lon"]);   // the Table's own columns: not tags, never links
const tableCSV = ({ head, rows }) => [head, ...rows].map(r => r.map(csvCell).join(",")).join("\n") + "\n";
function showTable(res) {
  const box = document.getElementById("table"), t = tableOf(res), { head, rows } = t;
  if (!rows.length) { box.innerHTML = '<div class="empty">No rows.</div>'; return; }
  box.innerHTML = `<div class="dbar"><span class="muted" style="flex:1">${rows.length.toLocaleString()} rows × ${head.length} columns` +
    (rows.length > TABLE_LIMIT ? ` (the first ${TABLE_LIMIT.toLocaleString()} shown)` : "") + "</span></div>" +
    "<table><thead><tr>" + head.map(h => `<th>${esc(h)}</th>`).join("") + "</tr></thead><tbody>" +
    rows.slice(0, TABLE_LIMIT).map(r => "<tr>" + r.map((c, j) => `<td${typeof c === "number" ? ' class="num"' : ""}>${TABLE_PLAIN.has(head[j]) || /^[@:]/.test(head[j]) ? esc(c) : formatTagValue(head[j], c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>";
  box.firstChild.appendChild(button("Download CSV", () => downloadText(tableCSV(t), "text/csv", "bypass-table.csv"), "All rows, for a spreadsheet"));
}

// ---- drawing (ui-map.js toGeoJSON), popups, JOSM
let lastEls = [];
const OSM_TYPES = { node: "n", way: "w", relation: "r" };
// ---- map apps on phones and tablets: CoMaps' documented web links (comaps.at/api) and geo: URIs (RFC 5870)
const COMAPS_MAX_POINTS = 100;            // one link; past this a GPX or KML file is the better way
const ANDROID = /Android/i.test(navigator.userAgent);     // iOS doesn't open geo: links
/** One point for an element: its own, its centre, or the middle of its bounds or first vertex. */
function pointOf(e) {
  if (e.lat !== undefined) return [e.lat, e.lon];
  if (e.center) return [e.center.lat, e.center.lon];
  if (e.bounds) return [(e.bounds.minlat + e.bounds.maxlat) / 2, (e.bounds.minlon + e.bounds.maxlon) / 2];
  const g = Array.isArray(e.geometry) ? e.geometry.find(Boolean) : null;
  if (g) return [g.lat, g.lon];
  if (e.geometry?.type === "Point") return [e.geometry.coordinates[1], e.geometry.coordinates[0]];
  return null;
}
const pointName = (e) => e.tags?.name || `${e.type} ${e.id ?? ""}`.trim();
/** CoMaps' link for named points: https://comaps.at/map?v=1&ll=lat,lon&n=name… (opens the app if installed). */
function comapsLink(els) {
  let url = "https://comaps.at/map?v=1";
  for (const e of els) { const p = pointOf(e); if (p) url += `&ll=${p[0].toFixed(6)},${p[1].toFixed(6)}&n=${encodeURIComponent(pointName(e))}`; }
  return url;
}
function geoLink(e) {
  const p = pointOf(e);
  return p && `geo:${p[0].toFixed(6)},${p[1].toFixed(6)}?q=${p[0].toFixed(6)},${p[1].toFixed(6)}(${encodeURIComponent(pointName(e))})`;
}
// ---- tag values as links, as openstreetmap.org shows them (openstreetmap-website app/helpers/browse_tags_helper.rb):
// Wikipedia, Wikidata, Wikimedia Commons, email, phone, a colour swatch, then tag2link's URL for the key
// (data/tag2link.json, built by tools-tag2link.mjs). Each ;-separated part is linked on its own; text only.
let TAG2LINK = {};
fetch("data/tag2link.json").then(r => r.json()).then(d => { TAG2LINK = d; }).catch(() => { /* links from rules only */ });
const QID = /^Q[1-9]\d*$/i, PHONE = /^\+[\d\s()/.-]{6,25}$/, EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/, WEBSITE_KEY = /(^|:)(website|url)$/;
const urlPart = (v) => encodeURIComponent(v).replace(/%2F/g, "/").replace(/%3A/g, ":");
const extLink = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(text)}</a>`;
/** The link for one part of a tag value, or null. */
function tagPartHref(k, t) {
  const wp = /(^|:)wikipedia(:([a-z-]+))?$/.exec(k);
  if (wp) {
    const m = /^([a-z-]{2,12}):(.+)$/.exec(t), lang = m ? m[1] : wp[3], title = m ? m[2] : t;
    if (!lang) return null;
    const [page, section] = title.split("#");
    return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.trim().replace(/ /g, "_"))}${section ? "#" + encodeURIComponent(section.replace(/ /g, "_")) : ""}`;
  }
  if (/(^|:)wikidata$/.test(k)) return QID.test(t) ? `https://www.wikidata.org/wiki/${t.toUpperCase()}` : null;
  if (/(^|:)wikimedia_commons$/.test(k)) return /^(file|category):/i.test(t) ? `https://commons.wikimedia.org/wiki/${urlPart(t.split("#")[0].replace(/ /g, "_"))}` : null;
  if ((k === "email" || k === "contact:email") && EMAIL.test(t)) return "mailto:" + t;
  if (PHONE.test(t)) return "tel:" + t.replace(/\s/g, "");
  if (WEBSITE_KEY.test(k) && BARE_DOMAIN.test(t)) return "https://" + t;
  const tpl = TAG2LINK[k];
  return tpl && !/^https?:/i.test(t) ? tpl.replace("$1", urlPart(t.replace(/^#/, ""))) : null;
}
/** A tag value as HTML: escaped text, with links where the value names a page elsewhere. */
function formatTagValue(k, v) {
  v = String(v ?? "");
  if (/^https?:\/\/\S+$/i.test(v)) return extLink(v, v);
  if (/(^|:)colour$/.test(k) && /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/i.test(v) && CSS.supports("color", v))
    return `<span class="swatch" style="background:${esc(v)}"></span>${esc(v)}`;
  return v.split(";").map(part => {
    const t = part.trim(), href = t && tagPartHref(k, t);
    return href ? esc(part.slice(0, part.indexOf(t))) + extLink(href, t) + esc(part.slice(part.indexOf(t) + t.length)) : esc(part);
  }).join(";");
}
// ---- "Similar": the clicked result's main tag, searched in the map view
const MAIN_KEYS = ["amenity", "shop", "tourism", "leisure", "craft", "office", "healthcare", "emergency", "historic",
  "man_made", "public_transport", "railway", "highway", "aeroway", "power", "natural", "landuse", "building", "sport",
  "barrier", "place", "boundary", "route", "waterway"];
function similarTag(e) { const k = MAIN_KEYS.find(k => e.tags?.[k] && e.tags[k] !== "yes" || (k === "building" && e.tags?.[k])); return k ? [k, e.tags[k]] : null; }
document.addEventListener("click", ev => {
  const b = ev.target.closest?.("[data-similar]");
  if (!b) return;
  const [k, v] = JSON.parse(b.dataset.similar);
  cm.setValue(`// like the one you clicked: ${k}=${v} in the map view\n[out:json];\nnwr[${JSON.stringify(k)}=${JSON.stringify(v)}]({{bbox}});\nout center;`);
  run();
});
function popupItem(e) {
  const typ = e.type, id = e.id, osm = OSM_TYPES[typ] && id;
  const title = osm ? `<a href="https://www.openstreetmap.org/${typ}/${id}" target="_blank" rel="noopener">${typ} ${id}</a>` : `${esc(typ)} ${esc(id ?? "")}`;
  const rows = Object.entries(e.tags || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${formatTagValue(k, v)}</td></tr>`).join("");
  const geo = TOUCH && ANDROID ? geoLink(e) : null, here = TOUCH && pointOf(e);
  const appLinks = (geo ? `<a href="${esc(geo)}" title="Opens the place in a map app of your choice">Open in…</a>` : "") +
    (here ? `<a href="${esc(comapsLink([e]))}" target="_blank" rel="noopener">CoMaps</a>` : "");
  const main = similarTag(e);
  const similar = main ? `<button data-similar="${esc(JSON.stringify(main))}" title="Find ${esc(main[0])}=${esc(main[1])} in the map view">Similar</button>` : "";
  const acts = osm || appLinks || similar ? `<div class="acts">` +
    (osm ? `<a href="https://www.openstreetmap.org/edit?editor=id&${typ}=${id}" target="_blank" rel="noopener">Edit in iD</a>` : "") +
    (osm && !TOUCH ? `<button data-josm="${OSM_TYPES[typ]}${Number(id)}" title="Loads the current version from the OSM API into JOSM (Remote control must be on)">Load in JOSM</button>` : "") +
    appLinks + similar + "</div>" : "";
  return `<strong>${title}</strong>${rows ? "<table>" + rows + "</table>" : ""}` +
    (outsideCoverage(e) ? '<p class="muted">Outside the area with complete data.</p>' : "") + acts;
}
function popup(items) {
  const shown = items.slice(0, 3).map(i => popupItem(lastEls[i])).join("<hr>");
  return shown + (items.length > 3 ? `<p class="muted">and ${items.length - 3} more here</p>` : "");
}
const JOSM = "http://127.0.0.1:8111";
const JOSM_TYPES = { n: "node", w: "way", r: "relation" };
const JOSM_MARGIN = 0.0005;            // degrees around a single point, so JOSM zooms to a street, not one node
/** The [s, w, n, e] around the coordinates of some elements (nodes, centres, bounds, geometry). */
function elementsBBox(els) {
  let s = 90, w = 180, n = -90, e = -180;
  const add = (lat, lon) => { if (lat == null || lon == null) return; s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon); };
  for (const x of els) {
    add(x.lat, x.lon);
    if (x.center) add(x.center.lat, x.center.lon);
    if (x.bounds) { add(x.bounds.minlat, x.bounds.minlon); add(x.bounds.maxlat, x.bounds.maxlon); }
    for (const p of x.geometry && Array.isArray(x.geometry) ? x.geometry : []) if (p) add(p.lat, p.lon);
    for (const m of x.members || []) for (const p of m.geometry || []) if (p) add(p.lat, p.lon);
  }
  return s <= n ? [s - JOSM_MARGIN, w - JOSM_MARGIN, n + JOSM_MARGIN, e + JOSM_MARGIN] : null;
}
// Safari blocks an HTTPS page's fetch to http://127.0.0.1 as mixed content, without asking, but lets a click open
// that address in a new tab (both checked 2026-11-14). Chrome and Firefox allow the fetch once the user allows
// local network access. A page served over http (Bypass Server, a local copy) can fetch in every browser.
const SAFARI = /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent);
const JOSM_BY_TAB = SAFARI && location.protocol === "https:";
const JOSM_TAB = "bypass-josm";         // one tab reused for JOSM's answers, so repeated loads don't pile up tabs
// The zoom follows the load in that tab after this delay; without JOSM's answer the page can't tell when the
// download is done, so if it takes longer the view still moves but the selection misses objects not yet loaded
const JOSM_TAB_ZOOM_DELAY_MS = 3000;
async function josmCall(path) {
  const r = await fetch(JOSM + path);                     // JOSM sends Access-Control-Allow-Origin: *, so its answer is readable
  const text = (await r.text()).trim();
  if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
  return text;
}
/** The remote control paths: load_object (current versions from the OSM API) and, with coordinates, zoom. */
function josmPaths(ids, els) {
  const load = "/load_object?new_layer=false&relation_members=true&objects=" + ids.join(",");
  const bb = elementsBBox(els || lastEls.filter(e => ids.includes(OSM_TYPES[e.type] + e.id)));
  const select = ids.map(i => JOSM_TYPES[i[0]] + i.slice(1)).join(",");
  const zoom = bb && `/zoom?left=${bb[1]}&right=${bb[3]}&bottom=${bb[0]}&top=${bb[2]}&select=${select}`;
  return { load, zoom };
}
/** Safari on HTTPS: opens the paths in a tab. Must run before any await, while the click still counts. */
function josmLoadByTab({ load, zoom }, n) {
  const tab = window.open(JOSM + load, JOSM_TAB);
  if (!tab) { setStatus("Safari blocked the tab for JOSM. Allow pop-ups for this site and try again.", "err"); return; }
  if (zoom) setTimeout(() => { try { tab.location.href = JOSM + zoom; } catch (e) { /* tab closed: the objects are loaded anyway */ } }, JOSM_TAB_ZOOM_DELAY_MS);
  setStatus(`Sent ${n} object${n === 1 ? "" : "s"} to JOSM. JOSM's answer is in the new tab: OK means they're loading from the OSM API. If Safari can't connect, start JOSM and turn on Remote control (Preferences → Remote Control).`, "ok");
}
/**
 * JOSM's remote control: load_object downloads the current versions from the OSM API, ready to edit; then
 * zoom moves JOSM's view there and selects them (load_object alone leaves the view where it was).
 */
async function josmLoad(ids, els) {
  if (!ids.length) { setStatus("No OSM objects in this result to load.", "err"); return; }
  if (ids.length > JOSM_LIMIT) { setStatus(`${ids.length.toLocaleString()} objects is a lot for JOSM's remote control; narrow the query to ${JOSM_LIMIT.toLocaleString()} or fewer.`, "err"); return; }
  const paths = josmPaths(ids, els);
  if (JOSM_BY_TAB) { josmLoadByTab(paths, ids.length); return; }
  setStatus(`Sending ${ids.length} object${ids.length === 1 ? "" : "s"} to JOSM…`);
  try {
    await josmCall(paths.load);
    if (paths.zoom) await josmCall(paths.zoom);
    setStatus(`JOSM loaded ${ids.length} object${ids.length === 1 ? "" : "s"} from the OSM API${paths.zoom ? " and zoomed to them" : ""}.`, "ok");
  } catch (e) {
    // a TypeError is all a page gets both when JOSM isn't running and when the browser's local network access
    // permission was declined, so the message covers both
    setStatus(e instanceof TypeError ? "JOSM isn't answering. Start it and turn on Remote control (Preferences → Remote Control). If it's already running, your browser may be blocking this page from reaching it: allow local network access for this site and try again."
                                     : "JOSM refused: " + e.message, "err");
  }
}
// popups are HTML strings (ui-map.js setHTML), so their JOSM buttons are handled here: no inline handlers under the CSP
document.addEventListener("click", ev => { const b = ev.target.closest?.("[data-josm]"); if (b) josmLoad([b.dataset.josm]); });
const FM_IGNORED = ["server", "type", "controls", "transform", "querySources"];
/** Draws the results; `fit: false` (re-runs on pan) leaves the map where the user moved it. */
function draw(els, config, { fit = true } = {}) {
  lastEls = els;
  const { fc, count, skipped } = toGeoJSON(els, { dim: e => outsideCoverage(e) === true,
    showUntagged: document.getElementById("untagged").checked, max: MAP_LIMIT });
  rmap.setResults(fc, config, popup, { rerun: !fit });
  if (fit && count && document.getElementById("fit").checked) rmap.fitResults();
  return { count, skipped };
}
function downloadText(text, type, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export { cleanGeoJSON, COMAPS_MAX_POINTS, comapsLink, downloadText, draw, FM_IGNORED, josmLoad, last, osmIds,
  pointOf, RESULT_EXT, setLast, showData, showTable, tableCSV, tableOf };
