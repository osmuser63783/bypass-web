// SPDX-License-Identifier: AGPL-3.0-or-later
// The files to publish, in one folder: `node tools-release.mjs [out] [--analytics <token>]` (default `site/`), then
// upload that folder as it is to any static host (or zip it for a tester). Every local script, stylesheet,
// module import, worker and data file gets the same `?v=<release>` (a hash of all the files and the token), so after a deploy a browser holding cached copies (GitHub Pages
// lets it keep them 10 minutes) asks for the new files instead of mixing them with old ones. The source tree is
// left as it is: during development serve.py sends `no-cache` instead.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLISH = ['index.html', 'app', 'src', 'data', 'vendor', 'ui-map.js', 'export.js', 'examples.js', 'serve.py',
  'LICENSES.txt', 'LICENSE.txt', 'icon.svg', 'icon-32.png', 'icon-180.png',
  'preview.jpg', 'google630684d18807411d.html'];   // link previews; Google Search Console's verification
// The analytics token comes from --analytics or, for a Git-connected Cloudflare Pages build, from the
// BYPASS_ANALYTICS_TOKEN environment variable; unset or empty, the release counts nothing.
const args = process.argv.slice(2);
const at = args.indexOf('--analytics');
const token = at >= 0 ? args.splice(at, 2)[1] : (process.env.BYPASS_ANALYTICS_TOKEN || '').trim();
if ((at >= 0 || token) && !/^[A-Za-z0-9]{16,64}$/.test(token ?? '')) throw new Error('the analytics token should be the site token from Cloudflare Web Analytics');
const out = args[0] || 'site';
const BEACON_HOST = 'https://static.cloudflareinsights.com';
// Cloudflare Pages (and Netlify) read _headers; other hosts serve it as a plain file, which does no harm. A <meta> CSP
// can't say frame-ancestors, so this is where "not inside other sites" is sent (core.js checks it too).
const HEADERS = `# Response headers for Cloudflare Pages (tools-release.mjs writes this file)
/*
  Content-Security-Policy: frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;

// hidden files and folders (.DS_Store, editors' and tools' bookkeeping) are never published
const hidden = (p) => p.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.' && part !== '..');
const walk = (p) => statSync(p).isDirectory() ? readdirSync(p).sort().flatMap(f => walk(join(p, f))) : [p];
const files = PUBLISH.flatMap(walk).filter(f => !hidden(f));
const hash = createHash('sha256');
for (const f of files) hash.update(f).update('\0').update(readFileSync(f)).update('\0');
hash.update(token);                              // a build with analytics differs from one without: another release
const release = hash.digest('hex').slice(0, 10);
const v = `?v=${release}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const p of PUBLISH) cpSync(p, join(out, p), { recursive: true, filter: (f) => !hidden(f) });

/** Rewrites one copied file; `min` is how many references the pattern must find (a moved reference fails here). */
function rewrite(file, pattern, replace, min = 1) {
  const path = join(out, file);
  let n = 0;
  const s = readFileSync(path, 'utf8').replace(pattern, (...m) => { n++; return replace(...m); });
  if (n < min) throw new Error(`${file}: expected at least ${min} reference(s) for ${pattern}, found ${n}`);
  writeFileSync(path, s);
  return n;
}

let count = 0;
// the page: local scripts and stylesheets (not links to text files, not other sites); and the release, for bug reports
count += rewrite('index.html', /(src|href)="((?![a-z]+:|#|\/\/)[^"?#]+\.(?:js|css))"/g, (m, attr, url) => `${attr}="${url}${v}"`, 6);   // 1 stylesheet, 4 classic scripts, app/main.js
rewrite('index.html', /<meta charset="utf-8">/i, (m) => `${m}\n<meta name="bypass-release" content="${release}">`);
// the page's scripts: the worker and the data files
count += rewrite('app/core.js', /new Worker\("src\/worker\.js"/g, () => `new Worker("src/worker.js${v}"`);
for (const f of readdirSync(join(out, 'app')).filter(f => f.endsWith('.js'))) {
  count += rewrite(`app/${f}`, /fetch\("(data\/[^"?]+)"\)/g, (m, url) => `fetch("${url}${v}")`, 0);
}
// the modules: every relative import, static or dynamic, in the engine (src/), the page (app/), ui-map.js and
// CodeMirror 6 (MapLibre's .mjs included: its worker's address is derived from the module's own and versioned by
// MapLibre). CodeMirror's files import each other: versioning only app/editor.js's imports would load a second
// copy of each, which CodeMirror refuses.
const IMPORT = /(from |import\(|^import )(["'])(\.{1,2}\/[^"'?]+\.m?js)\2/gm;
const modules = ['ui-map.js', ...['src', 'app', 'vendor/codemirror-6'].flatMap(d => readdirSync(join(out, d)).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`))];
for (const f of modules) {
  count += rewrite(f, IMPORT, (m, kw, q, url) => `${kw}${q}${url}${v}${q}`, 0);
  const left = readFileSync(join(out, f), 'utf8').match(/(?:from |import\(|^import )["']\.{1,2}\/[^"'?]+["']/m);
  if (left) throw new Error(`${f}: an import left without the release: ${left[0]}`);
}
// visit counting: the token, the beacon's host in the CSP and the About dialog's paragraph saying so; or neither
const ON = /\n[ \t]*<p id="pv-tracking">[\s\S]*?<\/p>\n([ \t]*)<!-- ANALYTICS-ON ([\s\S]*?) -->/;
if (token) {
  rewrite('app/core.js', /const ANALYTICS_TOKEN = "";/, () => `const ANALYTICS_TOKEN = "${token}";`);
  rewrite('index.html', /script-src 'self';/, () => `script-src 'self' ${BEACON_HOST};`);
  rewrite('index.html', ON, (m, indent, para) => `\n${indent}${para}`);
} else {
  rewrite('index.html', /\n[ \t]*<!-- ANALYTICS-ON [\s\S]*? -->/, () => '');
}
writeFileSync(join(out, '_headers'), HEADERS);
console.log(`${out}/: release ${release}, ${files.length} files, ${count} references versioned, analytics ${token ? 'on' : 'off'}`);
