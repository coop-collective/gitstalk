# Beanstalk, explained: git, results, backlog, MCP

Written 2026-10-05 for Coop, from the `prototype` branch: the code in `packages/`, the docs in `docs/claude-opus/`, and the recorded runs in `research/race/runs/`. Where something is designed but not built, or not measured, this says so.

Names used throughout:

- A **bean** is one agent's change.
- The **sprout** is the staged line, where beans land after their check passes.
- The **stalk** is the stable line, which only moves to validated sprout commits.

---

## 1. Is it git compatible?

**Short answer: yes at the protocol level, no as a general-purpose host yet.** Beanstalk speaks real git smart-HTTP, so stock `git clone`, `fetch` and `push` work against it. Every real-agent race on Cloudflare used plain git through the gateway. But today a repository exists only as part of a *race run*, and access comes only from run tokens. You can't yet create a repo, import your project, and point your team at it.

### Where things live

Each run gets one Artifacts repo, `race-<run>`, in the namespace `beanstalk-race`. Everything is a branch of that one repo:

| Ref | What it is | Who moves it |
|---|---|---|
| `refs/heads/beans/<task>` (e.g. `beans/t032`) | One agent's change | That agent, through the git proxy |
| `refs/heads/sprout` | The staged line | Only the runner's committer, after a pre-land check passes |
| `refs/heads/stalk` | The stable line, and the repo's default branch | Only the engine, after a green validation (compare-and-swap ref update) |
| `refs/beanstalk/candidates/<sha>` | Scratch commits (squashes, reverts) the runner builds before deciding | Runner only |

So `git clone` gives you the stalk. `git fetch` sees the sprout and every bean, because reads are open within a run, as in the local harness.

**Why beans are branches and not forks.** The first build forked one Artifacts repo per bean. Forks made after the first landing were unreadable (upload-pack answered 500, pushes failed with `delta base is missing`), and new forks were sometimes briefly invisible. Branches keep every object in one store, nothing is created per task, and a finished run leaves one repo to reap (`docs/claude-opus/31-gateway-engine-internals.md`, "Why a bean is a branch").

### The git proxy

Agents never hold an Artifacts token. They talk to `/git/<namespace>/<repo>.git/*` on the gateway Worker with a Beanstalk run token (as Bearer, or as a Basic-auth password). The gateway checks the token, asks the run's Durable Object what this caller may do, borrows a short-lived Artifacts token server-side, and streams the request through (`src/routes/git.ts`, `src/run/git-access.ts`).

| Caller | Can read | Can push |
|---|---|---|
| Slot token (one agent slot) | The whole run repo | Only `refs/heads/beans/<task>` for a task it holds or has an open invocation for. Never a deletion |
| Seed token (admin, 15 min) | The run repo | `sprout` and `stalk`, once, before the run starts |
| View token (browser, MCP) | Nothing over git | Nothing ("view tokens do not open git repos") |

To enforce this, the proxy reads the command list at the start of each push and refuses any other ref. What it does **not** check: whether a push to your own bean fast-forwards. Force-pushing your own bean is allowed. It also refuses compressed push bodies (HTTP 415).

### What a developer's normal git does today

| Action | Works today? |
|---|---|
| `git clone` / `fetch` with a slot token | Yes: you get the stalk, and can fetch the sprout and every bean |
| `git push origin HEAD:refs/heads/beans/t032` from the slot working on t032 | Yes. This is exactly what the race driver does |
| Pushing to `sprout`, `stalk`, `main` or someone else's bean | Refused (403) |
| Deleting a branch | Refused |
| Creating a repo, importing an existing project, a long-lived team repo | **Not built.** Repos are created by `POST /v1/runs` and reaped after the run |
| Signing in as a person and pushing | **Not built.** There are no user accounts, only run tokens and an admin token |
| Telling Beanstalk "my bean is ready" | Only through the race driver's `POST …/invocations/:inv/result`. A plain `git push` alone doesn't submit a bean |

### Cloudflare Artifacts as the storage

