// Bundle src/*.js into one classic script (dist/bypass.js) exposing window.Bypass, for pages
// that can't load ES modules (test.html). Each module gets its own function scope; its `import { … } from
// './x.js'` lines read from the modules built before it, and its `export` declarations are returned.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
// dependencies first; every module in src/ except the worker (it runs the page's storage, not the engine) must be listed
const order = ['errors.js', 'text.js', 'bundle.js', 'tes.js', 'store.js', 'spatial.js', 'ovindex.js', 'areas.js', 'geometry.js', 'expr.js',
  'localize.js', 'parse.js', 'engine-base.js', 'engine-query.js', 'engine-areas.js', 'engine-recurse.js', 'engine-make.js',
  'engine-output.js', 'engine.js', 'render.js', 'turbo.js', 'geocode.js'];
const NOT_BUNDLED = ['worker.js', 'library.js'];
const unlisted = readdirSync('src').filter(f => f.endsWith('.js') && !order.includes(f) && !NOT_BUNDLED.includes(f));
if (unlisted.length) throw new Error(`src/ modules missing from the build order: ${unlisted.join(', ')}`);
let out = '// SPDX-License-Identifier: AGPL-3.0-or-later\n// Built from browser/src by tools-build.mjs\n(() => {\nconst __m = {};\n';
for (const f of order) {
  let s = readFileSync(`src/${f}`, 'utf8');
  const names = [];
  s = s.replace(/^import \{([^}]*)\} from '\.\/([^']+)';$/gm, (m, list, mod) => `const {${list}} = __m[${JSON.stringify(mod)}];`);
  s = s.replace(/^import \* as ([A-Za-z_$][\w$]*) from '\.\/([^']+)';$/gm, (m, name, mod) => `const ${name} = __m[${JSON.stringify(mod)}];`);
  if (/^import /m.test(s)) throw new Error(`${f}: an import the build does not understand`);
  s = s.replace(/^export (async function|function|class|const|let) ([A-Za-z_$][\w$]*)/gm, (m, kw, name) => {
    names.push(name);
    if (kw === 'const' || kw === 'let') {               // export const A = 1, B = 2;
      // the whole declaration (it may span lines), comments removed; skipped when it holds code
      const decl = s.slice(s.indexOf(m)).split(/;[ \t]*(?:\/\/[^\n]*)?\n/)[0].replace(/\/\/[^\n]*/g, '');
      if (!/=>|function|\{/.test(decl)) for (const extra of decl.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=/g)) names.push(extra[1]);
    }
    return `${kw} ${name}`;
  });
  s = s.replace(/^export \{([^}]*)\};$/gm, (m, list) => { names.push(...list.split(',').map(x => x.trim()).filter(Boolean)); return ''; });
  s = s.replace(/const fs = await import\('node:fs\/promises'\);/, "throw new Error('fileSource is Node-only');");
  const real = Object.keys(await import(`./src/${f}`));          // the module's actual exports, as a check
  const missing = real.filter(n => !names.includes(n));
  if (missing.length) throw new Error(`${f}: exports not picked up by the build: ${missing.join(', ')}`);
  out += `// ---- ${f}\n__m[${JSON.stringify(f)}] = (() => {\n${s}\nreturn { ${[...new Set(names)].join(', ')} };\n})();\n`;
}
out += 'globalThis.Bypass = { ...__m["bundle.js"], ...__m["store.js"], ...__m["engine.js"], ...__m["tes.js"], ' +
  'expand: __m["turbo.js"].expand, Geocoder: __m["geocode.js"].Geocoder, render: __m["render.js"].render };\n})();\n';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/bypass.js', out);
console.log('dist/bypass.js', out.length, 'bytes');
