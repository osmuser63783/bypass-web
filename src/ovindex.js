// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass's quadtile index arithmetic, ported from osm_bypass/overpass_index.py, itself a port of Overpass
// API core/index_computations.h (Copyright (C) 2008-2018 Roland Olbricht et al., AGPL-3.0-or-later).
// Nodes are stored by a 32-bit quadtile of their position, ways and relations by calc_index of their
// nodes' quadtiles; that is Overpass's storage order (`out qt`). All values are unsigned 32-bit.

const u = (x) => x >>> 0;

function spread(x) {
  x = u(x & 0xffff0000);
  x = u(x | (x >>> 8)); x = u(x & 0xff00ff00);
  x = u(x | (x >>> 4)); x = u(x & 0xf0f0f0f0);
  x = u(x | (x >>> 2)); x = u(x & 0xcccccccc);
  x = u(x | (x >>> 1)); x = u(x & 0xaaaaaaaa);
  return x;
}

const llUpper = (ilat, ilon) => u(spread(u(ilat)) | (spread(u(ilon)) >>> 1));

/** Overpass's ll_upper_(lat, lon) ^ 0x40000000: the node index `out qt` sorts by. */
export function quadtile(lat, lon) {
  const ilat = Math.trunc((lat + 91.0) * 10000000 + 0.5);
  const ilon = Math.trunc(lon * 10000000 + (lon > 0 ? 0.5 : -0.5));
  return u(llUpper(ilat, ilon) ^ 0x40000000);
}

function upper(q, shift) {
  let r = u((q >>> shift) & 0x55555555);
  r = u(r | (r >>> 1)); r = u(r & 0x33333333);
  r = u(r | (r >>> 2)); r = u(r & 0x0f0f0f0f);
  r = u(r | (r >>> 4)); r = u(r & 0x00ff00ff);
  r = u(r | (r >>> 8));
  return r & 0xffff;
}
const upperIlat = (q) => upper(u(q & 0xaaaaaaaa), 1);
const upperIlon = (q) => upper(u(q & 0x55555555), 0);

const LEVELS = [[0x01, 0x2aaaaaa8, 0x55555554, 0x3], [0x02, 0x2aaaaa80, 0x55555540, 0xf],
  [0x04, 0x2aaaa800, 0x55555400, 0x3f], [0x08, 0x2aaa8000, 0x55554000, 0xff],
  [0x10, 0x2aa80000, 0x55540000, 0x3ff], [0x20, 0x2a800000, 0x55400000, 0xfff],
  [0x40, 0x28000000, 0x54000000, 0x3fff]];

function flaggedBox(i) {
  for (const [bit, lam, lom, add] of LEVELS) {
    if (i & bit) {
      const la = u(i & lam), lo = u(i & lom);
      return [la, lo, llUpper(u((upperIlat(la) + add) * 65536), 0), llUpper(0, u((upperIlon(lo) + add) * 65536))];
    }
  }
  return null;
}

const STEPS = [[0xfffe, 4, 0xfffffffc, 0x80000001], [0xfff8, 0x10, 0xffffffc0, 0x80000002],
  [0xffe0, 0x40, 0xfffffc00, 0x80000004], [0xff80, 0x100, 0xffffc000, 0x80000008],
  [0xfe00, 0x400, 0xfffc0000, 0x80000010], [0xf800, 0x1000, 0xffc00000, 0x80000020],
  [0xe000, 0x4000, 0xfc000000, 0x80000040]];

/** Port of Overpass's calc_index(): the storage index of a way or relation from its nodes' indexes. */
export function calcIndex(idxs) {
  if (!idxs.length) return 0xfe;
  const first = idxs[0];
  let latMin, lonMin, latMax, lonMax;
  if (first & 0x80000000) {
    const b = flaggedBox(first);
    if (!b) return 0x80000080;
    [latMin, lonMin, latMax, lonMax] = b;
  } else {
    latMin = latMax = u(first & 0x2aaaaaaa);
    lonMin = lonMax = u(first & 0x55555555);
  }
  for (let k = 1; k < idxs.length; k++) {
    const i = idxs[k];
    if (i & 0x80000000) {
      const b = flaggedBox(i);
      if (!b) return 0x80000080;
      const [la, lo, laU, loU] = b;
      latMin = Math.min(latMin, la); latMax = Math.max(latMax, laU);
      lonMin = Math.min(lonMin, lo); lonMax = Math.max(lonMax, loU);
    } else {
      const la = u(i & 0x2aaaaaaa), lo = u(i & 0x55555555);
      if (la < latMin) latMin = la; else if (la > latMax) latMax = la;
      if (lo < lonMin) lonMin = lo; else if (lo > lonMax) lonMax = lo;
    }
  }
  if (latMax === latMin && lonMax === lonMin) return first;
  const a = upperIlat(latMin), b = upperIlat(latMax), c = upperIlon(lonMin), d = upperIlon(lonMax);
  const base = u(lonMin | latMin);
  for (const [m, lim, keep, flag] of STEPS) {
    if ((b & m) - (a & m) < lim && (d & m) - (c & m) < lim) return u(u(base & keep) | flag);
  }
  return 0x80000080;
}

// ---- index ranges for a bbox (calc_ranges, calc_parents), used by `out geom(bbox)` to pick member ways

const i32 = (x) => x | 0;
const llu = (ilat, ilon) => u(llUpper(u(ilat), u(ilon)) ^ 0x40000000);

