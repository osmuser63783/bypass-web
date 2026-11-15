// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/areas.js: Saved areas: the progress dialogue, opening an area, Load this area (target, estimate, download), and the Saved areas dialogue.
// An ES module, loaded through app/main.js; it imports what it uses from the other modules and ui-map.js.
import { button, call, DEFAULT_SOURCE, esc, fmtBytes, fmtDate, LS, setStatus, shownUrl, srcLabel, withClient, worker } from "./core.js";
import { coverageBounds, info, refreshOtherAreas, rmap, showInfo } from "./map.js";
import { lastView, noteView, run, runBtn } from "./run.js";
import { takeRunOnOpen } from "./share.js";

// ---- progress dialogue (shared by download, opening and import)
const dl = { ov: document.getElementById("dl"), box: null };
function dlButtons(primary, secondary) {
  const p = document.getElementById("dl-primary"), q = document.getElementById("dl-secondary");
  p.hidden = !primary; if (primary) { p.textContent = primary.label; p.disabled = !!primary.disabled; p.onclick = primary.fn; }
  q.hidden = !secondary; if (secondary) { q.textContent = secondary.label; q.disabled = !!secondary.disabled; q.onclick = secondary.fn; }
}
function dlClose() {
  dl.ov.hidden = true;
  rmap.setBox("download", null);
}
function dlShow(title, sub) {
  document.getElementById("dl-title").textContent = title;
  document.getElementById("dl-sub").textContent = sub || "";
  document.getElementById("dl-body").innerHTML = "";
  document.getElementById("dl-prog").hidden = true;
  dl.ov.hidden = false;
}
function progressView(note) {
  document.getElementById("dl-prog").hidden = false;
  document.getElementById("pg-note").textContent = note || "";
  const bar = document.getElementById("pg-bar");
  bar.classList.add("indet"); bar.firstElementChild.style.width = "";
  document.getElementById("pg-left").textContent = "Starting…";
  document.getElementById("pg-right").textContent = "";
  return p => {
    const frac = p.totalBytes ? p.bytes / p.totalBytes : p.total ? p.done / p.total : null;
    bar.classList.toggle("indet", frac == null);
    bar.firstElementChild.style.width = frac == null ? "" : (100 * frac).toFixed(1) + "%";
    const parts = [`${p.done} of ${p.total} tile${p.total === 1 ? "" : "s"}`];
    if (p.totalBytes) parts.push(`${fmtBytes(p.bytes)} of ${fmtBytes(p.totalBytes)}`);
    document.getElementById("pg-left").textContent = parts.join(" · ");
    document.getElementById("pg-right").textContent = p.elapsed != null ? Math.round(p.elapsed) + " s" : "";
  };
}
function dlResult(title, html) {
  document.getElementById("dl-title").textContent = title;
  document.getElementById("dl-prog").hidden = true;
  document.getElementById("dl-body").innerHTML = html;
  dlButtons(null, { label: "Close", fn: dlClose });
}

// ---- opening a saved area (decodes its tiles into memory)
async function openLibrary(id, name) {
  dlShow("Opening " + name, "Decoding the saved tiles in this tab");
  dlButtons(null, null);
  const onp = progressView("");
  runBtn.disabled = true;
  LS.set("opening", id);              // cleared below; still set at the next start means this open never finished
  try {
    showInfo(await call("open", { id }, onp));
    LS.set("opening", "");
    runBtn.disabled = false;
    LS.set("library", id);
    dlClose();
    setStatus(`Opened ${info.name}: ${info.features.toLocaleString()} features in ${info.tiles} tiles.`, "ok");
  } catch (e) {
    LS.set("opening", "");
    runBtn.disabled = false;
    dlResult("Couldn't open " + name, `<div class="dl-msg err">${esc(e.message)}</div>`);
  }
}

