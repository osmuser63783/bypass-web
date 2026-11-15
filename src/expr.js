// SPDX-License-Identifier: AGPL-3.0-or-later
// Overpass QL evaluator expressions (`if:` filters): a port of osm_bypass/expr.py, whose parts are ports of
// Overpass API statements/*_operators.cc, string_endomorphisms.cc, aggregators.cc, set_list_operators.cc and
// data/utils.h (Copyright (C) 2008-2018 Roland Olbricht et al., AGPL-3.0-or-later).
//
// Values are strings, as in Overpass; arithmetic and ordered comparison use int64 (BigInt here) when both
// sides parse as integers, else doubles, else text. Geometry functions (geom(), center(), trace(), hull(),
// gcat(), pt(), lstr(), poly()) return geometry objects from geometry.js, for make/convert's ::geom.

import { Unsupported } from './errors.js';
import { cpCompare } from './text.js';
import * as G from './geometry.js';

// AST (arrays): ['lit', s] ['tag', e] ['call', name, args] ['setcall', set, name, args] ['un', op, e]
//               ['bin', op, a, b] ['cond', c, a, b] ['val', set]
//               ['prop', set, key] (any other set key: '') ['generic'] (`::` in make/convert, see bindKey)

const UNSUPPORTED_FUNCS = new Set(['version', 'timestamp', 'changeset', 'uid', 'user']);
const GEOM_FUNCS = { geom: 'eval-geometry', center: 'eval-center', trace: 'eval-trace', hull: 'eval-hull',
  gcat: 'eval-geom-concat', pt: 'eval-point', lstr: 'eval-linestring', poly: 'eval-polygon' };
const GEOM_ARGS = new Set(['center', 'trace', 'hull', 'gcat', 'lstr', 'poly']);
const COUNT_TYPES = new Set(['nodes', 'ways', 'relations', 'deriveds', 'nwr', 'nw', 'wr', 'nr']);
const TYPE_WORDS = new Set(['nodes', 'ways', 'relations', 'rels', 'deriveds', 'areas', 'nwr', 'nw', 'wr', 'nr']);
const RAW_TOKEN_ARG = new Set(['is_tag', 'count_by_role', 'count_distinct_by_role']);
const SCALARS = new Set(['id', 'type', 'lat', 'lon', 'length', 'is_closed', 'is_tag', 'number', 'is_number', 'count_tags',
  'count_members', 'count_distinct_members', 'lrs_in', 'lrs_isect', 'lrs_union', 'lrs_min', 'lrs_max', 'keys',
  'per_member', 'pos', 'mtype', 'ref', 'role', 'abs', 'suffix', 'date', 'is_date', 'count_by_role',
  'count_distinct_by_role', 'geom', 'center', 'trace', 'hull', 'pt', 'lstr', 'poly', 'per_vertex', 'angle']);
const PURE = new Set(['number', 'is_number', 'abs', 'suffix', 'date', 'is_date', 'lrs_in', 'lrs_isect', 'lrs_union',
  'lrs_min', 'lrs_max', 'center', 'trace', 'hull', 'pt', 'lstr', 'poly']);
const AGGREGATES = new Set(['min', 'max', 'sum', 'set', 'count', 'u', 'gcat']);
// Overpass's static errors for a call without arguments (checked against 0.7.62): aggregates "need an
// argument", these "must have one or more arguments"
const NEED_ARGUMENT = new Set(['min', 'max', 'sum', 'set', 'u', 'gcat']);
const ONE_OR_MORE = new Set(['hull', 'trace', 'center', 'lstr', 'poly', 'pt', 'number', 'is_number', 'suffix', 'date',
  'is_date', 'abs', 'per_member', 'per_vertex', 'lrs_in', 'lrs_isect', 'lrs_union', 'lrs_min', 'lrs_max', 'is_tag']);
// Overpass's other argument rules (0.7.62, tests/data/overpass_errors.tsv), as in expr.py: checked while parsing ...
const NO_ARGUMENTS = new Set(['angle', 'geom', 'id', 'is_closed', 'lat', 'length', 'lon', 'mtype', 'pos', 'ref', 'role',
  'type', 'keys']);
const ONE_ARGUMENT = new Set(['abs', 'date', 'is_date', 'is_number', 'number', 'suffix', 'lrs_max', 'lrs_min', 'center',
  'hull', 'trace', 'gcat', 'max', 'min', 'set', 'sum', 'u']);
