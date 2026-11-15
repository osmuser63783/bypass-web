// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/wizard.js: The Wizard: Overpass Turbo's wizard with plain-language extras, near-feature queries, explanations, the live count and suggestions.
// An ES module, loaded through app/main.js; it imports what it uses from the other modules and ui-map.js.
import { button, call, esc } from "./core.js";
import { cm } from "./editor.js";
import { info } from "./map.js";
import { lastView, noteView, run } from "./run.js";

// ---- query builder (Overpass Turbo's wizard, vendor/overpass-wizard.js, with iD presets)
const wizov = document.getElementById("wizov"), wizIn = document.getElementById("wiz-in");
// the wizard's fuzzy preset search calls a global levenshteinDistance (Overpass Turbo provides one)
window.levenshteinDistance = (a, b) => {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = t;
    }
  }
  return prev[b.length];
};
let presetText = null;
async function presetJSON() {               // parsed afresh for each use: the wizard modifies the objects
  if (!presetText) presetText = await (await fetch("data/presets-en.json")).text();
  return JSON.parse(presetText);
}
let wizPresets = null;
function openWizard() {
  wizov.hidden = false;
  loadFeatureNames().catch(() => { /* explanations use tags only */ });
  showWizardExamples(null);
  // the place examples name the place at the map centre, found in the saved data (the area's own name may not be one)
  noteView();
  if (info?.tiles && lastView) call("suggestName", { bbox: lastView.bbox })
    .then(name => { if (name && !wizov.hidden) showWizardExamples(name.split(",")[0].trim()); }).catch(() => {});
  wizIn.focus(); wizIn.select();
  if (wizIn.value) wizPreview();
}
/** One example per idea: a feature name, tags, the plain-language extras, or/and, type:, and places. */
function showWizardExamples(place) {
  const chips = ["Drinking Water", "shop=* and opening_hours!=*", "cafe without a wheelchair tag", "restaurant named pizza",
    "shop not checked for 2 years", "cafes within 200 m of a pub", "tourism=museum or tourism=gallery",
    "type:node and amenity=post_box", place ? `bench within 300 m of ${place}` : "bench near playground",
    place ? `cafe in ${place}` : "cafe global"];
  const box = document.getElementById("wiz-chips");
  box.innerHTML = "";
  for (const c of chips) box.appendChild(button(c, () => { wizIn.value = c; wizPreview(); wizIn.focus(); }));
}
document.getElementById("wizbtn").onclick = openWizard;
document.getElementById("wiz-close").onclick = () => { wizov.hidden = true; };
wizov.addEventListener("click", ev => { if (ev.target === wizov) wizov.hidden = true; });
document.addEventListener("keydown", ev => { if (ev.key === "Escape") wizov.hidden = true; });
/** Quotes a free-form name and a place that contain spaces ("Drinking Water around Edinburgh Castle"). */
/**
 * Quotes the multi-word names the wizard's grammar needs quoted: each free-form part of an and/or chain
 * ("bathing place and toilets!=*" -> "\"bathing place\" and toilets!=*"), and the place after in/around.
 */