// ---- loading areas from the bundle
document.getElementById("loadarea").onclick = () => { noteView(); if (lastView) loadArea(lastView.bbox); };
async function storageLeft() {
  try { const s = await navigator.storage.estimate(); return s.quota - s.usage; } catch (e) { return null; }
}
const LARGE_AREA_BYTES = 100e6;           // above this, say that opening it takes a while and a lot of memory
const NEAR_FRACTION = 0.5;                // a saved area within half a view's size of the view counts as "here"
/** [s, w, n, e] clamped to the map's real extent (a zoomed-out MapLibre view reaches past ±180°). */
function clampBox([s, w, n, e]) {
  return [Math.max(s, -85.05), Math.max(w, -180), Math.min(n, 85.05), Math.min(e, 180)];
}
/** Whether the open area's complete data lies within NEAR_FRACTION of the view box ([s, w, n, e]). */
function nearOpenArea(bbox) {
  const cb = info?.tiles ? coverageBounds() : null;
  return !!cb && nearView([[cb[1], cb[0], cb[3], cb[2]]], bbox);
}
/** Whether any of a saved area's boxes ([w, s, e, n]) lies within NEAR_FRACTION of the view box ([s, w, n, e]). */
function nearView(boxes, [s, w, n, e]) {
  const dy = (n - s) * NEAR_FRACTION, dx = (e - w) * NEAR_FRACTION;
  return (boxes || []).some(([bw, bs, be, bn]) => bw <= e + dx && be >= w - dx && bs <= n + dy && bn >= s - dy);
}
/**
 * Which saved area a view's tiles go into: the open one if it covers this place, else another saved area of
 * the same bundle that does, else a new one. One saved area per place keeps each small enough to open fast;
 * the dialogue can override it. Returns { kind: "open" | "other" | "new", id?, name? }.
 */
async function pickTarget(bbox, url) {
  if (info && info.canLoad && nearView(info.boxes, bbox)) return { kind: "open" };
  let libs = [];
  try { libs = (await call("libraries")).libraries; } catch (e) { /* none */ }
  const other = libs.find(f => !f.broken && f.id !== info?.id && f.source?.url === url && nearView(f.boxes, bbox));
  if (other) return { kind: "other", id: other.id, name: other.name };
  return info && info.canLoad && !info.tiles ? { kind: "open" } : { kind: "new" };   // an empty open area is filled first
}
let runAfterDownload = false;             // the dialogue came from Run: the query runs once the area is in
/**
 * Load this area's dialogue for a view box. `lead`: a first line saying why it opened (from Run: no saved data here),
 * and `runAfter`: run the query once the tiles are in, or once the saved area that has them is open.
 */
