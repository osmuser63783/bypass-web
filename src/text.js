// SPDX-License-Identifier: AGPL-3.0-or-later
// String helpers shared by the engine modules.

/**
 * Python's str ordering (by code point), without copying the strings. UTF-16 code units sort like code
 * points except that a surrogate (part of a character from U+10000 up) must sort after U+E000–U+FFFF.
 */
export function cpCompare(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    const x = a.charCodeAt(k), y = b.charCodeAt(k);
    if (x !== y) {
      const sx = x >= 0xd800 && x <= 0xdfff, sy = y >= 0xd800 && y <= 0xdfff;
      if (sx !== sy) return sx ? 1 : -1;
      return x < y ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
