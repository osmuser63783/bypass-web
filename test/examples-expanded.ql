// 55.9369909,-3.2137585,55.9696195,-3.1627750 is the map view; out center gives buildings a single point
[out:json][timeout:25];
nwr[amenity=pub](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
// around: everything within a radius of a point
[out:json];
node[amenity=drinking_water](around:1000,55.9533052,-3.1882668);
out;
----
// ( … ); is a union: the results of both statements together
[out:json];
(
  nwr[amenity=cafe](around:300,55.9533052,-3.1882668);
  nwr[amenity=restaurant](around:300,55.9533052,-3.1882668);
);
out center;
----
// ~ matches a regular expression; several [ ] filters must all match
[out:json];
nwr[amenity~"^(cafe|restaurant)$"][wheelchair=yes](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
// ,i makes the match case-insensitive; | means "or" inside the expression
[out:json];
nwr[amenity=restaurant][cuisine~"indian|thai|chinese",i](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
// a name search: any type of object whose name contains the text
[out:json];
nwr[name~"castle",i](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
// node = points only (way = lines and areas, relation = groups, nwr = all three)
[out:json];
node[emergency=defibrillator](55.9369909,-3.2137585,55.9696195,-3.1627750);
out;
----
// != keeps objects with another value or no fee tag at all
[out:json];
nwr[amenity=toilets][fee!=yes](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
[out:json];
node[highway=bus_stop][shelter=yes](around:500,55.9533052,-3.1882668);
out;
----
// [!key] finds objects that lack a tag: a typical to-do list for mappers
[out:json];
nwr[shop][!opening_hours](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
[out:json];
way[highway~"^(primary|secondary|tertiary|unclassified|residential)$"][!name](55.9369909,-3.2137585,55.9696195,-3.1627750);
out geom;
----
// mappers write both spellings, so look for both
[out:json];
(
  nwr[fixme](55.9369909,-3.2137585,55.9696195,-3.1627750);
  nwr[FIXME](55.9369909,-3.2137585,55.9696195,-3.1627750);
);
out center;
----
// an address needs a number or a house name: this finds those with neither
// (keys with a colon need quotes)
[out:json];
nwr["addr:street"][!"addr:housenumber"][!"addr:housename"](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
[out:json];
nwr[amenity=restaurant][!cuisine](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
[out:json];
nwr[amenity=place_of_worship][!religion](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
// out geom adds the coordinates of every point
[out:json];
way[highway~"^(primary|secondary|tertiary)$"](55.9369909,-3.2137585,55.9696195,-3.1627750);
out geom;
----
// relations group other objects; out geom draws all their members
[out:json];
relation[route=bus](55.9369909,-3.2137585,55.9696195,-3.1627750);
out geom;
----
[out:json];
(
  way[highway=cycleway](55.9369909,-3.2137585,55.9696195,-3.1627750);
  way[cycleway~"^(lane|track)$"](55.9369909,-3.2137585,55.9696195,-3.1627750);
  way["cycleway:left"~"^(lane|track)$"](55.9369909,-3.2137585,55.9696195,-3.1627750);
  way["cycleway:right"~"^(lane|track)$"](55.9369909,-3.2137585,55.9696195,-3.1627750);
);
out geom;
----
[out:json];
way[waterway~"^(river|canal)$"](around:2000,55.9533052,-3.1882668);
out geom;
----
// [out:csv(…)] prints a table (see the Table and Data tabs); ::type, ::id, ::lat, ::lon are special columns
[out:csv(::type, ::id, name, "addr:street", ::lat, ::lon; true; ",")];
nwr[amenity=cafe](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
// out bb gives each object its bounding box instead of full geometry
[out:json];
nwr[leisure=park](55.9369909,-3.2137585,55.9696195,-3.1627750);
out bb;
----
// out tags: no coordinates, just the tags (see the Table tab)
[out:json];
nwr[leisure=park][name](55.9369909,-3.2137585,55.9696195,-3.1627750);
out tags;
----
// out ids: the smallest answer, e.g. to load the objects into an editor
[out:json];
nwr[tourism=museum](55.9369909,-3.2137585,55.9696195,-3.1627750);
out ids;
----
// the area is looked up by name in the saved data (Overpass Turbo asks Nominatim)
[out:json];
area(id:3601920901)->.searchArea;
nwr[amenity=cafe](area.searchArea);
out center;
----
// is_in: the areas around a point; area.a[…] filters them
[out:json];
is_in(55.9533052,-3.1882668)->.a;
area.a[admin_level];
out tags;
----
// rel(bn): the relations these nodes belong to (recursion up)
[out:json];
node[highway=bus_stop](55.9369909,-3.2137585,55.9696195,-3.1627750);
rel(bn)[route=bus];
out tags;
----
// way(r): the member ways of these relations (recursion down)
[out:json];
rel[route=bus](55.9369909,-3.2137585,55.9696195,-3.1627750);
way(r);
out geom;
----
// way(bn): the ways these nodes are on
[out:json];
node[highway=traffic_signals](55.9369909,-3.2137585,55.9696195,-3.1627750);
way(bn)[highway];
out geom;
----
// closed ways work as areas too: (area.parks)
[out:json];
way[leisure=park](55.9369909,-3.2137585,55.9696195,-3.1627750)->.parks;
node[amenity=bench](area.parks);
out;
----
// (if: …) tests each element with an expression; t["key"] is a tag value, compared as a number here
[out:json];
way[highway][lanes](55.9369909,-3.2137585,55.9696195,-3.1627750)(if: t["lanes"] > 2);
out geom;
----
// number() reads the leading number, suffix() what follows it
[out:json];
way[highway][maxspeed](55.9369909,-3.2137585,55.9696195,-3.1627750)(if: number(t["maxspeed"]) > 20 && suffix(t["maxspeed"]) == "mph");
out geom;
----
// length() is the length in metres
[out:json];
way[highway=footway](55.9369909,-3.2137585,55.9696195,-3.1627750)(if: length() > 300);
out geom;
----
// count_tags() counts an element's tags
[out:json];
nwr[shop](55.9369909,-3.2137585,55.9696195,-3.1627750)(if: count_tags() >= 15);
out center;
----
// is_tag("key") is true when the tag is set
[out:json];
way[building](55.9369909,-3.2137585,55.9696195,-3.1627750)(if: is_tag("height") && !is_tag("building:levels"));
out geom;
----
// (around.set:radius): near any element of a set, here the bus stops
[out:json];
node[highway=bus_stop](55.9369909,-3.2137585,55.9696195,-3.1627750)->.stops;
nwr[amenity=cafe](around.stops:100);
out center;
----
// ( a; - b; ) is a difference: what a finds that b doesn't
[out:json];
(
  nwr[amenity=pub](55.9369909,-3.2137585,55.9696195,-3.1627750);
  - nwr[amenity=pub](around:500,55.9533052,-3.1882668);
);
out center;
----
// [~"key"~"value"] matches keys by regular expression too (wheelchair, wheelchair:description, …)
[out:json];
nwr[~"^wheelchair"~"."](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----
// foreach runs its block once per element; ->.p names the current one
[out:json];
node[amenity=pub](55.9369909,-3.2137585,55.9696195,-3.1627750)->.pubs;
foreach.pubs->.p {
  .p out;
  node(around.p:100)[amenity=bench];
  out count;
}
----
// out count: just the numbers, per type
[out:json];
node[amenity=bench](55.9369909,-3.2137585,55.9696195,-3.1627750);
out count;
----
[out:json];
node[natural=tree](55.9369909,-3.2137585,55.9696195,-3.1627750);
out count;
----
// ->.name keeps a result in a named set; .name out … prints it later
[out:json];
nwr[amenity=school](55.9369909,-3.2137585,55.9696195,-3.1627750)->.schools;
.schools out count;
.schools out center;
----
// nwr.set[…] filters an earlier result instead of searching again
[out:json];
nwr[amenity~"^(cafe|restaurant|pub|bar)$"](55.9369909,-3.2137585,55.9696195,-3.1627750)->.food;
nwr.food[outdoor_seating=yes];
out center;
----
// a number after out limits the output (sorted by type and ID)
[out:json];
nwr[amenity=cafe](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center 10;
----
// make builds one new object; set.count(nwr) counts the objects in a named set
[out:json];
nwr[amenity=pub](55.9369909,-3.2137585,55.9696195,-3.1627750)->.pubs;
nwr[amenity=cafe](55.9369909,-3.2137585,55.9696195,-3.1627750)->.cafes;
nwr[amenity=restaurant](55.9369909,-3.2137585,55.9696195,-3.1627750)->.restaurants;
make counts pubs=pubs.count(nwr), cafes=cafes.count(nwr), restaurants=restaurants.count(nwr);
out;
----
// set(…) collects the distinct values, separated by semicolons
[out:json];
way[highway][name](55.9369909,-3.2137585,55.9696195,-3.1627750);
make streets names=set(t["name"]), count=count(ways);
out;
----
// sum(length()) adds up the lengths of all ways in the set, in metres
[out:json];
way[highway=cycleway](55.9369909,-3.2137585,55.9696195,-3.1627750);
make cycleways ways=count(ways), metres=sum(length());
out;
----
// ::geom sets the new object's geometry: here the hull around all schools
[out:json];
nwr[amenity=school](55.9369909,-3.2137585,55.9696195,-3.1627750);
make schools count=count(nwr), ::geom=hull(gcat(geom()));
out geom;
----
// convert makes one new object per input object: here a point with two tags
[out:json];
nwr[amenity=pub](55.9369909,-3.2137585,55.9696195,-3.1627750);
convert pub ::id=id(), name=t["name"], ::geom=center(geom());
out geom;
----



















[out:json];
nwr[amenity=cafe](55.9369909,-3.2137585,55.9696195,-3.1627750);
out center;
----

















[out:json];
way[highway~"^(primary|secondary|tertiary|residential)$"](55.9369909,-3.2137585,55.9696195,-3.1627750);
out geom;