async function loadArea(bbox, forced = null, opts = {}) {
  const { lead = null, runAfter = false } = opts;
  runAfterDownload = runAfter;
  bbox = clampBox(bbox);
  const [s, w, n, e] = bbox;
  const hkm = (n - s) * 111.32, wkm = (e - w) * 111.32 * Math.cos((s + n) / 2 * Math.PI / 180);
  const km = v => v.toFixed(v < 10 ? 1 : 0);
  const url = info?.canLoad ? info.source.url : LS.get("source", DEFAULT_SOURCE);
  dlShow("Download this area", "Reading the bundle's tile index…");
  rmap.setBox("download", [s, w, n, e]);
  const body = document.getElementById("dl-body");
  body.innerHTML = '<p class="muted">Reading the bundle\'s tile index (about 770 KB for the planet)…</p>';
  dlButtons({ label: "Download", disabled: true }, { label: "Cancel", fn: dlClose });
  const target = forced ?? await pickTarget(bbox, url);
  const targetName = target.kind === "open" ? info.name : target.kind === "other" ? target.name : "a new saved area";
  document.getElementById("dl-sub").textContent = `${km(wkm)} × ${km(hkm)} km, into ${targetName}` +
    (target.kind === "new" ? " (named after the place)" : "") + `, from ${shownUrl(url)}`;
  let est;
  try { est = await call("estimate", { bbox, url, target: target.kind === "open" ? undefined : target.kind === "new" ? "new" : target.id }); }
  catch (ex) { dlResult("Download this area", `<div class="dl-msg err">${esc(ex.message)}</div>`); return; }
  const left = await storageLeft();
  let h = `<dl class="dl-grid"><dt>Tiles to fetch</dt><dd>${est.tiles.toLocaleString()}</dd>` +
          `<dt>Download and storage</dt><dd>${fmtBytes(est.bytes)}</dd>` +
          (target.kind !== "new" ? `<dt>Saved area after</dt><dd>${fmtBytes(est.total)}</dd>` : "") +
          (left != null ? `<dt>Browser limit left after</dt><dd>${fmtBytes(Math.max(left - est.bytes, 0))} <span class="muted">(not your free disk space)</span></dd>` : "") +
          `<dt>Data</dt><dd>${fmtDate(est.timestamp)} (revision ${est.revision})</dd></dl>` +
          '<p class="muted">Whole tiles are fetched, so the data reaches somewhat beyond the dashed box. Tiles are kept compressed and decoded into memory when the area opens.</p>';
  if (est.stale) h += `<div class="dl-msg">The bundle has newer data than ${esc(targetName)} (${fmtDate(est.libTimestamp).slice(0, 10)}, revision ${est.libRevision}). ` +
                      `Tiles of two revisions can't be mixed, so its ${est.areas} saved area${est.areas === 1 ? "" : "s"} come${est.areas === 1 ? "s" : ""} again together with this one. ` +
                      `The old data stays until the update is complete.</div>`;
  else if (!est.tiles) h += '<div class="dl-msg ok">Everything in this view is saved already.</div>';
  const tooBig = est.total > est.limit, noRoom = left != null && est.bytes > left;
  if (tooBig) h += `<div class="dl-msg err">That's ${fmtBytes(est.total)}, more than the ${fmtBytes(est.limit)} a saved area may hold: ` +
                   "decoded, it would need about five times that in this tab's memory. Zoom in, or load the places you need one at a time.</div>";
  else if (noRoom) h += '<div class="dl-msg err">Over the browser\'s storage limit for this site.</div>';
  else if (est.total > LARGE_AREA_BYTES) h += `<div class="dl-msg">A large saved area: opening it takes a while and about ${fmtBytes(5 * est.total)} of this tab's memory.</div>`;
  // the other choices, if the guess was wrong
  // Over the limit, adding to an area only makes it bigger: the one choice left is a new area, if the view alone fits
  const alts = [];
  if (!tooBig && target.kind !== "open" && info?.canLoad && info.source.url === url) alts.push([`Add to ${info.name} instead`, { kind: "open" }]);
  if (target.kind !== "new" && (!tooBig || est.bytes <= est.limit)) alts.push(["Into a new saved area instead", { kind: "new" }]);
  body.innerHTML = (lead ? `<p>${esc(lead)}</p>` : "") + h;
  if (alts.length) { const row = document.createElement("div"); row.className = "row"; row.style.marginTop = "10px"; for (const [label, t] of alts) row.appendChild(button(label, () => loadArea(bbox, t, opts))); body.appendChild(row); }
  if (!est.tiles && !est.stale && target.kind === "other") {   // another saved area has it all: just open that one
    dlButtons({ label: `Open ${target.name}`, fn: async () => { await openLibrary(target.id, target.name); if (runAfterDownload && info?.id === target.id) run(); } },
              { label: "Cancel", fn: dlClose });
    return;
  }
  const nothing = (!est.tiles && !est.stale) || tooBig || noRoom;
  dlButtons({ label: est.stale ? "Update and download" : "Download", disabled: nothing, fn: () => startDownload(bbox, url, target) },
            { label: nothing ? "Close" : "Cancel", fn: dlClose });
}
function warnLeaving(ev) { ev.preventDefault(); ev.returnValue = ""; }
async function startDownload(bbox, url, target = { kind: "open" }) {
  runBtn.disabled = true;
  try {
    if (target.kind === "new") showInfo(await call("create", { name: null, url }));      // opens the new, empty area
    else if (target.kind === "other") { await openLibrary(target.id, target.name); dlShow("Downloading tiles", ""); }
  } catch (e) { runBtn.disabled = false; dlResult("Download failed", `<div class="dl-msg err">${esc(e.message)}</div>`); return; }
  if (info) LS.set("library", info.id);
  document.getElementById("dl-title").textContent = "Downloading tiles";
  document.getElementById("dl-body").innerHTML = "";
  const onp = progressView("Tiles already downloaded are kept if you cancel; the area only counts as saved once all its tiles are in.");
  dlButtons(null, { label: "Cancel download", fn: () => { worker.postMessage({ cmd: "cancel" }); dlButtons(null, { label: "Cancelling…", disabled: true }); } });
  let r;
  window.addEventListener("beforeunload", warnLeaving);          // closing the tab would cut the download short
  try { r = await call("load", { bbox }, onp); }
  catch (e) { runBtn.disabled = false; dlResult("Download failed", `<div class="dl-msg err">${esc(e.message)}</div>`); return; }
  finally { window.removeEventListener("beforeunload", warnLeaving); }
  runBtn.disabled = false;
  showInfo(r.info);
  if (info) LS.set("library", info.id);
  if (r.cancelled) dlResult("Download cancelled", `<div class="dl-msg">${r.updated === undefined && r.added ? `${r.added} tiles were saved; ` : ""}the area isn't marked as saved.</div>`);
  else {
    dlResult(r.updated ? "Update complete" : "Download complete",
      `<div class="dl-msg ok">${r.updated ? `Downloaded all ${r.added} tiles again from the new data` : r.added ? `Added ${r.added} tile${r.added === 1 ? "" : "s"}` : "This area was saved already"} in ${r.seconds} s ` +
      `(${info.tiles} tiles, ${info.features.toLocaleString()} features in ${esc(info.name)}).</div>`);
    setStatus("Download complete: run the query.", "ok");
    const again = runAfterDownload; runAfterDownload = false;
    if (takeRunOnOpen() || again) run();       // a link with R, or Run's own dialogue: the query runs once its area is in
  }
}

