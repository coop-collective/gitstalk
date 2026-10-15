# Clef triage evaluation

An offline evaluation of how Clef (`@cf/cloudflare/clef-flash`) triages beans for the approval gate (`../approval-gate.ts`, `../triage-question.ts`, doc `docs/claude-opus/32-approval-rules.md`). Nothing here runs Clef in tests; the owner runs the live part.

## Contents

| File | What it is |
|---|---|
| `cases.json` | 42 labelled bean situations. 37 are every bean the staging benchmark triaged (`research/race/runs/stg-scion-policy-fastify-16-s{7,11,13}`, fastify tasks t001 to t038 without t033, which no class matched): files and line counts from the task's solution patch (`research/real-arena/fastify/solutions`), and Clef's recorded answers per seed (`recorded`, every judgement in order, from the push lines). 5 are synthetic cards (auth, a migration, a removed public method, a dependency change) plus a one-line typo fix, since the benchmark had few changes a person should hold. |
| `requests.jsonl` | The exact Workers AI bodies, one per line (`variant`, `id`, `model`, `body`), for three variants: `as-run` (the question the benchmark sent), `current` (today's wording plus the diff's size and test share) and `current-described` (today's, with a `description` on the policy's `lib` class). `../triage-eval.test.ts` keeps it equal to the code; `pnpm -F @gitstalk/gateway exec vitest run -u src/approval/triage-eval.test.ts` rewrites it after a change to the question. |
| `../triage-eval.test.ts` | The set's checks and the gate run over every case with a mocked AI binding: a sure answer routes as labelled, t013's recorded `card` at p=0.51 lands (the 0.65 threshold), and four re-checks of t013's first push ask Clef once. |
| `scripts/clef-triage-eval.mjs` (repository root) | The live runner. |

## Labels

`auto` or `card` is what a maintainer would want for the change in a real repository, judged from the task's title, files and size; `either` (t026) is scored on sureness only. The labels were proposed by the author and confirmed by the owner on 2026-10-14 (a test pins them); they are still a judgement, not ground truth: change them in `cases.json` (and that test) and the next run scores against yours. The cards among the benchmark's beans are t006, t007 and t009 (large: 450 to 850 changed lines across many files), t012 and t019 (they change which forwarded headers and addresses are trusted). t013 (`request.mediaType`, 45+/17-, with tests and types) is labelled `auto`: a backwards-compatible addition.

What the recorded answers already show, before any live run: the benchmark's Clef chose `auto` for every bean except t013, so by these labels it let all five cards through, at p 0.51 to 0.69. With nobody to approve them in a load test that was the convenient answer; in a real repository it is the wrong one. The `current` wording names size and trust changes as reasons for `card`, so expect it to hold some of them, which in an unattended benchmark means those beans wait (see the doc on holds).

## Running it live

```bash
export CLOUDFLARE_ACCOUNT_ID=...       # the account with Workers AI
export CLOUDFLARE_API_TOKEN=...        # a token with Workers AI read; never printed
node scripts/clef-triage-eval.mjs                         # the set, no network
node scripts/clef-triage-eval.mjs --live                  # every variant, once
node scripts/clef-triage-eval.mjs --live --repeat 3 --out /tmp/clef-eval.json
node scripts/clef-triage-eval.mjs --live --model clef --variant current
```

Per variant it prints how often the gate's route (a `card` counts only at p >= 0.65) matches the label, which cards it missed and which it added, the median probability of the choice and how many answers fall below 0.65, t013's answers, how many cases changed their answer across `--repeat` rounds, and the latency (p50, p90). `--out` keeps every answer for a closer look.

What to look for: `current` should match more labels than `as-run` without adding cards to the small fixes, t013 should be `auto` above 0.65, and the share of answers below 0.65 should fall. If `current-described` beats `current`, recommend descriptions in policy files.

## Clash evaluation

The `clash.<n>` question (`../triage-question.ts`, `RECHECK_MIN_PROBABILITY` in `../approval-gate.ts`) has its own set.

| File | What it is |
|---|---|
| `clash-cases.json` | 35 labelled bean pairs (17 clashes, 18 not) in six languages: the judged bean (`this`) and one that landed after it forked (`theirs`), each with its intent, message and before/after files. Clashes are units, formats, meanings, renamed fields and constants; the non-clashes touch the same names compatibly (refactors, docs, logging, tests, a defaulted parameter, two beans moving to dollars together). |
| `clash-requests.jsonl` | The exact bodies, links computed by the real `beanLinks()`, for three variants: `current` (`this` judged), `intents-only` (no links) and `swapped` (`theirs` judged against a landed `this`; the bean that pushes second is judged, so both orders happen). `clash-cases.test.ts` keeps it equal to the code (`vitest run -u` rewrites it). |
| `clash-answers.json`, `clash-answers-clef.json` | Clef Flash's and Clef's answers (2026-10-16; deterministic). |
| `scripts/clef-clash-eval.mjs` | The live runner: `--live [--model clef]` asks and saves, `--score` re-scores the saved answers, per case and at thresholds 0.30 to 0.80. |

Measured 2026-10-16. Clef Flash rates every pair of `current` and `intents-only` below 0.25, clashes and non-clashes alike: no threshold catches any clash. `swapped` catches only k01 (0.585, the original shipping pair in the order it was first measured). Clef (27B) separates them: `current` at 0.30 has precision 0.89 and recall 0.94 (at 0.50: 0.86 and 0.35); `swapped` at 0.50 has 0.88 and 0.82.