const TWO_ARGUMENTS = new Set(['lrs_in', 'lrs_isect', 'lrs_union', 'pt']);
// ... and after the context: functions that need an element, or a member (inside per_member, per_vertex)
const MEMBER_FUNCS = new Set(['angle', 'mtype', 'pos', 'ref', 'role']);
const OBJECT_TYPES = ['nodes', 'ways', 'relations'];
// The evaluators' names in Overpass's type errors
const EVAL_NAMES = { abs: 'eval-abs', center: 'eval-center', count_by_role: 'eval-prop-count',
  count_distinct_by_role: 'eval-prop-count', count_distinct_members: 'eval-prop-count', count_members: 'eval-prop-count',
  count_tags: 'eval-prop-count', date: 'eval-date', gcat: 'eval-geom-concat', geom: 'eval-geometry', hull: 'eval-hull',
  id: 'eval-id', is_closed: 'eval-is-closed', is_date: 'eval-is-date', is_number: 'eval-is-number', is_tag: 'eval-is-tag',
  keys: 'eval-all-keys', lat: 'eval-lat', length: 'eval-length', lon: 'eval-lon', lrs_in: 'eval-lrs-in',
  lrs_isect: 'eval-lrs-isect', lrs_max: 'eval-lrs-max', lrs_min: 'eval-lrs-min', lrs_union: 'eval-lrs-union',
  lstr: 'eval-linestring', max: 'eval-umax', min: 'eval-min', number: 'eval-number', per_member: 'eval-per-member',
  per_vertex: 'eval-per-vertex', poly: 'eval-polygon', pt: 'eval-point', set: 'eval-set', suffix: 'eval-suffix',
  sum: 'eval-sum', trace: 'eval-trace', type: 'eval-type', u: 'eval-union', count: 'eval-set-count' };
const OP_NAMES = { '+': 'eval-plus', '-': 'eval-minus', '*': 'eval-times', '/': 'eval-divided-by', '==': 'eval-equal',
  '!=': 'eval-not-equal', '<': 'eval-less', '<=': 'eval-less-equal', '>': 'eval-greater', '>=': 'eval-greater-equal',
  '&&': 'eval-and', '||': 'eval-or' };
const MULTIPLE = '< multiple values found >';

const SKIP = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
const TOK = /(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\|\||&&|==|!=|<=|>=|::|[<>+\-*/%!?:(),[\].])|([A-Za-z_][A-Za-z_0-9:]*)/y;

/** Parse an expression from text[pos:]; returns { ast, end }. Stops at a `)` or `,` at depth 0, or at `->`.
 *  `element`: evaluated per element (convert, if:, for) or once (make, the if statement). Overpass checks the
 *  context, the argument words and the types statically, after the argument counts, in that order. */
export function parseExpr(text, pos, want = 'string', containerOk = false, element = true) {
  const toks = [];
  let i = pos, depth = 0;
  for (;;) {
    SKIP.lastIndex = i; SKIP.exec(text); const j = SKIP.lastIndex;
    if (text.startsWith('->', j)) break;
    TOK.lastIndex = j;
    const m = TOK.exec(text);
    if (!m) break;
    const kind = m[1] !== undefined ? 'num' : m[2] !== undefined ? 'str' : m[3] !== undefined ? 'op' : 'id';
    const val = m[0];
    if (kind === 'op') {
      if (val === '(' || val === '[') depth++;
      else if (val === ')' || val === ']') { if (depth === 0) break; depth--; }
      else if (val === ',' && depth === 0) break;
    }
    toks.push([kind, val, j]);
    i = TOK.lastIndex;
  }
  const p = new P(toks, i, text);
  const ast = p.ternary();
  if (p.k !== toks.length) p.fail('unexpected token');
  checkContext(ast, element, false);
  if (hasContainer(ast) && !(containerOk && ast[0] === 'call' && ast[1] === 'keys')) {
    throw new SyntaxError(`static error: Evaluator for ${want} expected, but function "eval-all-keys" is an evaluator for container.`);
  }
  if (containerOk && ast[0] === 'call' && ast[1] === 'keys') return { ast, end: i };
  typecheck(ast, want);
  return { ast, end: i };
}

function hasContainer(ast) {
  if (!Array.isArray(ast)) return false;
  if (ast[0] === 'call' && ast[1] === 'keys') return true;
  return ast.slice(1).some(x => Array.isArray(x) && (x.length && typeof x[0] === 'string' ? hasContainer(x) : x.some(hasContainer)));
}

/** Overpass's static checks after the argument counts: functions that need an element (or a member) where
 *  there's none, then the word and role arguments; top-down. */
