// SPDX-License-Identifier: AGPL-3.0-or-later
// Errors the engine raises besides SyntaxError (kept apart so every module can import them).

/** Valid Overpass QL that the browser engine doesn't do (yet), or that needs data a bundle doesn't have. */
export class Unsupported extends Error {}

/** Every way-node-ID guard ends with this. The Open Planet Data bundle has way-node IDs since its release of
 *  10 November 2026, so only areas saved from earlier releases (or custom bundles saved without -w) lack them. */
export const NO_WAYNODE_IDS = 'This saved area has no way-node IDs: it was loaded from a bundle release before ' +
  '10 November 2026 (or from a bundle saved without them). Load the area again from the current bundle.';

/** An error while a parsed query runs (a timeout, filters too weak; ql.py RuntimeQLError). Overpass answers it
 *  with HTTP 200, the output so far and the error as a remark: `overpass` is the remark's text in Overpass's
 *  words, and Engine.run sets `result` to the output so far with that remark (render.js prints it). */
export class RuntimeQLError extends Error {
  constructor(msg, overpass) { super(msg); this.overpass = overpass ?? msg; this.result = null; }
}

/** The answer needs data beyond the loaded tiles; `extra.bbox` = [w, s, e, n] is what to load. */
export class Incomplete extends Error {
  constructor(msg, bbox) { super(msg); this.kind = 'incomplete'; this.extra = { bbox }; }
}
