// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/main.js: the page's entry module (index.html loads only this one). It imports the
// page's modules in the order they used to run as classic scripts; each imports what it needs from the others.
import "./core.js";
import "./editor.js";
import "./map.js";
import "./areas.js";
import "./wizard.js";
import "./run.js";
import "./results.js";
import "./share.js";
import "./start.js";