function checkContext(ast, element, member) {
  if (!Array.isArray(ast) || !ast.length || typeof ast[0] !== 'string') return;
  const k = ast[0];
  const fail = msg => { throw new SyntaxError(`parse error: ${msg}`); };
  if (k === 'tag' && !element) fail('t[...] must be called in a context where it can evaluate an element');
  if (k === 'call' || k === 'setcall') {
    const [name, args] = k === 'call' ? [ast[1], ast[2]] : [ast[2], ast[3]];
    if (k === 'call' && MEMBER_FUNCS.has(name) && !member) fail(`${name}(...) must be called in a context where it can evaluate an element's member`);
    if (k === 'call' && SCALARS.has(name) && !PURE.has(name) && !element) fail(`${name}(...) must be called in a context where it can evaluate an element`);
    const words = args.map(a => (a[0] === 'lit' ? a[1] : null));
    if ((name === 'count_members' || name === 'count_distinct_members') && words.some(w => !OBJECT_TYPES.includes(w))) {
      fail(`${name}(...) can only have one of the words nodes, ways, or relations as an argument`);
    }
    if (name === 'count_by_role' || name === 'count_distinct_by_role') {
      if (!args.length) fail(`${name}() must have the name of the wanted role as argument`);
      if (args.length > 2 || args[0][0] !== 'lit') fail(`${name}() needs a single literal expression as argument for the wanted role`);
      if (args.length === 2 && (!OBJECT_TYPES.includes(words[1]) || args[1][2] === 'quoted')) fail(`${name}(...) can only have one of the words nodes, ways, or relations as second argument`);
    }
    if (name === 'is_tag' && args.length > 1) fail('is_tag(key) needs a simple string as argument');
    if (name === 'count_tags' && args.length) fail('count_tags(...) does not accept any arguments');
    if ((name === 'per_member' || name === 'per_vertex') && args.length > 1) fail('"," cannot be used as binary operator');
    const inner = element || k === 'setcall' || AGGREGATES.has(name);
    for (const a of args) checkContext(a, inner, member || name === 'per_member' || name === 'per_vertex');
    return;
  }
  for (const a of ast.slice(1)) checkContext(a, element, member);
}

/** The Overpass evaluator an expression is, as its type errors name it. */
function evalName(ast) {
  const k = ast[0];
  if (k === 'call') return EVAL_NAMES[ast[1]] ?? `eval-${ast[1].replace(/_/g, '-')}`;
  if (k === 'setcall') return EVAL_NAMES[ast[2]] ?? `eval-${ast[2].replace(/_/g, '-')}`;
  if (k === 'lit') return 'eval-fixed';
  if (k === 'un') return ast[1] === '!' ? 'eval-not' : ast[2][0] === 'lit' ? 'eval-fixed' : 'eval-negate';
  if (k === 'bin') return OP_NAMES[ast[1]] ?? 'eval-fixed';
  if (k === 'cond') return 'eval-ternary';
  if (k === 'tag') return 'eval-value';
  if (k === 'generic') return 'eval-generic';
  return 'eval-set-key';                                  // _.val, x.key
}

/** Overpass's static type check: the arguments first, then the expression against what its place wants. */
function typecheck(ast, want) {
  const k = ast[0];
  if (k === 'call' || k === 'setcall') {
    const [name, args] = k === 'call' ? [ast[1], ast[2]] : [ast[2], ast[3]];
    const sub = GEOM_ARGS.has(name) ? 'geometry' : 'string';
    for (const x of args) { if (x[0] === 'lit' && TYPE_WORDS.has(x[1])) continue; typecheck(x, sub); }
    const got = name in GEOM_FUNCS ? 'geometry' : 'string';
    if (got !== want) throw new SyntaxError(`static error: Evaluator for ${want} expected, but function "${evalName(ast)}" is an evaluator for ${got}.`);
    return;
  }
  if (k === 'tag') typecheck(ast[1], 'string');
  else if (k === 'un') typecheck(ast[2], 'string');
  else if (k === 'bin') { typecheck(ast[2], 'string'); typecheck(ast[3], 'string'); }
  else if (k === 'cond') for (const x of ast.slice(1)) typecheck(x, 'string');
  if (want === 'geometry') throw new SyntaxError(`static error: Evaluator for geometry expected, but function "${evalName(ast)}" is an evaluator for string.`);
}

const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/']];

