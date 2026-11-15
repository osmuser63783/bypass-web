// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/run.js: Running a query: Run/Stop, the busy indicator, errors and notes.
// An ES module, loaded through app/main.js; it imports what it uses from the other modules and ui-map.js.
import { button, call, esc, LS, restartWorker, setStatus } from "./core.js";
import { cm, queryLoads } from "./editor.js";
import { coverageBounds, inCoverage, info, outsideCoverage, rmap, showTab, viewCovered } from "./map.js";
import { loadArea, nearOpenArea, openLibrary } from "./areas.js";
import { draw, FM_IGNORED, last, setLast, showData, showTable } from "./results.js";
import { splitFrontMatter } from "../ui-map.js";

// ---- run
const runBtn = document.getElementById("run");
const RUN_BUSY_DELAY_MS = 250;           // quicker runs finish without an animation flashing up
const RUN_TICK_MS = 100;
let running = false, busyTimer = null;
// The front matter's view options (center, zoom, bounds, pitch, bearing) apply only when they're new: on the first
// Run of a query opened in the editor (an example, a saved query, a link) or after they were edited. Other Runs
// leave the map as the user set it. Overpass Ultra applies them only when the page loads.
let appliedOptions = null;               // the options last applied, as JSON, with the query load they came with
/** Applies the front matter's view options if they're new; returns a note saying so, or null. */
function applyNewOptions(options) {
  const key = queryLoads + " " + JSON.stringify(options ?? null);
  if (key === appliedOptions) return null;
  appliedOptions = key;
  if (!options || typeof options !== "object") return null;
  const set = ["center", "zoom", "bounds", "pitch", "bearing"].filter(k => k in options);
  if (!set.length) return null;
  rmap.applyOptions(options);
  return `Map ${set.join(", ")} set by the query's front matter (options): on the first Run and when you change ` +
    "them. After that, Run leaves the map where you put it.";
}
runBtn.onclick = () => showsStop() ? stopRun() : run();     // a quick re-run on pan shows Run: a click queues a Run
/** While a query runs, Run becomes Stop (a re-run on pan: only once it takes longer than RUN_BUSY_DELAY_MS). */
function setRunning(on) {
  running = on;
  runBtn.textContent = on ? "Stop" : "Run";
  runBtn.classList.toggle("primary", !on);
  runBtn.classList.toggle("stop", on);
  runBtn.title = on ? "Stop the query (the saved area is then reopened, which takes a few seconds)" : "Run (Ctrl/Cmd+Enter)";
  runBtn.disabled = false;
}
const showsStop = () => runBtn.classList.contains("stop");
/** The spinner, elapsed time and moving bar (and Stop, for a re-run on pan), once a run takes longer than RUN_BUSY_DELAY_MS. */
function showBusy(t0) {
  const tick = () => {
    if (!showsStop()) setRunning(true);
    const st = setStatus(`Running… ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const sp = document.createElement("span"); sp.className = "spinner"; st.prepend(sp);
    document.getElementById("busybar").hidden = false;
    busyTimer = setTimeout(tick, RUN_TICK_MS);
  };
  busyTimer = setTimeout(tick, RUN_BUSY_DELAY_MS);
}
function hideBusy() { clearTimeout(busyTimer); busyTimer = null; document.getElementById("busybar").hidden = true; }
function stopRun() { if (running) restartWorker(); }
document.addEventListener("keydown", ev => {      // Esc stops a running query (dialogues close on Esc instead)
  if (ev.key === "Escape" && showsStop() && !document.querySelector(".overlay:not([hidden])")) stopRun();
});        // the run's call fails with kind "stopped"
// {{bbox}}/{{center}} come from the last view the map had while visible (a hidden map has no size)
let lastView = null;
function noteView() {
  const v = rmap.view();
  if (v) lastView = { bbox: v.bbox, center: v.center };
}
rmap.on("moveend", noteView);
rmap.on("resize", noteView);

const BBOX_SHORTCUT = /\{\{\s*(bbox|wsen)\s*\}\}/, CENTER_SHORTCUT = /\{\{\s*center\s*\}\}/;
const NO_DATA_HERE = "There's no saved data for this map view yet. Download it, and the query runs once it's in.";
/** Whether Run opens Load this area first: no saved area open, or a query about the map view far from the open one. */
function needsArea(query, v) {
  if (!v.bbox) return false;                       // no view to offer (the map has never been shown)
  if (!info?.tiles) return true;
  return (BBOX_SHORTCUT.test(query) || CENTER_SHORTCUT.test(query)) && !nearOpenArea(v.bbox);
}
let runIsLive = false;                   // the run under way is a re-run on pan
let runAfter = false;                    // Run was asked for while a re-run on pan was under way

/**
 * Runs the editor's query, or with `live` (a view from liveView()) the last query run, again for that view:
 * a re-run on pan keeps the map where it is and the tab that's showing (unless it fails), and the front matter's
 * view options unused.
 */
async function run({ live = null } = {}) {
  if (running) { if (runIsLive && !live) runAfter = true; return; }
  const text = live ? lastRun.text : cm.getValue();
  let fm;
  try { fm = splitFrontMatter(text); } catch (e) { showError(e); return; }
  const optionsNote = live ? null : applyNewOptions(fm.config?.options);
  rmap.setBox("incomplete", null);
  noteView();
  const v = live || lastView || { bbox: null, center: null };
  const query = fm.query;
  if (!query.trim()) { setStatus("Write a query first, or pick one from Examples.", "err"); return; }
  if (!live && needsArea(query, v)) { loadArea(v.bbox, null, { lead: NO_DATA_HERE, runAfter: true }); return; }
  if (!live) lastRun = { text, bbox: BBOX_SHORTCUT.test(query), center: CENTER_SHORTCUT.test(query) };
  runIsLive = !!live;
  if (live) running = true;              // the button and status change only if it's slow (showBusy): no flashing on each pan
  else { setRunning(true); setStatus("Running…"); }
  const t0 = performance.now();
  showBusy(t0);
  let res;
  try { res = await call("run", { query, bbox: v.bbox, center: v.center }); }
  catch (e) {
    hideBusy(); setRunning(false);
    if (e.kind === "stopped") { runIsLive = runAfter = livePending = false; await reopenAfterStop((performance.now() - t0) / 1000); return; }
    showError(e); afterRun(); return;
  }
  hideBusy(); setRunning(false);
  const total = Math.round(performance.now() - t0);
  setLast(res);
  const notes = [...res.notes];
  if (optionsNote) notes.push(optionsNote);
  const usesView = lastRun.bbox || lastRun.center;
  const outside = usesView && v.bbox && !viewCovered(v.bbox);
  const n = res.elements.length;
  const drawn = draw(res.elements, fm.config, { fit: !live });
  const ignored = FM_IGNORED.filter(k => fm.config && k in fm.config);
  if (ignored.length) notes.push(`Front matter ${ignored.join(", ")}: not used here (the query runs in this tab, on the saved area).`);
  const nOut = res.elements.filter(e => outsideCoverage(e) === true).length;
  if (nOut) notes.unshift(`${nOut} of ${n} results lie outside the outlined area, where the saved data is complete. ` +
    "They're dimmed: they come from coarser tiles that reach further, and others nearby are missing. Load this area adds the rest.");
  else if (outside) notes.unshift("Part of the map view is outside the outlined area, where the saved data is complete: results there may be missing. Load this area adds it.");
  const st = setStatus(`${n.toLocaleString()} element${n === 1 ? "" : "s"}` + (nOut ? ` (${nOut.toLocaleString()} outside the complete area, dimmed)` : "") +
            ` · ${res.ms} ms in the engine (${total} ms in all)` +
            (drawn.skipped ? ` · ${drawn.skipped.toLocaleString()} not drawn (no coordinates, or over the map limit)` : "") +
            (live ? " · re-run for the map view" : ""), nOut ? "" : "ok");
  if ((outside || nOut) && info && info.canLoad) addLoadButton(st, v.bbox);
  showData(res); showTable(res); showNotes(notes, res.expanded);
  if (!live) {
    if (n && !drawn.count) showTab("table");
    else if (drawn.count) showTab("map");
  }
  afterRun();
}
/** After a run: what the page asked for meanwhile. A Run's own view counts as done, so zoom to data doesn't re-run it. */
function afterRun() {
  if (!runIsLive) liveDone = liveKey(liveView());
  runIsLive = false;
  if (runAfter) { runAfter = livePending = false; run(); }
  else if (livePending) { livePending = false; liveRun(); }
}

// ---- re-run on pan: when the map stops, the last query runs again for the view, limited to the saved area
const LIVE_DEBOUNCE_MS = 400;            // after the map stops: one run per pan or zoom, not one per animation frame
const liveBox = document.getElementById("live");
liveBox.checked = LS.get("live", "0") === "1";
liveBox.onchange = () => { LS.set("live", liveBox.checked ? "1" : "0"); if (liveBox.checked) liveRun(); };
let lastRun = null;                      // { text, bbox, center } of the last Run: the query, and the shortcuts it uses
let liveTimer = null, livePending = false;
let liveDone = null;                     // liveKey() of the view the shown results are for
rmap.on("moveend", () => { clearTimeout(liveTimer); liveTimer = setTimeout(liveRun, LIVE_DEBOUNCE_MS); });

/**
 * The view to re-run for: the map's box cut to the saved area's bounds, and its centre. Null when there's nothing
 * to run on: no saved area, the map hidden, no overlap, or (for {{center}} queries) the centre outside the area.
 */
function liveView() {
  const v = rmap.view(), cb = coverageBounds();
  if (!v || !cb) return null;
  const [s, w, n, e] = v.bbox;
  const bbox = [Math.max(s, cb[0]), Math.max(w, cb[1]), Math.min(n, cb[2]), Math.min(e, cb[3])];
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;
  if (lastRun?.center && !inCoverage(v.center[0], v.center[1])) return null;
  return { bbox, center: v.center };
}
/** What a re-run's answer depends on: only the parts of the view that the query uses. */
function liveKey(v) {
  if (!v || !lastRun) return null;
  return JSON.stringify([lastRun.bbox ? v.bbox : null, lastRun.center ? v.center : null]);
}
function liveRun() {
  if (!liveBox.checked || !lastRun || !(lastRun.bbox || lastRun.center)) return;
  if (running) { livePending = true; return; }
  const v = liveView(), key = liveKey(v);
  if (!v || key === liveDone) return;
  liveDone = key;
  run({ live: v });
}
/** After Stop: the new worker has nothing open, so the saved area is opened again. */
async function reopenAfterStop(seconds) {
  const stopped = `Stopped the query after ${seconds.toFixed(1)} s.`;
  if (!info) { setStatus(stopped); return; }
  await openLibrary(info.id, info.name);
  setStatus(stopped + " The saved area is open again.");
}
function addLoadButton(el, bbox) {
  const b = document.createElement("button"); b.textContent = "Load this area"; b.style.marginLeft = "6px";
  b.onclick = () => loadArea(bbox); el.appendChild(b);
}

const OUT_META = /\bout(\s+(?:\w+\s+)*)meta\b/;             // test with this; replace all with a global copy
/** An error in the status line and the Notes tab, which comes to the front (a re-run on pan's too: the results are gone). */
function showError(e) {
  rmap.clearResults();
  const prefix = e.kind === "unsupported" ? "" : e.kind === "syntax" ? "Syntax error: "
    : e.kind === "incomplete" ? "Incomplete data: " : "Error: ";
  const st = setStatus(prefix + e.message, "err");
  const box = document.getElementById("notes");
  box.innerHTML = `<div class="note err">${esc(prefix + e.message)}</div>`;
  if (e.kind === "incomplete" && e.extra?.bbox) {           // outline what to load, and offer it
    const [w, s, ea, n] = e.extra.bbox;
    rmap.setBox("incomplete", [s, w, n, ea]);
    if (info?.canLoad) { addLoadButton(st, [s, w, n, ea]); addLoadButton(box.firstChild, [s, w, n, ea]); }
  } else if (!info) addLoadButton(st, lastView?.bbox);
  const note = box.firstChild;
  if (e.kind === "unsupported" && OUT_META.test(cm.getValue()))      // JOSM-style queries: the tags and geometry still work
    note.appendChild(button("Use out body instead", () => { const kept = appliedOptions?.replace(/^\d+/, ""); cm.setValue(cm.getValue().replace(new RegExp(OUT_META.source, "g"), "out$1body")); if (kept) appliedOptions = queryLoads + kept; run(); },
                            "The same objects without version and user; Load in JOSM then fetches the current versions for editing"));
  if (e.kind === "unsupported")
    box.insertAdjacentHTML("beforeend", '<div class="note info">Bundles hold the current map only: no metadata ' +
      '(<code>out meta</code>, <code>user</code>, <code>uid</code>, <code>newer</code>, <code>changed</code>) and no history ' +
      '(<code>[date:]</code>, <code>[diff:]</code>, <code>[adiff:]</code>). Only the public Overpass servers answer those; ' +
      'they are shared and overloaded, so please send them only the queries that need it.</div>');
  badge(1);
  showTab("notes");
}

/** A note added after a run (e.g. the front matter's style failing to load once the results are drawn). */
function addNote(text) {
  const box = document.getElementById("notes");
  if ([...box.querySelectorAll(".note")].some(n => n.textContent === text)) return;
  if (box.querySelector(".empty")) box.innerHTML = "";
  box.insertAdjacentHTML("beforeend", `<div class="note">${esc(text)}</div>`);
  badge(box.querySelectorAll(".note").length);
}
function badge(n) { const b = document.getElementById("nbadge"); b.hidden = !n; b.textContent = n; }
function showNotes(notes, expanded) {
  const box = document.getElementById("notes");
  let h = "";
  for (const t of notes || []) h += `<div class="note">${esc(t)}</div>`;
  if (expanded) h += `<div class="note info">The query after Overpass Turbo shortcuts were expanded:<pre>${esc(expanded.replace(/^\s*\n/, ""))}</pre></div>`;
  box.innerHTML = h || '<div class="empty">No notes.</div>';
  badge((notes || []).length);
}

export { addNote, lastView, noteView, run, runBtn, running };
