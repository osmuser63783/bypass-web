// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/core.js: page guards, constants, storage keys, the worker client and small helpers.
// The page's script is nine ES modules, loaded in this order by app/main.js:
//   core, editor, map, areas, wizard, run, results, share, start
// (each starts with what it holds). They import from each other and from ui-map.js (MapLibre), and use
// the globals of the classic scripts loaded first: examples.js, overpass-wizard.js, export.js
// and js-yaml. They are files rather than inline so the Content-Security-Policy can forbid inline script.
// Opened as a file: module workers don't load from file://, and tile.openstreetmap.org refuses
// requests without a Referer (its tile usage policy). Say how to serve it instead.
if (location.protocol === "file:") {
  document.body.innerHTML = '<div style="max-width:620px;margin:48px auto;padding:0 16px;font:15px/1.5 system-ui,sans-serif">' +
    "<h1 style=\"font-size:20px\">Serve this page instead of opening the file</h1>" +
    "<p>Opened from disk, the browser won't start the page's worker, and the OpenStreetMap tile server " +
    "blocks the map (no Referer, which its tile usage policy requires). In a terminal, in the folder with this page " +
    "(index.html), run (any Python 3, nothing to install):</p>" +
    "<pre style=\"background:#f1f3f5;padding:10px;border-radius:6px\">python3 serve.py</pre>" +
    "<p>and open <a href=\"http://localhost:8770/\">http://localhost:8770/</a>. On Windows the command may be <code>py serve.py</code>.</p></div>";
  throw new Error("opened from file://");
}
// Inside another site's frame, clicks could be steered onto Delete or Download (clickjacking). Hosting should also
// send `Content-Security-Policy: frame-ancestors 'none'`, which a <meta> can't; this covers hosts that can't.
{
  let foreign = false;
  try { foreign = window.top !== window.self && window.top.location.origin !== location.origin; } catch (e) { foreign = true; }
  if (foreign) {
    document.body.innerHTML = '<p style="max-width:520px;margin:48px auto;padding:0 16px;font:15px/1.5 system-ui,sans-serif">' +
      'Bypass doesn\'t run inside other sites. <a target="_top" rel="noopener">Open it on its own page</a>.</p>';
    document.querySelector("a").href = location.href;
    throw new Error("framed by another site");
  }
}
// Cloudflare Web Analytics' site token: empty here, so the page counts nothing; `node tools-release.mjs --analytics
// <token>` writes it into the release (start.js loads the beacon, and only when the browser doesn't ask not to be tracked)
const ANALYTICS_TOKEN = "";
// ?client= tells Open Planet Data, who asked to be able to tell its users apart, that the loads come from this page
const DEFAULT_SOURCE = "https://download.openplanetdata.com/osm/planet/gob/v1/planet-latest.osm.gob?client=osm-bypass-web";
/** A bundle URL as the page shows it: without ?client=, which is for Open Planet Data, not for people. */
function shownUrl(u) {
  try { const x = new URL(u); x.searchParams.delete("client"); return x.href; } catch { return u; }
}
/** A typed Open Planet Data URL gets ?client= back, like the default. */
function withClient(u) {
  try {
    const x = new URL(u);
    if (x.host === new URL(DEFAULT_SOURCE).host && !x.searchParams.has("client")) x.searchParams.set("client", "osm-bypass-web");
    return x.href;
  } catch { return u; }
}
// EXAMPLES comes from examples.js
const LS_PREFIX = "bypass.";
const LS = { get(k, d) { try { const v = localStorage.getItem(LS_PREFIX + k); return v === null ? d : v; } catch (e) { return d; } },
             set(k, v) { try { localStorage.setItem(LS_PREFIX + k, v); } catch (e) {} } };
const DEFAULT_QUERY = '// Ctrl/Cmd+Enter runs the query; Examples has more\n[out:json];\nnwr[shop][!opening_hours]({{bbox}});\nout center;';
const MAP_LIMIT = 200000;              // elements drawn on the map at most (MapLibre copes; the browser tab is the limit)
const TABLE_LIMIT = 5000;              // rows shown in the Table tab (Download CSV has all of them)
const JOSM_LIMIT = 2000;               // objects sent to JOSM's remote control at once
const $ = (id) => document.getElementById(id);
function button(label, fn, title) {
  const b = document.createElement("button"); b.textContent = label; b.onclick = fn; if (title) b.title = title; return b;
}
const FLASH_MS = 1200;
/** Shows on a button, briefly, that its action happened (for actions with nothing else to see, such as copying). */
function flash(b, text) {
  if (!b || b.dataset.label) return;
  b.dataset.label = b.textContent; b.textContent = text;
  setTimeout(() => { b.textContent = b.dataset.label; delete b.dataset.label; }, FLASH_MS);
}

// ---- the worker (saved areas, downloads, engine)
let worker = null, seq = 0;
const pending = new Map();
// A worker whose modules fail to load fires `error` before it says it's ready; that's retried once (a file can
// fail to load on a flaky connection), then every waiting call fails with a message instead of waiting forever.
let workerReady = false, workerRetried = false;
function startWorker() {
  workerReady = false;
  worker = new Worker("src/worker.js", { type: "module" });
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.ready) { workerReady = true; return; }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.progress) { p.onProgress?.(m.progress); return; }
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(Object.assign(new Error(m.error), { kind: m.kind, extra: m.extra }));
  };
  worker.onerror = ev => {
    if (workerReady) return;                         // a later error inside the worker: its call answers for it
    ev.preventDefault();
    worker.terminate();
    if (!workerRetried) {
      workerRetried = true;
      startWorker();
      for (const [id, p] of pending) worker.postMessage({ id, cmd: p.cmd, args: p.args });
      return;
    }
    const msg = "The page's background worker didn't start" + (ev.message ? ` (${ev.message})` : "") +
      ". Reload the page; if that doesn't help, this browser may be too old (it needs module workers and the origin-private file system).";
    setStatus(msg, "err");
    for (const p of pending.values()) p.reject(Object.assign(new Error(msg), { kind: "worker" }));
    pending.clear();
  };
}
startWorker();
/**
 * Stops whatever the worker is doing by replacing it: a running query is one synchronous call there, which no
 * message can interrupt. Pending calls fail with kind "stopped"; the new worker has no saved area open yet.
 */
function restartWorker() {
  worker.terminate();
  for (const p of pending.values()) p.reject(Object.assign(new Error("Stopped."), { kind: "stopped" }));
  pending.clear();
  startWorker();
}
function call(cmd, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress, cmd, args });
    worker.postMessage({ id, cmd, args });
  });
}


// ---- helpers
function setStatus(t, cls) { const s = document.getElementById("status"); s.textContent = t; s.className = cls || ""; return s; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fmtBytes(n) {
  if (n == null) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
}
const fmtDate = ms => ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "no date";
const fmtDay = ms => ms > 0 ? new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : null;
const srcLabel = s => s.kind === "url" ? new URL(s.url).host + " · " + new URL(s.url).pathname.split("/").pop() : "file " + s.name;

export { $, ANALYTICS_TOKEN, button, call, DEFAULT_QUERY, DEFAULT_SOURCE, esc, flash, fmtBytes, fmtDate, fmtDay,
  JOSM_LIMIT, LS, MAP_LIMIT, restartWorker, setStatus, shownUrl, srcLabel, TABLE_LIMIT, withClient, worker };
