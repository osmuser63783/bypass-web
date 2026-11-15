// SPDX-License-Identifier: AGPL-3.0-or-later
// The page's map: MapLibre GL with a vector basemap (OpenFreeMap) and the query results as one GeoJSON
// source, styled by default like Overpass Turbo or by Overpass Ultra's YAML front matter (`style:`).
// An ES module importing MapLibre GL 6 (ESM only); it exports ResultMap, toGeoJSON, splitFrontMatter and the rest.
// The same file as browser/ui-map.js (the browser version); tests/test_server.py checks they match.
import * as maplibregl from "./vendor/maplibre-gl-6.18.0/maplibre-gl.mjs";

const BASEMAPS = {                                  // in the menu's order, the default first
  bright: { label: "Bright (vector)", style: "https://tiles.openfreemap.org/styles/bright" },
  liberty: { label: "Liberty (vector)", style: "https://tiles.openfreemap.org/styles/liberty" },
  positron: { label: "Positron (vector, light)", style: "https://tiles.openfreemap.org/styles/positron" },
  dark: { label: "Dark (vector)", style: "https://tiles.openfreemap.org/styles/dark" },
  osm: { label: "OpenStreetMap (raster)", raster: "https://tile.openstreetmap.org/{z}/{x}/{y}.png" },
  none: { label: "No basemap", raster: null },
};
const DEFAULT_BASEMAP = "bright";           // until the user picks another (the pages remember the choice)
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const OFM_ATTR = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' + OSM_ATTR;
const SRC = "ultra";                       // the results source (Ultra's name for it)
const OWN = "ol-";                         // ids of the page's own sources and layers

// ---- results as GeoJSON (in the spirit of osmtogeojson)