function recRanges(south, north, west, east, bitlevel, out) {
  let dist = u(u(0xffff0000 >>> bitlevel) & 0xffff0000);
  if (u(south + dist) === north && i32(west + dist) === i32(east)) { out.push([llu(south, west), u(llu(north, east) + 1)]); return; }
  dist = u(u(dist >>> 1) & 0xffff0000);
  if (u(north | dist) !== u(south | dist)) {
    if (u(u(east) | dist) !== u(u(west) | dist)) {
      recRanges(south, u(south | dist), west, i32(west | dist), bitlevel + 1, out);
      recRanges(south, u(south | dist), i32((west | dist) + 0x10000), east, bitlevel + 1, out);
      recRanges(u(u(south | dist) + 0x10000), north, west, i32(west | dist), bitlevel + 1, out);
      recRanges(u(u(south | dist) + 0x10000), north, i32((west | dist) + 0x10000), east, bitlevel + 1, out);
    } else {
      recRanges(south, u(south | dist), west, east, bitlevel + 1, out);
      recRanges(u(u(south | dist) + 0x10000), north, west, east, bitlevel + 1, out);
    }
  } else if (u(u(east) | dist) !== u(u(west) | dist)) {
    recRanges(south, north, west, i32(west | dist), bitlevel + 1, out);
    recRanges(south, north, i32((west | dist) + 0x10000), east, bitlevel + 1, out);
  } else recRanges(south, north, west, east, bitlevel + 1, out);
}

function mergeRanges(rs, key = (v) => v) {
  rs = [...rs].sort((a, b) => key(a[0]) - key(b[0]) || key(a[1]) - key(b[1]));
  const out = [];
  for (const [lo, hi] of rs) {
    if (out.length && !(key(out[out.length - 1][1]) < key(lo))) { if (key(hi) > key(out[out.length - 1][1])) out[out.length - 1] = [out[out.length - 1][0], hi]; }
    else out.push([lo, hi]);
  }
  return out;
}

export function calcRanges(south, north, west, east) {
  const s = u(u(Math.trunc((south + 91.0) * 10000000 + 0.5)) & 0xffff0000);
  const n = u(u(Math.trunc((north + 91.0) * 10000000 + 0.5)) & 0xffff0000);
  const w = i32(Math.trunc(west * 10000000 + (west > 0 ? 0.5 : -0.5)) & 0xffff0000);
  const e = i32(Math.trunc(east * 10000000 + (east > 0 ? 0.5 : -0.5)) & 0xffff0000);
  const out = [];
  if (west <= east) {
    if (west < 0 && 0 <= east) { recRanges(s, n, 0, e, 1, out); recRanges(s, n, w, i32(0xffff0000), 1, out); }
    else recRanges(s, n, w, e, 1, out);
  } else {
    const e180 = i32(Math.trunc(180.0 * 10000000 + 0.5) & 0xffff0000), w180 = i32(Math.trunc(-180.0 * 10000000 - 0.5) & 0xffff0000);
    if (west < 0) { recRanges(s, n, w, i32(0xffff0000), 1, out); recRanges(s, n, 0, e180, 1, out); }
    else recRanges(s, n, w, e180, 1, out);
    if (east > 0) { recRanges(s, n, w180, i32(0xffff0000), 1, out); recRanges(s, n, 0, e, 1, out); }
    else recRanges(s, n, w180, e, 1, out);
  }
  return mergeRanges(out);
}

function decomp(lo, hi, out) {
  const steps = [0x3, 0xf, 0x3f, 0xff, 0x3ff, 0xfff, 0x3fff, 0xffff, 0x3ffff, 0xfffff, 0x3fffff, 0xffffff, 0x3ffffff, 0xfffffff, 0x3fffffff];
  while (lo < hi) {
    let up = null, size = 1;
    for (const mask of steps) {
      if ((lo % (mask + 1)) !== 0 || lo + mask + 1 > hi) { up = lo + size; break; }
      size = mask + 1;
    }
    if (up === null) up = lo + 0x40000000;
    out.push([lo, up]);
    lo = up;
  }
}

const u31key = (v) => (v & 0x7fffffff) * 4294967296 + u(v);

function blur(distance, bitmask, lower, upper, out) {
  const sb = 0x10000 - distance;
  const minLat = upperIlat(lower) & sb, minLon = upperIlon(lower) & sb, maxLat = upperIlat(upper) & sb, maxLon = upperIlon(upper) & sb;
  const push = (idx) => out.push([idx, (idx + 1) & 0x7fffffff]);
  let lat = u(minLat - distance);
  while (lat <= maxLat) {
    push(u(llUpper(u(lat * 65536), u((minLon - distance) * 65536)) | bitmask));
    lat = u(lat + distance);
    if (lat === 0) break;
  }
  for (let lon = minLon; lon <= maxLon; lon += distance) push(u(llUpper(u((minLat - distance) * 65536), u(lon * 65536)) | bitmask));
  push(u(llUpper(u(maxLat * 65536), u(maxLon * 65536)) | bitmask));
}

export function calcParents(nodeRanges) {
  const dec = [];
  for (const [lo, hi] of nodeRanges) decomp(lo, hi, dec);
  const out = [[0x80000080, 0x80000081]];
  for (const [lo, hi] of dec) {
    out.push([lo, hi]);
    for (const [dist, bit, mask] of [[2, 0x80000001, 0x7ffffffc], [8, 0x80000002, 0x7fffffc0], [0x20, 0x80000004, 0x7ffffc00],
      [0x80, 0x80000008, 0x7fffc000], [0x200, 0x80000010, 0x7ffc0000], [0x800, 0x80000020, 0x7fc00000], [0x2000, 0x80000040, 0x7c000000]]) {
      blur(dist, bit, u(lo & mask), u(u(hi - 1) & mask), out);
    }
  }
  return mergeRanges(out, u31key);
}

export function inU31Ranges(idx, ranges) {
  const k = u31key(idx);
  return ranges.some(([lo, hi]) => u31key(lo) <= k && k < u31key(hi));
}
