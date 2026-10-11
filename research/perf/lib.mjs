// Shared helpers: load Playwright from an external folder so the repo gains no dependency.
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

export function loadPlaywright() {
  const dir = process.env.PW_DIR;
  if (!dir) throw new Error('Set PW_DIR to a folder whose node_modules has playwright (kept out of the repo).');
  return createRequire(`${dir}/`)('playwright');
}

/** Chrome for Testing from the Playwright cache, or PW_CHROME. */
export function chromePath() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const root = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const d of dirs) {
    const p = `${root}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
  return undefined; // fall back to Playwright's default browser
}

export async function launch(pw) {
  const executablePath = chromePath();
  return pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

export const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};

export const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