const AREA_KEYS = ["building", "building:part", "landuse", "leisure", "natural", "amenity", "area", "place", "boundary", "shop", "tourism", "man_made", "waterway"];
function isAreaWay(e, pts) {
  if (pts.length < 4 || pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) return false;
  const t = e.tags || {};
  if (t.area === "no") return false;
  return AREA_KEYS.some(k => k in t && !(k === "waterway" && t[k] !== "riverbank")) || (t.highway === "pedestrian" && t.area === "yes");
}
const ll = (p) => [p.lon, p.lat];
const sameP = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Joins member ways into closed rings (null when some don't close). */
function joinRings(lines) {
  const rings = [], open = lines.map(l => l.slice()).filter(l => l.length >= 2);
  while (open.length) {
    let ring = open.shift();
    while (!sameP(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const k = open.findIndex(l => sameP(l[0], end) || sameP(l[l.length - 1], end));
      if (k < 0) return null;
      const l = open.splice(k, 1)[0];
      ring = ring.concat((sameP(l[0], end) ? l : l.reverse()).slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** A multipolygon relation's members as a (Multi)Polygon, or null. */
function relationPolygon(e) {
  const t = e.tags || {};
  if (t.type !== "multipolygon" && t.type !== "boundary") return null;
  const outer = [], inner = [];
  for (const m of e.members || []) {
    if (m.type !== "way" || !m.geometry) continue;
    const pts = m.geometry.filter(Boolean).map(ll);
    (m.role === "inner" ? inner : outer).push(pts);
  }
  const outers = joinRings(outer), inners = joinRings(inner) ?? [];
  if (!outers || !outers.length) return null;
  const polys = outers.map(r => [r]);
  for (const h of inners) { const p = polys.find(pl => inRing(h[0], pl[0])); if (p) p.push(h); }
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}

/**
 * The geometry of make/convert output. Overpass gives geom() of a closed way as a LineString and of a relation
 * as a collection of lines; with area tags (the test for ways) they become polygons, holes nested by inRing.
 */
function derivedGeometry(e) {
  const g = e.geometry;
  if (g.type === "LineString" && isAreaWay(e, g.coordinates)) return { type: "Polygon", coordinates: [g.coordinates] };
  if (g.type !== "GeometryCollection" || !g.geometries?.length || !g.geometries.every(x => x.type === "LineString")) return g;
  const rings = joinRings(g.geometries.map(x => x.coordinates));
  if (!rings?.length || !isAreaWay(e, rings[0])) return g;
  const outers = rings.filter(r => !rings.some(o => o !== r && inRing(r[0], o)));
  const polys = outers.map(r => [r]);
  for (const r of rings) if (!outers.includes(r)) { const p = polys.find(pl => inRing(r[0], pl[0])); if (p) p.push(r); }
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}

/**
 * The results as a FeatureCollection. Properties: the tags, plus @type, @id, @i (index into els), @dim
 * (outside the complete-data area), @tagged and @geometry (point, line, area).
 */
function toGeoJSON(els, { dim = () => false, showUntagged = false, max = Infinity } = {}) {
  const nodes = new Map(), inWay = new Set();
  for (const e of els) if (e.type === "node" && e.lat !== undefined) nodes.set(e.id, [e.lon, e.lat]);
  for (const e of els) if (e.type === "way" && e.nodes) for (const n of e.nodes) inWay.add(n);
  const features = [];
  let count = 0, skipped = 0;
  for (const [i, e] of els.entries()) {
    if (e.type === "count") continue;
    if (count >= max) { skipped++; continue; }
    const tagged = !!(e.tags && Object.keys(e.tags).length);
    const props = Object.assign({}, e.tags, { "@type": e.type, "@id": e.id ?? null, "@i": i, "@dim": !!dim(e), "@tagged": tagged });
    const geoms = [];
    if (e.geometry && !Array.isArray(e.geometry) && e.geometry.type) geoms.push(derivedGeometry(e));   // make/convert output
    else if (e.type === "node") {
      if (e.lat === undefined) { skipped++; continue; }
      if (!tagged && inWay.has(e.id) && !showUntagged) continue;
      geoms.push({ type: "Point", coordinates: [e.lon, e.lat] });
    } else if (e.type === "way") {
      const pts = e.geometry ? e.geometry.filter(Boolean).map(ll) : (e.nodes || []).map(n => nodes.get(n)).filter(Boolean);
      if (pts.length >= 2) geoms.push(isAreaWay(e, pts) ? { type: "Polygon", coordinates: [pts] } : { type: "LineString", coordinates: pts });
    } else if (e.type === "relation") {
      const poly = relationPolygon(e);
      if (poly) geoms.push(poly);
      else {
        const lines = [], pts = [];
        for (const m of e.members || []) {
          if (m.geometry) { const p = m.geometry.filter(Boolean).map(ll); if (p.length >= 2) lines.push(p); }
          else if (m.type === "node" && m.lat !== undefined) pts.push([m.lon, m.lat]);
        }
        if (lines.length) geoms.push({ type: "MultiLineString", coordinates: lines });
        if (pts.length) geoms.push({ type: "MultiPoint", coordinates: pts });
      }
    }
    if (!geoms.length) {
      if (e.center) geoms.push({ type: "Point", coordinates: [e.center.lon, e.center.lat] });
      else if (e.bounds) {
        const b = e.bounds;
        geoms.push({ type: "Polygon", coordinates: [[[b.minlon, b.minlat], [b.maxlon, b.minlat], [b.maxlon, b.maxlat], [b.minlon, b.maxlat], [b.minlon, b.minlat]]] });
      } else if (e.lat !== undefined) geoms.push({ type: "Point", coordinates: [e.lon, e.lat] });
    }
    if (!geoms.length) { skipped++; continue; }
    for (const g of geoms) {
      const kind = /Point/.test(g.type) ? "point" : /Polygon/.test(g.type) ? "area" : "line";
      features.push({ type: "Feature", id: features.length, geometry: g, properties: Object.assign({ "@geometry": kind }, props) });
    }
    count++;
  }
  return { fc: { type: "FeatureCollection", features }, count, skipped };
}

// ---- YAML front matter (Overpass Ultra)

/** { config, query }: the query keeps one empty line per front-matter line, so error positions still match. */
function splitFrontMatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { config: null, query: text };
  let config;
  try { config = jsyaml.load(m[1]) ?? {}; }
  catch (e) { throw Object.assign(new Error("YAML front matter: " + e.message), { kind: "syntax" }); }
  if (typeof config !== "object" || Array.isArray(config)) throw Object.assign(new Error("YAML front matter: expected keys such as style:"), { kind: "syntax" });
  // Plain data only: a parser bug (js-yaml < 4.1.1 let `<<` set the result's prototype) can't hide inherited keys
  // from the shared-link check (share.js frontMatterHosts reads the JSON), because the map reads this same copy
  config = JSON.parse(JSON.stringify(config));
  return { config, query: "\n".repeat(m[0].split("\n").length - 1) + text.slice(m[0].length) };
}

// Paint or layout? Ultra lets layers list both at the top level and sorts them (MapLibre style spec).
const LAYOUT_ALWAYS = new Set(["visibility", "line-cap", "line-join", "line-miter-limit", "line-round-limit", "line-sort-key",
  "fill-sort-key", "circle-sort-key", "fill-extrusion-edge-radius"]);
const PAINT_SYMBOL = /^(icon|text)-(opacity|color|halo-color|halo-width|halo-blur|translate|translate-anchor)$/;
const LAYER_KEYS = new Set(["id", "type", "source", "source-layer", "filter", "minzoom", "maxzoom", "metadata", "paint", "layout", "beforeLayerId"]);
/** Front matter sources get ids of the page's own, so they're removed with its layers when the style changes. */
const fmSourceId = (name) => `${OWN}fm-${name}`;
/** A front matter layer as a MapLibre layer; `sources`: the front matter's own (style.sources), by name. */
function normalizeLayer(l, k, sources = null) {
  const source = typeof l.source === "string" && sources && Object.hasOwn(sources, l.source) ? fmSourceId(l.source) : l.source ?? SRC;
  const out = { id: `${OWN}user-${k}`, type: l.type, source, paint: { ...(l.paint || {}) }, layout: { ...(l.layout || {}) } };
  for (const [key, v] of Object.entries(l)) {
    if (LAYER_KEYS.has(key)) { if (!["paint", "layout", "id", "source"].includes(key)) out[key] = v; continue; }
    if (LAYOUT_ALWAYS.has(key) || ((key.startsWith("icon-") || key.startsWith("text-") || key.startsWith("symbol-")) && !PAINT_SYMBOL.test(key))) out.layout[key] = v;
    else out.paint[key] = v;
  }
  if (out.type === "symbol" && out.layout["text-field"] !== undefined && !out.layout["text-font"]) out.layout["text-font"] = ["Noto Sans Regular"];
  const before = out.beforeLayerId; delete out.beforeLayerId;
  return { layer: out, before };
}

// ---- the default result style (Overpass Turbo's look: blue ways, orange points, purple relations)

const C = { way: "#2563eb", rel: "#7c3aed", node: "#c2410c", dim: "#8a94a3" };
const colour = ["case", ["get", "@dim"], C.dim, ["==", ["get", "@type"], "relation"], C.rel, ["==", ["get", "@type"], "node"], C.node, C.way];
const DEFAULT_LAYERS = [
  { id: OWN + "fill", type: "fill", source: SRC, filter: ["==", ["get", "@geometry"], "area"],
    paint: { "fill-color": colour, "fill-opacity": ["case", ["get", "@dim"], 0.12, 0.2] } },
  { id: OWN + "line", type: "line", source: SRC, filter: ["!=", ["get", "@geometry"], "point"],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": colour, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 4], "line-opacity": ["case", ["get", "@dim"], 0.5, 0.85] } },
  { id: OWN + "point", type: "circle", source: SRC, filter: ["==", ["get", "@geometry"], "point"],
    paint: { "circle-color": colour, "circle-opacity": ["case", ["get", "@dim"], 0.35, 0.55],
             "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "@tagged"], 4, 2.5], 16, ["case", ["get", "@tagged"], 7, 3.5]],
             "circle-stroke-color": colour, "circle-stroke-width": 2, "circle-stroke-opacity": ["case", ["get", "@dim"], 0.5, 0.9] } },
];
const SEL_COLOUR = "#f59e0b";
// the selected result's halo, under the result layers (a 3D building hides it: its own colour changes instead)
const SELECT_LAYERS = [
  { id: OWN + "sel-line", type: "line", source: OWN + "sel", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": SEL_COLOUR, "line-width": 6, "line-opacity": 0.75 } },
  { id: OWN + "sel-point", type: "circle", source: OWN + "sel", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": SEL_COLOUR, "circle-radius": 9, "circle-opacity": 0.6 } },
];

// ---- where layers go among the basemap's, bottom to top:
//   relief  hillshade and rasters: on the land and water, under everything else the basemap draws
//   fills   result fills and saved-area shading: on the basemap's flat buildings, under its roads
//   lines   result lines, points and 3D buildings: on everything the basemap draws except its labels
//   top     result labels and icons, above the basemap's labels (MapLibre places higher labels first)
// The basemap's layers are told apart by type and by OpenMapTiles' source layers (transportation, building),
// which OpenFreeMap's styles use; a style without them falls back to its first line and last non-label layers.
// A front matter layer's own beforeLayerId still wins.
const SLOT_OF_TYPE = { hillshade: "relief", raster: "relief", "color-relief": "relief", fill: "fills",
  line: "lines", circle: "lines", heatmap: "lines", "fill-extrusion": "lines", background: "lines", symbol: "top" };
/** { relief, fills, lines, top }: the basemap layer id each slot's layers go before (undefined: on top). */
function basemapSlots(layers) {
  const base = layers.filter(l => !l.id.startsWith(OWN) || l.id === OWN + "bg" || l.id === OWN + "osm");
  const first = (test) => { const k = base.findIndex(test); return k < 0 ? null : k; };
  const last = (test) => { for (let k = base.length - 1; k >= 0; k--) if (test(base[k])) return k; return null; };
  const aboveGeometry = (last(l => l.type !== "symbol") ?? -1) + 1;      // just above the basemap's last non-label layer
  const firstLine = first(l => l.type === "line"), firstRoad = first(l => l.type === "line" && l["source-layer"] === "transportation");
  const buildings = last(l => l.type === "fill" && l["source-layer"] === "building");
  const fills = Math.min(aboveGeometry, Math.max(firstRoad ?? firstLine ?? aboveGeometry, buildings === null ? 0 : buildings + 1));
  const id = (k) => base[k]?.id;
  return { relief: id(firstLine ?? aboveGeometry), fills: id(fills), lines: id(aboveGeometry), top: undefined };
}
/**
 * A 3D building of the results turns the selection's colour when selected (its ground halo would be hidden).
 * Left as it is when the colour depends on the zoom (MapLibre allows zoom only at an expression's top) or a
 * pattern replaces it.
 */
function withSelectedColour(layer) {
  if (layer.type !== "fill-extrusion" || layer.source !== SRC || layer.paint?.["fill-extrusion-pattern"] !== undefined) return layer;
  const c = layer.paint?.["fill-extrusion-color"] ?? "#000000";
  if (JSON.stringify(c).includes('["zoom"]')) return layer;
  return { ...layer, paint: { ...layer.paint, "fill-extrusion-color": ["case", ["boolean", ["feature-state", "selected"], false], SEL_COLOUR, c] } };
}

const EMPTY_FC = { type: "FeatureCollection", features: [] };
const AREA_HIT_PX = 6;                       // how near an outline a click or hover counts as on it
const LABEL_CHAR_PX = 7, LABEL_HALF_HEIGHT_PX = 9;   // the size of an area's name on the map (12px text), roughly

// ---- attribution
// MapLibre's own control puts every source's attribution into the page as HTML, and front matter can bring
// sources of its own (a style via `extends`, an inline layer source, a TileJSON url). Its cleaning keeps
// <iframe srcdoc>, which runs script as this page, so this control shows text and http(s)
// links only. It reuses MapLibre's classes, so it looks the same.
const ATTRIBUTION_DELAY_MS = 100;        // sources report in bursts while a style loads
const ATTRIBUTION_SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "TITLE", "SVG", "MATH"]);
const MAPLIBRE_LINK = { href: "https://maplibre.org/", text: "MapLibre" };

/** An attribution as DOM nodes: its text, with <a href="http(s)…"> kept as links; nothing else survives. */
function attributionNodes(html) {
  const doc = new DOMParser().parseFromString(String(html), "text/html");   // inert: no script runs, nothing loads
  const out = [];
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out.push(document.createTextNode(n.textContent));
      else if (n.nodeType !== Node.ELEMENT_NODE || ATTRIBUTION_SKIP.has(n.tagName.toUpperCase())) continue;
      else if (n.tagName === "A" && /^https?:\/\//i.test(n.getAttribute("href") || "")) out.push(link(n.getAttribute("href"), n.textContent));
      else walk(n);
    }
  };
  walk(doc.body);
  return out;
}
function link(href, text) {
  const a = document.createElement("a");
  a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = text;
  return a;
}

class SafeAttribution {
  onAdd(map) {
    this.map = map;
    this.el = document.createElement("div");
    this.el.className = "maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show";
    const b = document.createElement("button");
    b.type = "button"; b.className = "maplibregl-ctrl-attrib-button"; b.title = "Toggle attribution"; b.setAttribute("aria-label", b.title);
    b.onclick = () => this.el.classList.toggle("maplibregl-compact-show");
    this.inner = document.createElement("div");
    this.inner.className = "maplibregl-ctrl-attrib-inner";
    this.el.append(b, this.inner);
    this.update = () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.render(), ATTRIBUTION_DELAY_MS); };
    map.on("styledata", this.update);
    map.on("sourcedata", this.update);
    return this.el;
  }
  render() {
    let sources = {};
    try { sources = this.map.getStyle()?.sources || {}; } catch (e) { /* no style yet */ }
    const seen = new Set();
    for (const [id, def] of Object.entries(sources)) {
      const a = this.map.getSource(id)?.attribution ?? def.attribution;   // TileJSON sources report theirs once loaded
      if (a) seen.add(String(a));
    }
    const parts = [...seen].map(attributionNodes);
    parts.push([link(MAPLIBRE_LINK.href, MAPLIBRE_LINK.text)]);
    this.inner.replaceChildren();
    parts.forEach((nodes, i) => { if (i) this.inner.append(" | "); this.inner.append(...nodes); });
  }
  onRemove() {
    clearTimeout(this.timer);
    this.map.off("styledata", this.update);
    this.map.off("sourcedata", this.update);
    this.el.remove();
  }
}

// ---- coverage geometry
const WORLD_RING = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
/** A point on a ring's first edge (not a vertex, so rings that only touch at corners don't count it as inside). */
function edgeMidpoint(r) { return [(r[0][0] + r[1][0]) / 2, (r[0][1] + r[1][1]) / 2]; }
/** Even-odd point-in-ring test, [lon, lat]. */
function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

class ResultMap {
  constructor(el, { basemap = DEFAULT_BASEMAP, center = [55.9533, -3.1883], zoom = 14, onError, onStyleError, onAreaClick, onStyleSource } = {}) {
    this.el = el;
    this.basemapName = BASEMAPS[basemap] ? basemap : DEFAULT_BASEMAP;
    this.state = { coverage: null, boxes: {}, fc: { type: "FeatureCollection", features: [] }, userLayers: null, userSources: null, terrain: null, styleUrl: null, others: EMPTY_FC };
    this.onError = onError;
    this.onStyleError = onStyleError;                // problems with the front matter's style, for the user to see
    this.onAreaClick = onAreaClick;                  // (id, name): another saved area's outline was clicked
    this.onStyleSource = onStyleSource;              // (fromQuery): the front matter's style replaced the basemap, or not
    this.selectedIds = [];                           // feature ids of the selected result (for 3D buildings' colour)
    this.popupFn = null;
    this.hover = false;
    this.map = new maplibregl.Map({ container: el, style: this.styleFor(), center: [center[1], center[0]], zoom,
      attributionControl: false, hash: false, maxPitch: 60 });
    this.map.addControl(new SafeAttribution(), "bottom-right");
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    this.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    this.ready = false;                    // isStyleLoaded() stays false while tiles load, so track style.load
    this.map.on("style.load", () => { this.ready = true; this.apply(); });
    this.map.on("error", (ev) => {
      const m = ev?.error?.message || String(ev?.error || "");
      if (this.state.styleUrl && !this.ready && !ev?.sourceId && !ev?.tile) {   // the front matter's style didn't load
        const url = this.state.styleUrl;
        this.setStyleUrl(null);                          // back to the basemap, so the results still show
        this.styleNote(`The front matter's style ${url.length > 80 ? url.slice(0, 80) + "…" : url} couldn't be loaded (${m}), so the basemap is shown instead.`);
        return;
      }
      if (m && this.onError) this.onError(m);
    });
    this.popup = new maplibregl.Popup({ maxWidth: "340px", closeButton: true, closeOnClick: false });   // clicks are handled below
    const hit = (ev) => {
      const ids = this.resultLayerIds().filter(id => this.map.getLayer(id));
      if (!ids.length) return [];
      const p = ev.point, b = [[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]];
      return this.map.queryRenderedFeatures(b, { layers: ids });
    };
    const show = (ev) => {
      const fs = hit(ev);
      if (!fs.length) { if (!this.hover) { this.popup.remove(); this.select(null); } return; }
      const seen = new Set(), items = [];
      for (const f of fs) { const i = f.properties["@i"]; if (i !== undefined && !seen.has(i)) { seen.add(i); items.push(i); } }
      if (this.popupFn && items.length) {
        this.popup.setLngLat(ev.lngLat).setHTML(this.popupFn(items)).addTo(this.map);
        this.select(items[0]);
      }
    };
    this.map.on("click", (ev) => {
      const area = this.areaAt(ev.point);
      if (area && !hit(ev).length) { this.onAreaClick?.(area.id, area.name); return; }   // a saved area's outline or name
      if (!this.hover) show(ev);
    });
    this.map.on("mousemove", (ev) => {           // the cursor and hover label come from hoverPreview
      if (this.hover) { const fs = hit(ev); if (fs.length) show(ev); else { this.popup.remove(); this.select(null); } }
    });
    this.popup.on("close", () => this.select(null));
    this.hoverPreview(el, hit);
    new ResizeObserver(() => this.map.resize()).observe(el);
  }

  styleFor() {
    if (this.state?.styleUrl) return this.state.styleUrl;
    const b = BASEMAPS[this.basemapName];
    if (b.style) return b.style;
    const s = { version: 8, glyphs: GLYPHS, sources: {}, layers: [{ id: OWN + "bg", type: "background", paint: { "background-color": "#f2efe9" } }] };
    if (b.raster) {
      s.sources.osm = { type: "raster", tiles: [b.raster], tileSize: 256, maxzoom: 19, attribution: OSM_ATTR };
      s.layers.push({ id: OWN + "osm", type: "raster", source: "osm" });
    }
    return s;
  }
  setBasemap(name) {
    if (!BASEMAPS[name] || (name === this.basemapName && !this.state.styleUrl)) return;
    this.basemapName = name;
    this.ready = false;
    this.map.setStyle(this.styleFor(), { diff: false });   // a full reload fires style.load, which re-adds the overlays
  }
  /** A style URL from front matter (style: <url> or extends: <url>), or null for the chosen basemap. */
  setStyleUrl(url) {
    if ((url || null) === this.state.styleUrl) return;
    this.state.styleUrl = url || null;
    this.ready = false;
    this.map.setStyle(this.styleFor(), { diff: false });   // a full reload fires style.load, which re-adds the overlays
    this.onStyleSource?.(!!this.state.styleUrl);
  }

  /**
   * A label naming the result under a hovering mouse or pen (a Galaxy S Pen hovers, a finger can't). Pointer
   * events report a pen's hover where mouse events may not, and nothing here tests (hover: hover), which is
   * false on a touch phone even when its pen can hover.
   */
  hoverPreview(el, hit) {
    const tip = document.createElement("div");
    Object.assign(tip.style, { position: "absolute", zIndex: 3, pointerEvents: "none", display: "none", maxWidth: "240px",
      padding: "3px 7px", borderRadius: "5px", font: "12px/1.3 system-ui, sans-serif", background: "rgba(20, 24, 30, .85)",
      color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    el.appendChild(tip);
    let frame = 0;
    const hide = () => { tip.style.display = "none"; this.map.getCanvas().style.cursor = ""; };
    el.addEventListener("pointermove", (ev) => {
      if (ev.pointerType === "touch" || ev.buttons) { hide(); return; }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect(), point = { x: ev.clientX - r.left, y: ev.clientY - r.top };
        const fs = this.popup.isOpen() && this.hover ? [] : hit({ point }), area = fs.length ? null : this.areaAt(point);
        this.map.getCanvas().style.cursor = fs.length || area ? "pointer" : "";
        if (!fs.length && !area) { tip.style.display = "none"; return; }
        const p = fs.length ? fs[0].properties : null;
        tip.textContent = area ? `Saved area ${area.name}: click to open it` :
          (p.name || `${p["@type"] ?? ""} ${p["@id"] ?? ""}`.trim()) + (fs.length > 1 ? ` (+${fs.length - 1})` : "");
        Object.assign(tip.style, { display: "block", left: `${point.x + 14}px`, top: `${point.y + 12}px` });
      });
    });
    el.addEventListener("pointerleave", hide);
    el.addEventListener("pointerdown", hide);
  }
  styleNote(msg) { (this.onStyleError ?? this.onError)?.(msg); }
  resultLayerIds() { return (this.state.userLayers ?? DEFAULT_LAYERS).map(l => l.layer ? l.layer.id : l.id); }

  /** (Re)creates the page's own sources and layers: after every style change. */
  apply() {
    const m = this.map;
    if (!this.ready) return;
    this.appliedStyleKey = this.state.styleKey;      // setResults() only swaps the data while this stays the same
    if (m.getTerrain()) m.setTerrain(null);          // before its source goes
    for (const l of [...m.getStyle().layers].reverse()) if (l.id.startsWith(OWN) && l.id !== OWN + "bg" && l.id !== OWN + "osm") m.removeLayer(l.id);
    for (const id of Object.keys(m.getStyle().sources)) if (id === SRC || (id.startsWith(OWN))) m.removeSource(id);
    const slots = basemapSlots(m.getStyle().layers);
    const add = (layer, slot) => m.addLayer(layer, slots[slot]);
    // coverage: shade outside, outline inside
    const cov = this.state.coverage;
    m.addSource(OWN + "cov", { type: "geojson", data: cov ?? { type: "FeatureCollection", features: [] } });
    add({ id: OWN + "cov-shade", type: "fill", source: OWN + "cov", filter: ["==", ["get", "k"], "shade"], paint: { "fill-color": "#64748b", "fill-opacity": 0.16, "fill-antialias": false } }, "fills");   // no seams between boxes; the outline covers the edge
    add({ id: OWN + "cov-line", type: "line", source: OWN + "cov", filter: ["==", ["get", "k"], "edge"], paint: { "line-color": "#2563eb", "line-width": 1.5, "line-opacity": 0.8 } }, "lines");
    // other saved areas: dashed outlines with their names, unlike the open one's solid outline and shading
    m.addSource(OWN + "others", { type: "geojson", data: this.state.others });
    add({ id: OWN + "others-fill", type: "fill", source: OWN + "others", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#7c3aed", "fill-opacity": 0.06 } }, "fills");
    add({ id: OWN + "others-line", type: "line", source: OWN + "others", filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": "#7c3aed", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 } }, "lines");
    add({ id: OWN + "others-label", type: "symbol", source: OWN + "others", filter: ["==", ["geometry-type"], "Point"],
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-allow-overlap": false },
      paint: { "text-color": "#5b21b6", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } }, "top");
    // results
    m.addSource(SRC, { type: "geojson", data: this.state.fc, attribution: OSM_ATTR });
    m.addSource(OWN + "sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    for (const l of SELECT_LAYERS) add(l, "lines");
    for (const [name, def] of Object.entries(this.state.userSources ?? {})) {
      try { m.addSource(fmSourceId(name), def); } catch (e) { this.styleNote(`Front matter source ${name}: ${e.message}`); }
    }
    const imgs = [];
    for (const item of this.state.userLayers ?? DEFAULT_LAYERS.map(l => ({ layer: l }))) {
      try {
        const icon = item.layer.layout?.["icon-image"];
        if (typeof icon === "string" && /^https:\/\//.test(icon) && !m.hasImage(icon)) imgs.push(icon);
        this.addResultLayer(item, slots);
      } catch (e) { this.styleNote("Front matter style layer " + (item.layer.type || "?") + ": " + e.message); }
    }
    this.applyTerrain();
    for (const url of imgs) m.loadImage(url).then(r => { if (!m.hasImage(url)) m.addImage(url, r.data); }).catch(e => this.styleNote("Front matter icon " + url + ": " + e.message));
    // boxes (download preview, incomplete data)
    m.addSource(OWN + "boxes", { type: "geojson", data: this.boxesFC() });
    m.addLayer({ id: OWN + "box-dl", type: "line", source: OWN + "boxes", filter: ["==", ["get", "k"], "download"], paint: { "line-color": "#2563eb", "line-width": 2, "line-dasharray": [3, 2] } });
    m.addLayer({ id: OWN + "box-inc", type: "line", source: OWN + "boxes", filter: ["==", ["get", "k"], "incomplete"], paint: { "line-color": "#dc2626", "line-width": 2 } });
  }

  /** A result layer in its type's slot, or before the layer its front matter names. */
  addResultLayer(item, slots) {
    const m = this.map, before = item.before && m.getLayer(item.before) ? item.before : slots[SLOT_OF_TYPE[item.layer.type] ?? "lines"];
    m.addLayer(withSelectedColour(item.layer), before);
  }

  /** Front matter `terrain` (MapLibre's: { source, exaggeration }), its source one of the front matter's. */
  applyTerrain() {
    const t = this.state.terrain;
    if (!t || typeof t !== "object") return;
    const own = typeof t.source === "string" && this.state.userSources && Object.hasOwn(this.state.userSources, t.source);
    try { this.map.setTerrain({ ...t, source: own ? fmSourceId(t.source) : t.source }); }
    catch (e) { this.styleNote("Front matter terrain: " + e.message); }
  }

  boxesFC() {
    return { type: "FeatureCollection", features: Object.entries(this.state.boxes).filter(([, b]) => b).map(([k, [s, w, n, e]]) => ({
      type: "Feature", properties: { k }, geometry: { type: "LineString", coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } })) };
  }
  /** Draws (or with null removes) the dashed download box or the red "incomplete" box; bbox = [s, w, n, e]. */
  /** The other saved area whose outline or name is at a screen point ({ id, name }), or null. Inside an area
   *  doesn't count: a click there is for the map, and opening an area takes a few seconds. */
  areaAt(point) {
    const near = (a, b) => Math.abs(a - b) <= AREA_HIT_PX;
    for (const f of this.state.others.features) {
      const { id, name } = f.properties;
      if (f.geometry.type === "Point") {                       // the name, drawn centred on this point
        const c = this.map.project(f.geometry.coordinates), halfW = name.length * LABEL_CHAR_PX / 2;
        if (Math.abs(point.x - c.x) <= halfW && Math.abs(point.y - c.y) <= LABEL_HALF_HEIGHT_PX) return { id, name };
        continue;
      }
      const ring = f.geometry.coordinates[0];                  // a box: [w, s], [e, s], [e, n], [w, n]
      const sw = this.map.project(ring[0]), ne = this.map.project(ring[2]);
      const left = Math.min(sw.x, ne.x), right = Math.max(sw.x, ne.x), top = Math.min(sw.y, ne.y), bottom = Math.max(sw.y, ne.y);
      const inX = point.x >= left - AREA_HIT_PX && point.x <= right + AREA_HIT_PX, inY = point.y >= top - AREA_HIT_PX && point.y <= bottom + AREA_HIT_PX;
      if ((inY && (near(point.x, left) || near(point.x, right))) || (inX && (near(point.y, top) || near(point.y, bottom)))) return { id, name };
    }
    return null;
  }
  /** Other saved areas ([{ id, name, boxes: [[w, s, e, n], …] }]): dashed outlines, a name at the middle of each. */
  setOtherAreas(areas) {
    const features = [];
    for (const a of areas || []) {
      let w = 180, s = 90, e = -180, n = -90;
      for (const [bw, bs, be, bn] of a.boxes || []) {
        features.push({ type: "Feature", properties: { id: a.id, name: a.name }, geometry: { type: "Polygon", coordinates: [[[bw, bs], [be, bs], [be, bn], [bw, bn], [bw, bs]]] } });
        w = Math.min(w, bw); s = Math.min(s, bs); e = Math.max(e, be); n = Math.max(n, bn);
      }
      if (w <= e) features.push({ type: "Feature", properties: { id: a.id, name: a.name }, geometry: { type: "Point", coordinates: [(w + e) / 2, (s + n) / 2] } });
    }
    this.state.others = { type: "FeatureCollection", features };
    this.map.getSource(OWN + "others")?.setData(this.state.others);
  }
  setBox(kind, bbox) {
    this.state.boxes[kind] = bbox;
    this.map.getSource(OWN + "boxes")?.setData(this.boxesFC());
  }
  /** rings: [[lat, lon], ...] each, from the worker's coverage outline. */
  /**
   * Shades the map outside the area with complete data, outlined by `rings` ([lat, lon] lists). `boxes`
   * ([w, s, e, n] in degrees), when given, are the shade itself. Otherwise it comes from the rings, which may
   * nest (a gap inside the area, an island inside the gap), so each one's depth decides its role: even depths
   * are data (holes in the shade), odd depths are gaps (shaded, with the next depth as their holes). A ring
   * list given straight as holes of one world polygon nests holes in holes, which MapLibre's triangulation
   * draws as rays across the map.
   */
  setCoverage(rings, boxes = null) {
    if (!rings || !rings.length) this.state.coverage = null;
    else if (boxes) {                    // the browser version's grid coverage: the shade as ready-made boxes
      const rs = rings.filter(r => r.length >= 3).map(r => { const c = r.map(([la, lo]) => [lo, la]); if (!sameP(c[0], c[c.length - 1])) c.push(c[0]); return c; });
      this.state.coverage = { type: "FeatureCollection", features: [
        { type: "Feature", properties: { k: "shade" }, geometry: { type: "MultiPolygon",
          coordinates: boxes.map(([w, s, e, n]) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]]) } },
        { type: "Feature", properties: { k: "edge" }, geometry: { type: "MultiLineString", coordinates: rs } }] };
    } else {
      const rs = rings.filter(r => r.length >= 3).map(r => { const c = r.map(([la, lo]) => [lo, la]); if (!sameP(c[0], c[c.length - 1])) c.push(c[0]); return c; });
      const depth = rs.map((r, i) => { const p = edgeMidpoint(r); return rs.filter((o, j) => j !== i && insideRing(p, o)).length; });
      const holesOf = (i) => rs.filter((o, j) => depth[j] === depth[i] + 1 && insideRing(edgeMidpoint(o), rs[i]));
      const shade = [[WORLD_RING, ...rs.filter((r, i) => depth[i] === 0)]];
      rs.forEach((r, i) => { if (depth[i] % 2) shade.push([r, ...holesOf(i)]); });
      this.state.coverage = { type: "FeatureCollection", features: [
        { type: "Feature", properties: { k: "shade" }, geometry: { type: "MultiPolygon", coordinates: shade } },
        { type: "Feature", properties: { k: "edge" }, geometry: { type: "MultiLineString", coordinates: rs } }] };
    }
    this.map.getSource(OWN + "cov")?.setData(this.state.coverage ?? { type: "FeatureCollection", features: [] });
  }

  /** Shows results; config is the front matter (style, popupOnHover, popupTemplate). */
  /**
   * The results, with the front matter's config. When its style part (URL, layers, sources, terrain) is the same as
   * last time, only the results source gets the new data: rebuilding every layer and source would blank the map for
   * a few frames (and flatten terrain) on each re-run on pan. `rerun` (a re-run on pan) keeps an open popup and its
   * selection when the same OSM object is in the new results.
   */
  setResults(fc, config, popupFn, { rerun = false } = {}) {
    const keep = rerun && this.popup.isOpen() ? this.selectedObject : null;
    if (!keep) { this.popup.remove(); this.select(null); }
    this.state.fc = fc;
    this.hover = !!config?.popupOnHover;
    this.popupFn = config?.popupTemplate === false ? null : popupFn;
    let style = config?.style ?? null, url = null, layers = null;
    if (typeof style === "string") url = style;
    else if (style && typeof style === "object") {
      if (style.extends) url = style.extends;
      if (Array.isArray(style.layers)) layers = style.layers;
      else if (Array.isArray(style)) layers = style;
    }
    const own = style && typeof style === "object" && !Array.isArray(style) ? style : {};
    this.state.userSources = own.sources && typeof own.sources === "object" && !Array.isArray(own.sources) ? own.sources : null;
    this.state.terrain = own.terrain ?? null;
    this.state.userLayers = layers ? layers.map((l, k) => normalizeLayer(l, k, this.state.userSources)) : null;
    this.state.styleKey = JSON.stringify([url, layers, this.state.userSources, this.state.terrain]);
    const src = this.map.getSource(SRC);
    if ((url || null) !== this.state.styleUrl) this.setStyleUrl(url);    // apply() runs on style.load
    else if (this.ready && src && this.state.styleKey === this.appliedStyleKey) src.setData(fc);
    else this.apply();
    if (keep) this.reselect(keep);
  }
  /** Selects the result that is OSM object `[type, id]` again (its index changes between runs), or closes the popup. */
  reselect([type, id]) {
    const f = this.state.fc.features.find(f => f.properties["@type"] === type && f.properties["@id"] === id);
    if (f) this.select(f.properties["@i"]);
    else { this.popup.remove(); this.select(null); }
  }
  select(i) {
    const src = this.map.getSource(OWN + "sel");
    if (!src) return;
    const features = i === null ? [] : this.state.fc.features.filter(f => f.properties["@i"] === i);
    src.setData({ type: "FeatureCollection", features });
    for (const id of this.selectedIds) this.map.removeFeatureState({ source: SRC, id }, "selected");
    this.selectedIds = features.map(f => f.id);
    this.selectedObject = features.length && features[0].properties["@id"] != null ? [features[0].properties["@type"], features[0].properties["@id"]] : null;
    for (const id of this.selectedIds) this.map.setFeatureState({ source: SRC, id }, { selected: true });
  }
  /** No results, keeping the style (a front matter style stays until a query without one draws). */
  clearResults() {
    this.popup.remove();
    this.select(null);
    this.state.fc = { type: "FeatureCollection", features: [] };
    const src = this.map.getSource(SRC);
    if (src) src.setData(this.state.fc);
    else this.apply();
  }

  /** { bbox: [s, w, n, e], center: [lat, lon], zoom } of the visible map, or null while it has no size. */
  view() {
    const c = this.map.getCanvas();
    if (!c.clientWidth || !c.clientHeight) return null;
    const b = this.map.getBounds(), ce = this.map.getCenter();
    return { bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], center: [ce.lat, ce.lng], zoom: this.map.getZoom() };
  }
  setView(lat, lon, zoom) { this.map.jumpTo({ center: [lon, lat], zoom }); }
  /** bbox = [s, w, n, e] */
  fit(bbox, maxZoom = 18) { const [s, w, n, e] = bbox; this.map.fitBounds([[w, s], [e, n]], { padding: 24, maxZoom, duration: 0 }); }
  fitResults() {
    let s = 90, w = 180, n = -90, e = -180;
    const walk = (c) => { if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
    for (const f of this.state.fc.features) walk(f.geometry.coordinates);
    if (s <= n) this.fit([s, w, n, e]);
  }
  /** Applies front matter `options` (center, zoom, bounds, pitch, bearing) before a run. */
  applyOptions(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o.bounds) && o.bounds.length === 4) { const [w, s, e, n] = o.bounds.flat(); this.fit([s, w, n, e], 22); }
    const j = {};
    if (Array.isArray(o.center)) j.center = o.center;
    for (const k of ["zoom", "pitch", "bearing"]) if (typeof o[k] === "number") j[k] = o[k];
    if (Object.keys(j).length) this.map.jumpTo(j);
  }
  on(ev, fn) { this.map.on(ev, fn); }
}

// everything, for both pages: Bypass Web imports what it uses, the server page's ui-map-bridge.js all of it
export { AREA_HIT_PX, AREA_KEYS, ATTRIBUTION_DELAY_MS, ATTRIBUTION_SKIP, attributionNodes, BASEMAPS, basemapSlots,
  C, colour, DEFAULT_BASEMAP, DEFAULT_LAYERS, derivedGeometry, edgeMidpoint, EMPTY_FC, fmSourceId, GLYPHS, inRing,
  insideRing, isAreaWay, joinRings, LABEL_CHAR_PX, LABEL_HALF_HEIGHT_PX, LAYER_KEYS, LAYOUT_ALWAYS, link, ll,
  MAPLIBRE_LINK, normalizeLayer, OFM_ATTR, OSM_ATTR, OWN, PAINT_SYMBOL, relationPolygon, ResultMap,
  SafeAttribution, sameP, SEL_COLOUR, SELECT_LAYERS, SLOT_OF_TYPE, splitFrontMatter, SRC, toGeoJSON,
  withSelectedColour, WORLD_RING };
