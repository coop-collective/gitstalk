// The Clef triage evaluation (packages/gateway/src/approval/triage-eval/README.md): sends the
// exact request bodies the approval gate builds (requests.jsonl, kept equal to the code by
// triage-eval.test.ts) to Workers AI and scores the answers against the labels in cases.json.
//
//   node scripts/clef-triage-eval.mjs                 # the set and its requests, no network
//   node scripts/clef-triage-eval.mjs --live          # ask Clef Flash, each request once
//   node scripts/clef-triage-eval.mjs --live --repeat 3 --model clef --variant current \
//     --out /tmp/clef-eval.json
//
// --live needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with Workers AI read)
// in the environment; neither is printed. Answers go through the REST API, not AI Gateway.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL = path.join(ROOT, 'packages/gateway/src/approval/triage-eval');
/** The gate holds a bean only for a `card` at least this sure (`CARD_MIN_PROBABILITY`). */
const CARD_MIN_PROBABILITY = 0.65;
const MODELS = {
  'clef-flash': { id: '@cf/cloudflare/clef-flash', body: 'clef-flash' },
  clef: { id: '@cf/cloudflare/clef', body: 'clef' },
};
const CONCURRENCY = 4;
const TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));
const cases = new Map(
  JSON.parse(readFileSync(path.join(EVAL, 'cases.json'), 'utf8')).map((entry) => [entry.id, entry]),
);
const requests = readFileSync(path.join(EVAL, 'requests.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((request) => options.variant === null || request.variant === options.variant);

if (!options.live) {
  describeSet();
} else {
  await evaluate();
}

function describeSet() {
  const labels = countBy([...cases.values()], (entry) => entry.label);
  const variants = countBy(requests, (request) => request.variant);
  console.log(
    `${cases.size} cases (${format(labels)}); ${requests.length} requests (${format(variants)})`,
  );
  console.log('Add --live to ask Clef (needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN).');
}

async function evaluate() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for --live.');
    process.exit(2);
  }
  const model = MODELS[options.model];
  const jobs = requests.flatMap((request) =>
    Array.from({ length: options.repeat }, (_, round) => ({ request, round })),
  );
  const answers = await inPool(jobs, CONCURRENCY, ({ request, round }) =>
    ask({ account, token, model }, request).then((answer) => ({
      variant: request.variant,
      id: request.id,
      round,
      ...answer,
    })),
  );
  for (const variant of new Set(answers.map((answer) => answer.variant)))
    printScore(
      variant,
      answers.filter((answer) => answer.variant === variant),
    );
  if (options.out !== null) {
    writeFileSync(options.out, `${JSON.stringify({ model: model.id, answers }, null, 2)}\n`);
    console.log(`answers written to ${options.out}`);
  }
}

async function ask({ account, token, model }, request) {
  const body = { ...request.body, model: model.body };
  const started = Date.now();
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model.id}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const ms = Date.now() - started;
    if (!response.ok) return { ms, error: `HTTP ${response.status}` };
    const route = unwrap(await response.json())?.answers?.route;
    if (typeof route?.choice !== 'string') return { ms, error: 'no route answer' };
    return { ms, choice: route.choice, probabilities: route.probabilities ?? {} };
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

/** What the gate would do with an answer: `card` only when Clef is sure enough. */
function gateRoute(answer) {
  if (answer.choice !== 'card') return 'auto';
  return (answer.probabilities.card ?? 0) >= CARD_MIN_PROBABILITY ? 'card' : 'auto';
}

function printScore(variant, answers) {
  const answered = answers.filter((answer) => answer.error === undefined);
  const labelled = answered.filter((answer) => cases.get(answer.id)?.label !== 'either');
  const correct = labelled.filter((answer) => gateRoute(answer) === cases.get(answer.id)?.label);
  const sureness = answered.map((answer) => answer.probabilities[answer.choice] ?? 0);
  const unsure = sureness.filter((p) => p < CARD_MIN_PROBABILITY).length;
  const missedCards = labelled.filter(
    (answer) => cases.get(answer.id)?.label === 'card' && gateRoute(answer) === 'auto',
  );
  const extraCards = labelled.filter(
    (answer) => cases.get(answer.id)?.label === 'auto' && gateRoute(answer) === 'card',
  );
  const t013 = answered
    .filter((answer) => answer.id === 't013')
    .map((answer) => `${answer.choice} ${(answer.probabilities[answer.choice] ?? 0).toFixed(2)}`);
  const latency = answers.map((answer) => answer.ms).toSorted((a, b) => a - b);
  console.log(`\n${variant}: ${answered.length}/${answers.length} answered`);
  console.log(`  gate route matches the label: ${correct.length}/${labelled.length}`);
  console.log(`  cards missed: ${unique(missedCards)}; cards not wanted: ${unique(extraCards)}`);
  const median = quantile(
    sureness.toSorted((a, b) => a - b),
    0.5,
  );
  console.log(
    `  p of the choice: median ${median.toFixed(2)}, ${unsure} below ${CARD_MIN_PROBABILITY}`,
  );
  console.log(`  t013: ${t013.length === 0 ? 'not asked' : t013.join(', ')}`);
  console.log(`  flips across repeats: ${flips(answered)}`);
  console.log(`  latency ms: p50 ${quantile(latency, 0.5)}, p90 ${quantile(latency, 0.9)}`);
}

function flips(answers) {
  const byCase = new Map();
  for (const answer of answers)
    byCase.set(answer.id, new Set([...(byCase.get(answer.id) ?? []), answer.choice]));
  return [...byCase.values()].filter((choices) => choices.size > 1).length;
}

function unique(answers) {
  const ids = [...new Set(answers.map((answer) => answer.id))];
  return ids.length === 0 ? 'none' : ids.join(' ');
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
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

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function format(counts) {
  return Object.entries(counts)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
}

function parseArgs(args) {
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : (args[index + 1] ?? fallback);
  };
  const model = value('--model', 'clef-flash');
  if (!(model in MODELS)) {
    console.error(`--model must be one of ${Object.keys(MODELS).join(', ')}`);
    process.exit(2);
  }
  return {
    live: args.includes('--live'),
    model,
    variant: value('--variant', null),
    repeat: Math.max(1, Number(value('--repeat', '1')) || 1),
    out: value('--out', null),
  };
}
