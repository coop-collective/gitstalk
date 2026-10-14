# Demo script v2: 8 minutes, for Coop to record

For the competition video (backlog `16` item 0.9). v1 was built on the old race canvas and v2.0 numbers; v2 is built on the **Nightshift repository home** (`14` §11), the **v2.5 engine with dependency-aware starts**, and three seeds per side. Names: a **bean** is one agent's change, the **sprout** is the staged line, the **stalk** is the stable line.

**Rules for this script**

- Every number said or shown comes from a run directory in `research/race/runs/` and is cited next to it. If a number isn't in the table below, don't say it.
- The headline is: **"Ships more of the work, and gets most of it done about twice as fast as a GitHub-style merge queue."** Never say "1.6–2.3× sooner to done" or "under 9 minutes vs about 20": both are retired.
- Say what isn't built yet in the same breath as what is (see "Honest framing").

## The numbers (three seeds per side, Cloudflare, 12 Claude Code agents on Sonnet, 40 colliding tasks)

Same arena (`arena@26eecce0/8c321b35`), same seeds, every landed acceptance test protected (`protect_tests: landed`), 60 s emulated CI with 2 slots. Reproduce with `python3 research/race/kth_green.py <runs> --k 10 20 30 35`.

| Run directory | Gateway run id | Side | Tasks green | 35th green | Done (wall) | Red validations | Agent spend | Final stalk correct |
|---|---|---|---|---|---|---|---|---|
| `cf-queue-sonnet-12-s7-landed` | `u0ntf65lbe` | merge queue | 36 of 40 | 35.0 min | 40.6 min | 10 | $4.12 | yes |
| `cf-queue-sonnet-12-s11` | `7614ihh6an` | merge queue | 35 of 40 | 29.2 min | 30.2 min | 8 | $4.51 | yes |
| `cf-queue-sonnet-12-s13` | `qmf1zoz5fw` | merge queue | 37 of 40 | 36.8 min | 39.5 min | 10 | $4.54 | yes |
| `cf-v25dep2-sonnet-12-s7` | `j6boaclinn` | Beanstalk v2.5 + dep starts | 39 of 40 | 17.1 min | 31.6 min | 4 | $6.08 | yes |
| `cf-v25dep2-sonnet-12-s11` | `glajxkggnf` | Beanstalk v2.5 + dep starts | 39 of 40 | 14.9 min | 24.0 min | 0 | $4.18 | yes |
| `cf-v25dep2-sonnet-12-s13` | `okxdc8mx75` | Beanstalk v2.5 + dep starts | 38 of 40 | 22.0 min | 29.8 min | 4 | $5.32 | yes |

**What we may say, paired by seed:**

| Claim | Per seed (s7 / s11 / s13) | Said as |
|---|---|---|
| Ships more | 39 vs 36 / 39 vs 35 / 38 vs 37 | "38–39 of 40, against 35–37" |
| Most of it done sooner (35th green) | 2.05× / 1.95× / 1.67× | "1.7–2.1× sooner", "about twice as fast" |
| Done sooner (wall clock) | 1.28× / 1.26× / 1.33× | "about 1.3× sooner to done" |
| Stable line correct | yes / yes / yes | "the stalk was correct in every run" |
| Fewer red validations | 4 vs 10 / 0 vs 8 / 4 vs 10 | "fewer than half the red validations" |

**What we must also say** (from the same runs):

- **The queue's first greens come sooner.** The 10th green: queue 4.1 / 4.9 / 3.6 min, Beanstalk 5.3 / 5.3 / 5.5 min. On seed 13 the queue also reaches the 20th first (10.4 vs 12.3 min).
- **Beanstalk spends more on agents:** $4.18–6.08 against $4.12–4.54, mostly rework (informed repair sends work back to its author).
- **Decision cards in these races were answered by an oracle**, not a person: the side that landed first wins after 30 s (`--decision-seconds 30`, oracle `landed`). Beanstalk raised 8 / 6 / 9 cards (`summary.md`, "decision cards").

## What to have open

1. **Browser, tab 1:** the deployed web app's repository home on the v2.5 seed-7 run, `/runs/j6boaclinn` (Nightshift home: stalk on the left, generated explorer and Ask on the right). Night mode. If the gateway has reaped that run, use the recorded fixture (see "Before recording").
2. **Tab 2:** the same run's engine view, `/runs/j6boaclinn/race`, paused at 0:00, speed 10×.
3. **Tab 3:** the side-by-side race, `/race`, queue seed 7 against Beanstalk seed 7, paused at 0:00.
4. **Tab 4:** the landing page's race band (`packages/site`, `#race`), for the numbers card.
5. **Terminal:** Claude Code started with `claude --plugin-dir packages/claude-plugin`, `BEANSTALK_TOKEN` minted for the run (`pnpm -s -F @beanstalk/mcp mint-token j6boaclinn --gateway …`), font at 18 pt. Run `/mcp` once beforehand so the tools are listed.
6. **Editor:** `research/race/runs/` open on the six directories above, for the "every number is in the repo" beat.

