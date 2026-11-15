// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/share.js: Share links (Turbo's Q, C and R, in the fragment) and the Export dialogue.
// An ES module, loaded through app/main.js; it imports what it uses from the other modules and ui-map.js.
import { $, flash, setStatus } from "./core.js";
import { cm, TOUCH } from "./editor.js";
import { info, rmap } from "./map.js";
import { run } from "./run.js";
import { cleanGeoJSON, COMAPS_MAX_POINTS, comapsLink, downloadText, josmLoad, last, osmIds, pointOf, RESULT_EXT,
  tableCSV, tableOf } from "./results.js";
import { splitFrontMatter } from "../ui-map.js";

// ---- share links: Overpass Turbo's parameters, #Q=<query>&C=<lat>;<lon>;<zoom>[&R] (R: run at once), but in
// the fragment, which browsers never send to the server: the host's logs don't get the query or the place
function shareLink() {
  const v = rmap.view(), u = new URL(location.href.split(/[?#]/)[0]), p = new URLSearchParams();
  p.set("Q", cm.getValue());
  if (v) p.set("C", `${v.center[0].toFixed(5)};${v.center[1].toFixed(5)};${Math.round(v.zoom)}`);
  u.hash = p.toString();
  return u.toString();
}
let runOnOpen = false, linkView = false, linkHold = null;
/** Whether a link asked to run on opening; only the first caller gets true (areas.js and start.js ask). */
function takeRunOnOpen() { const r = runOnOpen; runOnOpen = false; return r; }
/** The hosts a query's front matter would make the browser contact (styles, sources, icons); [] if none. */
function frontMatterHosts(text) {
  let config = null;
  try { config = splitFrontMatter(text).config; } catch (e) { return []; }
  const urls = config ? JSON.stringify(config).match(/\b(?:https?|data):[^"\s]+/gi) || [] : [];
  return [...new Set(urls.map(u => { if (/^data:/i.test(u)) return "an address inside the query (data:)"; try { return new URL(u).host; } catch (e) { return u.slice(0, 40); } }))];
}
/** Takes a link's query and view from the fragment, then clears it (a reload doesn't bring the link back). */
const LINK_NEEDS_AREA = "This link runs a query on the map view's area. Click Load this area first: the query runs once the download is done.";
function readLink() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (!q.has("Q") && !q.has("C")) return false;
  if (q.has("Q")) cm.setValue(q.get("Q"));
  if (q.has("C")) { const [la, lo, z] = q.get("C").split(";").map(Number); if (isFinite(la) && isFinite(lo)) rmap.setView(la, lo, isFinite(z) ? z : 14); }
  runOnOpen = q.has("R"); linkView = q.has("C"); linkHold = null;
  const hosts = q.has("Q") ? frontMatterHosts(q.get("Q")) : [];
  if (runOnOpen && hosts.length) {                  // a link doesn't get to make this browser contact other sites unasked
    runOnOpen = false;
    linkHold = `This shared query's front matter loads files from ${hosts.join(", ")}. Read it, then press Run if that's fine.`;
  }
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}
// start.js reads the link once every module has loaded (readLink sets the editor and the map)
// A link opened in a tab already on this page changes only the fragment: no reload, so read it here
window.addEventListener("hashchange", () => {
  if (!readLink()) return;
  if (runOnOpen && info) { runOnOpen = false; run(); }
  else if (runOnOpen) setStatus(LINK_NEEDS_AREA);
  else if (linkHold) setStatus(linkHold);
});
async function copyShareLink(ev) {
  const link = shareLink();
  if (TOUCH && navigator.share) {                   // phones: the system's share sheet (messages, mail, copy)
    try { await navigator.share({ title: "Overpass query", url: link }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(link); flash(ev?.currentTarget, "Copied"); setStatus("Copied a link to this query and view. It opens in this page, in whoever's browser, with their own saved areas.", "ok"); }
  catch (e) { prompt("Link to this query and view:", link); }
}
document.getElementById("share").onclick = copyShareLink;

// ---- the Export dialogue, laid out like Overpass Turbo's (export.js does the GPX and KML)
const exportov = $("exportov");
/**
 * Phones: the share sheet, so the file goes straight to CoMaps, Organic Maps or OsmAnd (which open GPX and KML).
 * Browsers that can't share this kind of file download it, and tapping the download offers the same apps.
 */
async function shareOrDownload(text, type, name) {
  const file = new File([text], name, { type });
  if (TOUCH && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  downloadText(text, type, name);
}
function openExport() {
  if (!last) { setStatus("Run a query first: Export saves its result.", "err"); return; }
  const n = last.elements.length, ids = osmIds(last.elements).length;
  $("ex-sub").textContent = `${n.toLocaleString()} element${n === 1 ? "" : "s"} from the last run (${ids.toLocaleString()} OSM object${ids === 1 ? "" : "s"}).`;
  $("ex-raw").textContent = "Raw data (" + ({ json: "JSON", xml: "OSM XML", csv: "CSV" }[last.format] || last.format) + ")";
  $("ex-josm").disabled = !ids;
  const pts = last.elements.filter(pointOf).length;
  $("ex-comaps").disabled = !pts || pts > COMAPS_MAX_POINTS;
  $("ex-comaps-note").textContent = !pts ? "no results with a location" : pts > COMAPS_MAX_POINTS
    ? `${pts.toLocaleString()} points is too many for one link: share a GPX or KML file and open it in CoMaps instead`
    : `the ${pts} result${pts === 1 ? "" : "s"} as named points, in the CoMaps app (or on comaps.at)`;
  for (const [id, type] of [["ex-gpx", "application/gpx+xml"], ["ex-kml", "application/vnd.google-earth.kml+xml"]]) {
    const canShare = TOUCH && navigator.canShare?.({ files: [new File(["x"], "test." + id.slice(3), { type })] });   // some browsers share only images and text
    $(id).textContent = (canShare ? "Share " : "") + id.slice(3).toUpperCase();
  }
  exportov.hidden = false;
}
const EXPORTS = {
  "ex-geojson": () => downloadText(JSON.stringify(cleanGeoJSON(last.elements)), "application/geo+json", "bypass-export.geojson"),
  "ex-gpx": () => shareOrDownload(toGPX(cleanGeoJSON(last.elements)), "application/gpx+xml", "bypass-export.gpx"),
  "ex-kml": () => shareOrDownload(toKML(cleanGeoJSON(last.elements)), "application/vnd.google-earth.kml+xml", "bypass-export.kml"),
  "ex-comaps": () => window.open(comapsLink(last.elements.filter(pointOf)), "_blank", "noopener"),
  "ex-raw": () => downloadText(last.body, last.contentType, "bypass-export." + (RESULT_EXT[last.format] ?? "txt")),
  "ex-csv": () => downloadText(tableCSV(tableOf(last)), "text/csv", "bypass-export.csv"),
  "ex-josm": () => josmLoad(osmIds(last.elements), last.elements),
  "ex-query": async () => {
    try { await navigator.clipboard.writeText(cm.getValue()); setStatus("Copied the query.", "ok"); } catch (e) { setStatus("Couldn't copy: " + e.message, "err"); }
  },
  "ex-link": copyShareLink,
};
for (const [id, fn] of Object.entries(EXPORTS)) $(id).onclick = () => { fn(); if (id !== "ex-josm") exportov.hidden = true; };
$("exportbtn").onclick = openExport;
$("ex-close").onclick = () => { exportov.hidden = true; };
exportov.addEventListener("click", ev => { if (ev.target === exportov) exportov.hidden = true; });
document.addEventListener("keydown", ev => { if (ev.key === "Escape") exportov.hidden = true; });

export { LINK_NEEDS_AREA, linkHold, linkView, readLink, runOnOpen, takeRunOnOpen };