// ---- saved areas: list, open, export, import, delete, storage
const dataov = document.getElementById("dataov");
document.getElementById("databtn").onclick = () => openData();
document.getElementById("dt-close").onclick = () => { dataov.hidden = true; };
dataov.addEventListener("click", ev => { if (ev.target === dataov) dataov.hidden = true; });
document.addEventListener("keydown", ev => { if (ev.key === "Escape") dataov.hidden = true; });
let dataState = null;
function setDataState(d) { dataState = d; }                 // for start.js
async function openData() {
  dataov.hidden = false;
  const d = dataState = await call("libraries");
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); } catch (e) {}
  const mine = d.libraries.reduce((a, f) => a + (f.bytes || 0), 0);
  const st = d.storage;
  document.getElementById("dt-disk").innerHTML = st ?
    `<div class="row" style="justify-content:space-between"><span>Browser limit for this site: <strong>${fmtBytes(st.quota)}</strong>, ${fmtBytes(st.usage)} used</span>` +
    `<span class="muted">saved areas use ${fmtBytes(mine)}</span></div>` +
    `<div class="bar" style="margin-top:6px"><div style="width:${Math.min(100, 100 * st.usage / st.quota).toFixed(1)}%"></div></div>` +
    `<div class="row" style="margin-top:8px"><span class="muted" style="flex:1">${persisted
        ? "Storage is persistent: the browser won't clear it to make room."
        : "The browser may clear this storage when the disk runs low, or with the site's data."} ` +
    "The limit is what the browser allows this site, often a share of the disk's size; browsers don't tell pages how much disk space is actually free.</span>" +
    (persisted ? "" : '<button id="dt-persist">Keep it</button>') + "</div>" : '<p class="muted">Storage estimate not available.</p>';
  const pb = document.getElementById("dt-persist");
  if (pb) pb.onclick = async () => {
    let ok = false; try { ok = await navigator.storage.persist(); } catch (e) {}
    setStatus(ok ? "Storage is now persistent." : "The browser declined to make storage persistent (it decides from how you use the site).", ok ? "ok" : "");
    openData();
  };
  const t = document.getElementById("dt-files");
  if (!d.libraries.length) t.innerHTML = '<tr><td class="muted">None yet. Load this area creates one, or Import a .gob file.</td></tr>';
  else {
    let h = '<tr><th>Name</th><th class="src">Source</th><th class="narrow-hide">Data</th><th class="num">Tiles</th><th class="num">Size</th><th></th></tr>';
    for (const f of d.libraries) {
      const open = f.id === d.current;
      if (f.broken) { h += `<tr><td>${esc(f.name)}</td><td colspan="4" class="${f.newer ? "muted" : "danger"}">${f.newer ? "saved by a newer version of this page: reload" : "unreadable"}</td><td><button class="danger" data-del="${esc(f.id)}">Delete…</button></td></tr>`; continue; }
      h += `<tr class="${open ? "active" : ""}"><td class="name">${esc(f.name)}${open ? '<span class="pill">open</span>' : ""}</td>` +
           `<td class="src" title="${esc(f.source.url ? shownUrl(f.source.url) : f.source.name)}">${esc(srcLabel(f.source))}</td>` +
           `<td class="narrow-hide">${fmtDate(f.timestamp).slice(0, 10)}</td><td class="num">${Object.keys(f.tiles).length}</td>` +
           `<td class="num">${fmtBytes(f.bytes)}</td>` +
           `<td><div class="acts">` +
           (open ? "" : `<button data-open="${esc(f.id)}">Open</button>`) +
           `<button data-ren="${esc(f.id)}">Rename</button>` +
           `<button data-exp="${esc(f.id)}">Export</button>` +
           `<button class="danger" data-del="${esc(f.id)}">Delete…</button></div></td></tr>`;
    }
    t.innerHTML = h;
  }
  const byId = (id) => d.libraries.find(x => x.id === id);
  t.querySelectorAll("[data-open]").forEach(b => b.onclick = async () => { dataov.hidden = true; await openLibrary(b.dataset.open, byId(b.dataset.open).name); });
  t.querySelectorAll("[data-ren]").forEach(b => b.onclick = async () => {
    const f = byId(b.dataset.ren);
    const name = prompt("New name for " + f.name, f.name);
    if (name === null || !name.trim() || name.trim() === f.name) return;
    try { const r = await call("rename", { id: f.id, name }); if (r.info) showInfo(r.info); setStatus(`Renamed to ${r.name}.`, "ok"); }
    catch (e) { alert(e.message); }
    openData();
  });
  t.querySelectorAll("[data-exp]").forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = "Exporting…";
    try {
      const { blob, filename } = await call("export", { id: b.dataset.exp });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      setStatus(`Exported ${filename} (${fmtBytes(blob.size)}).`, "ok");
    } catch (e) { alert(e.message); }
    b.disabled = false; b.textContent = "Export";
  });
  t.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    const f = byId(b.dataset.del);
    if (!confirm(`Delete the saved area ${f.name}${f.bytes ? ` (${fmtBytes(f.bytes)}, ${Object.keys(f.tiles || {}).length} tiles)` : ""} from this browser?\n\nIt can't be undone (Export it first to keep a copy).`)) return;
    try { await call("delete", { id: f.id }); } catch (e) { alert(e.message); return; }
    if (f.id === d.current) { showInfo(null); rmap.clearResults(); }
    setStatus("Deleted " + f.name, "ok"); openData(); refreshOtherAreas();
  });
  document.getElementById("dt-note").textContent = d.current && info
    ? `${info.name} is open: ${info.features.toLocaleString()} features from ${info.tiles} tiles are decoded in this tab's memory.` : "";
}
document.getElementById("dt-newbtn").onclick = () => {
  const f = document.getElementById("dt-form"); f.hidden = !f.hidden;
  document.getElementById("dt-newsrc").value = shownUrl(LS.get("source", DEFAULT_SOURCE));
  document.getElementById("dt-newname").focus();
};
document.getElementById("dt-create").onclick = async () => {
  const name = document.getElementById("dt-newname").value.trim(), url = withClient(document.getElementById("dt-newsrc").value.trim());
  const btn = document.getElementById("dt-create"); btn.disabled = true; btn.textContent = "Reading the bundle…";
  try {
    showInfo(await call("create", { name: name || null, url }));
    LS.set("library", info.id); LS.set("source", url);
    document.getElementById("dt-form").hidden = true; document.getElementById("dt-newname").value = "";
    setStatus(`New saved area ${info.name}: pan to an area and click Load this area.`, "ok");
    openData();
  } catch (e) { alert(e.message); }
  btn.disabled = false; btn.textContent = "Create";
};
document.getElementById("dt-import").onclick = () => document.getElementById("dt-file").click();
document.getElementById("dt-file").onchange = async ev => {
  const file = ev.target.files[0]; ev.target.value = "";
  if (!file) return;
  const name = file.name.replace(/\.gob$/i, "").replace(/[-_]+/g, " ").trim().slice(0, 80) || "Imported area";
  dataov.hidden = true;
  dlShow("Importing " + file.name, `${fmtBytes(file.size)} into a new saved area ${name}`);
  dlButtons(null, { label: "Cancel", fn: () => worker.postMessage({ cmd: "cancel" }) });
  const onp = progressView("The file's tiles are copied into this browser's storage.");
  try {
    const r = await call("import", { file, name }, onp);
    if (r.cancelled) { dlResult("Import cancelled", '<div class="dl-msg">Nothing was kept.</div>'); return; }
    showInfo(r.info); LS.set("library", info.id);
    const cb = coverageBounds(); if (cb) rmap.fit(cb);
    dlResult("Import complete", `<div class="dl-msg ok">${r.tiles} tiles, ${info.features.toLocaleString()} features in ${esc(info.name)}.</div>`);
  } catch (e) { dlResult("Import failed", `<div class="dl-msg err">${esc(e.message)}</div>`); }
};

export { dataState, dl, loadArea, nearOpenArea, openLibrary, setDataState };
