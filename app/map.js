// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/map.js: The map (ui-map.js), the tabs, the open saved area in the header and on the map, and the other saved areas (outlines, the switch banner).
// An ES module, loaded through app/main.js; it imports what it uses from the other modules and ui-map.js.
import { call, esc, fmtBytes, fmtDate, fmtDay, LS, srcLabel } from "./core.js";
import { cm, fillExamples } from "./editor.js";
import { dl, openLibrary } from "./areas.js";
import { addNote, running } from "./run.js";
import { BASEMAPS, DEFAULT_BASEMAP, ResultMap } from "../ui-map.js";

// ---- map (ui-map.js: MapLibre with a vector basemap)
function savedView() {
  try { const v = JSON.parse(LS.get("view", "")); return v && v.z >= 3 ? v : null; } catch (e) { return null; }
}
const sv = savedView();
const rmap = new ResultMap(document.getElementById("map"), {
  basemap: LS.get("basemap", DEFAULT_BASEMAP), center: sv ? [sv.lat, sv.lng] : [55.9533, -3.1883], zoom: sv ? sv.z : 14,
  onError: (m) => { if (!/Failed to fetch|AbortError/.test(m)) console.warn("map:", m); },
  onStyleError: (m) => addNote(m),
  onAreaClick: (id, name) => { if (!running && dl.ov.hidden) openLibrary(id, name); },
  // a query's front matter style replaces the basemap: no menu while it does (the saved choice stays for later)
  onStyleSource: (fromQuery) => { document.getElementById("basemap").hidden = fromQuery; },
});
{
  const bm = document.getElementById("basemap");
  for (const [k, b] of Object.entries(BASEMAPS)) { const o = document.createElement("option"); o.value = k; o.textContent = b.label; bm.appendChild(o); }
  bm.value = rmap.basemapName;
  bm.onchange = () => { rmap.setBasemap(bm.value); LS.set("basemap", bm.value); };
}
rmap.on("moveend", () => { const v = rmap.view(); if (v) LS.set("view", JSON.stringify({ lat: v.center[0], lng: v.center[1], z: v.zoom })); });

// ---- the line between the query and the map: drag it, or focus it and use the arrow keys, to resize them.
// Side by side it moves left and right; on upright tablets (the query above the map) up and down; phones have
// tabs instead. The sizes are % of the page (CSS variables), so they follow the window, and are remembered.
const SPLIT_MIN_PX = 280;                // neither side smaller: the toolbar stays usable, the map keeps its controls
const SPLIT_KEY_STEP = 2;                // % per arrow key
const SPLIT_VAR = { cols: "--left-w", rows: "--top-h" };
const mainEl = document.querySelector("main"), split = document.getElementById("split");
/** "cols" (side by side), "rows" (one above the other), or null (phones: no line). */
function splitMode() {
  const cs = getComputedStyle(mainEl);
  if (cs.display !== "grid") return null;
  return cs.gridTemplateColumns.trim().split(/\s+/).length > 1 ? "cols" : "rows";
}
/** The query's share of the page in %, kept SPLIT_MIN_PX from either edge. */
function setSplit(mode, pct) {
  const r = mainEl.getBoundingClientRect(), size = mode === "cols" ? r.width : r.height;
  const min = Math.min(50, SPLIT_MIN_PX / size * 100);
  pct = Math.max(min, Math.min(100 - min, pct));
  mainEl.style.setProperty(SPLIT_VAR[mode], pct.toFixed(1) + "%");
  split.setAttribute("aria-valuenow", Math.round(pct));
  return pct;
}
// MapLibre follows its container only every 50 ms (its ResizeObserver is throttled): in between, a dragged map
// keeps its old canvas size, so it shifts or shows a strip of background, then jumps. Resizing and redrawing it
// (what MapLibre's own handler does) once per animation frame keeps it in step.
let mapFitFrame = 0;
function fitMapSoon() {
  if (!mapFitFrame) mapFitFrame = requestAnimationFrame(() => { mapFitFrame = 0; rmap.map.resize(); rmap.map.redraw(); });
}
function splitPct(mode) {
  const l = document.getElementById("left").getBoundingClientRect(), r = mainEl.getBoundingClientRect();
  return mode === "cols" ? l.width / r.width * 100 : l.height / r.height * 100;
}
for (const mode of Object.keys(SPLIT_VAR)) {
  const v = parseFloat(LS.get("split-" + mode, ""));
  if (isFinite(v)) mainEl.style.setProperty(SPLIT_VAR[mode], v + "%");
}
split.addEventListener("pointerdown", ev => {
  const mode = splitMode();
  if (!mode || ev.button !== 0) return;
  ev.preventDefault();
  split.setPointerCapture(ev.pointerId);
  split.classList.add("drag"); document.body.dataset.splitting = mode;
  let pct = splitPct(mode);
  const move = (e) => {
    const r = mainEl.getBoundingClientRect();
    pct = setSplit(mode, mode === "cols" ? (e.clientX - r.left) / r.width * 100 : (e.clientY - r.top) / r.height * 100);
    fitMapSoon();
  };
  const end = () => {
    split.removeEventListener("pointermove", move); split.removeEventListener("pointerup", end); split.removeEventListener("pointercancel", end);
    split.classList.remove("drag"); delete document.body.dataset.splitting;
    LS.set("split-" + mode, pct.toFixed(1));
  };
  split.addEventListener("pointermove", move);
  split.addEventListener("pointerup", end);
  split.addEventListener("pointercancel", end);
});
split.addEventListener("dblclick", () => {        // back to the stylesheet's sizes
  const mode = splitMode();
  if (!mode) return;
  mainEl.style.removeProperty(SPLIT_VAR[mode]); LS.set("split-" + mode, "");
  fitMapSoon();
});
split.addEventListener("keydown", ev => {
  const mode = splitMode(), keys = mode === "cols" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const k = keys.indexOf(ev.key);
  if (!mode || k < 0) return;
  ev.preventDefault();
  LS.set("split-" + mode, setSplit(mode, splitPct(mode) + (k ? 1 : -1) * SPLIT_KEY_STEP).toFixed(1));
  fitMapSoon();
});
/** For screen readers: the line runs up and down (vertical) side by side, across (horizontal) one above the other. */
function splitOrientation() {
  const mode = splitMode();
  if (mode) split.setAttribute("aria-orientation", mode === "rows" ? "horizontal" : "vertical");
}
splitOrientation();
addEventListener("resize", splitOrientation);