Clear notifications, hide bookmarks, 1440×900 browser window, system in night mode.

## The script

### 0:00–0:30 The one sentence

**On screen:** the repository home, stalk growing in replay at 10×.

> "When a dozen coding agents work on the same code, a merge queue makes them wait in line. Beanstalk lets them land without waiting. It checks every change on the exact tree it would land on, sends broken work back to the agent that wrote it, and asks a person only when two specs genuinely disagree."

### 0:30–1:30 The repository home

**On screen:** tab 1. Point, don't click yet.

- The **stalk** on the left: beans in flight at the tip, the lime sprout leaves, the pointer to the stalk, mature leaves below; a red leaf for a culprit, struck-through rows for beans that fell off.
- The **explorer** on the right: Growing now, What happened, Files.
- The **status line:** sprout number, stalk number, sessions active.

> "This is a repository on Beanstalk, mid-race. Twelve Claude Code sessions are working on one shop codebase. Beans are their changes. A bean that passes its check on the exact merged tree lands on the sprout, and the others build on it right away. The stalk only moves to sprout commits that passed validation together."

### 1:30–2:45 Ask

**On screen:** tab 1. Press ⌘K, pick or type "What changed on coupons recently?", then "Why did the sprout go red?".

- The page reshapes: matching files, the bean journey with its diff, then the red-validation card with the culprit and its revert.
- Open the ⓘ receipt on "This view" once.

> "You don't browse a forge like this, you ask it. Code finds the candidates; a small decision model, Jev, only picks and orders what to show, and every pick has a receipt. Your agents can ask the same question over MCP before they edit."

Do not quote an answer latency: live Ask on a running race is still slow (`14` §11, backlog 0.4). Use the recorded run.

### 2:45–4:15 The race, the money shot

**On screen:** tab 3, side by side at 10×, seed 7: queue left, Beanstalk right. Let it run to Beanstalk's 35th green, then pause.

> "Same 40 colliding tasks, same seed, same 12 agents, all on Cloudflare. Left, a GitHub-style batched merge queue. Right, Beanstalk."

