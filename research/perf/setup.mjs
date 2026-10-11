// Creates the perf test account on a staging environment with a virtual passkey, saves its
// session cookie + handle OUTSIDE the repo, and creates a repo
// from the TypeScript starter template.
// Usage: PW_DIR=<dir with node_modules/playwright> node research/perf/setup.mjs --base https://gitstalk.dev --out <dir>
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadPlaywright, launch, arg } from './lib.mjs';

const base = arg('base', 'https://gitstalk.dev');
const out = arg('out');
if (!out) throw new Error('--out <dir outside the repo> is required');
mkdirSync(out, { recursive: true });

const pw = loadPlaywright();
const browser = await launch(pw);
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

const handle = `perf-${randomBytes(3).toString('hex')}`;
await page.goto(`${base}/signup`, { waitUntil: 'networkidle' });
await page.fill('input[name=handle]', handle);
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/signup'), { timeout: 30000 }), page.click('button[type=submit]')]);
console.log('signed up, at', new URL(page.url()).pathname);

// Save the session straight away.
const all = await context.cookies();
console.log('cookie names', all.map((c) => `${c.name}(${c.httpOnly ? 'http' : 'js'})`).join(','));
const cookie = all.find((c) => /session/.test(c.name));
if (!cookie) throw new Error('no bs_session cookie');
const secret = (n, v) => writeFileSync(`${out}/${n}`, v, { mode: 0o600 });
secret('cookie.txt', cookie.value);
secret('handle.txt', handle);

// Repo from the template.
await page.goto(`${base}/new`, { waitUntil: 'networkidle' });
await page.fill('input[name=name]', 'perf-repo');
await page.check('input[value="template:typescript-starter"]');
await Promise.all([page.waitForURL((u) => u.pathname.includes('/perf-repo'), { timeout: 60000 }), page.click('main button[type=submit]')]);
console.log('repo created at', new URL(page.url()).pathname);

console.log('saved cookie and handle to', out, '- next: mint-token.mjs, seed.mjs');
await browser.close();
