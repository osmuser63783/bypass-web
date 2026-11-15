// SPDX-License-Identifier: AGPL-3.0-or-later
// GPX and KML for the Export dialogue: the same conversions as the server page's export.js (osm_bypass/web),
// from the GeoJSON that ui-map.js makes. A classic script; the dialogue itself is in index.html.
"use strict";

/** The notice Overpass puts in its own output (and Overpass Turbo in its GeoJSON): the data's source and licence. */
const OSM_COPYRIGHT = "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.";

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const featureName = (p) => p.name || `${p["@type"]} ${p["@id"]}`;
/** Lines and rings of a GeoJSON geometry as lists of [lon, lat]; points separately. */
function parts(g) {
  const c = g.coordinates;
  switch (g.type) {
    case "Point": return { points: [c], lines: [] };
    case "MultiPoint": return { points: c, lines: [] };
    case "LineString": return { points: [], lines: [c] };
    case "MultiLineString": return { points: [], lines: c };
    case "Polygon": return { points: [], lines: c };
    case "MultiPolygon": return { points: [], lines: c.flat() };
    default: return { points: [], lines: [] };
  }
}
/** GPX 1.1: points as waypoints, lines and outlines as tracks, named after the object. */
function toGPX(fc) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Bypass" xmlns="http://www.topografix.com/GPX/1/1">',
    "<metadata><copyright author=\"OpenStreetMap contributors\"><license>https://opendatacommons.org/licenses/odbl/</license></copyright></metadata>"];
  for (const f of fc.features) {
    const { points, lines } = parts(f.geometry), name = xmlEsc(featureName(f.properties));
    for (const [lon, lat] of points) out.push(`<wpt lat="${lat}" lon="${lon}"><name>${name}</name></wpt>`);
    if (lines.length) out.push(`<trk><name>${name}</name>` + lines.map(l =>
      "<trkseg>" + l.map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join("") + "</trkseg>").join("") + "</trk>");
  }
  return out.join("\n") + "\n</gpx>\n";
}
/** KML 2.2: one placemark per object, its tags as ExtendedData. */
function toKML(fc) {
  const coords = (l) => l.map(([lon, lat]) => `${lon},${lat}`).join(" ");
  const geom = (g) => {
    if (g.type === "Point") return `<Point><coordinates>${g.coordinates.join(",")}</coordinates></Point>`;
    if (g.type === "LineString") return `<LineString><coordinates>${coords(g.coordinates)}</coordinates></LineString>`;
    if (g.type === "Polygon") return "<Polygon>" + g.coordinates.map((r, i) =>
      `<${i ? "innerBoundaryIs" : "outerBoundaryIs"}><LinearRing><coordinates>${coords(r)}</coordinates></LinearRing></${i ? "innerBoundaryIs" : "outerBoundaryIs"}>`).join("") + "</Polygon>";
    const kids = g.type === "MultiPoint" ? g.coordinates.map(c => ({ type: "Point", coordinates: c }))
      : g.type === "MultiLineString" ? g.coordinates.map(c => ({ type: "LineString", coordinates: c }))
      : g.type === "MultiPolygon" ? g.coordinates.map(c => ({ type: "Polygon", coordinates: c })) : [];
    return "<MultiGeometry>" + kids.map(geom).join("") + "</MultiGeometry>";
  };
  const marks = fc.features.map(f => {
    const p = f.properties;
    const data = Object.entries(p).map(([k, v]) => `<Data name="${xmlEsc(k)}"><value>${xmlEsc(v)}</value></Data>`).join("");
    return `<Placemark><name>${xmlEsc(featureName(p))}</name><ExtendedData>${data}</ExtendedData>${geom(f.geometry)}</Placemark>`;
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    "<description>Data © OpenStreetMap contributors, ODbL</description>\n" + marks.join("\n") + "\n</Document></kml>\n";
}

