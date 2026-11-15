# Bypass Web

> **EXPERIMENTAL.** Bypass Web is new and still changing: expect bugs, gaps, and changes between versions.
>
> **Feedback is very welcome:** wrong or different answers, queries that fail, confusing bits, ideas.
> Please [open an issue](https://github.com/osmuser63783/bypass-web/issues), ideally with the query and the area.

Bypass Web answers [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL) queries in your
browser, on OpenStreetMap data for an area you've saved there. Queries run in the tab: no Overpass server is
asked, and the query and its results aren't sent anywhere.

It is mainly a tool for mappers (people who edit OpenStreetMap) and for analysts interested in a relatively small geographic area (e.g. one town or city).

## Starting it

Serve this folder and open the page in your browser. With Python 3 (nothing else to install):

```bash
python3 serve.py        # in this folder; then open http://127.0.0.1:8770/
```

`serve.py` serves the folder on your own computer only. Any static web server works too. Opening
`index.html` from disk doesn't: the page's worker and data files don't load from `file://`, and the map
tiles don't load either.

The page saves areas only over HTTPS or on `localhost`, so a phone or tablet can't use it from your
computer's address on the local network.

## Using it

1. **Pan to your area and press *Load this area*.** The dialogue shows the size and the data's date before
   anything is downloaded. The area is saved in this browser and reopens by itself next time.
2. **Write a query, or pick an example query.** There is a Wizard (based on Overpass Turbo's), and you can save and load queries.
   Overpass Turbo's shortcuts work, including `{{bbox}}` and `{{geocodeArea:…}}`.
3. **Run it.** Results appear on the map and in the Data, Table and Notes tabs.

Then:
- **Export** saves the result as GeoJSON, GPX, KML, CSV or the raw answer, loads it into JOSM, or copies the
  query.
- **Share** makes a link with the query and the map view. (It doesn't share downloaded areas, so whoever opens it uns the query on their own saved area.)
- **Saved areas** lists your areas: open, export as a file, import, delete. An area can grow: *Load this area*
  on a neighbouring view adds to the open one.
- **Updating:** when the bundle has newer data than a saved area, *Load this area* says so and downloads it
  again. The old data stays until the update is complete.

### Queries supported

The engine answers every part of Overpass QL that the data can answer: all statements, filters, recursion, areas, `make` and
`convert`, the output modes and formats. Not available: metadata and history (`out meta`, `[date:]`, `[diff:]`,
filters on user, version or timestamp), since the data doesn't include them.

The engine is tested on real queries from the Overpass manual, the wiki and forums, and on generated ones
using every statement and function. Its answers have been compared with those of the reference Overpass API
(0.7.62) on the same data.

### Limits

- **A saved area is at most 300 MB.** A view that would need more
  (e.g. a big country) is refused before anything is downloaded.
- **The data is as old as the bundle's latest release**, shown in the header as "data as of …".
- **Storage:** areas are kept in the browser's private file storage for this site (OPFS). Clearing this
  site's data in the browser removes them.

## Development

The page is static. The code in `src/` (the engine) and `app/` (the page) is plain ES modules with no build
step, so the same files run in browsers and in Node 18 or later. `serve.py` sends `Cache-Control: no-cache`,
so edits show on reload.

```bash
node test/examples.mjs <bundle.gob>   # the page's examples, on a bundle file
```

- **Hosting it:** `node tools-release.mjs` writes `site/`, the folder to upload to any static host. Its files
  get a `?v=<release>` on every URL, so browsers don't mix cached old files with new ones after an update.

## Licence of the code

Bypass Web is free software under the [GNU Affero General Public License 3.0 or later](LICENSE.txt). It ports
parts of the [Overpass API](https://github.com/drolbr/Overpass-API) (Roland Olbricht et al., AGPL). The
JavaScript the page runs is served as written, not minified, so its files are its source. The repository is
[github.com/osmuser63783/bypass-web](https://github.com/osmuser63783/bypass-web).

It builds on Overpass Turbo (Martin Raifer; shortcuts and the Wizard), iD's tagging schema (feature names),
tag2link (value links), Overpass Ultra (front-matter styling), MapLibre GL JS, CodeMirror and js-yaml.
Their licences and full notices are in [LICENSES.txt](LICENSES.txt).