At the pause (Beanstalk's 35th green, 17.1 min, `cf-v25dep2-sonnet-12-s7`; the queue gets there at 35.0 min, `cf-queue-sonnet-12-s7-landed`):

> "Beanstalk has 35 tasks green. The queue gets there at 35 minutes."

Cut to tab 4 (the race band) and read it:

> "We ran three seeds a side. Beanstalk shipped 38 to 39 of the 40 tasks; the queue shipped 35 to 37. Beanstalk got the 35th task green 1.7 to 2.1 times sooner, and finished about 1.3 times sooner. The stalk was correct in every run. So: it ships more of the work, and gets most of it done about twice as fast."

Then the honest line, on the same card:

> "Two costs. The queue's first few greens come sooner, and Beanstalk spends more on agents, about $4 to $6 a race against $4 to $4.50, because broken work goes back to its author to fix."

### 4:15–5:45 How it works, on one bean

**On screen:** tab 2, the engine view of `j6boaclinn`, normal speed, scrubbing. Then back to tab 1 for a bean journey.

1. **Pre-land check on the exact tree.** A lane flips to "pre-land check"; the agent is released to its next task.
2. **Informed repair.** A check comes back red; the bean goes back to the same session with the failing test and the landed change underneath it (open the bean journey's "Sent back" step).
3. **Revert-first.** A red validation: the culprit is bisected by read set and reverted, never the innocent beans. Seed 7 had 4 red validations against the queue's 10 (`summary.md`, "Red validations").
4. **Dependency-aware starts.** Tasks that build on each other start in order, so fewer beans collide in the first place: the v2.5 change these runs measure.

> "A merge queue holds green work back and re-tests whole batches. Beanstalk shares green work immediately, takes out only the culprit, and gives the fix to the agent that has the context."

### 5:45–6:30 People decide meaning

**On screen:** tab 1, ask "What did we decide?"; the decision card leads (two specs, one kept).

> "Some clashes aren't bugs, they're two specs that disagree. Agents don't get to pick. A decision card lays out both sides for the people who own them. In these benchmark races an oracle answered the cards after 30 seconds, so they'd be repeatable; in a real repository, you do."

### 6:30–7:20 Your agents, today and next

**On screen:** terminal. In Claude Code, ask: "Using beanstalk, what overlaps with billing/coupons.ts right now?" then "What's the status of the run?".

> "Agents connect through a plugin and an MCP server. Today the tools are read-only: run status, work overlaps, check results, change status, and Ask. Connecting takes a token from your deployment. One-command install with browser sign-in, Codex subscriptions, cloud agents and your own model keys are next, and the site says so."

Tools shown must be among `repo_status`, `work_overlaps`, `bean_status` (with `checks: true` for failures), `ask_repo`, `repo_read` (`packages/mcp/src/tools/`); the explorer links come in their `preview_url` and `preview_urls`. Don't show a write.

### 7:20–7:40 Underneath, and receipts

**On screen:** one diagram, then the editor on `research/race/runs/`.

```
agent sessions → MCP + gateway Worker → run Durable Object (SQLite) → runner containers → Artifacts (bean, sprout and stalk refs)
```

> "Every integration decision runs on Cloudflare Workers, Durable Objects and Containers, and every repository is an Artifacts repo. Agents never hold an Artifacts token. And every number in this video is a run directory in the repo, with its events, so you can check it."

### 7:40–8:00 Close

**On screen:** the repository home, stalk fully grown.

> "Beanstalk ships more of the work, and gets most of it done about twice as fast as a merge queue. Agents land without waiting, the stalk stays honest, and people decide what the product means. Open source under the Apache License 2.0."

## Shot list

| # | Time | Source | Shot | Notes |
|---|---|---|---|---|
| 1 | 0:00 | Tab 1 | Home, stalk replaying at 10× | Night mode, no cursor |
| 2 | 0:30 | Tab 1 | Slow pan: stalk, explorer, status line | Cursor points, no clicks |
| 3 | 1:30 | Tab 1 | ⌘K, coupons question, view reshapes | Recorded run only |
| 4 | 2:05 | Tab 1 | "Why did the sprout go red?", culprit card; ⓘ receipt | |
| 5 | 2:45 | Tab 3 | Side by side, seed 7, 10× from 0:00 | Pause on Beanstalk's 35th green |
| 6 | 3:30 | Tab 4 | Site race band, full card | Read the numbers verbatim |
| 7 | 4:00 | Tab 4 | Same card, hold for the cost line | |
| 8 | 4:15 | Tab 2 | Engine view: lane flips to pre-land check | 1× speed |
| 9 | 4:40 | Tab 1 | Bean journey: "Sent back" step with failing test | |
| 10 | 5:05 | Tab 2 | Red validation, bisect, revert | Scrub to it |
| 11 | 5:45 | Tab 1 | "What did we decide?", decision card | |
| 12 | 6:30 | Terminal | Claude Code: `/mcp` list, overlaps question, run status | 18 pt font |
| 13 | 7:20 | Slide | Architecture line | Static |
| 14 | 7:30 | Editor | `research/race/runs/` with the six directories | |
| 15 | 7:40 | Tab 1 | Home, stalk grown; title card | |

## Honest framing (say these, in these words or close)

- "Measured on our arena, three seeds a side." Not "always", not "for any codebase".
- The queue reaches its first greens sooner; Beanstalk spends more on agents.
- Decision cards in races were answered by an oracle.
- MCP tools are read-only today; sign-in, Codex subscriptions, cloud agents and bring-your-own keys are coming.
- Repositories today are race runs; persistent repositories are next (`16` Phase 2).

## Before recording

- [x] **The v2.5 run in the app.** The web app's recorded fixtures are now `cf-v25dep2-sonnet-12-s7` (`j6boaclinn`) against `cf-queue-sonnet-12-s7-landed` (`u0ntf65lbe`), built by `packages/web/scripts/build-fixtures.mjs`, so `/runs/j6boaclinn` works offline and `/race` replays seed 7. Its counters show the 35th green (17.1 against 35.0 min) and done (31.6 against 40.6 min), and the replay bar has a moment at each side's 35th green to pause on. Screenshots: `research/prototypes/repo-experience/shots/app-v2/demo-*.png`.
- [ ] Site race band deployed with the v2.5 numbers (backlog 0.7).
- [ ] README table updated to these six runs (backlog 0.3), so the README and the video agree.
- [ ] A view token minted for the run; the plugin's tools answer in Claude Code.
- [ ] Rehearse twice; record shot 12 separately as a fallback.

## Numbers not to use

- "1.6–2.3× sooner to done", "under 9 minutes vs about 20" (retired; not these runs).
- v2.0 and v2.4 single-seed numbers from the old README table, and the local-harness "1.98×, 95% CI 1.68–2.28" (different engine, different harness).
- Any Ask latency (not measured on a live run yet).
- Third-party statistics from v1 (41.7% conflicting pairs, Cursor's swarm, GitHub's reverted PRs): they aren't from our run directories.
