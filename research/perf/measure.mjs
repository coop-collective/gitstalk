// Page-timing harness for the Gitstalk web app (staging only).
//
//   PW_DIR=<dir with node_modules/playwright> node research/perf/measure.mjs \
//     --base https://gitstalk.dev --cookie-file <dir>/cookie.txt [--handle-file <dir>/handle.txt]
//     [--runs 5] [--idle 60] [--out research/perf/results/run.json] [--only routes,soft,idle]
//     [--compare https://gitstalk.io]
//
// The session cookie (__Host-bs_session value) lives in a file outside the repo. The handle
// defaults to <cookie-file dir>/handle.txt. Repo is <handle>/perf-repo (see README for setup).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadPlaywright, launch, arg, median } from './lib.mjs';

const base = arg('base', 'https://gitstalk.dev').replace(/\/$/, '');
if (/gitstalk\.io\/?$/.test(base)) throw new Error('refusing to load-test production; use --compare for a few signed-out requests');
const cookieFile = arg('cookie-file');
if (!cookieFile) throw new Error('--cookie-file <path> is required');
const cookie = readFileSync(cookieFile, 'utf8').trim();
const handle = (process.env.PERF_HANDLE ?? readFileSync(arg('handle-file', `${dirname(cookieFile)}/handle.txt`), 'utf8')).trim();
const repoName = arg('repo', 'perf-repo');
const runs = Number(arg('runs', '5'));
const idleSeconds = Number(arg('idle', '60'));
const only = (arg('only', 'routes,soft,idle')).split(',');
const outFile = arg('out', `research/perf/results/raw-${new Date().toISOString().slice(0, 10)}.json`);
const repo = `/${handle}/${repoName}`;

const pw = loadPlaywright();
const browser = await launch(pw);
const log = (...a) => console.error(...a);

async function newContext(withCookie = true) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (withCookie) await context.addCookies([{ name: '__Host-bs_session', value: cookie, url: base, secure: true, httpOnly: true }]);
  await context.addInitScript(() => {
    window.__lcp = 0;
    window.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  return context;
}

const isRsc = (r) => /[?&]_rsc=/.test(r.url()) || r.headers()['rsc'] === '1' || (r.headers()['accept'] ?? '').includes('text/x-component');

/** Navigate and collect TTFB, LCP, load, JS/total transfer. */
async function loadRoute(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500); // let LCP settle and hydration fetches finish
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    const sum = (xs, k) => xs.reduce((a, e) => a + (e[k] || 0), 0);
    const js = res.filter((e) => e.initiatorType === 'script' || /\.js(\?|$)/.test(e.name));
    return {
      ttfb: nav.responseStart,
      responseEnd: nav.responseEnd,
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      lcp: window.__lcp || null,
      cls: Math.round(window.__cls * 1000) / 1000,
      htmlBytes: nav.encodedBodySize,
      requests: res.length + 1,
      jsFiles: js.length,
      jsTransfer: sum(js, 'transferSize'),
      jsEncoded: sum(js, 'encodedBodySize'),
      jsDecoded: sum(js, 'decodedBodySize'),
      totalTransfer: sum(res, 'transferSize') + nav.transferSize,
      totalEncoded: sum(res, 'encodedBodySize') + nav.encodedBodySize,
    };
  });
}

const stat = (rows) => {
  const out = {};
  for (const k of Object.keys(rows[0] ?? {})) out[k] = median(rows.map((r) => r[k]));
  return out;
};

const result = { base, takenAt: new Date().toISOString(), runs, node: process.version, repo: 'perf-repo', browser: browser.version() };

// 1. routes: cold (fresh context = empty HTTP cache) and warm (same context, second load onward)
const bean = await (async () => {
  const c = await newContext();
  const p = await c.newPage();
  const html = await (await p.request.get(`${base}${repo}/changes`)).text();
  const run = await (await p.request.get(`${base}${repo}/actions`)).text();
  const beanLink = [...html.matchAll(/href="(\/[^"]*\/changes\/[^"/]+)"/g)].map((m) => m[1])[0] ?? [...(await (await p.request.get(`${base}${repo}`)).text()).matchAll(/href="(\/[^"]*\/changes\/[^"/]+)"/g)].map((m) => m[1])[0];
  const runLink = [...run.matchAll(/href="(\/[^"]*\/actions\/runs\/[^"/]+)"/g)].map((m) => m[1])[0];
  await c.close();
  return { beanLink, runLink };
})();
log('discovered', bean);
result.discovered = { bean: Boolean(bean.beanLink), run: Boolean(bean.runLink) };

const routes = {
  home: '/',
  repo: repo,
  changes: `${repo}/changes`,
  bean: bean.beanLink,
  history: `${repo}/history`,
  actionsRun: bean.runLink,
  owner: `/${handle}`,
};

if (only.includes('routes')) {
  result.routes = {};
  for (const [name, path] of Object.entries(routes)) {
    if (!path) { log('skip', name); continue; }
    const cold = [];
    for (let i = 0; i < runs; i++) {
      const c = await newContext();
      cold.push(await loadRoute(await c.newPage(), `${base}${path}`));
      await c.close();
    }
    const c = await newContext();
    const page = await c.newPage();
    await loadRoute(page, `${base}${path}`); // prime
    const warm = [];
    for (let i = 0; i < runs; i++) warm.push(await loadRoute(page, `${base}${path}`));
    await c.close();
    result.routes[name] = { path: path.replace(handle, '<handle>'), cold: { median: stat(cold), runs: cold }, warm: { median: stat(warm), runs: warm } };
    log(name, 'cold ttfb', result.routes[name].cold.median.ttfb?.toFixed(0), 'lcp', result.routes[name].cold.median.lcp?.toFixed(0));
  }
}

