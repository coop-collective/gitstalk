# Orchestrated races (`orchestrated.py`)

A race with no driver: one coding-agent session per forge gets the whole backlog and its own subagents, and decides splitting, ordering, stacking and retries itself. The harness only sets up the forge, starts the session and measures from the forge side afterwards. The question it answers is how fast each forge gets parallel work integrated, not how fast the agent is.

## Run one

```bash
cd research/race
python3 orchestrated.py --forge github --gh-owner kintohubtest --arena ../real-arena/fastify --tasks 10 \
  --model sonnet --worker-model sonnet --subagents 4 --max-usd 20 --max-wall-minutes 90 \
  --out runs/orch-fastify-sonnet-4-t10-github
python3 orchestrated.py --forge beanstalk --gateway https://<gateway> --arena ../real-arena/fastify --tasks 10 \
  --model sonnet --worker-model sonnet --subagents 4 --max-usd 20 --max-wall-minutes 90 \
  --out runs/orch-fastify-sonnet-4-t10-beanstalk
python3 kth_green.py runs/orch-fastify-sonnet-4-t10-github runs/orch-fastify-sonnet-4-t10-beanstalk --k 3 5 8
```

## What the harness does

1. **The repository, from one base.**
   - GitHub: `<owner>/beanstalk-orch-<arena>-<seed>`, public. It holds the arena base plus `suite.yml`, the lockfile under `.github/race/` and the upstream automation removed, exactly as in `forge_github` (`GITHUB.md`). The ruleset is the merge queue with K = `--ci-slots` and batch `--batch`.
   - A warm-up PR (one file changed) is opened and closed first. On a repo created a minute earlier, GitHub ran no workflow for the first PRs, and it never runs one for a PR with no diff (both seen 2026-10-07).
   - Check concurrency, matched explicitly (`docs/claude-opus/18-git-native-flow.md` §7.1): GitHub runs each PR's checks on Actions (about 20 jobs at once for the org) and builds `--ci-slots` merge groups at once; Beanstalk runs one pre-land sandbox per bean in check (32 at most by default) and `ci_slots` validations at once (2). `--preland-concurrency N` sets the Beanstalk arm's `settings.engine` to `{preland_sandboxes: N, ci_slots: --ci-slots}`, so `--preland-concurrency 20` matches the two arms; without it the gateway's defaults apply. It needs a gateway with the runner pool (2026-10-07); an older one refuses `settings.engine`.
   - Beanstalk: an Artifacts repo is seeded with the arena base through a race run's seed token. The admin API has no other way to put existing history into a repository. A repository engine (the git-native flow, `docs/claude-opus/18-git-native-flow.md`) is opened on it with the arena's suite, and a git token is minted for that one repository.
