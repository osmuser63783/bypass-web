// SPDX-License-Identifier: AGPL-3.0-or-later
// Example queries for the page: a compact tour of the Overpass QL the browser engine runs, one feature or
// idea per example, for mappers doing QA and for analysts. The same tour as the server page
// (osm_bypass/web/examples.js). All work on the map view ({{bbox}} and {{center}}, Overpass Turbo's
// shortcuts), so they run as fast in a city as in a large saved area. Each query starts with a comment
// naming what it shows.
// A classic script: it defines the global EXAMPLES. test/examples.mjs runs them all.
"use strict";
// Every Door's idea of a POI (its "amenity" mode), for the freshness map
const POI_UNION = '(\n' +
  '  nwr["shop"]["shop"!="no"];\n  nwr["craft"]["craft"!="no"];\n  nwr["office"]["office"!="no"];\n' +
  '  nwr["healthcare"]["healthcare"!="no"];\n  nwr["club"]["club"!="no"];\n' +
  '  nwr["amenity"]["amenity"!~"^(no|recycling|parking|bench|parking_space|clothes_dryer|dressing_room|shower|waste_basket|bicycle_parking|shelter|post_box|drinking_water|hunting_stand|grave_yard|waste_disposal|fountain|parking_entrance|telephone|taxi|water_point|bbq|motorcycle_parking|grit_bin|clock|watering_place|public_bookcase|food_sharing|give_box|car_sharing|bicycle_repair_station|loading_dock|letter_box|waste_dump_site|compressed_air|sanitary_dump_station|lavoir|waste_transfer_station|boat_storage|weightbridge|feeding_place|game_feeding|trolley_bay|ticket_validator|health_post|kneipp_water_cure|vacuum_cleaner|car_pooling|table|garages|vehicle_ramp|water|yes|chair|nameplate|lounger)$"];\n' +
  '  nwr["amenity"="recycling"]["recycling_type"="centre"];\n' +
  '  nwr["tourism"]["tourism"!~"^(no|attraction|viewpoint|artwork|picnic_site|camp_pitch|wilderness_hut|cabin|information)$"];\n' +
  '  nwr["tourism"="information"]["information"~"^(office|visitor_centre)$"];\n' +
  '  nwr["leisure"~"^(sports_centre|fitness_centre|stadium|golf_course|marina|horse_riding|resort|sauna|water_park|sports_hall|beach_resort|miniature_golf|dance|ice_rink|adult_gaming_centre|bowling_alley|amusement_arcade|tanning_salon|escape_game|hackerspace|climbing|trampoline_park|social_club|club|maze|shooting_ground|spa|trampoline|indoor_play|racetrack|hot_spring|arena|turkish_bath|water_slide|karaoke|bird_hide|wildlife_hide)$"];\n' +
  '  nwr["emergency"~"^(ambulance_station|mountain_rescue|ses_station|water_rescue|air_rescue_service)$"];\n' +
  '  nwr["military"~"^(office|school|academy)$"];\n' +
  '  nwr["attraction"~"^(big_wheel|amusement_ride|winery|maze|carousel|geosite|train|summer_toboggan|river_rafting)$"];\n' +
  '  nwr["xmas:feature"]["xmas:feature"!~"^(no|tree)$"];\n);\n';
/** One circle layer of the freshness map: radius r, colours for green, orange, red and none. */
const GLOW = (r, c) => `    - type: circle\n      paint:\n        circle-blur: ${r > 3 ? 3 : 0}\n        circle-radius: ${r}\n` +
  `        circle-color:\n          - match\n          - [get, bucket]\n          - green\n          - ${c[0]}\n          - orange\n` +
  `          - ${c[1]}\n          - red\n          - ${c[2]}\n          - ${c[3]}\n`;

// The 3D buildings example: a building's height and base in metres from its tags (Simple 3D Buildings), as
// MapLibre expressions. Unknown heights draw 4 m high; heights that aren't plain numbers ("12 m") fall back too.
const UNKNOWN_HEIGHT_M = 4, LEVEL_M = 3;
// Mapterhorn's public terrain tiles (Terrarium-encoded WebP). Zoom 12 exists everywhere, finer zooms only where
// it has finer data (404s elsewhere), so MapLibre overzooms 12.
const DEM_SOURCE = '{type: raster-dem, tiles: ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"], encoding: terrarium,\n' +
  '           tileSize: 512, maxzoom: 12, attribution: "<a href=\'https://mapterhorn.com/attribution\'>© Mapterhorn</a>"}';
