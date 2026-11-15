// SPDX-License-Identifier: AGPL-3.0-or-later
// The Overpass QL parser (a port of ql.py, piece by piece): settings, tokens, statements -> a statement list
// for Engine.run. Split out of engine.js; the engine imports parse().

import { Unsupported } from './errors.js';
import { parseExpr, strtod } from './expr.js';

function tokenize(src) {
  const toks = [];
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(->|::|!=|!~|==|<=|>=|&&|\|\||~|=|[()\[\];,.:!<>{}+\-*\/%?|&^])/y;
  // ql.py string(): a backslash keeps the next character (\n and \t are newline and tab)
  const unescape = (s) => s.replace(/\\(.)/gs, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  let m;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    if (!(m = re.exec(src))) {                    // any other character is a token of its own, as in Overpass
      toks.push({ t: 'p', v: String.fromCodePoint(src.codePointAt(at)), at, end: at + String.fromCodePoint(src.codePointAt(at)).length });
      re.lastIndex = toks.at(-1).end;
      continue;
    }
    if (m[1] !== undefined) toks.push({ t: 'str', v: unescape(m[1]), at, end: re.lastIndex });
    else if (m[2] !== undefined) toks.push({ t: 'str', v: unescape(m[2]), at, end: re.lastIndex });
    else if (m[3] !== undefined) toks.push({ t: 'num', v: m[3], at, end: re.lastIndex });
    else if (m[4] !== undefined) toks.push({ t: 'id', v: m[4], at, end: re.lastIndex });
    else if (m[5] !== undefined) toks.push({ t: 'p', v: m[5], at, end: re.lastIndex });
  }
  return toks;
}

// Overpass compiles regexes as POSIX ERE: Perl-only syntax is a static error there, and POSIX bracket
// classes need translating (ql.py _regex, _posix_classes)
const POSIX = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t', punct: '!-/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: ' -~', graph: '!-~' };
function regex(pattern, ci) {
  if (pattern.includes('(?')) throw new SyntaxError(`static error: Invalid regular expression: "${pattern}"`);
  const p = pattern.replace(/\[:([a-z]+):\]/g, (m, c) => POSIX[c] ?? m);
  try { return new RegExp(p, ci ? 'i' : ''); } catch (e) { throw new SyntaxError(`static error: Invalid regular expression: "${pattern}"`); }
}

const QUERY_TYPES = { node: ['node'], way: ['way'], relation: ['relation'], rel: ['relation'],
  nwr: ['node', 'way', 'relation'], nw: ['node', 'way'], wr: ['way', 'relation'], nr: ['node', 'relation'], area: ['area'], derived: ['derived'] };
// ql.py _RECURSION_RESULTS: what each recursion filter can produce
const RECURSION_RESULTS = { r: [null, 'nodes, ways, or relations'], w: [['node'], 'nodes'], br: [['relation'], 'relations'],
  bw: [['relation'], 'relations'], bn: [['way', 'relation'], 'ways or relations'] };

// ---- settings ([out:…][timeout:…][bbox:…];), from the raw text as ql.py _settings does -----------------

const UNSUPPORTED_SETTINGS = { date: "historical queries need OSM's edit history, which the local copy doesn't keep",
  diff: "diff queries need OSM's edit history, which the local copy doesn't keep",
  adiff: "diff queries need OSM's edit history, which the local copy doesn't keep" };

/** Index of the ']' closing a setting, skipping brackets and quotes inside it (ql.py _setting_end). */
function settingEnd(t, i) {
  let depth = 0, q = null;
  for (; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { if (depth === 0 && c === ']') return i; depth--; }
  }
  return -1;
}

/** Overpass's decode_json for a quoted token: \n \t \uXXXX, and \x for any other character x. */
function decodeJson(t) {
  return t.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (m, c) => c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' ? '\n' : c === 't' ? '\t' : c);
}