// ---- tabs
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.v));
function showTab(v) {
  document.body.dataset.view = v;                  // narrow screens show the query (Query) or the results, not both
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("active", x.dataset.v === v));
  document.querySelectorAll(".view").forEach(x => x.classList.toggle("active", x.id === "v-" + v));
  if (v === "map") setTimeout(() => rmap.map.resize(), 0);
  if (v === "query") setTimeout(() => cm.refresh?.(), 0);   // CodeMirror measured its gutter while hidden: numbers overlapped the text
}

// ---- the open saved area
let info = null;
function showInfo(i) {
  info = i;
  const bits = [], meta = document.getElementById("meta");
  if (!i) bits.push("<strong>No saved area yet</strong>", "pan the map to your area and click Load this area");
  else {
    bits.push(`<strong>${esc(i.name)}</strong>`);
    if (!i.tiles) bits.push("empty: pan to an area and click Load this area");
    else {
      const day = fmtDay(i.timestamp);
      if (day) bits.push("data as of " + esc(day));
      bits.push(`${i.tiles} tiles`);
    }
  }
  meta.innerHTML = bits.join(" · ");
  meta.title = i ? `From ${srcLabel(i.source)}` + (i.tiles ? `, revision ${i.revision} (${fmtDate(i.timestamp)}): ` +
    `${i.tiles} tiles, ${fmtBytes(i.bytes)}, ${i.features.toLocaleString()} features` : "") : "";
  fillExamples();
  document.title = i ? `${i.name} · Bypass Web` : "Bypass Web";
  covCells = new Set(i ? i.coverage.cells : []);
  // Where the saved tiles hold complete data: outlined; the map outside it is shaded.
  rmap.setCoverage(i ? i.coverage.rings : null, i ? i.coverage.shade : null);
  if (i) rememberExtent(i.id, coverageBounds());
  refreshOtherAreas();
}

// ---- the other saved areas: drawn on the map, and offered when the map centre moves into one
let otherAreas = [];                     // [{ id, name, boxes: [[w, s, e, n]] }]
let dismissedArea = null;                // the area whose offer was closed with ×: not offered again until another is
/** An area's outline for when it isn't open: its downloaded boxes, or (imported areas have none) its extent
 *  as last seen open. Extents are kept per area in localStorage. */