class P {
  constructor(toks, end, src) { this.toks = toks; this.k = 0; this.end = end; this.src = src; }
  fail(msg) { throw new SyntaxError(`${msg} in an if: expression`); }
  peek() { return this.toks[this.k] ?? [null, null, null]; }
  take(val) {
    const [kind, v] = this.peek();
    if (kind === null || (val !== undefined && v !== val)) return null;
    this.k++;
    return [kind, v];
  }
  expect(val) { if (!this.take(val)) this.fail(`expected '${val}'`); }
  /** Overpass's token tree (tokenizer_utils.cc) gives `?` priority 3 and `:` 4, left-associative:
   *  `a ? b : c ? d : e` is `(a ? b : c) ? d : e`, and a `?` can't stand between `?` and `:`. */
  ternary() {
    let c = this.binop(0);
    while (this.take('?')) {
      const a = this.binop(0);
      if (!this.take(':')) this.fail('parse error: Operator "?" must have a ":" operator as right-hand-side argument');
      c = ['cond', c, a, this.binop(0)];
    }
    if (this.peek()[1] === ':') this.fail('parse error: ":" cannot be used as binary operator');
    return c;
  }
  binop(lvl) {
    if (lvl === LEVELS.length) return this.unary();
    let a = this.binop(lvl + 1);
    for (;;) {
      const [kind, v] = this.peek();
      if (kind === 'op' && v === '%') this.fail('parse error: "%" cannot be used as binary operator');  // no evaluator has it
      if (kind === 'op' && LEVELS[lvl].includes(v)) {
        this.k++;
        if (this.peek()[0] === null) this.fail(`parse error: "${v}" needs a right hand side argument`);
        a = ['bin', v, a, this.binop(lvl + 1)];
      } else return a;
    }
  }
  unary() {
    const [kind, v] = this.peek();
    if (kind === 'op' && (v === '!' || v === '-')) {
      this.k++;
      this.noOperatorAfter(v);
      return ['un', v, this.unary()];
    }
    return this.primary();
  }
  /** Overpass's token tree reads `!` or a lone `-` right after a unary operator as a binary operator with an
   *  empty left side (`!!1`, `! -1`, `- -1`); `-!1` nests, and a minus glued to a number is part of the number. */
  noOperatorAfter(op) {
    const [kind, v, pos] = this.peek();
    if (kind !== 'op') return;
    if (v === '!' && op === '!') this.fail('parse error: "!" cannot be used as binary operator');
    if (v === '-' && !/^-\.?\d/.test(this.src.slice(pos, pos + 3))) {
      this.fail(`parse error: Put quotation marks around "${op}" if it should be a constant and not a tag evaluation.`);
    }
  }
  primary() {
    const t = this.take();
    if (!t) this.fail('parse error: Evaluator expected, but empty token found.');
    const [kind, v] = t;
    if (kind === 'num') return ['lit', v];
    if (kind === 'str') return ['lit', v.slice(1, -1).replace(/\\(.)/gs, '$1')];
    if (kind === 'op' && v === '(') { const e = this.ternary(); this.expect(')'); return e; }
    if (kind === 'op' && v === '::') return ['generic'];        // the current key's value in make/convert (bindKey)
    if (kind === 'op' && v === '.' && this.peek()[0] === 'id') {
      const e = this.primary();                       // `.b.count(ways)` parses, evaluates over an empty set
      if (e[0] !== 'setcall') this.fail('Property assignment needs a right-hand-side value');
      return ['setcall', null, e[2], e[3]];
    }
    if (kind === 'id') return this.name(v);
    this.fail(`unexpected token '${v}'`);
  }
  name(v) {
    if (v === 't' && this.peek()[1] === '[') return this.tagValue();
    let setName = null;
    if (this.peek()[1] === '.' && this.toks[this.k + 1]?.[0] === 'id') {
      this.k++;
      setName = v; v = this.take()[1];
      if (v === 'val') return ['val', setName];
    }
    if (this.take('(')) return this.functionCall(v, setName);
    if (setName !== null) return ['prop', setName, v];        // eval-set-key: only `for` sets a key (val)
    if (TYPE_WORDS.has(v)) return ['lit', v];
    this.fail(`unexpected word '${v}'`);
  }
  tagValue() {
    this.expect('[');
    const nxt = this.toks[this.k + 1]?.[1];
    if (this.peek()[0] === 'id' && nxt !== '.' && nxt !== '(') this.fail(`parse error: Put quotation marks around "${this.peek()[1]}" if it should be a constant and not a tag evaluation.`);
    const k = this.ternary();
    this.expect(']');
    return ['tag', k];
  }
  functionCall(v, setName) {
    const args = this.args(v);
    if (UNSUPPORTED_FUNCS.has(v)) throw new Unsupported(`${v}(): version, timestamp, changeset and user are not in a bundle`);
    if (!SCALARS.has(v) && !AGGREGATES.has(v)) this.fail(`parse error: Function "${v}" not known`);
    if (setName !== null && !AGGREGATES.has(v)) this.fail(`parse error: ${v}(...) cannot have an input set`);
    if (args.length && NO_ARGUMENTS.has(v)) this.fail(`parse error: ${v}(...) does not accept any arguments`);
    if ((args.length > 1 && ONE_ARGUMENT.has(v)) || (args.length > 2 && TWO_ARGUMENTS.has(v))) this.fail('parse error: "," cannot be used as binary operator');
    if (args.length === 1 && TWO_ARGUMENTS.has(v)) this.fail(`parse error: ${v}(...) needs two arguments`);
    if (!args.length && NEED_ARGUMENT.has(v)) this.fail(`parse error: ${v}(...) needs an argument`);
    if (!args.length && ONE_OR_MORE.has(v)) this.fail(`parse error: ${v}(...) must have one or more arguments`);
    if (v === 'count') {
      if (!args.length) this.fail('parse error: count(...) must have one or more arguments');
      if (args.length !== 1 || args[0][0] !== 'lit' || !COUNT_TYPES.has(args[0][1])) {
        this.fail('parse error: "count" accepts only one of "nodes", "ways", "relations", "deriveds", "nwr", "nw", "wr", or "nr" as type argument.');
      }
    }
    if (setName === null) return ['call', v, args];
    if (!AGGREGATES.has(v)) this.fail(`${v}() cannot be applied to a set`);
    return ['setcall', setName, v, args];
  }
  args(v) {
    const args = [];
    if (this.take(')')) return args;
    for (;;) {
      if (RAW_TOKEN_ARG.has(v) && !args.length && ['id', 'num'].includes(this.peek()[0]) && [')', ','].includes(this.toks[this.k + 1]?.[1])) {
        args.push(['lit', this.take()[1]]);
      } else if (RAW_TOKEN_ARG.has(v) && args.length === 1 && this.peek()[0] === 'str') {
        args.push([...this.primary(), 'quoted']);               // the type is a word: "ways" is refused (checkContext)
      } else args.push(this.ternary());
      if (this.take(')')) return args;
      this.expect(',');
    }
  }
}

