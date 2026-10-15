// The Clef clash evaluation (packages/gateway/src/approval/triage-eval/README.md): sends the
// exact request bodies the approval gate builds for labelled bean pairs (clash-requests.jsonl,
// kept equal to the code by clash-cases.test.ts) to Workers AI, and scores each `clash.0`
// probability against the pair's label at thresholds 0.30 to 0.80.
//
//   node scripts/clef-clash-eval.mjs                  # the set and its requests, no network
//   node scripts/clef-clash-eval.mjs --live           # ask Clef Flash once per request
//   node scripts/clef-clash-eval.mjs --score          # score the saved clash-answers.json
//   node scripts/clef-clash-eval.mjs --live --model clef   # Clef (27B), to clash-answers-clef.json
//
// --live reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, else the owner's account and the
// Wrangler OAuth token (~/Library/Preferences/.wrangler/config/default.toml); neither is
// printed. Answers go through the REST API, not AI Gateway, to triage-eval/clash-answers.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL = path.join(ROOT, 'packages/gateway/src/approval/triage-eval');
const MODELS = {
  'clef-flash': {
    id: '@cf/cloudflare/clef-flash',
    body: 'clef-flash',
    answers: 'clash-answers.json',
  },
  clef: { id: '@cf/cloudflare/clef', body: 'clef', answers: 'clash-answers-clef.json' },
};
const DEFAULT_ACCOUNT = 'e40385e6d96d5cad8df33b1ef3e3694a';
const WRANGLER_CONFIG = path.join(homedir(), 'Library/Preferences/.wrangler/config/default.toml');
/** The gate's `RECHECK_MIN_PROBABILITY`. */
const RECHECK_MIN_PROBABILITY = 0.5;
const THRESHOLDS = Array.from({ length: 11 }, (_, step) => 0.3 + step * 0.05);
const CONCURRENCY = 4;
const TIMEOUT_MS = 30_000;

const options = parseArgs(process.argv.slice(2));
const model = MODELS[options.model];
const ANSWERS = path.join(EVAL, model.answers);
const cases = new Map(
  JSON.parse(readFileSync(path.join(EVAL, 'clash-cases.json'), 'utf8')).map((entry) => [
    entry.id,
    entry,
  ]),
);
const requests = readFileSync(path.join(EVAL, 'clash-requests.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

if (options.live) await evaluate();
else if (options.score) score(JSON.parse(readFileSync(ANSWERS, 'utf8')).answers);
else describeSet();

function describeSet() {
  const clashes = [...cases.values()].filter((entry) => entry.clash).length;
  console.log(
    `${cases.size} pairs (${clashes} clash, ${cases.size - clashes} not); ${requests.length} requests`,
  );
  console.log('Add --live to ask Clef Flash, or --score to score clash-answers.json.');
}

async function evaluate() {
  const credentials = credentialsOf();
  const answers = await inPool(requests, CONCURRENCY, (request) =>
    ask(credentials, request).then((answer) => ({
      variant: request.variant,
      id: request.id,
      clash: request.clash,
      links: request.links,
      ...answer,
    })),
  );
  writeFileSync(ANSWERS, `${JSON.stringify({ model: model.id, answers }, null, 2)}\n`);
  console.log(`answers written to ${path.relative(ROOT, ANSWERS)}`);
  score(answers);
}

function credentialsOf() {
  const account = fromEnv('CLOUDFLARE_ACCOUNT_ID') ?? DEFAULT_ACCOUNT;
  const token = fromEnv('CLOUDFLARE_API_TOKEN') ?? wranglerToken();
  if (!token) {
    console.error('Set CLOUDFLARE_API_TOKEN, or log in with wrangler, for --live.');
    process.exit(2);
  }
  return { account, token };
}

/** An environment variable's value; null when it is unset or empty. */
function fromEnv(name) {
  const value = process.env[name] ?? '';
  return value === '' ? null : value;
}

function wranglerToken() {
  try {
    return (
      /^oauth_token\s*=\s*"([^"]+)"/mu.exec(readFileSync(WRANGLER_CONFIG, 'utf8'))?.[1] ?? null
    );
  } catch {
    return null;
  }
}

async function ask({ account, token }, request) {
  const started = Date.now();
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model.id}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request.body, model: model.body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const ms = Date.now() - started;
    if (!response.ok) return { ms, error: `HTTP ${response.status}` };
    const answers = unwrap(await response.json())?.answers;
    const noul = answers?.['clash.0']?.noul;
    if (typeof noul !== 'number') return { ms, error: 'no clash answer' };
    const route = answers?.route;
    return { ms, p: noul, route: route?.choice ?? null, routeP: route?.probabilities ?? {} };
  } catch (error) {
    return { ms: Date.now() - started, error: error instanceof Error ? error.message : 'failed' };
  }
}

/** The REST API wraps the answer in `result` (at most twice). */
function unwrap(raw) {
  let value = raw;
  for (let depth = 0; depth < 2 && value && !('answers' in value); depth += 1)
    value = value.result ?? value;
  return value;
}

function score(answers) {
  const failed = answers.filter((answer) => answer.error !== undefined);
  for (const answer of failed) console.log(`${answer.variant} ${answer.id}: ${answer.error}`);
  const answered = answers.filter((answer) => answer.error === undefined);
  for (const variant of new Set(answered.map((answer) => answer.variant))) {
    const rows = answered
      .filter((answer) => answer.variant === variant)
      .toSorted((a, b) => b.p - a.p);
    console.log(`\n${variant}: ${rows.length} answered`);
    printCases(rows);
    printThresholds(rows);
  }
}

function printCases(rows) {
  console.log('  p      label  links  route       case');
  for (const row of rows) {
    const wrong = row.p >= RECHECK_MIN_PROBABILITY !== row.clash ? ' <- wrong at 0.5' : '';
    const route = `${row.route ?? '-'} ${(row.routeP[row.route] ?? 0).toFixed(2)}`;
    console.log(
      `  ${row.p.toFixed(3)}  ${row.clash ? 'clash' : 'no   '}  ${String(row.links).padStart(5)}  ${route.padEnd(10)}  ${row.id} ${cases.get(row.id)?.this.bean} / ${cases.get(row.id)?.theirs.bean}${wrong}`,
    );
  }
}

function printThresholds(rows) {
  console.log('  threshold  precision  recall  false rechecks  missed clashes');
  for (const threshold of THRESHOLDS) {
    const flagged = rows.filter((row) => row.p >= threshold - 1e-9);
    const caught = flagged.filter((row) => row.clash).length;
    const clashes = rows.filter((row) => row.clash).length;
    const precision = flagged.length === 0 ? 1 : caught / flagged.length;
    console.log(
      `  ${threshold.toFixed(2)}       ${precision.toFixed(2)}       ${(caught / clashes).toFixed(2)}    ${String(flagged.length - caught).padStart(2)}              ${clashes - caught}`,
    );
  }
}

async function inPool(items, size, work) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // oxlint-disable-next-line no-await-in-loop -- a small pool keeps the rate polite
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

function parseArgs(args) {
  const at = args.indexOf('--model');
  const name = at === -1 ? 'clef-flash' : args[at + 1];
  if (!(name in MODELS)) {
    console.error(`--model must be one of ${Object.keys(MODELS).join(', ')}`);
    process.exit(2);
  }
  return { live: args.includes('--live'), score: args.includes('--score'), model: name };
}