Artifacts is the git storage. It has no server-side merge, so all merging happens in the **runner**, a Rust container with git 2.47, Node and Mergiraf (`packages/gateway/container`). The runner squashes a bean onto the sprout, composes queue batches, reverts, runs the test suite on an exact commit, and moves refs with `--force-with-lease`. It keeps a bare-repo cache per trunk and gets a per-job Artifacts token. Write tokens stay on the committer instance, which never runs agent code.

Artifacts quirks found the hard way, and the workarounds:

- **Late forks were unreadable.** Beans became branches.
- **"stored delta chain contains a cycle" on a revert push.** The runner now pushes whole objects (`exp/artifacts-delta-cycle-bug.md`).
- **Fetch-by-sha is unverified.** The runner only ever fetches named refs.

### GitHub interop: designed, not built

- **Mirroring.** The thesis docs say a stalk can be mirrored to GitHub and beans exported as PRs, with a "GitHub-down write path" (`claude-10`, `claude-11` idea #32). Both self-critiques (`claude-14`, `claude-14b`) moved "GitHub mirror and PR export" to the roadmap. **No code exists.**
- **Stalk promotion as a GitHub Action** (`10` §5c). A `.github/workflows/stalk.yml` would fire on each sprout push, run the full suite and a verifier agent, and then do one of two things:
  - **pass:** a separate job with the only stalk-write permission fast-forwards the stalk;
  - **fail:** `revert-culprit` reverts the culprit out of the sprout.

  Teams would own "what stable means" by editing YAML. It depends on an Actions-compatible runner on Containers (`05`), which is also **not built**. Today the RunDO engine does promotion itself.

---

## 2. Performance seen so far

Setup for every race below: 40 colliding tasks in a synthetic TypeScript "shop" arena, Sonnet agents, 60 s emulated CI on 2 slots, every landed acceptance test protected. The baseline is a good batched, bisecting merge queue.

### Local harness (5 seeds)

Beanstalk v2 finished first in **5 of 5 seed pairs, 1.98x sooner on average** (95% CI 1.68–2.28, p = 0.008). The queue was the noisy one (16.5–34.7 min against v2's 11.3–14.4), but it reached the 20th green first in 4 of 5 pairs, and v2 cost about 12% more (`exp/e7`).

### Cloudflare, 12 real agents, three seeds (every decision made on the deployed prototype)

The demo engine is **v2.5 with dependency-aware starts** and the tail fix (`--preset demo`). Numbers from `python3 kth_green.py --k 35` and the summaries, seeds 7 / 11 / 13:

| Run | Green | 35th green (min) | Done (min) | Agent $ | Red validations |
|---|---|---|---|---|---|
| Queue (`cf-queue-sonnet-12-s7-landed`, `-s11`, `-s13`) | 36 / 35 / 37 | 35.0 / 29.2 / 36.8 | 40.6 / 30.2 / 39.5 | 4.12 / 4.51 / 4.54 | 10 / 8 / 10 |
| **v2.5 + dependency starts** (`cf-v25dep2-sonnet-12-s7`, `-s11`, `-s13`) | **39 / 39 / 38** | **17.1 / 14.9 / 22.0** | **31.6 / 24.0 / 29.8** | 6.08 / 4.18 / 5.32 | 4 / 0 / 4 |
| v2.4 (`cf-v24-sonnet-12-s7`, `-s11`, `-s13`) | 37 / 32 / 33 | 15.2 / not reached / not reached | 17.7 / 17.3 / 25.4 | 4.40 / 5.75 / 5.83 | 4 / 5 / 13 |

**The claim:** Beanstalk ships more (38–39 of 40 against the queue's 35–37), its 35th task is green 1.7–2.1x sooner on every seed (2.05x, 1.96x, 1.67x), and it is done about 1.3x sooner (1.28x, 1.26x, 1.33x). The final stalk was correct in every run.

How the engine was chosen: every v2.5 phase ran on the same three seeds (`docs/claude-opus/11`, "CF v2.5 phase matrix"). The partial phases (v2.5a to v2.5c) shipped fewer tasks than the queue and about as many as v2.4 or fewer (31–34.7 green on average against 34.0); full v2.5 with FIFO starts shipped 37–39 but was slow (done 22.8–40.5 min); adding dependency starts made it win, once the tail fix stopped one looping bean (t032) from holding two runs to the 60-minute cap (`cf-v25dep-*`, rerun as `cf-v25dep2-*`). The simulator had over-predicted v2.5 (12–16 min done simulated; 24–32 min real for the demo engine).

Earlier single-seed history (seed 7): v2.0 35 green, done 17.5 min; v2.2 24 green (failed); v2.3 34 green, 17.9 min. Two earlier v2 cloud runs hit infrastructure bugs (34 and 27 green) and are kept but excluded (`08` §5.5). Before any real agents, replay parity was checked: with free replay agents, the cloud and local forges made identical decisions (25/25/15 for both policies).

### Why "done" moves less than the 35th green

v2.4 finished first (17–25 min) but shipped only 32–37 tasks: it gave up on the hard beans early. v2.5 keeps working on them (cards that re-execute the loser, a rescue, dynamic culprits), so it ships 38–39 and its last minutes go to those few beans. The end of a race is set by the last beans: the ones in a rework chain, a revert or a decision card, plus the final validation. For a team, the 35th-green number matters more than "done": most work is usable in about half the time.

### Cost

Agent spend only, three seeds:

| Run | Agent spend (7 / 11 / 13) | Total | Against the queue |
|---|---|---|---|
| Queue | $4.12 / $4.51 / $4.54 | $13.16 | baseline |
| v2.5 + dependency starts | $6.08 / $4.18 / $5.32 | $15.58 | +18% (seed 11 was 7% cheaper) |
| v2.4 | $4.40 / $5.75 / $5.83 | $15.98 | +21% |

**Measured Cloudflare infrastructure** (the gateway's meter, `infra` in `summary.json`), the three `cf-v25dep2` races: **$0.38 / $0.35 / $0.42** (containers $0.24–0.28, Artifacts $0.11–0.14, Workers and Durable Objects under $0.01), about 7% of the agent spend. The queue and v2.4 races ran before the meter. The estimates below were made before any metered race and came out close (~$0.46 for v2.4).

**Cloudflare infrastructure, per race (the pre-meter estimate).** From 2026-10-06 every RunDO meters what its run uses and `summary.json` reports it under `infra` (counts and dollars at list prices; `packages/gateway/src/run/infra-meter.ts`, gateway README "Spend guards"). Before the first metered race, the figures below were **estimates** from the recorded runs' event counts (`research/race/runs/cf-v24-sonnet-12-s7`, `cf2-replay-v2-8-s7`), priced the way the meter prices them.

| | v2.4, 12 Sonnet agents (1,126 s) | Replay, 8 agents (417 s) |
|---|---|---|
| Runner calls (checks, squashes, CI, lands, promotions) | ~266 | ~185 |
| Container busy / up seconds (15 / 11 `standard-2` instances, 2 min `sleepAfter`) | ~1,600 / ~18,700 | ~1,000 / ~5,900 |
| Containers | **~$0.33** | **~$0.11** |
| Artifacts operations (agent fetch+push, runner fetches and pushes, binding calls) | ~870 → **~$0.13** | ~590 → **~$0.09** |
| Workers + DO requests, DO duration | ~1,500 requests → **< $0.01** | **< $0.01** |
| **Total** | **~$0.46** (about 10% of the $4.40 agent spend) | **~$0.20** |

How it was estimated: container busy time is the events' `suite_seconds` plus about 1.5 s per runner call; up time is every instance warm for the whole race plus its 2-minute tail (sandboxes rarely idle 2 minutes); vCPU at $0.000020/s busy, 6 GiB + 12 GB at $0.0000158/s up. Artifacts counts 4 git requests per agent invocation, one fetch per runner call, one push per committer write and the binding calls, at $0.15/1k (an upper bound: binding reads may not be billed, and the first 10k operations a month are free, about 11 such races). Idle up time dominates, so a lower `sleepAfter` or fewer sandboxes is the lever, not the requests. Storage is negligible now that each race deletes its repo when it ends (`keep_repo` keeps it; the hourly sweep deletes anything older than a day).

### What each version added, and why

| Version | Added | Why |
|---|---|---|
| **v2.0** | Pre-land check on the exact merged tree (sprout plus bean). Optimistic landing. Informed rework (the author's own session, with the change that broke it). Decision cards. Revert-first on a red validation | The core thesis: land without queueing, and blame precisely |
| v2.1 / v2.2 | Re-check adapts to the red rate. Agent released while its check runs (E5). Flake-confirmed reverts (E3). Cards re-execute the loser (E6). Inherited reds | Each won in isolation, in experiments and in the simulator (39/40 predicted) |
| v2.2 on Cloudflare | **Failed: 24 green** | Releasing agents caused a landing burst (19 in minute 2). The adaptive re-check trusted a lagging signal. Validation fell 27 commits behind. 11 innocent beans burned their rework rounds on reds that weren't theirs. Replay agents didn't reproduce the burst |
| **v2.3** | Sprout window with AIMD backpressure: at most W unvalidated landings; W grows by 2 per green and halves on a red. Sampled re-checks. Inherited reds by read set. Early revert tickets | Fixes the burst. 34 green, a tie with v2.0. One card blamed the wrong counterpart |
| **v2.4** | Reconcile before a card: a test author first amends tests that pin a value the other task legitimately changed. Only a real contradiction reaches a human. Stale-failure re-checks | Fewer wasted cards and drops. 37 green on seed 7, but 32 and 33 on seeds 11 and 13 |
| **v2.5 + dependency starts** (the demo) | Escalation after one repeated red, every landed party reconciled, lone-suspect reverts, base and dynamic culprits, a wider window, structural merges, start cards, one rescue; a free agent takes a bean that clashes with nothing in flight; the tail fix (at most 10 invocations per bean, a 10-minute tail guard) | Ships 38–39 of 40 on three seeds. The partial phases alone did worse |

### Caveats

- **Three seeds on Cloudflare**, one run each, for the queue, v2.4 and every v2.5 phase; v2.0 to v2.3 have one. Seeds swing a lot (v2.4: 37 green on seed 7, 32 on seed 11).
- **Short tasks.** Beans take tens of seconds. With 7x-longer tasks (E5), v2's lead shrank to 1.32–1.40x and the queue led on early greens.
- **The arena is synthetic.** On a real repo with little contention (markedjs/marked, E2), file-level v2 *lost* (19–20 min against 4.4) until the adaptive re-check. E2 hasn't been re-run on v2.4 or v2.5.
- **Tests are given, not written by the forge.** Without forge-owned tests, v2's stalk went wrong silently (E1: 6 of 39 greens wrong).
- Agents ran on the laptop. Only the decisions ran on Cloudflare.

---

## 3. Backlog to a real product on Cloudflare

Sizes: **S** is under a day, **M** is 1–3 days, **L** is a week or more. Sizes are my estimates unless a doc gives one.

| Area | Item | State | Size |
|---|---|---|---|
| **Engine** | v2.5: reconcile with every landed task behind the failing assertions (E6's dynamic culprits) | Next on the list (`11`) | M |
| | Forge-owned tests: a test author with fail-first proof for every task, and a targeted check of the exact landing tree (E1) | Not built | L |
| | Rest of E6: start cards, declared couplings, rescue re-execution, contract oracle. Plus the error-budget controller (reports `999`) | Not built | M–L |
| | Planning and dependency-aware starts (E4's real limit at scale) | Not built | L |
| **Git compatibility** | Persistent repos: create, import an existing repo, repos that outlive a run | Not built (repos are per run) | L |
| | Submit a bean without the race driver: a push, a CLI or MCP marks it ready | Not built | M |
| | Stalk promotion as an Action, on an Actions-compatible runner (`05`, `10` §5c) | Designed | L |
| | GitHub mirror and PR export | Idea only | L |
| | Compressed pushes; verify fetch-by-sha | Gaps | S |
| **Identity / auth** | Users and agents as principals, delegated tokens (`sub`/`act`), per-task capability tokens, OAuth 2.1 for MCP, device flow for a CLI (`06` §2, `claude-06`) | Designed. Today: HMAC run tokens (slot, seed, view) plus an admin token | L |
| | Rule-of-Two session taint, trust labels on returned text | Designed | M |
| **Web app** | Plot phases 1–3 | Mostly done (`14` §10) | — |
| | Jev eval: 60 questions, top-1 agreement against the rules | Not done | M |
| | Polish: list toggle, time bucketing past 200 rows, Jev warm-up | Not done | M |
| | Stream a bean's changeset while the agent writes | Prototyped behind `stream_diffs`, proven locally with real `claude -p` (`14` streaming note); verify in a Cloudflare race | S |
| | Real sign-in to replace `DEMO_PASSWORD` | Not built | M |
| **MCP / plugin** | Write tools: `task_next`/`task_claim`, `change_submit`, `decision_request`, `context_read`, `marker_drop` | Designed (`06` §4) | M–L |
| | Previews: `preview_ensure`, `_http`, `_browse`, `_compare`, `_logs`, and `attest` | Designed (`06` §5) | L |
| | OAuth instead of hand-minted view tokens. The same verbs as a `bean` CLI | Designed | M |
| **Ops / cost** | Spend guard and automatic reap before Artifacts billing (~10-14). Today reap is a manual admin route | Partial | S–M |
| | Measure infra cost per race | Not measured | S |
| | Shared legacy account, container cap 48 (one 20-agent run uses 23) | Known limit | — |
| **Competition (2026-10-14)** | 5–10 min video. The 8-min script exists (`12`) but quotes v2.0 numbers (13.8 / 17.5) and still lists a fresh v2.2 run as a must | Script done, not recorded | M |
| | Run instructions. The README's "Run it" exists; it hasn't been tested on a fresh account | Mostly done | S |
| | Licence note. Apache-2.0 since 2026-10-14 (your decision), as the rules require; `LICENSE`, `NOTICE`, `TRADEMARKS.md`, the README, the site and `AGENTS.md` say so, and the script's close ("open source") is accurate | Done | S |
| | Entrant eligibility (US/Canada residency) | Settled: `AGENTS.md` records you as eligible. The winner must be in SF on 10-21 | — |

### Top 5, in order

1. **Run v2.4 against the queue on 2–3 more seeds on Cloudflare (M).** Today's headline rests on one seed. Replay agents are free, but real agents are what convinced.
2. **Record the video from an updated script (M).** Use the v2.4 numbers: 37 green, 30th at 8.9 against 19.9, done 2.3x sooner. Rehearse the human-mode decision card.
3. **Finish the submission text (S).** Test the run instructions on a clean account. (The licence note is done: Apache-2.0 since 2026-10-14, so "open source" in the close is accurate.)
4. **An MCP write path: `task_next`/`task_claim` plus `change_submit` (M–L).** With these, a stock Claude Code session with the plugin can join a run without the Python driver. That's the step from "a race rig" to "a forge an agent can use".
5. **A cost guard (S–M).** Auto-reap after every run, a per-run spend cap, and a measured infra cost, before Artifacts billing starts around 10-14.

---

## 4. MCP and plugin support

```
 Claude Code ──(plugin: skill + .mcp.json)──▶ beanstalk-mcp Worker  /mcp  (stateless, Bearer view token)
      │                                              │  service binding (Workers RPC, no HTTP)
      │ git clone/push (slot token)                  ▼
      └────────────────────────────────────▶ beanstalk-gateway Worker
                                               ├─ RunDO: engine state + events.jsonl
                                               ├─ git proxy ──▶ Artifacts (race-<run>)
                                               └─ runner containers (squash, check, revert)
```

The plugin and the MCP server are **read-only**. An agent still changes code through git and the driver. MCP tells it what's going on around it.

### `packages/mcp`

A Worker (`beanstalk-mcp`) serving stateless MCP over Streamable HTTP through the Agents SDK's `createMcpHandler`. There is no `McpAgent`, and no code-mode `execute` tool (Coop's decision).

**Auth.** The caller sends `Authorization: Bearer <view token>`. The token is run-scoped and minted by the gateway admin route `POST /v1/runs/:run/view-token` (valid a week, via `pnpm -F @beanstalk/mcp mint-token <run>`). The MCP Worker holds no secret: it asks the gateway (`verifyViewToken` RPC) whether the token is good.

| Token presented | Result |
|---|---|
| Missing, forged or expired | 401 |
| Slot or seed token | 403 |
| Valid view token | The tools read only that token's run |

The deployed URL answers 401 without a token, as expected.

**Where each tool gets its data.** "Event log" means the run's `events.jsonl`, pulled once per request through `runEvents` and reduced with `shared-ask`. All six tools are annotated `readOnlyHint: true`.

| Tool | Answers | Reads |
|---|---|---|
| `ask_repo(question, ref?)` | The web app's Ask view as JSON: spec, resolved files, beans, decisions, the picker's `picks` (Jev or rules), `preview_url` | Shared Ask pipeline over gateway RPC: `repoTree`, `repoFile`, `repoDiff`, `repoLog`, `beansByPath`, `decisions`, … |
| `work_overlaps(paths)` | Beans in flight, on the sprout, or green in the last 15 min on those paths, with intent and status | `beansByPath` RPC, plus the event log |
| `bean_status(bean, checks?)` | Status, phase, checks, reworks, card, a `next` instruction and a `preview_url`; with `checks: true` the latest check's failures, with `inherited` and `protected` flags, history, `blamed_by` | `beanDetail` RPC (built from the event log) and the event log |
| `repo_status()` | Sprout and stalk heads, the window, beans in flight, open cards, red validations, cost, `preview_urls` for both lines | Event log, plus `runView` RPC (for the window) |
| `repo_read(path \| paths \| glob \| grep)` | Files with a line range, a tree listing, or `rg --json`-shaped grep results | `repoFile`, `repoTree`, `repoGrep` RPCs |

Tests run the Worker against a fake gateway that answers from a recorded v2 run.

### `packages/claude-plugin`

| File | What it does |
|---|---|
| `.claude-plugin/plugin.json` | Manifest: name `beanstalk`, v0.1.0, licence MIT (the plugin repository is MIT; Gitstalk itself is Apache-2.0) |
| `.mcp.json` | One HTTP server. URL from `BEANSTALK_MCP_URL` (defaults to the deployed `beanstalk-mcp…workers.dev/mcp`), header `Bearer ${BEANSTALK_TOKEN}` |
| `skills/beanstalk/SKILL.md` | The working loop (below) |

The skill's working loop:

1. Orient with `ask_repo`.
2. Call `work_overlaps` before editing, and fit the change to other beans' intents.
3. After submitting, poll `bean_status` with backoff and act on `next`.
4. On a red check, read `bean_status` with `checks: true`. Ignore `inherited` reds, and **never edit protected tests**.
5. Show a person the `preview_url` the answers carry.

Load it with `claude --plugin-dir packages/claude-plugin`.

### What an agent can do with it today

During a run, an agent can:

- see who else is touching its files, and why;
- follow its own bean from submitted to the stalk;
- read why a check was red, and whether the failure is its fault;
- ask the repo questions;
- hand a person a link.

That's coordination awareness, the thing a plain git host lacks.

### What's missing

- **Getting work:** `task_next` and `task_claim`. Tasks still come from the race driver's long poll.
- **Submitting over MCP:** `change_submit`. Today the agent pushes with git, and the driver posts the result.
- **Asking a human:** `decision_request`. Cards are raised only by the engine.
- **Context and notes:** `context_read`, which would log reads into the read set, and `marker_drop`.
- **Previews:** `preview_url` is only a link into the explorer, not a running app. `preview_ensure`, `_http`, `_browse`, `_compare` and `_logs`, plus `attest`, are designed (`06` §5) but not built.
- **Real sign-in:** OAuth for MCP clients. Today an operator mints and pastes a view token.
- **Live work in progress:** with `stream_diffs`, `bean_status` reports `editing_now` and `work_overlaps` counts the files a bean's agent is editing now, so overlap warnings fire before a commit exists (`14` streaming note).