function rememberExtent(id, bounds) {
  if (!bounds) return;
  const [s, w, n, e] = bounds, all = JSON.parse(LS.get("extents", "{}") || "{}");
  all[id] = [w, s, e, n]; LS.set("extents", JSON.stringify(all));
}
async function refreshOtherAreas() {
  let libs = [];
  try { libs = (await call("libraries")).libraries; } catch (e) { return; }
  const extents = JSON.parse(LS.get("extents", "{}") || "{}");
  otherAreas = libs.filter(f => !f.broken && f.id !== info?.id)
    .map(f => ({ id: f.id, name: f.name, boxes: f.boxes?.length ? f.boxes : extents[f.id] ? [extents[f.id]] : [] }))
    .filter(a => a.boxes.length);
  rmap.setOtherAreas(otherAreas);
  offerOtherArea();
}
/**
 * When the open area is out of view and another saved area is in it, a banner at the top of the map offers that
 * one (the one covering most of the view). Clicking an area's outline or name opens it directly.
 */
function offerOtherArea() {
  const banner = document.getElementById("area-offer"), v = rmap.view();
  if (!v) return;
  const [s, w, n, e] = v.bbox, cb = info ? coverageBounds() : null;
  const openInView = cb && !(cb[3] < w || cb[1] > e || cb[2] < s || cb[0] > n);
  let best = null, bestOverlap = 0;
  for (const a of otherAreas) for (const [bw, bs, be, bn] of a.boxes) {
    const ow = Math.min(e, be) - Math.max(w, bw), oh = Math.min(n, bn) - Math.max(s, bs);
    if (ow > 0 && oh > 0 && ow * oh > bestOverlap) { best = a; bestOverlap = ow * oh; }
  }
  if (!best || openInView || running || !dl.ov.hidden || best.id === dismissedArea) { banner.hidden = true; return; }
  banner.querySelector("span").textContent = `${best.name} is saved here.`;
  banner.querySelector(".open").textContent = `Open ${best.name}`;
  banner.querySelector(".open").onclick = () => { banner.hidden = true; openLibrary(best.id, best.name); };
  banner.querySelector(".close").onclick = () => { banner.hidden = true; dismissedArea = best.id; };
  banner.hidden = false;
}
rmap.on("moveend", offerOtherArea);
// complete-data cells on the finest tile grid (zoom info.coverage.z), as "col,row"
let covCells = new Set();
function inCoverage(lat, lon) {
  if (!info) return false;
  const n = 2 ** info.coverage.z, la = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
  const c = Math.floor((lon + 180) / 360 * n), r = Math.floor((1 - Math.asinh(Math.tan(la)) / Math.PI) / 2 * n);
  return covCells.has(c + "," + r);
}
/** [s, w, n, e] of the complete-data area, or null. */
function coverageBounds() {
  if (!info || !info.coverage.rings.length) return null;
  let s = 90, w = 180, n = -90, e = -180;
  for (const ring of info.coverage.rings) for (const [la, lo] of ring) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  return s <= n ? [s, w, n, e] : null;
}
/** Whether the whole view has complete data (sampled on a 7 × 7 grid). */
function viewCovered(bbox) {
  if (!info) return false;
  const [s, w, n, e] = bbox;
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++)
    if (!inCoverage(s + (n - s) * i / 6, w + (e - w) * j / 6)) return false;
  return true;
}
/** Every [lat, lon] in GeoJSON coordinates, however deeply nested (the geometry of make/convert output). */
function geoJSONPoints(c, pts) {
  if (typeof c[0] === "number") pts.push([c[1], c[0]]);
  else for (const x of c) geoJSONPoints(x, pts);
}
/** Whether an element lies outside the complete area (null: no coordinates to tell). */
function outsideCoverage(e) {
  const pts = [];
  if (e.lat !== undefined) pts.push([e.lat, e.lon]);
  if (e.center) pts.push([e.center.lat, e.center.lon]);
  if (e.bounds) pts.push([(e.bounds.minlat + e.bounds.maxlat) / 2, (e.bounds.minlon + e.bounds.maxlon) / 2]);
  if (Array.isArray(e.geometry)) { for (const p of e.geometry) if (p && p.lat !== undefined) pts.push([p.lat, p.lon]); }
  else if (e.geometry?.coordinates) geoJSONPoints(e.geometry.coordinates, pts);   // make/convert with ::geom
  else if (e.geometry?.geometries) for (const g of e.geometry.geometries) if (g.coordinates) geoJSONPoints(g.coordinates, pts);
  for (const m of e.members || []) {
    if (m.lat !== undefined) pts.push([m.lat, m.lon]);
    for (const p of m.geometry || []) if (p) pts.push([p.lat, p.lon]);
  }
  if (!pts.length) return null;
  return !pts.some(([la, lo]) => inCoverage(la, lo));
}

export { coverageBounds, inCoverage, info, outsideCoverage, refreshOtherAreas, rmap, savedView, showInfo, showTab,
  viewCovered };
