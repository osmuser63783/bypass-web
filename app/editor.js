// SPDX-License-Identifier: AGPL-3.0-or-later
// Bypass Web, app/editor.js: The query editor (CodeMirror 6), the Examples menu with saved queries, and the About dialogue.
// An ES module, loaded through app/main.js; it imports what it uses from the other modules and ui-map.js.
import { button, DEFAULT_QUERY, flash, LS, setStatus } from "./core.js";
import { run } from "./run.js";
import { EditorState } from "../vendor/codemirror-6/state.js";
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from "../vendor/codemirror-6/view.js";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "../vendor/codemirror-6/commands.js";
import { bracketMatching, HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from "../vendor/codemirror-6/language.js";
import { tags } from "../vendor/codemirror-6/lezer-highlight.js";

// ---- editor: CodeMirror 6 on every screen (it edits through the browser's own text input, so phones keep their
// selection handles, copy and paste and keyboard, which CodeMirror 5 fought), with a small Overpass QL mode
const OVERPASS_KEYWORDS = /^(?:node|way|relation|rel|nwr|nw|nr|wr|area|derived|out|make|convert|foreach|for|if|else|complete|is_in|map_to_area|local|timeline|retro|compare)\b/;
const OVERPASS_WORDS = /^(?:body|skel|ids|tags|meta|count|geom|bb|center|qt|asc|noids|around|poly|pivot|bbox|timeout|maxsize|date|diff|adiff|csv|json|xml|popup)\b/;
const FRONT_MATTER_FENCE = /^---\s*$/;             // YAML front matter (styling, as in Overpass Ultra)
const overpassQL = StreamLanguage.define({
  name: "overpassql",
  startState: () => ({ mode: "query" }),            // "query", "comment" (inside /* */) or "front" (front matter)
  copyState: (st) => ({ mode: st.mode }),
  token(stream, st) {
    if (st.mode === "comment") {
      if (stream.skipTo("*/")) { stream.pos += 2; st.mode = "query"; } else stream.skipToEnd();
      return "comment";
    }
    if (st.mode === "front") {
      if (stream.sol() && stream.match(FRONT_MATTER_FENCE)) { st.mode = "query"; return "meta"; }
      if (stream.match(/^#.*/)) return "comment";
      if (stream.match(/^[\w-]+(?=:)/)) return "variable-2";
      if (stream.match(/^"(?:[^\\"]|\\.)*"?/)) return "string";
      stream.next();
      return null;
    }
    if (stream.sol() && stream.match(FRONT_MATTER_FENCE)) { st.mode = "front"; return "meta"; }
    if (stream.match("/*")) { st.mode = "comment"; return "comment"; }
    if (stream.match(/^\/\/.*/)) return "comment";
    if (stream.match(/^"(?:[^\\"]|\\.)*"?/) || stream.match(/^'(?:[^\\']|\\.)*'?/)) return "string";
    if (stream.match(/^\{\{[\s\S]*?\}\}/)) return "meta";
    if (stream.match(OVERPASS_KEYWORDS)) return "keyword";
    if (stream.match(OVERPASS_WORDS)) return "variable-2";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i)) return "number";
    if (stream.match(/^(?:->|!=|!~|=|~|<<|>>|<|>|\.|::|&&|\|\||!)/)) return "operator";
    if (stream.match(/^\w+/)) return null;            // a whole other word, so "layout" doesn't colour its "out"
    stream.next();
    return null;
  },
});
// The token colours are the page's own (.cm-keyword etc. in index.html, light and dark)
const overpassColours = HighlightStyle.define([
  { tag: tags.keyword, class: "cm-keyword" }, { tag: tags.string, class: "cm-string" },
  { tag: tags.number, class: "cm-number" }, { tag: tags.comment, class: "cm-comment" },
  { tag: tags.operator, class: "cm-operator" }, { tag: tags.special(tags.variableName), class: "cm-variable-2" },
  { tag: tags.meta, class: "cm-meta" },
]);
// Touch screens: share sheets, map-app links and no JOSM button (results.js, share.js); no focus on a new query
const TOUCH = matchMedia("(pointer: coarse)").matches;
const changeHandlers = [];
const view = new EditorView({
  parent: document.getElementById("editor"),
  state: EditorState.create({
    doc: LS.get("query", DEFAULT_QUERY),
    extensions: [
      lineNumbers(), highlightSpecialChars(), history(), drawSelection(), bracketMatching(),
      indentUnit.of("  "), EditorView.lineWrapping,
      overpassQL, syntaxHighlighting(overpassColours),
      keymap.of([{ key: "Mod-Enter", run: () => { run(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({ "aria-label": "Overpass query", autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
      EditorView.updateListener.of(u => {
        if (!u.docChanged) return;
        const origin = u.transactions.some(t => t.isUserEvent("setValue")) ? "setValue" : "input";
        for (const f of changeHandlers) f(null, { origin });
      }),
    ],
  }),
});
/** The editor as the rest of the page uses it: a query loaded by setValue() reports origin "setValue". */
const cm = {
  getValue: () => view.state.doc.toString(),
  setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "setValue" }),
  focus: () => view.focus(),
  refresh: () => view.requestMeasure(),
  on: (ev, f) => { if (ev === "change") changeHandlers.push(f); },
  view,
};
cm.on("change", () => LS.set("query", cm.getValue()));
let queryLoads = 0;                       // queries put in the editor (examples, saved queries, links), for run.js
cm.on("change", (_, ch) => { if (ch?.origin === "setValue") queryLoads++; });
const sel = document.getElementById("examples");
/** The examples menu, by group, after the saved queries. */
function fillExamples() {
  sel.innerHTML = '<option value="">Examples…</option>';
  const saved = savedQueries();
  if (saved.length) {
    const g = document.createElement("optgroup"); g.label = "Saved queries";
    saved.forEach((x, i) => { const o = document.createElement("option"); o.value = "s" + i; o.textContent = x.name; g.appendChild(o); });
    const o = document.createElement("option"); o.value = "manage"; o.textContent = "Rename or delete saved queries…"; g.appendChild(o);
    sel.appendChild(g);
  }
  const groups = new Map();
  for (const [i, x] of EXAMPLES.entries()) {
    if (!groups.has(x.group)) { const g = document.createElement("optgroup"); g.label = x.group; groups.set(x.group, g); sel.appendChild(g); }
    const o = document.createElement("option"); o.value = i; o.textContent = x.name;
    groups.get(x.group).appendChild(o);
  }
}
// ---- saved queries (as Overpass Turbo's Save/Load): kept in this browser, listed at the top of Examples
function savedQueries() { try { return JSON.parse(LS.get("saved", "[]")); } catch (e) { return []; } }
function storeSaved(list) { LS.set("saved", JSON.stringify(list)); fillExamples(); }
/** A name for the editor's query: its first comment, or the date. */
function defaultQueryName(q) {
  const c = /^\s*\/\/\s*(.+)$/m.exec(q.replace(/^---[\s\S]*?\n---\s*\n/, ""));
  return c ? c[1].slice(0, 60) : "Query of " + new Date().toLocaleDateString();
}
document.getElementById("savebtn").onclick = (ev) => {
  const q = cm.getValue();
  if (!q.trim()) { setStatus("Nothing to save: the editor is empty.", "err"); return; }
  const name = prompt("Name for this query:", defaultQueryName(q));
  if (name === null || !name.trim()) return;
  const list = savedQueries(), at = list.findIndex(x => x.name === name.trim());
  if (at >= 0 && !confirm(`Replace the saved query “${name.trim()}”?`)) return;
  const entry = { name: name.trim().slice(0, 80), query: q, saved: Date.now() };
  if (at >= 0) list[at] = entry; else list.unshift(entry);
  storeSaved(list);
  flash(ev.currentTarget, "Saved");
  setStatus(`Saved “${entry.name}”: it's at the top of Examples.`, "ok");
};
const savedov = document.getElementById("savedov");
function openSaved() {
  const list = savedQueries(), t = document.getElementById("sv-list");
  t.innerHTML = list.length ? "" : '<tr><td class="muted">None yet: Save in the toolbar keeps the query in the editor.</td></tr>';
  list.forEach((x, i) => {
    const tr = document.createElement("tr"), name = document.createElement("td"), when = document.createElement("td"), acts = document.createElement("td");
    name.textContent = x.name; when.className = "muted"; when.textContent = new Date(x.saved).toLocaleDateString();
    const div = document.createElement("div"); div.className = "acts";
    div.append(button("Load", () => { cm.setValue(x.query); savedov.hidden = true; }),
      button("Rename", () => { const n = prompt("New name:", x.name); if (n && n.trim()) { list[i].name = n.trim().slice(0, 80); storeSaved(list); openSaved(); } }),
      button("Delete", () => { if (confirm(`Delete the saved query “${x.name}”?`)) { list.splice(i, 1); storeSaved(list); openSaved(); } }));
    acts.append(div); tr.append(name, when, acts); t.append(tr);
  });
  savedov.hidden = false;
}
document.getElementById("sv-close").onclick = () => { savedov.hidden = true; };
savedov.addEventListener("click", ev => { if (ev.target === savedov) savedov.hidden = true; });
document.addEventListener("keydown", ev => { if (ev.key === "Escape") savedov.hidden = true; });
fillExamples(true);

// ---- About this page (privacy, source code, credits): a static dialogue in index.html
const privov = document.getElementById("privov");
document.getElementById("privbtn").onclick = () => { privov.hidden = false; };
document.getElementById("pv-close").onclick = () => { privov.hidden = true; };
privov.addEventListener("click", ev => { if (ev.target === privov) privov.hidden = true; });
document.addEventListener("keydown", ev => { if (ev.key === "Escape") privov.hidden = true; });
sel.onchange = () => {
  const v = sel.value; sel.value = "";
  if (v === "") return;
  if (v === "manage") { openSaved(); return; }
  cm.setValue(v[0] === "s" ? savedQueries()[+v.slice(1)]?.query ?? "" : EXAMPLES[+v].q);
  if (!TOUCH) cm.focus();                         // on a phone, focus would pop up the keyboard
};   // on a phone, focus would pop up the keyboard

export { cm, fillExamples, queryLoads, TOUCH };
