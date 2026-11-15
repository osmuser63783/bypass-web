// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/start.js: Start-up: reopen the last saved area (or say why not), then run a linked query.
// An ES module, loaded through app/main.js; it imports what it uses from the other modules and ui-map.js.
import { ANALYTICS_TOKEN, call, LS, setStatus } from "./core.js";
import { coverageBounds, rmap, savedView, showInfo } from "./map.js";
import { openLibrary, setDataState } from "./areas.js";
import { run } from "./run.js";
import { LINK_NEEDS_AREA, linkHold, linkView, readLink, runOnOpen, takeRunOnOpen } from "./share.js";

// ---- a shared link's query and view (#Q=…&C=…), before the area reopens and the beacon loads
readLink();

// ---- visit counting: only in a release built with an analytics token (core.js ANALYTICS_TOKEN), never when the
// browser sends Do Not Track or Global Privacy Control. It loads after share.js has cleared a link from the address,
// and with "spa": false the beacon doesn't follow later address changes, so a query in a link is never reported.
if (ANALYTICS_TOKEN && navigator.doNotTrack !== "1" && !navigator.globalPrivacyControl) {
  const beacon = document.createElement("script");
  beacon.defer = true;
  beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
  beacon.dataset.cfBeacon = JSON.stringify({ token: ANALYTICS_TOKEN, spa: false });
  document.head.appendChild(beacon);
}

// ---- start: reopen the last saved area
(async () => {
  let d;
  try { d = await call("libraries"); }
  catch (e) { setStatus("Browser storage isn't available here: " + e.message + " (a private window may block it).", "err"); showInfo(null); return; }
  setDataState(d);
  const lastId = LS.get("library", "");
  const pick = d.libraries.find(f => f.id === lastId && !f.broken) || d.libraries.find(f => !f.broken);
  if (!pick) {
    showInfo(null);
    setStatus(runOnOpen ? LINK_NEEDS_AREA
                        : "No saved area yet: pan the map to your area and click Load this area. Tiles come from Open Planet Data's planet bundle.");
    return;
  }
  if (LS.get("opening", "") === pick.id) {          // it hung or crashed the tab last time: don't trap the page in it
    showInfo(null);
    setStatus(`Opening ${pick.name} didn't finish last time, so it wasn't opened again. Open or delete it under Saved areas.`, "err");
    return;
  }
  await openLibrary(pick.id, pick.name);
  if (!savedView() && !linkView) { const cb = coverageBounds(); if (cb) rmap.fit(cb); }
  if (takeRunOnOpen()) run();
  else if (linkHold) setStatus(linkHold);
})();