2. **The working tree.**
   - A clone of the forge repo, with `BACKLOG.md` (every task's prompt and acceptance tests) and `.worktrees/` excluded from git.
   - The dependency snapshot is linked above the clone, so every worktree resolves it.
   - The clone's credential helper is `gh auth git-credential` (GitHub) or reads `$BEANSTALK_TOKEN` (Beanstalk). The token never appears in a file or in argv.
3. **The session.** Claude Code `-p` is started with:
   - a `worker` subagent type (`--agents`, its own model) and tools `Read,Edit,Write,Glob,Grep,Bash,Agent,TodoWrite`;
   - `acceptEdits`, no prompts, Bash allowed except gh's admin commands (`repo`, `api`, `auth`, `secret`, `ruleset`, `org`, `workflow`, `variable`), pushes to `main`, `curl`/`wget` and web tools;
   - the budget cap (`--max-budget-usd`) and the wall cap (the process group is killed).

   The prompt (`harness/orch_prompt.py`) is identical on both arms apart from the forge section. It covers parallel subagents with "give each subagent its own branch in its own `git worktree`" under `.worktrees/`, at most N at once, the acceptance tests to add, the `Task: <id>` trailer, never pushing to the line, and the time budget. The forge section says how to submit (PR + `gh pr merge --auto`, or `git push -o wait origin HEAD:refs/heads/bean/<name>`), how to follow, and how to handle a kick-out or a red.
4. **Afterwards.** The harness waits up to `--drain-minutes` for in-flight integrations, then measures (`harness/orch_measure.py`):
   - **Integration (headline):** per change (PR or bean), submitted (PR opened / bean pushed) and ready (PR enqueued / bean pushed) to integrated (merged to `main` / landed on the sprout; Beanstalk also to the stalk), as median and p90. It also reports the rework integration caused (kick-outs, red checks, conflicts, re-pushes), changes integrated per 10 minutes, the most changes waiting at once, and the share of the wall time with a change waiting.
   - **Green per task (secondary):** the integration line's first-parent history is replayed from the base. Each commit gets the canonical acceptance tests of every task not yet green, and a task is green at the first commit where all its files pass. Its time is the merge (GitHub) or the stalk promotion (Beanstalk).
   - **Final check:** the whole suite (retried once on red) and every task's acceptance tests on the line's head.
   - **Session:** model spend, turns, subagent calls (in one message, in the background) and the commands it ran most.

Outputs: `events.jsonl`, in the harness schema (`race.start` at the session start, `task.green` from the replay, `change.ready` / `change.integrated` / `change.stable`, `ci.end`, one `invocation.end` with the session's cost, `final.check`). Also `summary.json` and `summary.md`, `prompt.txt`, `worker_prompt.txt`, and `transcript.jsonl` (the session, scrubbed of the Beanstalk token).

Session cost: a resumed `claude -p` process reports the session's cumulative `total_cost_usd`, so the session's figure is the last segment's total (never the sum); `cost_partial` is true when the last segment was killed at the wall cap before it reported. `--max-budget-usd` is per process (a resumed process ran past a cap set below the cumulative total, 2026-10-08), so each resume gets `--max-usd` minus the spend so far.

## Guidance: the shared prompt or the plugin (`--guidance`)

`--guidance prompt` (default) is the shared prompt above; every GitHub/Beanstalk baseline pair uses it. `--guidance plugin` (Beanstalk arm only) is a labelled variant: the shared part of the prompt is unchanged, and the Beanstalk forge section is replaced by the Beanstalk plugin's skill (`skills/gitstalk/SKILL.md` of the plugin's own repository, [coop-collective/gitstalk-plugin](https://github.com/coop-collective/gitstalk-plugin), since 2026-10-11 read from `GITSTALK_PLUGIN_DIR`, else a sibling clone `../gitstalk-plugin`, else `research/race/.plugin`, cloned on demand; frontmatter removed, references named by absolute path), in the lead's prompt and appended to the `worker` subagent's prompt, as an agent with the plugin installed would read it. The MCP server stays disconnected (git only). The summary's label, `guidance`, `guidance_version`, `plugin_version` and `config.guidance` say which was used.

Versions (`orch_prompt.PLUGIN_GUIDANCE_VERSION`):

- **plugin-v1** (plugin 0.5.0, the 2026-10-08 run below): push plainly, take the next task, read status refs between steps, poll every 30-60 s once nothing else is left. The shared session sentence ("don't end your turn while a worker is running").
- **plugin-v2** (plugin 0.6.0): never sleep-poll. Out of work, one blocking `git push -o bean=<a> -o bean=<b> origin HEAD:refs/wait/any` that the forge wakes at the first verdict (`refs/wait/all` before finishing; `docs/claude-opus/18-git-native-flow.md` §4.1; needs a gateway with it). The lead's session sentence is replaced (`SESSION_NOTIFIED`): background workers keep running when the lead ends its turn, and Claude Code starts its next turn with a notification each time one finishes, so the lead ends its turn instead of sleeping and acts on each notification. Checked with Claude Code 2.1.293 in `-p` with `--output-format stream-json` (the harness's flags) on 2026-10-08: a lead that started one background worker and ended its turn got a `task_notification` and a new turn when the worker finished, and the process exited only after that turn. The v1 sentence is what made the v1 lead `sleep 420`. The baselines (`--guidance prompt`) keep the old sentence byte for byte. The continuation after an early exit says the same (`CONTINUE_NOTIFIED`). **The 10-minute ceiling:** `claude -p` stops background tasks still running 10 minutes after the lead's last turn ("Background tasks still running 10m after the last turn (subagent "Worker A tasks", …); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely."). A sleeping lead never meets it; a lead that ends its turn and waits for notifications does whenever no worker finishes within 10 minutes. The first plugin-v2 run below met it; since then the harness sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` for `--guidance plugin` (`config.bg_wait_ceiling`). Text is included rather than the plugin installed because the race session runs with no settings sources, no slash commands and workers without the Skill tool; that the skill loads on its own in a normal session is checked separately (the plugin repository's README; it was `packages/claude-plugin/README.md` before 2026-10-11).

`orch_pushes.py <run>...` reads a run's transcript: bean pushes by the lead and the workers (blocking `-o wait`, plain, background), PRs created and enqueued, and the time spent waiting on checks from the transcript's timestamps: foreground blocking pushes, foreground `sleep` polls of the forge, event-driven waits counted apart (`wait_any`, `wait_all`, `reattach` = a wait naming one bean, MCP `bean_wait`, each with its seconds, summed as `event_wait_s`), every foreground `sleep` whatever it waits for (`sleep_calls`, `sleep_s`: stated seconds at most the command's duration, so the lead's blind sleeps count), and each side's summed active span (`check_wait_share`). Re-measured, plugin-v1: lead 3 sleeps, 1,395 s asleep; workers 35 sleeps, 1,947 s asleep (2,946 s in commands that slept while following the forge).

## Credentials and what Coop must do

- **GitHub:** a fine-grained token cannot be created through the API, so the smoke uses the gh CLI's own login, with gh's admin commands denied to the session. For measured races, create a fine-grained PAT limited to the one race repo (contents and pull requests write, actions read) in the GitHub UI. Then run the session with `GH_TOKEN` set to it; the harness passes it through, but this is not wired yet.
- **Beanstalk:** the harness mints a git token bound to the one repository engine through the admin API.

## Result: plugin guidance, 38 tasks, N = 8 (2026-10-08)

`orch-fastify-sonnet-8-t38-beanstalk-plugin`: seed 7, Sonnet lead + 8 Sonnet workers, `--preland-concurrency 20`, ci_slots 2, `--max-usd 40`, 150-min cap, live gateway, `--guidance plugin` (plugin 0.5.0: push plainly, take the next task, read status refs between steps). Against the two runs of 2026-10-07 with the shared prompt (one run each; no repeats):

| | GitHub | Beanstalk, shared prompt | Beanstalk, plugin guidance |
|---|---|---|---|
| 1st / 5th / 10th / 19th / 30th green (min) | 4.2 / 5.1 / 8.3 / 15.0 / 23.3 | 2.4 / 3.1 / 4.6 / 10.5 / 16.2 | 2.7 / 4.2 / 7.1 / 13.1 / 19.4 |
| Last (38th) green (min) | 41.4 | 22.4 | 27.6 |
| Wall (lead ended) (min) | 50.9 | 25.8 | 34.6 (33.4 before six needless resumes, below; the lead sat in a blind `sleep 420` from 25.7 to 32.8 after its last worker ended at 28.0) |
| Submitted -> integrated, median / p90 (min) | 5.4 / 13.9 | 1.0 / 2.7 | 2.8 / 7.3 |
| Beans landed on the first push: push -> landed, median / p90 (min) | - | 0.9 / 1.7 | 2.2 / 4.2 |
| Pre-land check, median / p90 (s); validation median (s) | - | 48 / 67; 50 | 67 / 92; 67 |
| Worker bean pushes: blocking `-o wait` / plain / background | - | 48 / 0 / 1 | 0 / 51 / 0 |
| Worker time waiting on checks (s, share of worker active time) | 7,117 (55%, sleeping on `gh pr checks`) | 3,097 (38%): 3,061 blocking pushes, 36 polls | 2,946 (28%): 0 blocking; about 1,150 polling between tasks, about 1,790 polling for their last beans before reporting |
| Kick-outs / red checks / conflicts / re-pushes | 1 / 2 / 1 / 1 | 7 / 1 / 6 / 7 | 7 / 5 / 2 / 4 |
| Model spend (USD) | 6.53 | 5.25 | 5.52 (5.37 before the needless resumes) |
| CI minutes | 74.9 | 60.5 | 92.0 (pre-land 63.5) |
| Final: suite green, tasks accepted, correct | yes, 38/38, yes | yes, 38/38, yes | yes, 38/38, yes |

What it shows:

- **The guidance took.** The lead wrote one brief for all workers from the skill ("Do NOT use -o wait; immediately start next task"); each worker pushed its own beans (51 plain pushes, none blocking; the lead pushed none: its two counted `-o wait` matches are the brief's text) and read verdicts with the `for-each-ref` line.
- **It did not make this run faster.** Workers traded blocking pushes for `sleep 45` to `sleep 90` polls: 28% of their time against 38%, most of it at the end of each worker's list, waiting for its last beans as the skill says, at a coarser grain than `-o wait`. Workers produced beans at the same rate (first pushes per 5 minutes 9 / 13 / 9 / 7 / 1, against 10 / 10 / 10 / 6 / 2), so the saving never reached integration.
- **Checks were slower on the forge that hour, independent of the guidance:** pre-land median 67 s against 48 s and validations 67 s against 50 s (validations do not depend on how agents push; doc 18 §7.1 saw a lone fastify suite take 34 to 71 s across one day). More beans out at once (up to 13 waiting against 7) and more red checks (5 against 1; t030 alone 4) added pre-land minutes. With one run each, the 5-minute gap in the last green is within what check speed alone moves.
- **What would make non-blocking pay:** a git way to wait for an already-pushed bean's verdict (today a second push of a bean in check is refused; `bean_wait` needs MCP, which the race does not connect), and a lead that waits on worker notifications instead of a blind `sleep`. The guidance stays (idle time on checks fell, nothing broke), but this run is no evidence of a speed-up.

## Result: plugin-v2, 38 tasks, N = 8 (2026-10-08)

`orch-fastify-sonnet-8-t38-beanstalk-plugin-v2`: same settings as plugin-v1 (seed 7, Sonnet lead + 8 Sonnet workers, `--preland-concurrency 20`, ci_slots 2, `--max-usd 40`, 150-min cap, `--wait-gateway`), live gateway `f23b6146` (`refs/wait/any|all`, event-driven `-o wait` and `bean_wait`, the new hints), plugin 0.6.0. One run per arm; no repeats.

| | GitHub | Beanstalk, shared prompt | plugin-v1 | plugin-v2 |
|---|---|---|---|---|
| 1st / 5th / 10th / 19th / 30th green (min) | 4.2 / 5.1 / 8.3 / 15.0 / 23.3 | 2.4 / 3.1 / 4.6 / 10.5 / 16.2 | 2.7 / 4.2 / 7.1 / 13.1 / 19.4 | 2.6 / 6.3 / 8.1 / 11.0 / 18.8 |
| 37th / 38th green (min) | 35.2 / 41.4 | 22.1 / 22.4 | 25.8 / 27.6 | 21.8 / not reached (t009, below) |
| Wall (lead ended) (min) | 50.9 | 25.8 | 34.6 | **24.2** |
| Submitted -> integrated, median / p90 (min) | 5.4 / 13.9 | 1.0 / 2.7 | 2.8 / 7.3 | 2.3 / 4.4 |
| Pre-land check, median / p90 (s); validation median (s) | - | 47 / 63; 48 | 67 / 92; 67 | 55 / 72; 61 |
| Worker bean pushes: blocking / plain / background | - | 48 / 0 / 1 | 0 / 51 / 0 | 0 / 37 / 0 |
| Worker waits: wait-any / wait-all / re-attach | - | - | - | 0 / 9 / 0 (868 s) |
| Worker sleeps: calls, seconds asleep | 63, 3,950 | 6, 460 | 35, 1,947 | **3, 120** |
| Worker time waiting on checks (s, share of active) | 7,117 (55%) | 3,097 (38%) | 2,946 (28%) | **868 (12%)** |
| Lead sleeps: calls, seconds asleep | 6, 2,550 | 3, 1,470 | 3, 1,395 | **0, 0** |
| Kick-outs / red checks / conflicts / re-pushes | 1 / 2 / 1 / 1 | 7 / 1 / 6 / 7 | 7 / 5 / 2 / 4 | 1 / 0 / 1 / 1 |
| Model spend (USD) | 6.53 | 5.25 | 5.52 | **4.48** |
| CI minutes | 74.9 | 60.5 | 92.0 | 73.3 (pre-land 46.8) |
| Harness resumes | 6 | 0 | 6 (needless, fixed since) | 3 (below) |
| Final: suite green, tasks accepted, correct | yes, 38/38, yes | yes, 38/38, yes | yes, 38/38, yes | yes, **37/38**, yes |

What it shows:

- **Nothing sleeps any more.** The lead never ran `sleep` (v1: 1,395 s asleep); it started 8 background workers and ended its turn. Workers slept 120 s in all (`sleep 60`, `sleep 60`, `sleep 45` in two workers, counted to the end of each command; v1: 1,947 s) and waited 868 s in 9 `refs/wait/all` pushes, which the forge woke at the verdicts. Worker time on checks fell to 12% of active time (v1 28%, shared prompt 38%). Workers used `refs/wait/all` at the end of their list, never `any`: with plain pushes and no reds there was nothing to react to before the last bean.
- **Faster than v1, level with the shared prompt.** Wall 24.2 min against 34.6 (v1) and 25.8 (shared prompt); the 37th green at 21.8 against 25.8 and 22.1; $4.48, the cheapest arm. Checks were quicker than in v1's hour (pre-land median 55 s against 67 s) and there were no red checks (v1 5), so part of the gain against v1 is the forge's speed and luck; one run each.
- **The 10-minute ceiling cost it a restart.** The lead ended its turn at 0.9 min; no worker finished within 10 minutes, so `claude -p` stopped all 8 at 11.4 min (with 16 of 38 tasks integrated) and exited. The harness resumed the lead (`CONTINUE_NOTIFIED`), which re-launched 8 workers on the 22 open tasks; two more short resumes at 22.3 and 22.5 min chased t031, which the lead then pushed itself (`-o wait`, landed). Without the ceiling the stopped workers' in-progress tasks would not have been redone; the harness now sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` for plugin guidance.
- **One task was not delivered (t009).** After the restart a worker pushed the t003 change (lazy schema compilers, already landed as `t003-lazy-compilers`) to `bean/t009-handler-timeout`; it landed as an empty-effect squash named after t009, so the lead's trailer check and the harness's continuation check both counted t009 as integrated, and handler timeouts were never implemented (its acceptance tests fail on the final sprout; the suite is green). An agent mix-up after the restart, not a forge verdict; the 38th green is "not reached".
- **First attempt discarded.** The first plugin-v2 attempt ran with the arena's `deps/node_modules` missing in this worktree (a dangling link), so workers could not run tests locally and the final check failed every file (0 of 38 green on a line the forge had validated). It was discarded and the harness now refuses to start without the dependencies. Its transcript still showed the behaviour: lead 0 sleeps, workers 0 sleeps, 11 wait-all and 21 re-attach waits.

## Repeats: plugin-v2 x3 and the shared prompt x2 (2026-10-08/09)

Added runs, same settings as above (N = 8 Sonnet, 38 tasks, `--preland-concurrency 20`, ci_slots 2, `--max-usd 40`, 150-min cap, `--wait-gateway`, live gateway `f23b6146`): `orch-fastify-sonnet-8-t38-beanstalk-plugin-v2-r2` (seed 7, the harness setting `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`), `orch-fastify-sonnet-8-t38-s11-beanstalk-plugin-v2` and `orch-fastify-sonnet-8-t38-s11-beanstalk` (seed 11; the seed only names the repository, so these are repeats of the same 38 tasks). Mean and range where there are repeats; one run otherwise.

| | GitHub (1) | Shared prompt (2) | plugin-v1 (1) | plugin-v2 (3) |
|---|---|---|---|---|
| 1st / 5th / 10th green (min) | 4.2 / 5.1 / 8.3 | 2.3 / 2.8 / 5.2 | 2.7 / 4.2 / 7.1 | 2.5 / 4.5 / 6.5 |
| 19th green (min) | 15.0 | 10.0 (9.6-10.5) | 13.1 | 11.8 (11.0-12.6) |
| 30th green (min) | 23.3 | 17.1 (16.2-18.1) | 19.4 | 22.1 (16.7-31.0) |
| 37th green (min) | 35.2 | 23.9 (22.1-25.6) | 25.8 | 27.5 (21.8-35.5) |
| Last green (min) | 41.4 | 24.2 (22.4-26.1) | 27.6 | 27.9 (21.8-36.5); 38 of 38 in 2 runs |
| Wall (min) | 50.9 | 28.0 (25.8-30.3) | 34.6 | 35.6 (24.2-46.2) |
| Pushed -> integrated, median / p90 (min) | 5.4 / 13.9 | 1.2 / 3.4 | 2.8 / 7.3 | 2.0 / 4.0 |
| Worker time waiting on checks (share of active) | 55% | 45% (38-52%) | 28% | 16% (12-25%) |
| Worker / lead seconds asleep | 3,950 / 2,550 | 705 / 1,590 | 1,947 / 1,395 | 657 / **0** |
| Worker waits any / all / re-attach (per run) | - | - | - | 0/9/0, 6/5/2, 0/11/8 |
| Model spend (USD) | 6.53 | 4.70 (4.15-5.25) | 5.52 | 5.21 (4.48-5.62) |
| Suite green, tasks accepted | yes, 38 | yes, 38 / 38 | yes, 38 | yes, 37 / 38 / 38 |

Per plugin-v2 run (seed 7, seed 7 repeat, seed 11): last green 21.8 / 36.5 / 25.3 min, wall 24.2 / 36.4 / 46.2, resumes 3 / 0 / 1.

What it shows:

- **The forge-side change worked every time.** No lead slept in any plugin-v2 run (the shared-prompt leads slept 1,470 and 1,710 s); waiting on checks fell to 12 to 25% of worker time against 38 to 52% with blocking pushes, and pushed -> integrated stayed near the shared prompt's (2.0 min median against 1.2, p90 4.0 against 3.4).
- **It is not faster overall.** Across repeats plugin-v2's last green (27.9 min mean, 21.8 to 36.5) and wall (35.6) are no better than the shared prompt's (24.2, 28.0); the spread inside each arm is larger than the gap between them. The early greens (19th) are within a minute or two. Three runs and two are too few to rank them.
- **What made the slow plugin-v2 runs slow was not the forge.**
  - Seed 7 repeat (last green 36.5): no beans were pushed from 14.3 to 26.4 min. Workers were waiting for their own local suite runs: the harness's `locked_suite.py` runs one full suite at a time across the 8 workers, on a machine shared with other agents' jobs that day. 13 of their sleeps (1,580 s) are on those local runs (`sleep 240; grep pass /tmp/o13.txt`), only 71 s on the forge. Blocking-push arms hide this queue: a worker waiting on `-o wait` is not running its suite.
  - Seed 11 (wall 46.2 against last green 25.3): a harness bug, fixed since. The continuation check read `Task:` trailers, and the engine's squash trailer is the bean's name, so beans not named after their task looked missing. The lead was resumed at 31.5 min with 25 delivered tasks listed, spent 15 minutes re-pushing empty "record" commits with the trailers, and ended at 46.2. The integration times are unaffected.
  - Seed 7 (first run): `claude -p`'s 10-minute ceiling stopped the workers once (above).
- **The delivery guard** (coordinator's request after t009): the harness, not the skill. A task counts as delivered only when every one of its acceptance test files is on the line (and, for a file the base already had, changed since the base). Not identical text: agents append tests to the file (t025) or drop an unused import (GitHub run: t027, t029). Not "the tests pass": that is the replay's job, and running them on every continuation decision would take minutes. Applied after the fact to all seven lines, it flags only t009 in the first plugin-v2 run. It replaced the trailer check entirely (the seed-11 bug), and the resume prompt names the undelivered tasks.
- **Outages.** The seed 7 repeat's first attempt died in its final check (the suite timed out after 1,200 s on the loaded machine) and was rerun in full. The rerun's race finished, but its measurement died reaching the gateway during a network outage. Instead of a third race it was measured again from its run directory (`orchestrated.py --remeasure`: start = first transcript timestamp - 2.2 s, end = last + 9 s, the offsets on three complete runs; one segment, no resumes). The harness now collects from the forge before the hour-long replay.

Harness fix from the plugin-v1 run: the continuation check read `Task:` trailers on the stalk, and the engine's squash commits name the bean (`Task: t009-handler-timeout`) when the bean is named after its task, so the lead was resumed six times with all 38 tasks integrated (about 1.2 min and $0.15). It now reads the sprout and accepts `<id>-…` trailers.
