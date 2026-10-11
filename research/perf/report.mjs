// Renders the tables of a results markdown file from measure.mjs and bundle.mjs JSON.
//   node research/perf/report.mjs --measure <raw.json> [--bundle <bundle.json>] > tables.md
import { readFileSync } from 'node:fs';
import { arg } from './lib.mjs';

const m = JSON.parse(readFileSync(arg('measure'), 'utf8'));
const b = arg('bundle') ? JSON.parse(readFileSync(arg('bundle'), 'utf8')) : null;
const ms = (n) => (n == null ? '-' : `${Math.round(n)}`);
const kb = (n) => (n == null ? '-' : `${(n / 1024).toFixed(0)}`);
const lines = [];
const top = (by = {}) => {
  const e = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const shown = e.slice(0, 3).map(([k, c]) => `${k} x${c}`).join('; ');
  return e.length ? shown + (e.length > 3 ? ` (+${e.length - 3} more paths, mostly chunk/prefetch fetches)` : '') : 'none';
};
const p = (s = '') => lines.push(s);

if (b) {
  p('### Bundle (local build of packages/web, dist/client)');
  p();
  p('| type | files | raw KB | gzip KB | brotli KB |');
  p('|---|---:|---:|---:|---:|');
  for (const [t, s] of Object.entries(b.dist.byType)) p(`| ${t} | ${b.dist.byTypeCount[t]} | ${kb(s.raw)} | ${kb(s.gzip)} | ${kb(s.brotli)} |`);
  p(`| **total** | ${b.dist.files} | ${kb(b.dist.total.raw)} | ${kb(b.dist.total.gzip)} | ${kb(b.dist.total.brotli)} |`);
  if (b.live) {
    p();
    p(`### Per-page scripts and styles in the HTML (from ${b.live.base})`);
    p();
    p('| page | assets | JS raw KB | JS gzip KB | JS brotli KB | CSS brotli KB | HTML brotli KB |');
    p('|---|---:|---:|---:|---:|---:|---:|');
    for (const [n, s] of Object.entries(b.live.perPage)) p(`| ${n} | ${s.assets} | ${kb(s.js.raw)} | ${kb(s.js.gzip)} | ${kb(s.js.brotli)} | ${kb(s.css.brotli)} | ${kb(s.htmlBrotli)} |`);
    const c = b.live.preloadedOnEveryPage;
    p();
    p(`Chunks loaded on every page: ${c.files} files, JS raw ${kb(c.js.raw)} KB, gzip ${kb(c.js.gzip)} KB, brotli ${kb(c.js.brotli)} KB.`);
  }
  p();
}

const row = (label, cache, d) => `| ${label} | ${cache} | ${ms(d.ttfb)} | ${ms(d.lcp)} | ${ms(d.load)} | ${d.jsFiles} | ${kb(d.jsTransfer)} | ${kb(d.jsEncoded)} | ${d.requests} | ${kb(d.totalTransfer)} |`;
if (m.routes) {
  p(`### Page timing, medians of ${m.runs} runs (${m.base})`);
  p();
  p('| route | cache | TTFB ms | LCP ms | load ms | JS files | JS transferred KB | JS encoded KB | requests | total transferred KB |');
  p('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [n, r] of Object.entries(m.routes)) {
    p(row(`${n} \`${r.path}\``, 'cold', r.cold.median));
    p(row('', 'warm', r.warm.median));
  }
  p();
}
if (m.softMedian) {
  p('### Soft navigation between repo tabs (from the repo page; medians)');
  p();
  p('| to tab | URL change ms | painted ms | RSC requests (incl. prefetch) |');
  p('|---|---:|---:|---:|');
  for (const [t, s] of Object.entries(m.softMedian)) if (s) p(`| ${t} | ${ms(s.urlChangeMs)} | ${ms(s.paintMs)} | ${s.rscRequests} |`);
  p();
  p(`Back navigation (browser back after each tab): median ${ms(m.backMedian.ms)} ms, ${m.backMedian.rscRequests} RSC requests.`);
  p();
}
if (m.idle) {
  p(`### Idle polling, requests in ${Object.values(m.idle)[0].seconds} s`);
  p();
  p('| page | visible | hidden | what (visible) |');
  p('|---|---:|---:|---|');
  for (const n of new Set(Object.keys(m.idle).map((k) => k.split(':')[0]))) {
    const v = m.idle[`${n}:visible`];
    const h = m.idle[`${n}:hidden`];
    p(`| ${n} | ${v?.requests ?? '-'} | ${h?.requests ?? '-'} | ${top(v?.byPath)} |`);
  }
  p();
}
if (m.compare) {
  p('### Signed-out `/` comparison (3 loads each, cold)');
  p();
  p('| origin | TTFB ms | LCP ms | load ms | JS transferred KB | requests |');
  p('|---|---:|---:|---:|---:|---:|');
  const c = m.compare.median;
  const d = m.compareBaseSignedOutMedian;
  p(`| ${m.base} | ${ms(d.ttfb)} | ${ms(d.lcp)} | ${ms(d.load)} | ${kb(d.jsTransfer)} | ${d.requests} |`);
  p(`| ${m.compare.base} | ${ms(c.ttfb)} | ${ms(c.lcp)} | ${ms(c.load)} | ${kb(c.jsTransfer)} | ${c.requests} |`);
  p();
}
console.log(lines.join('\n'));