// 2. soft navigation between repo tabs and back-navigation
if (only.includes('soft')) {
  result.soft = [];
  const tabs = ['changes', 'history', 'actions'];
  for (let i = 0; i < runs; i++) {
    const c = await newContext();
    const page = await c.newPage();
    let marks = [];
    page.on('request', (r) => { if (isRsc(r)) marks.push({ url: new URL(r.url()).pathname, t: Date.now(), done: null }); });
    page.on('requestfinished', (r) => { if (isRsc(r)) { const m = marks.find((x) => x.url === new URL(r.url()).pathname && !x.done); if (m) m.done = Date.now(); } });
    await page.goto(`${base}${repo}`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const row = { tabs: {}, back: null };
    let prev = repo;
    for (const tab of tabs) {
      const link = page.locator(`a[href="${repo}/${tab}"]`).first();
      if (!(await link.count())) { row.tabs[tab] = { error: 'no link' }; continue; }
      marks = [];
      const t0 = Date.now();
      await link.click();
      await page.waitForURL((u) => u.pathname === `${repo}/${tab}`, { timeout: 30000 });
      const tUrl = Date.now();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const tPaint = Date.now();
      await page.waitForTimeout(800);
      const lastDone = Math.max(0, ...marks.map((m) => m.done ?? 0));
      row.tabs[tab] = { urlChangeMs: tUrl - t0, paintMs: Math.max(tPaint, lastDone) - t0, rscRequests: marks.length, from: prev.replace(handle, '<handle>') };
      prev = `${repo}/${tab}`;
      // back-navigation to the previous page
      marks = [];
      const b0 = Date.now();
      await page.goBack({ waitUntil: 'commit' });
      await page.waitForURL((u) => u.pathname !== `${repo}/${tab}`, { timeout: 30000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(800);
      row.back = row.back ?? [];
      row.back.push({ from: tab, ms: Date.now() - b0, rscRequests: marks.length });
      prev = repo;
    }
    result.soft.push(row);
    await c.close();
  }
  result.softMedian = {};
  for (const tab of tabs) {
    const rows = result.soft.map((r) => r.tabs[tab]).filter((x) => x && !x.error);
    result.softMedian[tab] = rows.length ? stat(rows.map(({ from, ...n }) => n)) : null;
  }
  const backs = result.soft.flatMap((r) => r.back ?? []);
  result.backMedian = { ms: median(backs.map((b) => b.ms)), rscRequests: median(backs.map((b) => b.rscRequests)) };
  log('soft', JSON.stringify(result.softMedian), JSON.stringify(result.backMedian));
}

// 3. idle polling: requests over idleSeconds with the tab visible and hidden
if (only.includes('idle')) {
  result.idle = {};
  const idleRoutes = { home: '/', changes: `${repo}/changes`, actionsRun: bean.runLink };
  for (const [name, path] of Object.entries(idleRoutes)) {
    if (!path) continue;
    for (const visibility of ['visible', 'hidden']) {
      const c = await newContext();
      const page = await c.newPage();
      await page.goto(`${base}${path}`, { waitUntil: 'load' });
      await page.waitForTimeout(3000);
      if (visibility === 'hidden') {
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        // also move a second tab to the front so Chrome's own signal is used where headless honours it
        const other = await c.newPage();
        await other.goto('about:blank');
        await other.bringToFront();
      }
      const seen = [];
      const onReq = (r) => seen.push({ method: r.method(), type: r.resourceType(), path: new URL(r.url()).pathname + (isRsc(r) ? ' (rsc)' : '') });
      page.on('request', onReq);
      await new Promise((r) => setTimeout(r, idleSeconds * 1000));
      page.off('request', onReq);
      const byPath = {};
      for (const s of seen) { const k = `${s.method} ${s.type} ${s.path.replaceAll(handle, '<handle>').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')}`; byPath[k] = (byPath[k] ?? 0) + 1; }
      result.idle[`${name}:${visibility}`] = { seconds: idleSeconds, requests: seen.length, byPath };
      log('idle', name, visibility, seen.length);
      await c.close();
    }
  }
}

// 4. optional signed-out comparison against another origin (few requests only)
const compare = arg('compare');
if (compare) {
  result.compare = { base: compare, runs: [] };
  for (let i = 0; i < 3; i++) {
    const c = await newContext(false);
    const page = await c.newPage();
    result.compare.runs.push(await loadRoute(page, `${compare}/`));
    await c.close();
  }
  result.compare.median = stat(result.compare.runs);
  // and the same signed-out page on the base
  result.compareBaseSignedOut = [];
  for (let i = 0; i < 3; i++) {
    const c = await newContext(false);
    result.compareBaseSignedOut.push(await loadRoute(await c.newPage(), `${base}/`));
    await c.close();
  }
  result.compareBaseSignedOutMedian = stat(result.compareBaseSignedOut);
}

await browser.close();
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 2));
log('wrote', outFile);
