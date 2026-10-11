// Bundle-size measurement for the Gitstalk web app.
//
//   node research/perf/bundle.mjs [--no-build] [--base https://gitstalk.dev --cookie-file <path>]
//        [--out research/perf/results/bundle-<date>.json]
//
// 1. Runs `pnpm -F @gitstalk/web build` (skip with --no-build) and sums raw / gzip / brotli
//    sizes of every file in packages/web/dist/client, by type.
// 2. With --base and --cookie-file: fetches each route's HTML, collects the modulepreload,
//    stylesheet and script URLs, downloads them and sums raw / gzip / brotli per page, plus
//    the set preloaded on EVERY page (the intersection). Brotli/gzip are computed locally from
//    the served bytes, an estimate of the wire size (Cloudflare re-compresses at the edge).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { arg } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'packages/web/dist/client');
const out = arg('out', `research/perf/results/bundle-${new Date().toISOString().slice(0, 10)}.json`);

const sizes = (buf) => ({
  raw: buf.length,
  gzip: gzipSync(buf, { level: 9 }).length,
  brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});
const add = (a, b) => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli });
const zero = () => ({ raw: 0, gzip: 0, brotli: 0 });

if (!process.argv.includes('--no-build')) {
  execFileSync('pnpm', ['-F', '@gitstalk/web', 'build'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
}

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const result = { takenAt: new Date().toISOString(), dist: { byType: {}, total: zero(), files: 0, largest: [] } };
const files = [];
for (const f of walk(dist)) {
  const ext = extname(f).slice(1) || 'other';
  const s = sizes(readFileSync(f));
  files.push({ file: f.slice(dist.length), ext, ...s });
  result.dist.byType[ext] = add(result.dist.byType[ext] ?? zero(), s);
  result.dist.total = add(result.dist.total, s);
}
result.dist.files = files.length;
result.dist.byTypeCount = Object.fromEntries(Object.keys(result.dist.byType).map((k) => [k, files.filter((f) => f.ext === k).length]));
result.dist.largest = files.sort((a, b) => b.raw - a.raw).slice(0, 10).map(({ file, raw, gzip, brotli }) => ({ file, raw, gzip, brotli }));

const base = arg('base')?.replace(/\/$/, '');
const cookieFile = arg('cookie-file');
if (base && cookieFile) {
  const cookie = readFileSync(cookieFile, 'utf8').trim();
  const handle = readFileSync(arg('handle-file', `${dirname(cookieFile)}/handle.txt`), 'utf8').trim();
  const headers = { cookie: `__Host-bs_session=${cookie}` };
  const get = async (p) => (await fetch(`${base}${p}`, { headers })).text();
  const repo = `/${handle}/${arg('repo', 'perf-repo')}`;
  const link = (html, re) => [...html.matchAll(re)].map((m) => m[1])[0];
  const changes = await get(`${repo}/changes`);
  const actions = await get(`${repo}/actions`);
  const routes = {
    home: '/',
    repo,
    changes: `${repo}/changes`,
    bean: link(changes, /href="(\/[^"]*\/changes\/[^"/]+)"/g),
    history: `${repo}/history`,
    actionsRun: link(actions, /href="(\/[^"]*\/actions\/runs\/[^"/]+)"/g),
    owner: `/${handle}`,
  };
  const cache = new Map();
  const asset = async (u) => {
    if (!cache.has(u)) cache.set(u, sizes(Buffer.from(await (await fetch(new URL(u, base), { headers })).arrayBuffer())));
    return cache.get(u);
  };
  const perPage = {};
  for (const [name, path] of Object.entries(routes)) {
    if (!path) continue;
    const html = await get(path);
    const urls = new Set();
    for (const m of html.matchAll(/<link[^>]+>|<script[^>]+>/g)) {
      const tag = m[0];
      const href = tag.match(/(?:href|src)="([^"]+)"/)?.[1];
      if (!href || !/\.(js|css)(\?|$)/.test(href)) continue;
      if (/rel="(modulepreload|stylesheet)"/.test(tag) || /^<script/.test(tag)) urls.add(href);
    }
    const detail = {};
    let totalJs = zero();
    let totalCss = zero();
    for (const u of urls) {
      const s = await asset(u);
      detail[u] = s;
      if (/\.css/.test(u)) totalCss = add(totalCss, s);
      else totalJs = add(totalJs, s);
    }
    perPage[name] = { path: path.replace(handle, '<handle>'), htmlBytes: Buffer.byteLength(html), htmlBrotli: sizes(Buffer.from(html)).brotli, assets: urls.size, js: totalJs, css: totalCss, urls: [...urls] };
  }
  const sets = Object.values(perPage).map((p) => new Set(p.urls));
  const common = [...sets[0]].filter((u) => sets.every((s) => s.has(u)));
  let commonJs = zero();
  for (const u of common) if (!/\.css/.test(u)) commonJs = add(commonJs, await asset(u));
  result.live = { base, perPage, preloadedOnEveryPage: { files: common.length, urls: common, js: commonJs } };
}

mkdirSync(dirname(join(root, out)), { recursive: true });
writeFileSync(join(root, out), JSON.stringify(result, null, 2));
const kb = (n) => `${(n / 1024).toFixed(1)}k`;
console.log(`dist/client: ${files.length} files, raw ${kb(result.dist.total.raw)} gzip ${kb(result.dist.total.gzip)} br ${kb(result.dist.total.brotli)}`);
console.log('wrote', out);