function wizQuote(text) {
  const m = /^(.*?)(\s+(?:in|around)\s+)(.+)$/i.exec(text);
  const left = (m ? m[1] : text).trim(), right = m ? m[3].trim() : null;
  const q = (x) => /^(["']).*\1$/.test(x) || !/\s/.test(x) ? x : `"${x.replace(/"/g, '\\"')}"`;
  const quotePart = (part) => {
    const [, open, body, close] = /^(\s*\(*\s*)(.*?)(\s*\)*\s*)$/.exec(part);
    const free = body && !/[=~!*:"']/.test(body) && !/\s+global$/i.test(body);
    return open + (free ? q(body) : body) + close;
  };
  return left.split(/(\s+(?:and|or)\s+)/i).map((p, i) => i % 2 ? p : quotePart(p)).join("") + (m ? m[2] + q(right) : "");
}
// Plain-language extras, rewritten into the wizard's own grammar before it runs (and its output adjusted after):
//   "cafe without a wheelchair tag" (or "cafe without wheelchair") -> cafe and wheelchair!=*
//   "cafe with a wheelchair tag" (or "cafe with wheelchair")       -> cafe and wheelchair=*
//   "pub named crown"          -> pub and name~/crown/i
//   "bench within 200 m of X"  -> bench around X, radius 200
//   "shop not checked for 2 years" (or "checked more than 2 years ago") -> check_date older, or none
const WIZ_STOP = "(?=\\s+(?:and|or|in|around|with|without|named|within|not\\s+checked|checked|global)\\b|$)";
// "a pub", "the bakery", "any bench": the wizard's grammar has no articles; nor plurals ("cafes", "bus stops")
const ARTICLE_START = /^\s*(?:a|an|the|any|some|all)\s+/i;
const ARTICLE_AFTER = /\b(of|near|with|without)\s+(?:a|an|the|any|some)\s+/gi;
/** One word made singular, if it looks plural: bakeries -> bakery, benches -> bench, cafes -> cafe; not bus, glass. */
function singular(w) {
  if (/ies$/i.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ch|sh|x|ss|zz)es$/i.test(w)) return w.slice(0, -2);
  if (/[^su]s$/i.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}
/** The feature words of a wizard input made singular; tags, quoted names and the place after in/around stay. */
function singularize(text) {
  const m = /^(.*?)(\s+(?:in|around)\s+.+)$/i.exec(text);
  const left = m ? m[1] : text, right = m ? m[2] : "";
  return left.split(/(\s+(?:and|or)\s+)/i).map((part, i) =>
    i % 2 || /[=~!*:"']/.test(part) ? part : part.replace(/[A-Za-z]+/g, (w) => /^(type|global)$/i.test(w) ? w : singular(w))).join("") + right;
}
/**
 * "diet:vegan" alone: a namespaced key (diet:vegan, addr:street, name:en), so diet:vegan=*. The wizard's own grammar
 * reads key:value as a substring search (diet~vegan), which a bare OSM key almost never means. type:node stays
 * the wizard's; quoted text and values (cuisine=a:b) are left alone.
 */
function namespacedKeys(text) {
  return text.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/).map((s, i) => i % 2 ? s :
    s.replace(/(^|[\s(])([\w-]+(?::[\w-]+)+)(?=$|[\s)])/g, (m, lead, key) => /^type:/i.test(key) ? m : `${lead}${key}=*`)).join("");
}
// "without a toilets tag" is "without toilets" (ARTICLE_AFTER has taken the "a"): the key is toilets
const asKey = (phrase) => /[=~]/.test(phrase) ? phrase : phrase.trim().replace(/\s+tags?$/i, "").toLowerCase().replace(/\s+/g, "_");
function plainLanguage(text) {
  let radius = null, age = null;
  const keys = [];
  text = text.replace(ARTICLE_AFTER, "$1 ");
  text = text.replace(/\bwithin\s+(\d+(?:\.\d+)?)\s*(m|km|metres?|meters?|kilometres?|kilometers?)\s+of\s+/i, (m, n, unit) => {
    radius = Math.round(parseFloat(n) * (/^k/i.test(unit) ? 1000 : 1)); return "around ";
  });
  text = text.replace(/\s*\b(?:not\s+checked\s+(?:for|in)|checked\s+(?:more\s+than|over))\s+(\d+)\s+(year|month)s?(?:\s+ago)?\b/i, (m, n, unit) => {
    age = `${n} ${unit}${n === "1" ? "" : "s"}`; return "";
  });
  text = text.replace(new RegExp("(?:\\s+and)?\\s+without\\s+(.+?)" + WIZ_STOP, "gi"), (m, k) => ` and ${/[=~]/.test(k) ? k : (keys.push(asKey(k)), asKey(k) + "!=*")}`);
  text = text.replace(new RegExp("(?:\\s+and)?\\s+with\\s+(.+?)" + WIZ_STOP, "gi"), (m, k) => ` and ${/[=~]/.test(k) ? k : (keys.push(asKey(k)), asKey(k) + "=*")}`);
  text = text.replace(new RegExp("\\s+named\\s+[\"']?(.+?)[\"']?" + WIZ_STOP, "gi"), (m, n) => ` and name~/${n.replace(/\//g, "")}/i`);
  text = namespacedKeys(text);           // last: "without name:en" has become name:en!=* by now
  return { text: text.trim(), radius, age, keys };
}
/**
 * "without toilet": the key is `toilets`. A with/without key the saved area doesn't use, whose plural or singular
 * it does use, is swapped for that one; the dialogue says so. Returns the notes.
 */
async function resolveKeys(pl) {
  const notes = [];
  if (!info?.tiles) return notes;
  for (const k of new Set(pl.keys)) {
    let used = [];
    try { used = (await call("tagSuggest", { prefix: k.replace(/s$/, ""), limit: 50 })).map(([s]) => s); } catch (e) { return notes; }
    if (used.includes(k)) continue;
    const alt = [k + "s", k.replace(/s$/, "")].find(a => a !== k && used.includes(a));
    if (!alt) { notes.push(`No feature in this area has the key ${k}.`); continue; }
    pl.text = pl.text.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=!?=)`, "g"), alt);
    notes.push(`Using the key ${alt}: ${k} isn't used in this area.`);
  }
  return notes;
}
/** The wizard's output with the plain-language extras the grammar can't say (radius, check_date age). */
function adjustWizardQuery(q, { radius, age }) {
  if (radius) q = q.replace(/\{\{radius=\d+\}\}/, `{{radius=${radius}}}`);
  if (age) q = q.replace(/^(\s*(?:nwr|node|way|relation|nw|nr|wr)\b.*?);$/gm,
    `$1(if: t["check_date"] == "" || t["check_date"] < "{{date:${age}}}");`);
  return q;
}
let wizNotes = [];
async function wizBuild(text) {
  wizNotes = [];
  const q = (await nearFeatures(text)) ?? await wizBuildSimple(text, true);
  return q === false ? q : explainQuery(q);
}

// ---- explaining the result: a comment in plain words above each line of the generated query, instead of the
// wizard's "query part for: …", so the query teaches Overpass QL as it's used
let featureNames = null;                     // "amenity=cafe" -> "Cafe", from iD's presets with a single tag
async function loadFeatureNames() {
  if (featureNames) return;
  featureNames = new Map();
  for (const p of Object.values(await presetJSON())) {
    const tags = Object.entries(p.tags || {});
    if (p.name && tags.length === 1 && tags[0][1] !== "*" && !featureNames.has(tags[0].join("="))) featureNames.set(tags[0].join("="), p.name);
  }
}
const TYPE_WORDS = { nwr: "points, lines and areas", node: "points", way: "lines and areas", relation: "relations",
  nw: "points, lines and areas", nr: "points and relations", wr: "lines, areas and relations" };
const unq = (s) => JSON.parse(s.replace(/^'|'$/g, '"'));
/** One [filter] in words. */
function explainFilter(f) {
  let m;
  if ((m = /^\[("(?:[^"\\]|\\.)*")=("(?:[^"\\]|\\.)*")\]$/.exec(f))) { const k = unq(m[1]), v = unq(m[2]); return featureNames?.get(`${k}=${v}`) ? `${featureNames.get(`${k}=${v}`)} (${k}=${v})` : `${k}=${v}`; }
  if ((m = /^\[("(?:[^"\\]|\\.)*")\]$/.exec(f))) return `with a ${unq(m[1])} tag`;
  if ((m = /^\[("(?:[^"\\]|\\.)*")!~"\.\*"\]$/.exec(f))) return `without a ${unq(m[1])} tag`;
  if ((m = /^\[("(?:[^"\\]|\\.)*")!=("(?:[^"\\]|\\.)*")\]$/.exec(f))) return `${unq(m[1])} not ${unq(m[2])}`;
  if ((m = /^\[("(?:[^"\\]|\\.)*")~("(?:[^"\\]|\\.)*")(,i)?\]$/.exec(f))) return `${unq(m[1])} containing “${unq(m[2])}”${m[3] ? " (any case)" : ""}`;
  if ((m = /^\[("(?:[^"\\]|\\.)*")!~("(?:[^"\\]|\\.)*")(,i)?\]$/.exec(f))) return `${unq(m[1])} not containing “${unq(m[2])}”`;
  return f;
}
/** Where a statement looks, in words. */
function explainWhere(w) {
  let m;
  if (w === "({{bbox}})") return "in the map view";
  if (w === "(area.searchArea)") return "inside that area";
  if ((m = /^\(around:\{\{radius\}\},\{\{geocodeCoords:(.+)\}\}\)$/.exec(w))) return `within the radius of ${m[1]}`;
  if ((m = /^\(around\.near:(\d+)\)$/.exec(w))) return `within ${m[1]} m of any of those`;
  if ((m = /^\(if: t\["check_date"\] == "" \|\| t\["check_date"\] < "\{\{date:(.+)\}\}"\)$/.exec(w))) return `whose check_date is missing or more than ${m[1]} old`;
  return w;
}
/** A statement such as nwr["amenity"="cafe"]["wheelchair"!~".*"]({{bbox}}); in words. */
function explainStatement(line) {
  const m = /^\s*(nwr|node|way|relation|nw|nr|wr)((?:\[(?:"(?:[^"\\]|\\.)*"|[^\]])*\])*)((?:\([^;]*?\))*);$/.exec(line);
  if (!m) return null;
  const filters = m[2].match(/\[(?:"(?:[^"\\]|\\.)*"|[^\]])*\]/g) || [];
  const wheres = m[3].match(/\((?:[^()]|\([^()]*\))*\)/g) || [];
  const [first, ...rest] = filters.map(explainFilter);
  return `${first ?? "anything"}${rest.length ? ", " + rest.join(", ") : ""}: ${TYPE_WORDS[m[1]]}${wheres.length ? ", " + wheres.map(explainWhere).join(", ") : ""}`;
}
/** How many statements the union opening at line i holds. */
function unionSize(lines, i) {
  let n = 0;
  for (let j = i + 1; j < lines.length && !/^\s*\)/.test(lines[j]); j++) if (/^\s*(nwr|node|way|relation|nw|nr|wr)\b/.test(lines[j])) n++;
  return n;
}
/** The generated query with a plain-words comment above each line. */
function explainQuery(q) {
  const out = [];
  let m;
  const lines = q.split("\n");
  let radius = null;
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (/^\/\/ (gather results|print results|query part for:|fetch area|adjust the search radius)/.test(t)) continue;   // the wizard's own comments
    const indent = line.match(/^\s*/)[0];
    const say = (text) => out.push(`${indent}// ${text}`);
    if ((m = /^\[out:(\w+)\]\[timeout:(\d+)\](\[bbox:\{\{bbox\}\}\])?;$/.exec(t))) say(`settings: answer as ${m[1].toUpperCase()}, stop after ${m[2]} seconds${m[3] ? ", look only in the map view" : ""}`);
    else if ((m = /^\{\{radius=(\d+)\}\}$/.exec(t))) { radius = m[1]; say(`the radius: ${radius} m`); }
    else if ((m = /^\{\{geocodeArea:(.+)\}\}->\.searchArea;$/.exec(t))) say(`the area called ${m[1]}, found by name in the saved data`);
    else if (t === "(") { if (unionSize(lines, i) > 1) say("all of these together (a union):"); }
    else if (t === ")->.near;") say("the results above are kept as the set “near”");
    else if (t === "out geom;") say("output: each result with its full geometry");
    else if (t === "out center;") say("output: one point for each result (the centre of lines and areas)");
    else if (t === "out;" || t === "out body;") say("output: the results with their tags");
    else { const e = explainStatement(t); if (e) say(radius ? e.replace("within the radius of", `within ${radius} m of`) : e); }
    out.push(line);
  }
  return out.join("\n");
}
/** One wizard query (with the plain-language extras), or false. */
async function wizBuildSimple(text, comment) {
  const outputMode = document.querySelector('input[name="wiz-out"]:checked').value;
  if (!wizPresets) wizPresets = await presetJSON();
  const opts = { comment, globalBbox: false, outputMode, timeout: 25, freeFormPresets: wizPresets };
  const pl = plainLanguage(text.replace(ARTICLE_START, ""));
  wizNotes.push(...await resolveKeys(pl));
  let q = false;
  for (const attempt of new Set([pl.text, wizQuote(pl.text), wizQuote(singularize(pl.text))])) {   // as typed, quoted, singular
    q = OverpassWizard(attempt, opts);
    if (q !== false) break;
  }
  if (q === false) return q;
  q = q.replace(/(The original search was:\n)“[^\n]*”/, (m, lead) => `${lead}“${text.replace(/\*\//g, "* /")}”`);   // their words, not the quoted rewrite
  return adjustWizardQuery(q, pl);
}
// "cafe within 200 m of pub", "bench near playground": near features of a kind, not a place. The wizard's "around"
// only knows places ({{geocodeCoords:…}}), so this becomes two steps: those features in the view, then the
// others within the radius of any of them. When the part after "of" isn't a kind of feature (a place name such
// as "Leith"), the wizard's own "around" handles it.
const NEAR_DEFAULT_M = 100;
const NEAR = /^(.+?)\s+(?:within\s+(\d+(?:\.\d+)?)\s*(m|km|metres?|meters?|kilometres?|kilometers?)\s+of|near)\s+(.+)$/i;
const statementsOf = (q) => (/\(\n([\s\S]*?)\n\);/.exec(q) || [])[1];
async function nearFeatures(text) {
  const m = NEAR.exec(text);
  if (!m || /\b(in|around|global)\b/i.test(m[4])) return null;
  const [, a, n, unit, b] = m;
  const radius = n ? Math.round(parseFloat(n) * (/^k/i.test(unit) ? 1000 : 1)) : NEAR_DEFAULT_M;
  const qb = await wizBuildSimple(b, false);
  if (qb === false || /geocode/.test(qb)) return null;              // not a kind of feature: a place
  const qa = await wizBuildSimple(a, false);
  const sa = qa && statementsOf(qa), sb = statementsOf(qb);
  if (!sa || !sb || !/\{\{bbox\}\}/.test(sa)) return null;
  const outLine = (/^out\b[^;]*;/m.exec(qa) || ["out geom;"])[0];
  return `/*\nGenerated by the wizard from: “${text.replace(/\*\//g, "* /")}”\n*/\n[out:json][timeout:25];\n` +
    `(\n${sb}\n)->.near;\n` +
    `(\n${sa.replace(/\(\{\{bbox\}\}\)/g, `(around.near:${radius})`)}\n);\n${outLine}`;      // explainQuery adds the comments
}
async function wizPreview() {
  const text = wizIn.value.trim(), msg = document.getElementById("wiz-msg"), out = document.getElementById("wiz-out");
  msg.innerHTML = ""; out.hidden = true;
  if (!text) return null;
  const q = await wizBuild(text);
  if (q === false) {
    const left = text.replace(/\s+(in|around)\s+.*$/i, "").replace(/^["']|["']$/g, "");
    let hint = "";
    try { const s = OverpassWizard.presetSearch(await presetJSON()).fuzzy_search({ free: left }); if (s) hint = s; } catch (e) {}
    msg.innerHTML = `<div class="dl-msg err">Couldn't make a query from that.${hint ? ` Did you mean <button id="wiz-hint">${esc(hint)}</button>?` : " Try a tag such as amenity=cafe, or a feature name such as Drinking Water."}</div>`;
    if (hint) document.getElementById("wiz-hint").onclick = () => { wizIn.value = text.replace(left, hint); wizPreview(); };
    return null;
  }
  out.textContent = q; out.hidden = false;
  if (wizNotes.length) msg.innerHTML = wizNotes.map(n => `<div class="muted">${esc(n)}</div>`).join("");
  wizCount(q);
  return q;
}
// ---- live count: the query, run as out count on the map view, while you type (the engine answers in milliseconds)
let wizCountSeq = 0;
async function wizCount(q) {
  const el = document.getElementById("wiz-count"), seq = ++wizCountSeq;
  if (!info?.tiles) { el.textContent = ""; return; }
  el.textContent = "Counting…";
  noteView();
  const v = lastView || { bbox: null, center: null };
  try {
    const r = await call("run", { query: q.replace(/^(\s*)out\b[^;]*;/gm, "$1out count;"), bbox: v.bbox, center: v.center });
    if (seq !== wizCountSeq) return;
    const c = r.elements.filter(e => e.type === "count"), n = (k) => c.reduce((a, e) => a + Number(e.tags[k] || 0), 0);
    const where = /\{\{bbox\}\}/.test(q) ? "in the map view" : "in the saved area";
    el.textContent = `${n("total").toLocaleString()} found ${where} (${n("nodes").toLocaleString()} points, ${n("ways").toLocaleString()} ways, ${n("relations").toLocaleString()} relations)`;
  } catch (e) { if (seq === wizCountSeq) el.textContent = e.kind === "stopped" ? "" : "Can't count this yet: " + e.message.slice(0, 140); }
}
// ---- suggestions from the saved area: keys after a word, values after key=
const WIZ_SUGGEST_MIN = 2;                     // letters typed before keys are suggested
const WIZ_KEYS_MAX = 6, WIZ_VALUES_MAX = 10;
let wizSuggestSeq = 0;
async function wizSuggest() {
  const box = document.getElementById("wiz-suggest"), seq = ++wizSuggestSeq;
  const before = wizIn.value.slice(0, wizIn.selectionStart ?? wizIn.value.length);
  box.innerHTML = "";
  // The words since the last joining word, and which word that was:
  //   start, and, or, ( : a key (only for the first word, so "drinking water" doesn't become waterway=) or
  //                        iD's feature names, which need neither a saved area nor a word being typed
  //   with, without      : a key only, inserted as words ("pub without a toilets tag")
  //   of, near           : iD's feature names only ("cafe within 200 m of a pub")
  const parts = before.split(/\b(and|or|without|with|of|near)\b|\(/i);
  const segment = parts.pop().replace(/^\s*(?:type:\w+\s+)?(?:(?:a|an|the|any|some)\s+)?/i, "");
  const joiner = (parts.pop() ?? "").toLowerCase();
  const keyOnly = joiner === "with" || joiner === "without", featuresOnly = joiner === "of" || joiner === "near";
  if (!keyOnly && !/[=~!*]/.test(segment) && segment.trim().length >= WIZ_SUGGEST_MIN) showPresetSuggestions(box, segment, before.length - segment.length, before.length, seq);
  if (featuresOnly) return;
  const m = /(?:^|[\s(])([\w:]+)(?:(!?=|~)([^\s()"]*))?$/.exec(before);
  if (!m || !info?.tiles) return;
  const [, key, op, value = ""] = m;
  const valueMode = op === "=" || op === "!=";
  const firstWord = !/\s/.test(segment.trim());
  if (!valueMode && (op || !firstWord || key.length < WIZ_SUGGEST_MIN)) return;
  let list = [];
  try { list = await call("tagSuggest", valueMode ? { key, prefix: value, limit: WIZ_VALUES_MAX } : { prefix: key, limit: WIZ_KEYS_MAX }); } catch (e) { return; }
  if (seq !== wizSuggestSeq) return;
  const start = before.length - m[0].length + m[0].indexOf(key);
  // after with/without, a key completes to "a toilets tag", so the input says what the query means
  const tagWords = (s) => `${/\b(?:a|an|any)\s+$/i.test(before.slice(0, start)) ? "" : "a "}${s} tag`;
  for (const [s, count] of list) {
    if (valueMode && s === value) continue;
    const b = document.createElement("button");
    b.append(valueMode ? `${key}${op}${s}` : keyOnly ? tagWords(s) : `${s}=`);
    const small = document.createElement("small"); small.textContent = count.toLocaleString(); b.append(small);
    b.title = valueMode ? `${count.toLocaleString()} features in the saved area have ${key}=${s}` : `${count.toLocaleString()} features in the saved area have ${s}`;
    b.onclick = () => {
      const ins = valueMode ? `${key}${op}${/[\s()]/.test(s) ? JSON.stringify(s) : s}` : keyOnly ? tagWords(s) : `${s}=`;
      wizIn.value = wizIn.value.slice(0, start) + ins + wizIn.value.slice(before.length);
      wizIn.focus(); wizIn.setSelectionRange(start + ins.length, start + ins.length);
      wizSuggest(); clearTimeout(wizTimer); wizTimer = setTimeout(wizPreview, 150);
    };
    box.appendChild(b);
  }
}
// iD's feature names ("Drinking Water", "Bakery") that start with, or have a word starting with, the typed words
const WIZ_PRESET_MAX = 4;
let presetNames = null;
async function showPresetSuggestions(box, segment, from, to, seq) {
  presetNames ??= Object.values(await presetJSON()).filter(p => p.name && p.searchable !== false)
    .map(p => ({ name: p.name, lower: p.name.toLowerCase(), tags: Object.entries(p.tags || {}).map(([k, v]) => `${k}=${v}`).join(" ") }));
  if (seq !== wizSuggestSeq) return;                 // typed on meanwhile
  const words = segment.trim().toLowerCase();
  if (!words || /[=~!*]/.test(words) || /\b(in|around|global)\b/.test(words)) return;
  const hits = presetNames.filter(p => p.lower.startsWith(words) || p.lower.includes(" " + words))
    .sort((a, b) => (b.lower.startsWith(words) - a.lower.startsWith(words)) || a.name.length - b.name.length).slice(0, WIZ_PRESET_MAX);
  const buttons = [];
  for (const p of hits) {
    if (p.lower === words) continue;
    const b = document.createElement("button");
    b.append(p.name); const small = document.createElement("small"); small.textContent = p.tags; b.append(small);
    b.title = "iD's feature name for " + p.tags;
    b.onclick = () => {
      const lead = segment.match(/^\s*/)[0];
      wizIn.value = wizIn.value.slice(0, from) + lead + p.name + wizIn.value.slice(to);
      wizIn.focus(); clearTimeout(wizTimer); wizTimer = setTimeout(wizPreview, 100); box.innerHTML = "";
    };
    buttons.push(b);
  }
  box.prepend(...buttons);                         // feature names first, best match first, then the keys
}
let wizTimer = null;
wizIn.addEventListener("input", () => { clearTimeout(wizTimer); wizTimer = setTimeout(wizPreview, 250); wizSuggest(); });
document.querySelectorAll('input[name="wiz-out"]').forEach(r => r.onchange = wizPreview);
async function wizUse(andRun) {
  const q = await wizPreview();
  if (!q) { wizIn.focus(); return; }
  cm.setValue(q); wizov.hidden = true;
  if (andRun) run();
}
document.getElementById("wiz-insert").onclick = () => wizUse(false);
document.getElementById("wiz-run").onclick = () => wizUse(true);
wizIn.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); wizUse(true); } });