// ---- C number parsing, as Overpass's data/utils.h uses it (strtoll base 0, strtod)

const CSPACE = ' \t\n\v\f\r';
const STRTOD = /[+-]?(?:0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?|[nN][aA][nN](?:\([0-9A-Za-z_]*\))?)/y;
const STRTOLL = /[+-]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)/y;
const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;

function hexFloat(body) {                         // "1a.8p3" (no 0x, no sign)
  const [mant, exp] = body.toLowerCase().split('p');
  const [ip, fp = ''] = mant.split('.');
  let v = 0;
  for (const c of ip) v = v * 16 + parseInt(c, 16);
  let scale = 1 / 16;
  for (const c of fp) { v += parseInt(c, 16) * scale; scale /= 16; }
  return v * 2 ** Number(exp ?? 0);
}

/** [value, end, erange] like C strtod; end = 0 when nothing was parsed. */
export function strtod(s) {
  let i = 0;
  while (i < s.length && CSPACE.includes(s[i])) i++;
  STRTOD.lastIndex = i;
  const m = STRTOD.exec(s);
  if (!m) return [0, 0, false];
  const t = m[0], end = STRTOD.lastIndex;
  const neg = t.startsWith('-'), body = t.replace(/^[+-]/, ''), low = body.toLowerCase();
  if (low.startsWith('inf')) return [neg ? -Infinity : Infinity, end, false];
  if (low.startsWith('nan')) return [NaN, end, false];
  const v = low.startsWith('0x') ? (neg ? -1 : 1) * hexFloat(body.slice(2)) : Number(t);
  const mant = body.split(/[eEpP]/)[0];
  const nonzero = [...mant].some(c => !'0.xX'.includes(c));
  const erange = !Number.isFinite(v) || (nonzero && (v === 0 || Math.abs(v) < 2.2250738585072014e-308));
  return [v, end, erange];
}

/** strtoll(s, &end, 0) consuming the whole string (leading blanks allowed); saturates. BigInt or null. */
export function tryInt64(s) {
  if (/^\d{1,18}$/.test(s) && (s[0] !== '0' || s.length === 1)) return BigInt(s);
  if (s === '') return null;
  let i = 0;
  while (i < s.length && CSPACE.includes(s[i])) i++;
  STRTOLL.lastIndex = i;
  const m = STRTOLL.exec(s);
  if (!m || STRTOLL.lastIndex !== s.length) return null;
  const t = m[0], neg = t.startsWith('-'), b = t.replace(/^[+-]/, '');
  let v = b.slice(0, 2).toLowerCase() === '0x' ? BigInt(b) : b.length > 1 && b[0] === '0' ? BigInt('0o' + b.slice(1)) : BigInt(b);
  if (neg) v = -v;
  return v < I64_MIN ? I64_MIN : v > I64_MAX ? I64_MAX : v;
}

/** strtod consuming the whole string. */
export function tryDouble(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '') return null;
  const [v, end] = strtod(s);
  return end && end === s.length ? v : null;
}

function tryStartsWithDouble(s) {
  if (s === '') return null;
  const [v, end, erange] = strtod(s);
  return end && !erange ? v : null;
}

function doubleSuffix(s) {
  if (s === '') return '';
  const [, end, erange] = strtod(s);
  if (end && !erange) { let r = s.slice(end); while (r && CSPACE.includes(r[0])) r = r.slice(1); return r; }
  return '';
}