/** [out:csv(fields; header; separator)] (ql.py _csv_spec). */
function csvSpec(raw) {
  raw = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const m = /^csv\s*\(([\s\S]*)\)\s*$/.exec(raw);
  if (!m) throw new SyntaxError('expected [out:csv(fields; header; separator)]');
  const parts = [];
  let cur = '', q = null;
  for (const c of m[1]) {
    if (q) { cur += c; if (c === q) q = null; }
    else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === ';') { parts.push(cur); cur = ''; }
    else cur += c;
  }
  parts.push(cur);
  if (/[\u201c\u201d\u2018\u2019]/.test(parts[0])) throw new SyntaxError('CSV format specification expected (typographic quotes are not quotes)');
  const fields = [];
  for (let f of parts[0].split(',')) {
    f = f.trim();
    const pre = f.startsWith('::') ? '::' : '';
    f = f.slice(pre.length).trim();
    if (f && (f[0] === '"' || f[0] === "'") && f.at(-1) === f[0] && f.length >= 2) f = decodeJson(f.slice(1, -1));
    else if (pre && f.includes(':')) throw new SyntaxError("parse error: ',', ';', or ')'  expected - ':' found.");   // ::"count:nodes" needs quotes
    f = pre + f;
    if (f) fields.push(f);
  }
  if (!fields.length) throw new SyntaxError("parse error: CSV format specification expected - ')' found.");      // the field list is empty
  let header = true;
  if (parts.length > 1 && parts[1].trim()) header = parts[1].trim().toLowerCase() !== 'false';
  let sep = '\t';
  if (parts.length > 2 && parts[2].trim()) sep = parts[2].trim().replace(/^["']+|["']+$/g, '').replace(/\\t/g, '\t');
  return { fields, header, sep };
}

/** output_popup_factory.cc: ("title"; [k=v][k2~re]; [k3]; "title key";) ... (ql.py _popup_spec). */
function popupSpec(raw) {
  const toks = [];
  const re = /\s*(?:("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(!=|[()\[\];!~=])|([^\s()\[\];!~="']+))/g;
  let m;
  while ((m = re.exec(raw)) && m[0] !== '') {
    if (m[1]) toks.push(['s', m[1].slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'")]);
    else if (m[2]) toks.push(['p', m[2]]);
    else if (m[3]) toks.push(['s', m[3]]);
  }
  let k = 0;
  const peek = () => toks[k] ?? ['', ''];
  const isTok = (t, v) => peek()[0] === t && peek()[1] === v;
  const until = (stops, consume = true) => {
    while (k < toks.length && !(toks[k][0] === 'p' && stops.includes(toks[k][1]))) k++;
    if (consume && k < toks.length) k++;
  };
  const cats = [];
  until(['(', ']'], false);
  while (isTok('p', '(')) {
    k++;
    const cat = { title: peek()[1], conjs: [], titleKey: '' };
    k++;
    if (isTok('p', ';')) until([';', ')'], true); else until([';', ')']);
    while (isTok('p', '[')) {
      const conj = [];
      while (isTok('p', '[')) {
        k++;
        if (peek()[0] !== 's') throw new SyntaxError(`parse error: Key expected - '${peek()[1]}' found.`);
        const key = peek()[1];
        k++;
        let value = '.', straight = true;
        until(['!', '~', '=', '!=', ']'], false);
        if (isTok('p', '!')) { straight = false; k++; until(['~', '=', ']'], false); }
        if ((peek()[1] === '=' || peek()[1] === '!=') && peek()[0] === 'p') { straight = peek()[1] === '='; k++; value = '^' + peek()[1] + '$'; k++; }
        else if (isTok('p', '~')) { k++; value = peek()[1]; k++; }
        until([']']);
        conj.push([key, value, straight]);
      }
      until([';']);
      cat.conjs.push(conj);
    }
    if (!isTok('p', ')')) { cat.titleKey = peek()[1]; k++; until([';']); }
    until([')']);
    cats.push(cat);
  }
  return cats;
}

/** eval_number_with_suffix (ql.py limits.number_with_suffix): C strtoll base 0, then ki/Mi/Gi or k/M/G; 0 for
 *  anything Overpass can't read. */
function numberWithSuffix(text) {
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)/.exec(text);
  if (!m) return 0;
  const digits = m[2];
  const v = (m[1] === '-' ? -1 : 1) * (/^0[xX]/.test(digits) ? parseInt(digits, 16) : digits.length > 1 && digits[0] === '0' ? parseInt(digits, 8) : Number(digits));
  let rest = text.slice(m[0].length);
  if (!rest) return v;
  if (rest.startsWith(' ')) rest = rest.slice(1);
  const f = { ki: 1024, Mi: 1 << 20, Gi: 1 << 30, k: 1000, M: 1e6, G: 1e9 }[rest];
  return f ? v * f : 0;
}

// A token as Overpass's tokenizer reads it (for "X expected - Y found" and unquoted setting values)
const FOUND = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z_0-9]*|[-+]?(?:\d+\.?\d*|\.\d+)|->|::|\S/;

const SETTING_NUMBER_ERROR = a => `static error: For the attribute "${a}" of the element "osm-script" the only allowed values are positive integers optionally with suffix "ki", "Mi", or "Gi".`;

function parseSettings(src) {
  let i = 0, seen = false;
  const settings = { out: 'json', outGiven: false };
  const skip = () => {
    for (;;) {
      const m = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(src.slice(i, i + 100000));
      if (!m) return;
      i += m[0].length;
    }
  };
  const expectChar = (c) => {
    skip();
    if (src[i] !== c) throw new SyntaxError(`parse error: '${c}' expected - '${src.slice(i).match(FOUND)?.[0] ?? ''}' found.`);
    i++;
  };
  skip();
  while (src[i] === '[') {
    seen = true;
    i++; skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) throw new SyntaxError('expected a setting name');
    const name = m[0];
    i += name.length;
    expectChar(':');
    if (name in UNSUPPORTED_SETTINGS) throw new Unsupported(`[${name}:…]: ${UNSUPPORTED_SETTINGS[name]}`);
    if (!['out', 'timeout', 'maxsize', 'bbox'].includes(name)) throw new SyntaxError(`static error: Unknown attribute "${name}" in element "osm-script".`);
    if (name === 'bbox') {
      const j = settingEnd(src, i);
      const vals = src.slice(i, j).split(',').map(v => Number(v.trim()));
      if (vals.length < 4) throw new SyntaxError('static error: A bounding box needs four comma-separated values.');
      if (vals.length > 4) throw new SyntaxError("parse error: ']' expected - ',' found.");
      if (vals.some(Number.isNaN)) throw new SyntaxError('expected [bbox:south,west,north,east]');
      if (!(vals[0] >= -90 && vals[0] <= 90 && vals[2] >= -90 && vals[2] <= 90)) throw new SyntaxError('static error: Latitudes in bounding boxes must be between -90.0 and 90.0.');
      if (!(vals[1] >= -180 && vals[1] <= 180 && vals[3] >= -180 && vals[3] <= 180)) throw new SyntaxError('static error: Longitudes in bounding boxes must be between -180.0 and 180.0.');
      const [sv, w, n, e] = vals;
      settings.bbox = { kind: 'bbox', s: sv, w, n, e };
      i = j;
    } else {
      const j = settingEnd(src, i);
      if (j < 0) throw new SyntaxError("expected ']'");
      const raw = src.slice(i, j).trim();
      settings[name] = raw.replace(/^["']+|["']+$/g, '');
      // parse_setup joins the tokens with blanks: 1Gi is "1 Gi", 0x10 is "0 x10" (refused); quoted, strtoll base 0
      if ((name === 'timeout' || name === 'maxsize') && !/^["']/.test(raw)) settings[name] = (raw.match(new RegExp(FOUND.source, 'g')) ?? []).join(' ');
      if ((name === 'timeout' || name === 'maxsize') && numberWithSuffix(settings[name]) <= 0) {
        throw new SyntaxError(SETTING_NUMBER_ERROR(name === 'timeout' ? 'timeout' : 'element-limit'));
      }
      if (name === 'out') settings.outGiven = true;
      i = j;
    }
    expectChar(']');
    skip();
  }
  if (seen) expectChar(';');
  const fmt = settings.out;
  if (fmt.startsWith('csv')) { settings.csv = csvSpec(fmt); settings.out = 'csv'; }
  else if (fmt.startsWith('popup')) { settings.popup = popupSpec(fmt.slice(5)); settings.out = 'popup'; }
  else if (fmt.startsWith('custom')) throw new Unsupported('[out:custom]: it fills templates stored on the Overpass server');
  else if (fmt !== 'json' && fmt !== 'xml') throw new SyntaxError(`parse error: Unknown output format: ${fmt.split('(')[0]}`);
  return { settings, rest: i };
}

const AROUND_RADIUS_ERROR = 'static error: For the attribute "radius" of the element "around" the only allowed ' +
  'values are nonnegative floats.';
const AROUND_LAT_ERROR = 'static error: For the attribute "lat" of the element "around" the only ' +
  'allowed values are floats between -90.0 and 90.0 or an empty value.';
const AROUND_LON_ERROR = 'static error: For the attribute "lon" of the element "around" the only ' +
  'allowed values are floats between -1800.0 and 180.0 or an empty value.';          // sic, as Overpass says it

/** `istream >> double`: [value, position, stream still good]. A failed read gives 0 and a bad stream; reaching
 *  the end of the text also leaves it not good (eofbit) (ql.py _stream_double). */
function streamDouble(text, pos) {
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(pos));
  if (!m) return [0, pos, false];
  return [Number(m[0]), pos + m[0].length, pos + m[0].length < text.length];
}

function aroundPoint(lat, lon) {
  if (!(lat >= -90 && lat <= 90)) throw new SyntaxError(AROUND_LAT_ERROR);
  if (!(lon >= -180 && lon <= 180)) throw new SyntaxError(AROUND_LON_ERROR);
  return [lat, lon];
}

export function parse(src) {
  const { settings, rest } = parseSettings(src);
  const body = src.slice(rest);
  const toks = tokenize(body);
  let i = 0;
  const peek = (k = 0) => toks[i + k];
  const isP = (v, k = 0) => peek(k)?.t === 'p' && peek(k).v === v;
  const isId = (v, k = 0) => peek(k)?.t === 'id' && peek(k).v === v;
  const found = () => { const t = peek() ?? toks.at(-1); return t ? body.slice(t.at, t.end) : ''; };
  const expect = (v) => { if (!isP(v)) throw new SyntaxError(`parse error: '${v}' expected - '${found()}' found.`); i++; };
  const word = () => { const t = toks[i++]; if (!t || t.t === 'p') throw new SyntaxError(`expected a value near token ${i}`); return t.v; };
  const num = () => {
    const neg = isP('-') ? (i++, -1) : 1;
    if (isP('.') && peek(1)?.t === 'num' && peek(1).at === peek().end && /^\d/.test(peek(1).v)) { i++; return neg * Number('.' + word()); }
    return neg * Number(word());
  };
  /** A set name after `.`: Overpass wants an identifier (`.1` and `."x"` are refused). */
  const setName = () => {
    if (peek()?.t !== 'id') throw new SyntaxError(`parse error: Variable expected - '${found()}' found.`);
    return word();
  };
  // around.cc reads its arguments through C atof: a placeholder such as `latNode1` is 0 (ql.py _atof)
  const atof = () => { const neg = isP('-') ? (i++, -1) : 1; const [v, end] = strtod(word()); return end ? neg * v : 0; };
  // Unquoted keys and values are letters, digits and '_' only, as in Overpass: ["addr:street"] needs the
  // quotes, and [addr:street] is a parse error there too (ql.py _UNQUOTED).
  const tagWord = () => {
    const v = word();
    if (isP(':')) throw new SyntaxError("parse error: '!', '~', '=', '!=', or ']'  expected - ':' found.");      // sic: two blanks, as Overpass
    return v;
  };
  const intList = () => { const out = [num()]; while (isP(',')) { i++; out.push(num()); } return out; };
  // > >> < << (two adjacent tokens for the doubled forms)
  const recOp = () => {
    const a = toks[i++].v;
    if (isP(a) && peek().at === toks[i - 1].end) { i++; return a + a; }
    return a;
  };

  // Overpass requires ';' after every statement, the last one too; after a block's closing bracket it's optional
  const endStatement = (st) => {
    if (st.block) { if (isP(';')) i++; return; }
    if (!isP(';')) throw new SyntaxError(`parse error: ';' expected - '${found()}' found.`);
    i++;
  };
  const statements = () => {
    const out = [];
    while (i < toks.length && !isP(')') && !isP('}')) {
      const st = statement();
      endStatement(st);
      out.push(st);
    }
    return out;
  };
  /** The statements of a block: `{ … }` or `( … )` (a block left open at the end of the query still runs). */
  const blockBody = () => {
    const close = isP('{') ? '}' : isP('(') ? ')' : null;
    if (!close) throw new SyntaxError(`parse error: '(' or '{' expected - '${found()}' found.`);
    i++;
    const out = [];
    while (!isP(close)) {
      if (!peek()) return out;
      const st = statement();
      endStatement(st);
      out.push(st);
    }
    i++;
    return out;
  };
  /** make/convert <type> key=expr, ... (ql.py _make), read from the raw text. */
  function makeStatement(from) {
    const kind = word();
    if (!peek() || isP(';') || isP('->')) throw new SyntaxError('static error: The attribute type must be set to a nonempty string.');
    if (peek().t !== 'id') throw new SyntaxError(`parse error: Element class name expected - '${found()}' found.`);
    const type = word();
    let pos = toks[i - 1].end;
    const ws = () => { const m = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(body.slice(pos)); pos += m[0].length; };
    const stringlike = (stop) => {
      ws();
      if (body[pos] === '"' || body[pos] === "'") {
        const q = body[pos]; let j = pos + 1, out = '';
        while (j < body.length && body[j] !== q) { if (body[j] === '\\' && j + 1 < body.length) { out += body[j + 1] === 'n' ? '\n' : body[j + 1] === 't' ? '\t' : body[j + 1]; j += 2; } else out += body[j++]; }
        if (j >= body.length) throw new SyntaxError('unterminated string');
        pos = j + 1;
        return out;
      }
      let j = pos;
      while (j < body.length && !/\s/.test(body[j]) && !stop.includes(body[j])) j++;
      if (j === pos) throw new SyntaxError('expected a value');
      const v = body.slice(pos, j); pos = j; return v;
    };
    /** The expression right of `=`; `::` in it is the value of the key being set. */
    const assignedValue = (want) => {
      ws();
      if (pos >= body.length || ';,'.includes(body[pos])) throw new SyntaxError('parse error: To set a property it must have a value to the right of the equal sign');
      const { ast, end } = parseExpr(body, pos, want, false, kind === 'convert');
      pos = end;
      return ast;
    };
    const assigns = [];
    ws();
    while (!(body[pos] === ';' || body.startsWith('->', pos))) {
      // `::=…` (every key of the element) or `set::=…` (every key in that set), blanks allowed between the
      // tokens; `::id=` and `::geom=` are special properties instead (set_prop.cc)
      const generic = /^(?:([A-Za-z_][A-Za-z_0-9]*)\s*)?::\s*=/.exec(body.slice(pos));
      if (generic) {
        const keysFrom = generic[1] ?? null;
        if (kind === 'make' && keysFrom === null) throw new SyntaxError('parse error: The generic tag set property can only be called from convert');
        pos += generic[0].length;
        if (assigns.some(a => a.key === '::=')) throw new SyntaxError(`static error: A ${kind} statement can have at most one any-key set-prop statement.`);
        assigns.push({ key: '::=', expr: assignedValue('string'), keysFrom });
      } else if (body[pos] === '!') {
        pos++;
        assigns.push({ key: stringlike('=,;-'), expr: null });
      } else {
        let key;
        if (body.startsWith('::', pos)) { pos += 2; ws(); const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(pos)); if (!m) throw new SyntaxError('expected a name after ::'); key = '::' + m[0]; pos += m[0].length; }
        else {
          ws();
          const quoted = body[pos] === '"' || body[pos] === "'";
          key = stringlike('=,;');
          const special = /[^A-Za-z0-9_]/.exec(key);
          if (special && !quoted) throw new SyntaxError(`parse error: if special character "${special[0]}" is present in property name then the property name must be in quotes`);
        }
        ws();
        if (body[pos] !== '=') throw new SyntaxError(`parse error: '=' expected - '${body.slice(pos).match(FOUND)?.[0] ?? ''}' found.`);
        pos++;
        if (key.startsWith('::') && key !== '::id' && key !== '::geom') throw new SyntaxError('parse error: The only allowed special properties are "id" and "geometry"');
        const ast = assignedValue(key === '::geom' ? 'geometry' : 'string');
        if ((key === '::id' || key === '::geom') && assigns.some(a => a.key === key)) {     // Overpass says "make" for convert's ::geom
          throw new SyntaxError(`static error: A ${key === '::id' ? kind : 'make'} statement can have at most one set-prop statement of subtype setting ${key === '::id' ? 'the id' : 'the geometry'}.`);
        }
        if (!key.startsWith('::') && assigns.some(a => a.key === key && a.expr)) throw new SyntaxError(`static error: A key cannot be added twice to an element: "${key}"`);
        assigns.push({ key, expr: ast });
      }
      ws();
      if (body[pos] === ',') { pos++; ws(); } else break;
    }
    while (i < toks.length && toks[i].at < pos) i++;
    return { kind: 'make', make: kind, type, from, assigns, into: target() };
  }

  /** An expression in parentheses after for/if, read from the raw text. */
  const parenExpr = (containerOk) => {
    expect('(');
    const { ast, end } = parseExpr(body, toks[i - 1].end, 'string', containerOk, containerOk);   // for: per element; if: once
    while (i < toks.length && toks[i].at < end) i++;
    expect(')');
    return ast;
  };

  const target = () => {
    if (isP('->')) {
      i++; expect('.');
      return setName();
    }
    return '_';
  };

  function outStatement(from) {
    const o = { kind: 'out', from, verbosity: 'body', geom: null, sort: 'asc', limit: null, ids: true };
    while (peek() && !isP(';')) {
      if (isP('(')) {                                   // (s,w,n,e): clip printed geometry to this box
        i++;
        const v = [num()]; for (let k = 0; k < 3; k++) { expect(','); v.push(num()); }
        expect(')');
        const [so, we, no, ea] = v;
        if (!(so >= -90 && so <= 90 && no >= -90 && no <= 90 && no >= so && we >= -180 && we <= 180 && ea >= -180 && ea <= 180)) throw new SyntaxError('static error: invalid bbox for print');
        o.bbox = v;
        continue;
      }
      if (peek().t === 'p' || peek().t === 'str') throw new SyntaxError(`parse error: Invalid parameter for print: "${found()}"`);
      const t = word();
      if (['ids', 'skel', 'body', 'tags'].includes(t)) { o.verbosity = t; o.count = false; }       // the last one counts
      else if (t === 'quirks') throw new SyntaxError('static error: For the attribute "mode" of the element "print" the only allowed values are "ids_only", "skeleton", "body", "tags",  "count", or "meta".');
      else if (['center', 'bb', 'geom'].includes(t)) o.geom = t;
      else if (t === 'asc' || t === 'qt') o.sort = t;
      else if (t === 'noids') o.ids = false;
      else if (t === 'meta' || t === 'attribution') {
        throw new Unsupported(`out ${t}: version, timestamp, changeset and user are not in a bundle. ` +
          'For editing, load the objects you found from the OSM API (e.g. JOSM load_object)');
      } else if (t === 'count') o.count = true;
      else if (/^\d+$/.test(t)) o.limit = Number(t);
      else throw new SyntaxError(`parse error: Invalid parameter for print: "${t}"`);
    }
    return o;
  }

  // ---- statements: statement() looks at the first tokens and hands over to the parser for that kind
  /** One statement, with `line` (where it starts; not enumerable) for runtime errors: Overpass names the
   *  statement and its line ('Query timed out in "query" at line 3 …', ql.py _statement). */
  function statement() {
    const at = rest + (peek()?.at ?? 0);
    let line = 1;
    for (let j = src.indexOf('\n'); j !== -1 && j < at; j = src.indexOf('\n', j + 1)) line++;
    const st = statementBody();
    Object.defineProperty(st, 'line', { value: line, enumerable: false });
    return st;
  }
  function statementBody() {
    if (isP('(')) return unionStatement();
    if (!peek()) throw new SyntaxError('parse error: Unexpected end of input.');
    if (isId('foreach') || isId('for')) return loopStatement();
    if (isId('if')) return ifStatement();
    let from = '_';
    if (isP('.')) {                                          // .set out | .set > | .set; | .set is_in | .set map_to_area
      i++; from = setName();
      if (isP(';') || isP('->') || !peek()) return { kind: 'copy', from, into: target() };
    }
    if (isP('<') || isP('>')) return { kind: 'recurse', op: recOp(), from, into: target() };
    if (isId('out')) { i++; return outStatement(from); }
    if (isId('is_in')) return isInStatement(from);
    if (isId('map_to_area')) { i++; return { kind: 'map_to_area', from, into: target() }; }
    if (isId('local')) return localStatement(from);
    if (isId('make') || isId('convert')) {
      if (isId('make') && from !== '_') throw new SyntaxError('static error: Unknown attribute "from" in element "make".');
      return makeStatement(from);
    }
    if (isId('complete')) return completeStatement(from);
    if (from !== '_' || isP('.')) {
      if (peek()?.t === 'id' && ['retro', 'compare'].includes(peek().v)) {
        throw new Unsupported(`'${peek().v}' compares the map at two dates, and a bundle holds one date only`);
      }
      throw new SyntaxError(`expected out, a recursion or ';' after .${from}`);
    }
    if (peek().t !== 'id') throw new SyntaxError(`parse error: Unknown type "${found()}"`);
    return queryStatement();
  }

  /** ( A; B; … )  a union; a difference is exactly ( A; - B; ) */
  function unionStatement() {
    i++;
    const items = [];
    let sign = '+', diff = false;
    while (!isP(')')) {
      if (!peek()) throw new SyntaxError(diff ? 'parse error: difference always requires two operands' : 'parse error: Unexpected end of input.');   // left open
      if (isP('-')) {
        if (items.length !== 1 || diff) throw new SyntaxError(diff ? 'parse error: difference always requires two operands' : 'parse error: Unknown type "-"');
        i++; sign = '-'; diff = true; continue;
      }
      if (diff && items.length === 2) throw new SyntaxError('parse error: difference always requires two operands');
      const st = statement();
      endStatement(st);
      items.push({ sign, st });
      sign = '+';
    }
    expect(')');
    return { kind: 'union', items, into: target() };
  }

  /** foreach[.in][->.var] { … }   for[.in][->.var] (expr) { … } */
  function loopStatement() {
    const kw = word();
    let from = '_';
    if (isP('.')) { i++; from = setName(); }
    const into = target();
    if (kw === 'foreach') return { kind: 'foreach', from, into, body: blockBody(), block: true };
    const key = parenExpr(true);
    return { kind: 'for', from, into, key, body: blockBody(), block: true };
  }

  /** if (expr) { … } else { … } */
  function ifStatement() {
    i++;
    const cond = parenExpr(false);
    const then = blockBody();
    let orelse = [];
    if (isId('else')) { i++; orelse = blockBody(); }
    return { kind: 'if', cond, then, orelse, into: '_', block: true };
  }

  /** [.in] is_in[(lat, lon)][->.out] */
  function isInStatement(from) {
    i++;
    let coords = null;
    if (isP('(')) {
      i++;
      const lat = num();
      const lon = isP(',') ? (i++, num()) : 1000;               // Overpass: is_in(1) is a bad longitude
      expect(')');
      for (const [n, v, lim] of [['lat', lat, 90], ['lon', lon, 180]]) {
        if (!(v >= -lim && v <= lim)) throw new SyntaxError(`static error: For the attribute "${n}" of the element "coord-query" the only allowed values are floats between -${lim}.0 and ${lim}.0.`);
      }
      coords = [lat, lon];
    }
    return { kind: 'is_in', from: coords ? null : from, coords, into: target() };
  }

  /** [.in] local [l|ll|llb][(s,w,n,e)][->.out] */
  function localStatement(from) {
    i++;
    let mode = 'l', bbox = null;
    if (peek() && peek().t !== 'p') {
      mode = word();
      if (!['l', 'll', 'llb'].includes(mode)) throw new SyntaxError('static error: Localize must have one of the values "l", "ll", or "llb". "l" is the default value.');
    }
    if (isP('(')) {
      i++;
      const v = [num()];
      for (let k = 0; k < 3; k++) { expect(','); v.push(num()); }
      expect(')');
      const [so, we, no, ea] = v;
      if (!(so >= -90 && so <= 90 && no >= -90 && no <= 90 && no >= so && we >= -180 && we <= 180 && ea >= -180 && ea <= 180)) throw new SyntaxError('static error: invalid bbox for local');
      bbox = v;
    }
    return { kind: 'local', from, mode, bbox, into: target() };
  }

  /** [.in] complete[(max)][.in][->.out] { … } */
  function completeStatement(from) {
    i++;
    let into = '_', maxnum = 4096;
    for (let k = 0; k < 3; k++) {
      if (isP('->')) into = target();
      else if (isP('.') && from === '_') { i++; from = setName(); }
      else if (isP('(')) {
        i++;
        if (peek() && !isP(')', 1)) { i++; expect(')'); }
        const t = peek();
        if (!t || t.t !== 'num' || !/^\d+$/.test(t.v) || Number(t.v) < 1 || Number(t.v) > 1048576 || !isP(')', 1)) {
          throw new SyntaxError('static error: Maximum loop number for complete must be an integer between "1" and "1048576".');
        }
        maxnum = Math.trunc(num()); expect(')');
      }
    }
    return { kind: 'complete', from, into, maxnum, body: blockBody(), block: true };
  }

  /** type[.in…][filter…][->.out]: a query, its filters in brackets or parentheses */
  function queryStatement() {
    const type = word();
    const types = QUERY_TYPES[type];
    if (!types) {
      if (['retro', 'compare', 'timeline'].includes(type)) {
        throw new Unsupported(`'${type}' needs the map's history, and a bundle holds one date only`);
      }
      throw new SyntaxError(`parse error: Unknown type "${type}"`);
    }
    const q = { kind: 'query', types, typeName: type, filters: [], inputs: [] };
    while (isP('[') || isP('(') || isP('.')) {
      if (isP('.')) { i++; q.inputs.push(setName()); }
      else if (isP('[')) tagFilter(q);
      else parenFilter(q);
    }
    if (type === 'derived' && q.filters.some(f => f.kind === 'ids')) {
      throw new SyntaxError('static error: For the attribute "type" of the element "id-query" the only allowed values are "node", "way", "relation", or "area".');
    }
    q.into = target();
    if (!q.filters.length && !q.inputs.length && !settings.bbox) throw new SyntaxError('parse error: An empty query is not allowed');
    return q;
  }

  /** [k] [!k] [k=v] [k!=v] [k~re] [k!~re] (,i) and [~"key"~"value"(,i)] */
  function tagFilter(q) {
    i++;
    let neg = false;
    if (isP('!')) { i++; neg = true; }
    if (isP('~')) {                                         // [~"key"~"value"(,i)]
      i++;
      const kre = word();
      expect('~');
      const vre = word();
      let ci = false;
      if (isP(',')) { i++; if (word() !== 'i') throw new SyntaxError("expected 'i' after ','"); ci = true; }
      expect(']');
      q.filters.push({ kind: 'likelike', kre: regex(kre, ci), vre: regex(vre, ci) });
      return;
    }
    const key = tagWord();
    if (isP(']')) { i++; q.filters.push({ kind: neg ? 'nokey' : 'key', key }); return; }
    if (neg) throw new SyntaxError('[!k=…] is invalid');
    if (!['=', '!=', '~', '!~'].some(o => isP(o))) throw new SyntaxError(`parse error: '!', '~', '=', '!=', or ']'  expected - '${found()}' found.`);
    const op = toks[i++].v;
    const value = tagWord();
    let ci = false;
    if (isP(',')) { i++; if (word() !== 'i') throw new SyntaxError('expected i'); ci = true; }
    expect(']');
    if (op === '=' || op === '!=') {
      if (value === '') return;                                    // [k=""] adds no filter (3.1)
      q.filters.push({ kind: op === '=' ? 'eq' : 'ne', key, value });
    } else if (op === '~' || op === '!~') {
      q.filters.push({ kind: op === '~' ? 're' : 'nre', key, re: regex(value, ci) });
    } else throw new SyntaxError(`operator ${op}`);
  }

  /** ( … ): an input set, a recursion, or the filter named by its first word (PAREN_FILTERS), else a bbox or IDs */
  function parenFilter(q) {
    i++;                                                           // '('
    if (isP('.')) { i++; q.inputs.push(word()); expect(')'); return; }      // (.set): an input set
    if (isP('<') || isP('>')) {                                    // (<) (>>.w): recursion as a filter
      const op = recOp();
      let set = '_';
      if (isP('.')) { i++; set = word(); }
      expect(')');
      q.filters.push({ kind: 'recurse', op, set });
      return;
    }
    const w = peek()?.t === 'id' ? peek().v : null;
    const named = w && (w.startsWith('around') ? aroundFilter : Object.hasOwn(RECURSION_RESULTS, w) ? relationFilter
      : Object.hasOwn(PAREN_FILTERS, w) ? PAREN_FILTERS[w] : null);           // own keys only: not (constructor)
    if (named) { named(q, w); return; }
    if (['user', 'uid', 'newer', 'changed', 'user_touched', 'uid_touched'].includes(w)) {
      throw new Unsupported(`filter (${w} …): bundles have no metadata (users, changesets, timestamps), so this can't be answered from them`);
    }
    if (peek()?.t === 'num' || isP('-')) {
      const vals = intList();
      expect(')');
      if (vals.length !== 1 && vals.length !== 4) throw new SyntaxError('expected one id or four bbox values');
      if (vals.length === 4) {
        const [s, ww, n, e] = vals;
        for (const [name, v, lim] of [['s', s, 90], ['w', ww, 180], ['n', n, 90], ['e', e, 180]]) {
          if (!(v >= -lim && v <= lim)) throw new SyntaxError(`static error: For the attribute "${name}" of the element "bbox-query" the only allowed values are floats between -${lim}.0 and ${lim}.0.`);
        }
        if (n < s) throw new SyntaxError('static error: The value of attribute "n" of the element "bbox-query" must always be greater or equal than the value of attribute "s".');
        q.filters.push({ kind: 'bbox', s, w: ww, n, e }); return;
      }
      q.filters.push({ kind: 'ids', ids: positiveIds(vals) }); return;
    }
    if (!peek()) throw new SyntaxError('unexpected end of the query');
    throw new SyntaxError(`unknown filter (${peek().v} …)`);
  }

  const positiveIds = (ids) => {
    if (ids.some(v => v === 0)) throw new SyntaxError('static error: For the attribute "ref" of the element "id-query" the only allowed values are positive integers.');
    return ids;
  };

  /** (around[.set]:r[,lat,lon…]) */
  function aroundFilter(q) {
    i++;
    let set = null;
    if (isP('.')) { i++; set = word(); }
    if (isP(':')) i++;
    if (!peek() || isP(')')) throw new SyntaxError('parse error: around requires the radius as first argument');
    const r = atof();
    if (r < 0) throw new SyntaxError(AROUND_RADIUS_ERROR);
    const nums = [];
    while (isP(',')) { i++; nums.push(atof()); }
    if (nums.length % 2) throw new SyntaxError('parse error: around requires an odd number of arguments');
    const coords = [];
    for (let k = 0; k < nums.length; k += 2) coords.push(aroundPoint(nums[k], nums[k + 1]));
    expect(')');
    q.filters.push({ kind: 'around', radius: r, coords, set: set ?? (coords.length ? null : '_') });   // (around:r): around `_`
  }

  /** (r) (w) (bn) (bw) (br) (n) …[.set][:role | :positions]: members or parents of a set */
  function relationFilter(q, w) {
    i++;
    let set = '_', role = null, positions = null;
    if (isP('.')) { i++; set = word(); }
    if (isP(':')) {
      i++;
      const typeName = q.types.length === 1 ? q.types[0] : q.typeName;
      if (w === 'r' || typeName === 'relation') role = word();          // recurse.cc: a role for relations ...
      else if (w === 'w' || typeName === 'way') {                      // ... node positions for ways
        positions = [];
        do {
          if (peek()?.t === 'str' || peek()?.t === 'id') {           // atoll: 0 (refused) or the leading digits
            const tok = word(), m = /^\s*[-+]?\d+/.exec(tok);
            if (!m || Number(m[0]) === 0) throw new SyntaxError(`static error: Invalid pos '${tok}' in positions list.`);
            positions.push([Number(m[0]), Number(m[0])]);
            continue;
          }
          const raw = (isP('-') ? '-' : '') + (peek(isP('-') ? 1 : 0)?.v ?? '');
          const a = num();
          if (a === 0) throw new SyntaxError(`static error: Invalid pos '${raw}' in positions list.`);
          let b = a;
          if (isP('-') && peek(1)?.t === 'num') { i++; b = num(); }                      // 2--1
          else if (peek()?.t === 'num' && peek().v.startsWith('-')) b = Number(word().slice(1));   // 2-3 (tokenized as 2, -3)
          positions.push([a, b]);
        } while (isP(',') && (i++, true));
      } else word();                                              // neither (bn on wr): Overpass ignores it
    }
    expect(')');
    const ok = RECURSION_RESULTS[w][0];
    const typeNames = ['nwr', 'nw', 'wr', 'nr'].includes(q.typeName) ? [q.typeName] : q.types;
    if (ok && !typeNames.every(t => ok.includes(t) || (w === 'bn' && t === 'wr'))) {
      throw new SyntaxError(`parse error: A recursion of type '${w}' produces ${RECURSION_RESULTS[w][1]}.`);
    }
    q.filters.push({ kind: 'rel', rel: w, set, role, positions });
  }

  /** The parenthesised filters named by their first word (around and the recursion results are matched apart). */
  const PAREN_FILTERS = {
    id(q) { i++; expect(':'); if (peek()?.t !== 'num' && !isP('-')) positiveIds([0]); q.filters.push({ kind: 'ids', ids: positiveIds(intList()) }); expect(')'); },
    area(q) {                                                    // (area:id,…) or (area[.set])
      i++;
      if (isP(':')) { i++; q.filters.push({ kind: 'areaIds', ids: intList() }); }
      else { let set = '_'; if (isP('.')) { i++; set = word(); } q.filters.push({ kind: 'inArea', set }); }
      expect(')');
    },
    if(q) {                                                      // (if: expression): parsed from the raw text
      i++;
      expect(':');
      const { ast, end } = parseExpr(body, toks[i - 1].end);
      while (i < toks.length && toks[i].at < end) i++;
      expect(')');
      q.filters.push({ kind: 'if', ast });
    },
    pivot(q) { i++; let set = '_'; if (isP('.')) { i++; set = word(); } expect(')'); q.filters.push({ kind: 'pivot', set }); },
    poly(q) {                                                    // (poly:"lat lon lat lon …")
      i++; expect(':');
      const text = word();
      const bounds = 'static error: For the attribute "bounds" of the element "polygon-query" ';
      const coords = [];
      for (let pos = 0; ;) {                                       // while (in.good()) { in >> lat; …; in >> lon; }
        const [lat, p1, good] = streamDouble(text, pos);
        if (!good) throw new SyntaxError(bounds + 'an even number of float values must be provided.');
        const [lon, p2, more] = streamDouble(text, p1);
        coords.push([lat, lon]);
        pos = p2;
        if (!more) break;
      }
      if (coords.length < 3) throw new SyntaxError(bounds + 'at least 3 lat/lon float value pairs must be provided.');
      if (!coords.every(([la]) => la >= -90 && la <= 90)) throw new SyntaxError(bounds + 'the only allowed values for latitude are floats between -90.0 and 90.0.');
      if (!coords.every(([, lo]) => lo >= -180 && lo <= 180)) throw new SyntaxError(bounds + 'the only allowed values for longitude are floats between -180.0 and 180.0.');
      expect(')');
      q.filters.push({ kind: 'poly', coords });
    },
    way_cnt: wayCountFilter,
    way_link: wayCountFilter,
  };

  /** (way_cnt[.set]:lo[-hi]) (way_link[.set]:lo[-hi]): nodes in that many ways of a set */
  function wayCountFilter(q, w) {
    i++;
    let set = '_'; if (isP('.')) { i++; set = word(); }
    expect(':');
    const lowError = 'static error: lower must be an integer greater or equal 1';
    if (peek()?.t !== 'num' && !isP('-')) throw new SyntaxError(lowError);
    const lo = Math.trunc(num());
    if (!(lo >= 1)) throw new SyntaxError(lowError);
    let hi = lo;
    if (peek()?.t === 'num' && peek().v.startsWith('-')) hi = Math.trunc(Math.abs(Number(word())));      // 2-4 (tokenized as 2, -4)
    else if (isP('-')) { i++; hi = peek()?.t === 'num' ? Math.trunc(Number(word())) : null; }
    if (hi !== null && hi < lo) throw new SyntaxError('static error: upper must be an integer greater or equal lower');
    expect(')');
    if (!q.types.every(t => t === 'node')) throw new SyntaxError(`parse error: A recursion of type '${w}' produces nodes.`);
    q.filters.push({ kind: 'waycount', wc: w, set, lo, hi });
  }

  const prog = statements();
  if (i < toks.length) throw new SyntaxError(`unexpected '${peek().v}' near token ${i}`);
  return { settings, statements: prog };
}
