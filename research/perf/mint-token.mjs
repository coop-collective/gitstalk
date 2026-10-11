// Mints a read+write personal access token for the perf account (session cookie from <dir>/cookie.txt)
// and saves it to <dir>/token.txt (outside the repo, mode 600).
// Usage: PW_DIR=... node research/perf/mint-token.mjs --base https://gitstalk.dev --dir <secrets dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { loadPlaywright, launch, arg } from './lib.mjs';

const base = arg('base', 'https://gitstalk.dev');
const dir = arg('dir');
if (!dir) throw new Error('--dir <secrets dir> is required');
const browser = await launch(loadPlaywright());
const context = await browser.newContext();
await context.addCookies([{ name: '__Host-bs_session', value: readFileSync(`${dir}/cookie.txt`, 'utf8').trim(), url: base, secure: true, httpOnly: true }]);
const page = await context.newPage();
await page.goto(`${base}/settings/tokens`, { waitUntil: 'networkidle' });
const nameInput = await page.$('main input[type=text], main input[name=name]');
if (nameInput) await nameInput.fill('perf-write');
for (const scope of ['collaborate', 'write']) await page.check(`input[name=scope][value=${scope}]`);
await page.click('button:has-text("Create token")');
await page.waitForTimeout(2500);
const token = (await page.textContent('main')).match(/bsu_[A-Za-z0-9_-]{43}/)?.[0];
if (!token) throw new Error('token not found on the page');
writeFileSync(`${dir}/token.txt`, token, { mode: 0o600 });
console.log('token saved to', `${dir}/token.txt`);
await browser.close();