/** Overpass's to_string(double): ostream << setprecision(14), i.e. C's %.14g. */
export function fmt(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const [mant, expStr] = x.toExponential(13).split('e');
  const exp = Number(expStr);
  if (exp < -4 || exp >= 14) {
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    return `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  const f = x.toFixed(13 - exp);
  return f.includes('.') ? f.replace(/0+$/, '').replace(/\.$/, '') : f;
}

/** string_represents_boolean_true(). */
export function truthy(s) {
  const d = tryDouble(s);
  return d !== null ? d !== 0 : s !== '';
}

const wrap64 = (v) => BigInt.asIntN(64, v);

function arith(op, a, b) {
  if (op !== '/') {
    const ia = tryInt64(a), ib = tryInt64(b);
    if (ia !== null && ib !== null) return String(wrap64(op === '+' ? ia + ib : op === '-' ? ia - ib : ia * ib));
  }
  const da = tryDouble(a), db = tryDouble(b);
  if (da !== null && db !== null) {
    if (op === '+') return fmt(da + db);
    if (op === '-') return fmt(da - db);
    if (op === '*') return fmt(da * db);
    if (db === 0) return fmt(da !== 0 && !Number.isNaN(da) ? Math.sign(da) * (Object.is(db, -0) ? -1 : 1) * Infinity : NaN);
    return fmt(da / db);
  }
  return op === '+' ? a + b : 'NaN';
}

const ENC = new TextEncoder();
/** std::string comparison: bytes (UTF-8). */
function byteCmp(a, b) {
  if (/^[\x00-\x7f]*$/.test(a) && /^[\x00-\x7f]*$/.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = ENC.encode(a), y = ENC.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length < 0 ? -1 : x.length > y.length ? 1 : 0;
}
/** Python's str ordering: by code point. */
const cpCmp = cpCompare;

function compare(op, a, b) {
  let c;
  const ia = tryInt64(a), ib = tryInt64(b);
  if (ia !== null && ib !== null) c = ia < ib ? -1 : ia > ib ? 1 : 0;
  else {
    const da = tryDouble(a), db = tryDouble(b);
    if (da !== null && db !== null) {
      if (Number.isNaN(da) || Number.isNaN(db)) return op === '!=';
      c = da < db ? -1 : da > db ? 1 : 0;
    } else c = byteCmp(a, b);
  }
  return { '==': c === 0, '!=': c !== 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[op];
}

const B = (x) => (x ? '1' : '0');

/**
 * Evaluates an AST. el: the element view (see Engine.elem), group: element views for aggregates,
 * sets(name) -> [element views, val] for `name.count(…)` / `name.val`.
 */
/** The expression for one key of a make/convert assignment: Overpass passes the key down the evaluator tree
 *  (set_prop.cc), and `::` (Evaluator_Generic) is that key's value in the element evaluated: t["key"]. */
export function bindKey(ast, key) {
  if (!Array.isArray(ast)) return ast;
  if (ast[0] === 'generic') return ['tag', ['lit', key]];
  if (!hasGeneric(ast)) return ast;
  return ast.map((x, i) => (i === 0 ? x : Array.isArray(x) && typeof x[0] !== 'string' ? x.map(a => bindKey(a, key)) : bindKey(x, key)));
}

function hasGeneric(ast) {
  if (!Array.isArray(ast)) return false;
  if (ast[0] === 'generic') return true;
  return ast.some((x, i) => i > 0 && Array.isArray(x) && (typeof x[0] === 'string' ? hasGeneric(x) : x.some(hasGeneric)));
}

export function evaluate(ast, el, group = null, val = '', sets = null) {
  switch (ast[0]) {
    case 'lit': return ast[1];
    case 'prop': case 'generic': return '';             // bindKey replaces `::` where a key is set
    case 'val': {
      const name = ast[1] ?? '_';
      return name === '_' || !sets ? val : sets(name)[1];
    }
    case 'setcall': {
      if (!sets) throw new Unsupported(`${ast[1]}.${ast[2]}(): set-qualified aggregates need a query context`);
      const [members, v] = ast[1] !== null ? sets(ast[1]) : [[], ''];
      return call(ast[2], ast[3], null, members, v, sets);
    }
    case 'tag': {
      const key = evaluate(ast[1], el, group, val, sets);
      const v = el ? el.tag(key) : undefined;
      return v === undefined || v === null ? '' : v;
    }
    case 'un': {
      const v = evaluate(ast[2], el, group, val, sets);
      if (ast[1] === '!') return B(!truthy(v));
      const i = tryInt64(v);
      if (i !== null) return String(i !== I64_MIN ? -i : i);
      const d = tryDouble(v);
      return d !== null ? fmt(-d) : 'NaN';
    }
    case 'cond': return evaluate(truthy(evaluate(ast[1], el, group, val, sets)) ? ast[2] : ast[3], el, group, val, sets);
    case 'bin': {
      const op = ast[1], a = evaluate(ast[2], el, group, val, sets);
      if (op === '&&') return B(truthy(a) && truthy(evaluate(ast[3], el, group, val, sets)));
      if (op === '||') return B(truthy(a) || truthy(evaluate(ast[3], el, group, val, sets)));
      const b = evaluate(ast[3], el, group, val, sets);
      if (['==', '!=', '<', '<=', '>', '>='].includes(op)) return B(compare(op, a, b));
      return arith(op, a, b);
    }
    case 'call': return call(ast[1], ast[2], el, group, val, sets);
  }
  throw new Error(`bad expression ${ast[0]}`);
}

const DBL_MAX = 1.7976931348623157e308;

/** aggregators.cc (min/max/sum) and set_list_operators.cc (lrs_min/lrs_max), as in expr.py. */
function numericAggregate(name, vals, start = 'void') {
  if (name === 'sum') {
    let typ = 'int', rl = 0n, rd = 0;
    for (const v of vals) {
      if (typ === 'int') { const i = tryInt64(v); if (i !== null) rl = wrap64(rl + i); else typ = 'dbl'; }
      if (typ === 'int' || typ === 'dbl') { const d = tryDouble(v); if (d !== null) rd += d; else typ = 'str'; }
    }
    return typ === 'int' ? String(rl) : typ === 'dbl' ? fmt(rd) : 'NaN';
  }
  const lo = name === 'min';
  let typ = start;
  let rl = lo ? I64_MAX : I64_MIN, rd = lo ? DBL_MAX : -DBL_MAX, rs = '';
  const pick = lo ? (a, b) => (b < a ? b : a) : (a, b) => (a < b ? b : a);
  for (const v of vals) {
    if (typ === 'void') typ = 'int';
    if (typ === 'int') { const i = tryInt64(v); if (i !== null) rl = pick(rl, i); else typ = 'dbl'; }
    if (typ === 'int' || typ === 'dbl') { const d = tryDouble(v); if (d !== null) rd = pick(rd, d); else typ = 'str'; }
    if (v !== '') rs = rs === '' ? v : (lo ? (byteCmp(v, rs) < 0 ? v : rs) : (byteCmp(rs, v) < 0 ? v : rs));
  }
  return typ === 'void' ? '' : typ === 'int' ? String(rl) : typ === 'dbl' ? fmt(rd) : rs;
}

/** Overpass's trim() in set_list_operators.cc, quirks included. */
function trim(x) {
  let frm = 0;
  while (frm < x.length && /\s/.test(x[frm])) frm++;
  if (frm === x.length) return ' ';
  let to = x.length - 1;
  while (/\s/.test(x[to])) to--;
  return x.substr(frm, to + 1);
}

const lrs = (s) => (s === '' ? [] : [...new Set(s.split(';').map(trim))].sort(cpCmp));

function date(s, isDate) {
  const parts = [];
  let pos = 0;
  for (let k = 0; k < 6; k++) {
    while (pos < s.length && !/\d/.test(s[pos])) pos++;
    let v = 0;
    while (pos < s.length && /\d/.test(s[pos])) { v = 10 * v + Number(s[pos]); pos++; }
    parts.push(v);
  }
  const [y, mo, d, h, mi, se] = parts;
  const bad = y < 1000 || mo > 12 || d > 31 || h > 23 || mi > 59 || se > 60;
  if (isDate) return bad ? '0' : '1';
  if (bad) return 'NaD';
  return fmt(y + mo / 16 + d / (16 * 32) + h / (16 * 32 * 32) + mi / (16 * 32 * 32 * 64) + se / (16 * 32 * 32 * 64 * 64));
}

const MTYPES = { nodes: 'node', ways: 'way', relations: 'relation', rels: 'relation' };

/** Evaluator_Properties_Count (tag_value.cc). */
function propCount(name, args, a, el) {
  const byRole = name.endsWith('by_role');
  const role = byRole && a.length ? a[0] : null;
  const word = byRole && args.length > 1 ? args[1] : !byRole && args.length ? args[0] : null;
  const mtype = word && word[0] === 'lit' ? MTYPES[word[1]] ?? null : null;
  const t = el.meta('type');
  if (t === 'way' && !byRole && mtype === null) return el.meta(name);
  if (t !== 'relation') return '0';
  const ms = el.members().filter(m => (mtype === null || m[0] === mtype) && (role === null || m[2] === role));
  if (name === 'count_members' || name === 'count_by_role') return String(ms.length);
  return String(new Set(ms.map(m => m[0] + '/' + m[1])).size);
}

const COUNT_KINDS = { nodes: ['node'], ways: ['way'], relations: ['relation'], nwr: ['node', 'way', 'relation'],
  nw: ['node', 'way'], wr: ['way', 'relation'], nr: ['node', 'relation'] };

function call(name, args, el, group, val, sets) {
  if (AGGREGATES.has(name)) return aggregate(name, args, group, val, sets);
  if (name === 'per_member' || name === 'per_vertex') return perMemberOrVertex(name, args, el, group, val, sets);
  if (el === null && !PURE.has(name)) throw new Error(`parse error: ${name}(...) must be called in a context where it can evaluate an element`);
  const a = args.map(x => evaluate(x, el, group, val, sets));
  if (name === 'angle') return el.meta('angle');
  if (name in GEOM_FUNCS) return geomCall(name, a, el);
  const f = SCALAR_FUNCS[name];
  return f ? f(a, el, args) : el.meta(name);
}

function aggregate(name, args, group, val, sets) {
  if (group === null) throw new Unsupported(`${name}() outside make/for: aggregate functions work over a set (make and for aren't in the browser engine yet)`);
  if (name === 'count') {
    const kinds = COUNT_KINDS[args[0]?.[0] === 'lit' ? args[0][1] : ''];
    const tally = {};
    for (const e of group) { const t = e.etype(); tally[t] = (tally[t] ?? 0) + 1; }
    if (!kinds) return String(Object.entries(tally).filter(([t]) => !['node', 'way', 'relation', 'area'].includes(t)).reduce((s, [, n]) => s + n, 0));
    return String(kinds.reduce((s, t) => s + (tally[t] ?? 0), 0));
  }
  if (name === 'gcat') {
    let comp = null;
    for (const e of group) { const g = evaluate(args[0], e, null, val, sets); if (g) { comp ??= new G.Compound(); comp.addComponent(g); } }
    return comp;
  }
  const vals = group.map(e => evaluate(args[0], e, null, val, sets));
  if (name === 'min' || name === 'max' || name === 'sum') return numericAggregate(name, vals);
  const distinct = [...new Set(vals.filter(v => v !== ''))];
  if (name === 'set') return distinct.sort(cpCmp).join(';');
  return !distinct.length ? '' : distinct.length === 1 ? distinct[0] : MULTIPLE;          // u()
}

/** The element seen from one member position inside per_member()/per_vertex(). */
class MemberView {
  constructor(el, i, m) { this.el = el; this.i = i; this.m = m; }
  tag(k) { return this.el.tag(k); }
  tags() { return this.el.tags(); }
  members() { return this.el.members(); }
  etype() { return this.el.etype(); }
  countTags() { return this.el.countTags(); }
  meta(name) {
    if (name === 'pos') return String(this.i + 1);
    if (name === 'mtype') return this.m[0];
    if (name === 'ref') return String(this.m[1]);
    if (name === 'role') return this.m[2];
    if (name === 'angle') return this.el.angle(this.i);
    return this.el.meta(name);
  }
}

function perMemberOrVertex(name, args, el, group, val, sets) {
  if (el === null) throw new Error(`parse error: ${name}(...) must be called in a context where it can evaluate an element`);
  const ms = el.members();
  let idx;
  if (name === 'per_member') idx = ms.map((_, i) => i);
  else {
    if (el.meta('type') !== 'way' || ms.length <= 2) return '';
    idx = [...Array(ms.length - 2).keys()].map(i => i + 1);
    if (el.meta('is_closed') === '1') idx.push(ms.length - 1);
  }
  return idx.map(i => evaluate(args[0], new MemberView(el, i, ms[i]), group, val, sets)).join(';');
}

function numberOrAbs(s, absolute) {
  const i = tryInt64(s);
  if (i !== null) return String(absolute && i < 0n && i !== I64_MIN ? -i : i);
  const d = tryStartsWithDouble(s);
  if (d === null) return 'NaN';
  return fmt(absolute ? Math.abs(d) : d);
}

/** expr.py _geom_call. */
function geomCall(name, a, el) {
  if (name === 'geom') return el.geometry();
  if (name === 'pt') {
    const la = tryDouble(a[0]), lo = tryDouble(a[1]);
    if (la !== null && la >= -90 && la <= 90 && lo !== null && lo >= -180 && lo <= 180) return new G.Point(la, lo);
    return new G.Null();
  }
  if (name === 'lstr') return new G.Linestring(a.filter(g => g && g.hasCenter()).map(g => [g.centerLat(), g.centerLon()]));
  if (name === 'poly') {
    const fp = new G.FreePolygon();
    for (const g of a) if (g && g.hasLineGeometry()) fp.addLinestring(g.line());
    return G.rhrPolygon(fp);
  }
  const g = a[0];
  if (!g) return null;
  if (name === 'center') return g.hasCenter() ? new G.Point(g.centerLat(), g.centerLon()) : new G.Null();
  if (name === 'trace') return G.makeTrace(g);
  if (name === 'hull') return G.makeHull(g);
  throw new Error(`bad geometry function ${name}`);
}

const lrsMinMax = (name) => (a) => (a[0] === '' ? '' : numericAggregate(name === 'lrs_min' ? 'min' : 'max', a[0].split(';').map(trim), 'int'));

const SCALAR_FUNCS = {
  lrs_in: (a) => (a[1] === '' ? '0' : B(new Set(a[1].split(';').map(trim)).has(trim(a[0])))),
  lrs_isect: (a) => { const y = new Set(lrs(a[1])); return lrs(a[0]).filter(x => y.has(x)).join(';'); },
  lrs_union: (a) => [...new Set([...lrs(a[0]), ...lrs(a[1])])].sort(cpCmp).join(';'),
  lrs_min: lrsMinMax('lrs_min'),
  lrs_max: lrsMinMax('lrs_max'),
  is_tag: (a, el) => B(el.tag(a[0]) !== undefined),
  number: (a) => numberOrAbs(a[0], false),
  abs: (a) => numberOrAbs(a[0], true),
  is_number: (a) => B(tryInt64(a[0]) !== null || tryStartsWithDouble(a[0]) !== null),
  suffix: (a) => doubleSuffix(a[0]),
  date: (a) => date(a[0], false),
  is_date: (a) => date(a[0], true),
  count_tags: (a, el) => String(el.countTags()),
  count_members: (a, el, args) => propCount('count_members', args, a, el),
  count_distinct_members: (a, el, args) => propCount('count_distinct_members', args, a, el),
  count_by_role: (a, el, args) => propCount('count_by_role', args, a, el),
  count_distinct_by_role: (a, el, args) => propCount('count_distinct_by_role', args, a, el),
  keys: (a, el) => [...new Set(Object.keys(el.tags()))].sort(cpCmp).join(';'),
};