/** A two-line `case` expression, its second line indented to sit under the first's conditions. */
const caseExpr = (l1, l2) => (indent) => l1 + "\n" + indent + " ".repeat('["case", '.length) + l2;
const HEIGHT_EXPR = caseExpr(`["case", ["has", "height"], ["to-number", ["get", "height"], ${UNKNOWN_HEIGHT_M}],`,
  `["has", "building:levels"], ["*", ${LEVEL_M}, ["to-number", ["get", "building:levels"], 1]], ${UNKNOWN_HEIGHT_M}]`);
const BASE_EXPR = caseExpr(`["case", ["has", "min_height"], ["to-number", ["get", "min_height"], 0],`,
  `["has", "building:min_level"], ["*", ${LEVEL_M}, ["to-number", ["get", "building:min_level"], 0]], 0]`);

var EXAMPLES = [
  // ---- filters: what to match
  { group: "Filters", name: "Missing tags: shops without opening hours", q:
    '// [!key]: objects that lack a tag, the classic mapper to-do list\n// out center: one point for each building or area\n' +
    '[out:json];\nnwr[shop][!opening_hours]({{bbox}});\nout center;' },
  { group: "Filters", name: "Values: regular expressions, not-equal, ignoring case", q:
    '// ~ matches a regular expression, ,i ignores case, != excludes one value\n' +
    '[out:json];\nnwr[amenity=restaurant][cuisine~"italian|pizza",i][takeaway!=only]({{bbox}});\nout center;' },
  { group: "Filters", name: "Keys by pattern: fixme notes in any spelling", q:
    '// [~"key"~"value"]: any tag whose key and value match the patterns (FIXME, fixme, Fixme, …)\n' +
    '[out:json];\nnwr[~"^fixme$"~".",i]({{bbox}});\nout center;' },
  { group: "Filters", name: "Numbers: roads with more than two lanes", q:
    '// (if: …) filters with an expression; number() reads a tag as a number\n' +
    '[out:json];\nway[highway][lanes]({{bbox}})(if: number(t["lanes"]) > 2);\nout geom;' },
  { group: "Where", name: "Around a point: drinking water near the map centre", q:
    '// (around:radius,lat,lon); {{center}} is the map centre\n[out:json];\nnode[amenity=drinking_water](around:500,{{center}});\nout;' },
  { group: "Where", name: "Around a set: schools with no bus stop within 150 m", q:
    '// ->.name keeps a set; (around.set:r) is near any of its members; ( a; - b; ) is a difference\n' +
    '[out:json];\nnwr[amenity=school]({{bbox}})->.schools;\nnode[highway=bus_stop](around.schools:150)->.stops;\n' +
    'nwr.schools(around.stops:150)->.served;\n(.schools; - .served;);\nout center;' },
  { group: "Where", name: "Inside areas: benches in parks", q:
    '// map_to_area turns closed ways and multipolygons into areas; (area.set) is inside them\n' +
    '[out:json];\nnwr[leisure=park]({{bbox}});\nmap_to_area->.parks;\nnode[amenity=bench](area.parks);\nout;' },
  { group: "Where", name: "Which areas contain the map centre?", q:
    '// is_in: the areas around a point (boundaries, parks, buildings, …)\n[out:json];\nis_in({{center}})->.a;\narea.a[name];\nout tags;' },
  { group: "Relations and parents", name: "Bus routes, their streets and stops", q:
    '// (r.set) members of relations, (r.set:"role") with a role\n' +
    '[out:json];\nrel[route=bus]({{bbox}})->.routes;\n(\n  way(r.routes);\n  node(r.routes:"stop");\n  node(r.routes:"platform");\n);\nout geom;' },
  { group: "Relations and parents", name: "Parents: roads with traffic signals", q:
    '// way(bn.set): the ways those nodes belong to\n' +
    '[out:json];\nnode[highway=traffic_signals]({{bbox}})->.signals;\nway(bn.signals)[highway];\nout geom;' },
  { group: "Relations and parents", name: "Ways down to their nodes (OSMnx-style network)", q:
    '// > recurses down: ways to all their nodes, also the untagged ones\n' +
    '[out:json];\n(\n  way[highway~"^(primary|secondary|tertiary|residential|unclassified)$"]({{bbox}});\n  >;\n);\nout skel;' },
  { group: "Statistics", name: "Counting: buildings, by object type", q:
    '// out count: only the number of nodes, ways and relations (see the Table tab)\n[out:json];\nnwr[building]({{bbox}});\nout count;' },
  { group: "Statistics", name: "Grouping: amenities by type", q:
    '// for (expression): one group per value; make: a new object with computed tags\n[out:json];\n' +
    'nwr[amenity]({{bbox}})->.all;\nfor.all (t["amenity"]) {\n  make stat amenity=_.val, count=count(nwr);\n  out;\n}' },
  { group: "Statistics", name: "Totals: kilometres of cycleway and footway", q:
    '// set.sum(): over the set kept as ->.set (no leading dot here); length() in metres per way\n[out:json];\n' +
    'way[highway=cycleway]({{bbox}})->.cycle;\nway[highway=footway]({{bbox}})->.foot;\n' +
    'make stat cycleway_km=cycle.sum(length())/1000, footway_km=foot.sum(length())/1000;\nout;' },
  { group: "Statistics", name: "Per object: benches within 50 m of each pub", q:
    '// foreach: once per member of a set; p.u(t["name"]) is the pub\'s name\n[out:json];\n' +
    'nwr[amenity=pub]({{bbox}})->.pubs;\nforeach.pubs->.p {\n  node[amenity=bench](around.p:50);\n' +
    '  make pub name=p.u(t["name"]), benches=count(nodes);\n  out;\n}' },
  { group: "Statistics", name: "New geometry: outline around all schools", q:
    '// make with ::geom: hull() of all schools\' geometry, drawn on the map\n[out:json];\n' +
    'nwr[amenity=school]({{bbox}});\nmake hull ::geom=hull(gcat(geom())), schools=count(nwr);\nout geom;' },

  // ---- output
  { group: "Output", name: "CSV for a spreadsheet: cafés with address", q:
    '// [out:csv(…)]: chosen columns; ::lat, ::lon, ::id are the object\'s own\n' +
    '[out:csv(::type, ::id, name, "addr:street", "addr:housenumber", ::lat, ::lon; true; ",")];\nnwr[amenity=cafe]({{bbox}});\nout center;' },
  { group: "Map styling (Overpass Ultra front matter)", name: "POI freshness: when were they last checked?", q:
    '---\n# Every POI that Every Door\'s "amenity" mode would show, as a glowing light:\n' +
    '#   green  = check_date less than a year ago\n#   orange = check_date 1 to 5 years ago\n' +
    '#   red    = check_date more than 5 years ago\n#   grey   = no check_date: never confirmed on the ground\n' +
    '# Bundles hold no edit timestamps (metadata), so unlike the Ultra version this can\'t fall\n' +
    '# back to the last edit: only check_date counts. {{date:…}} is expanded before the query runs.\n' +
    'style:\n  # a dark basemap, so the lights stand out (OpenFreeMap\'s; any MapLibre style URL works)\n  extends: https://tiles.openfreemap.org/styles/dark\n  layers:\n' +
    GLOW(30, ["rgba(0, 200, 50, 0.25)", "rgba(255, 150, 0, 0.25)", "rgba(255, 30, 30, 0.25)", "rgba(120, 120, 120, 0.12)"]) +
    GLOW(14, ["rgba(0, 255, 100, 0.4)", "rgba(255, 180, 0, 0.4)", "rgba(255, 60, 60, 0.4)", "rgba(140, 140, 140, 0.25)"]) +
    GLOW(2.5, ['"#16a34a"', '"#f59e0b"', '"#dc2626"', '"#9ca3af"']) +
    '---\n[out:json][timeout:180][bbox:{{bbox}}];\n' + POI_UNION +
    '// convert: one new object per input, with computed tags\n' +
    '// ?: groups to the left in Overpass (a ? b : c ? d : e is (a ? b : c) ? d : e), so each later choice is in brackets\n' +
    'convert item ::=::, ::geom=center(geom()),\n  bucket=t["check_date"] == "" ? "none"\n' +
    '    : (t["check_date"] >= "{{date:1 year}}" ? "green"\n    : (t["check_date"] >= "{{date:5 years}}" ? "orange" : "red"));\nout geom;' },
  { group: "Map styling (Overpass Ultra front matter)", name: "Shops coloured by opening hours, with names", q:
    '---\n# YAML front matter (as in Overpass Ultra): MapLibre layers; tags are feature properties\nstyle:\n  layers:\n' +
    '    - type: circle\n      circle-radius: 6\n      circle-stroke-color: white\n      circle-stroke-width: 1\n' +
    '      circle-color: ["case", ["has", "opening_hours"], "#16a34a", "#dc2626"]\n' +
    '    - type: symbol\n      text-field: ["get", "name"]\n      text-size: 11\n      text-offset: [0, 1.1]\n' +
    '      text-anchor: top\n      text-halo-color: white\n      text-halo-width: 1.5\n---\n' +
    '[out:json];\nnwr[shop]({{bbox}});\nout center;' },
  { group: "Map styling (Overpass Ultra front matter)", name: "3D buildings on terrain: how far to the nearest bus stop?", q:
    '---\n# Buildings in 3D, coloured by how far they are from a bus stop: in a straight line from the building\'s\n' +
    '# nearest edge (walking is further). Blue dots are the bus stops.\n' +
    '#   green: up to 100 m · light green: 100 to 200 m · orange: 200 to 400 m · red: over 400 m\n' +
    '# Height: height, else building:levels × 3 m (4 m when neither is mapped); min_height or\n' +
    '# building:min_level lifts a building:part off the ground.\n' +
    '# Terrain: Mapterhorn\'s elevation model at true height, shaded under the roads.\n' +
    '# Ctrl+drag (or right-drag) tilts and turns the map; click a building for its tags.\n' +
    'options:\n  pitch: 60\nstyle:\n' +
    '  # Positron: flat footprints underneath. Liberty draws 3D buildings of its own, which would show through.\n' +
    '  extends: https://tiles.openfreemap.org/styles/positron\n' +
    '  sources:\n    # Mapterhorn\'s public terrain tiles (zoom 12: about 10 m per pixel here)\n' +
    `    dem: ${DEM_SOURCE}\n` +
    '    # the same tiles for the hillshade: MapLibre shades better from a source of its own\n' +
    `    hillshade: ${DEM_SOURCE}\n` +
    '  terrain: {source: dem, exaggeration: 1}\n  layers:\n' +
    '    # hillshade goes on the land and water, under the basemap\'s roads and buildings, by itself\n' +
    '    - type: hillshade\n      source: hillshade\n' +
    '      hillshade-exaggeration: 0.4\n' +
    '    - type: fill-extrusion\n      filter: ["==", ["get", "@geometry"], "area"]\n' +
    `      fill-extrusion-height:\n        ${HEIGHT_EXPR("        ")}\n` +
    `      fill-extrusion-base:\n        ${BASE_EXPR("        ")}\n` +
    '      fill-extrusion-color:\n' +
    '        ["match", ["get", "bus_stop_m"], "100", "#1a9850", "200", "#91cf60", "400", "#fdae61", "#d73027"]\n' +
    '      fill-extrusion-opacity: 0.9\n' +
    '    - type: circle\n      filter: ["==", ["get", "@geometry"], "point"]\n      circle-radius: 5\n' +
    '      circle-color: "#1d4ed8"\n      circle-stroke-color: white\n      circle-stroke-width: 1.5\n---\n' +
    '[out:json][timeout:120];\n' +
    'wr[building]({{bbox}})->.outlines;\n' +
    'wr["building:part"]({{bbox}})->.parts;\n' +
    'node(w.parts)->.pn;\n' +
    '// a building outline with parts would hide them inside it, so it\'s left out. Such an outline shares most\n' +
    '// of its nodes with its parts; a neighbour shares only a wall\n' +
    'way(bn.pn)->.w;\n' +
    '(way.w[building]; rel(bw.w)[building];)->.cand;\n' +
    'foreach.cand->.one(\n' +
    '  (.one; >;); node._->.n;\n' +
    '  node.n.pn->.shared;\n' +
    '  if (shared.count(nodes) * 2 > n.count(nodes)) { (.drop; .one;)->.drop; }\n' +
    ');\n' +
    '(.outlines; - .drop;)->.outlines;\n' +
    '(.outlines; .parts;)->.shown;\n' +
    '// bus stops up to 400 m from any of them, also outside the view; then the buildings in each distance band\n' +
    'nwr[highway=bus_stop](around.shown:400)->.stops;\n' +
    'nwr.shown(around.stops:100)->.d100;\n' +
    'nwr.shown(around.stops:200)->.d200;\n' +
    'nwr.shown(around.stops:400)->.d400;\n' +
    '(.d400; - .d200;)->.b400;\n' +
    '(.d200; - .d100;)->.b200;\n' +
    '(.shown; - .d400;)->.far;\n' +
    '// convert keeps the tags and id and adds the band; naming the type way or relation keeps Edit in iD\n' +
    'way.d100; convert way ::=::, ::id=id(), ::geom=geom(), bus_stop_m=100; out geom;\n' +
    'rel.d100; convert relation ::=::, ::id=id(), ::geom=geom(), bus_stop_m=100; out geom;\n' +
    'way.b200; convert way ::=::, ::id=id(), ::geom=geom(), bus_stop_m=200; out geom;\n' +
    'rel.b200; convert relation ::=::, ::id=id(), ::geom=geom(), bus_stop_m=200; out geom;\n' +
    'way.b400; convert way ::=::, ::id=id(), ::geom=geom(), bus_stop_m=400; out geom;\n' +
    'rel.b400; convert relation ::=::, ::id=id(), ::geom=geom(), bus_stop_m=400; out geom;\n' +
    'way.far; convert way ::=::, ::id=id(), ::geom=geom(), bus_stop_m="more"; out geom;\n' +
    'rel.far; convert relation ::=::, ::id=id(), ::geom=geom(), bus_stop_m="more"; out geom;\n' +
    '.stops out center;' },
];
