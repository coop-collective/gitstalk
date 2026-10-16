# The git-native flow: push is submit

Written 2026-10-07 from the `git-native` branch (based on `prototype` at `fed4f54`). Names as everywhere: a **bean** is one change, the **sprout** is the staged line, the **stalk** is the stable line.

**What it is.** An agent or a person contributes to a Gitstalk repository with plain git. `git push origin HEAD:refs/heads/bean/<name>` submits a bean; the engine runs its normal flow (pre-land check on the merged tree, landing, re-checks, revert or reset, reconcile, cards); the verdict comes back as `remote:` lines on the push and as a ref anyone can fetch. Nothing is installed or configured on the client beyond a credential. Everything is in the gateway (`packages/gateway`).

**Status.** Built and working end to end with a real git client: on staging (real Artifacts and runner containers, `exp/git-native/staging-transcript.txt`) and locally under `wrangler dev` with real checks (`exp/git-native/local-transcript.txt`); Miniflare tests cover each path (§9). Coop approved the design; this document records what was built and the contracts other work codes against.

---

## Contents

1. The flow in one screen
2. URLs and credentials
3. Push = submit
4. Push options (4.1 Waiting for verdicts: `refs/wait/any|all`)
5. What the push prints
6. Refs: lines, beans, status
7. The continuous engine
8. Contracts for the repository and auth work
9. Verification
10. Gaps and next steps

---

## 1. The flow in one screen

```
git clone https://<web>/<owner>/<repo>.git                  (credential: token as the Basic password)
git switch -c work origin/sprout ; …commit…
git push -o wait origin HEAD:refs/heads/bean/add-total
        │
        ▼  gateway /git/<owner>/<repo>.git/git-receive-pack   (push/push-proxy.ts)
  1. verifyGitCredential(token)                     → user, scopes, engine   (auth/git-credential.ts)
  2. read commands + push options (-o)              (git/push-request.ts)
  3. refuse in the protocol: sprout/stalk/main, other branches, deletions, >1 bean,
     a bean in flight or already landed              → "! [remote rejected] … (reason)"
  4. forward the push to Artifacts (gateway token, options stripped), read its report-status
  5. engine DO: read the head commit (intent, Task: trailer), find its fork point on the sprout,
     admit the bean (new) or answer its waiting rework (next push)   (push/push-driver.ts)
  6. remote: bean received, check started
  7. -o wait: stream progress + keepalives until the verdict (landed / red / conflict / parked)
        │
        ▼  engine (unchanged v2 rules, demo settings): squash onto the sprout, pre-land check on
           the merged tree, land, validate, promote the stalk; red → rework waits for the next push
        │
        ▼  refs/beans/<name>/status  (annotated tag: "<phase>: <reason>" and the verdict)
```

---

## 2. URLs and credentials

- **Repository URL:** `https://<web>/<owner>/<repo>.git` (or without `.git`), on the same host as the repository page, as on GitHub (Coop's decision, 2026-10-08): the web Worker's route handlers `app/[owner]/[repo]/{info/refs,git-upload-pack,git-receive-pack}` forward the request untouched (streaming body, auth, push options, side-band) to the gateway over the service binding. The gateway also answers `/<owner>/<repo>[.git]/…` at its own root (Actions' `actions/checkout`) and keeps `https://<gateway>/git/<owner>/<repo>.git`, which is what the forwarding calls. The gateway derives the engine id from `<owner>/<repo>` (`r` + 19 hex digits of SHA-256 of the lower-cased `owner/repo`, `push/repo-engine.ts`), so it needs no lookup. A repository the credential may not use answers 404, as a missing one does.
- **Race URLs keep working:** `/git/<namespace>/race-<run>.git` (the Artifacts namespace as the first segment) is the per-run proxy exactly as before, with slot, seed and view tokens. An owner handle equal to the namespace name (`beanstalk-race`, `beanstalk-race-staging`) is therefore reserved.
- **Credential:** a token as the HTTP Basic password (`https://x:<token>@…`, or git's standard credential helper: `credential.helper '!f() { echo username=x; echo password=$TOKEN; }; f'`) or a Bearer header. The demo uses the helper, so the token is never in a URL, a remote config or the output.
- **Agents never hold Artifacts tokens.** The gateway mints a short-lived Artifacts token per request (read for fetches, write for pushes) inside the engine's Durable Object and forwards the request; the client's `Authorization` never goes upstream.
- **One function checks credentials:** `verifyGitCredential(env, token) → GitCredential | null` in `src/auth/git-credential.ts` (§8.3).

Today's tokens: a `git`-scope run token (new) for a person or an agent on one engine (`repo:read`, `bean:write`), minted by `gitToken` (RPC) or `POST /v1/repos/:engine/git-token` (admin); a `view` token reads. Contributor tokens stay collaboration-only (403 on git).

---

## 3. Push = submit

| Push | Result |
|---|---|
| `refs/heads/bean/<name>`, new name | A new bean `<name>` (letters, digits, `.`, `_`, `-`; up to 32). Title = commit subject; intent = subject and body without trailers; `Task: <id>` trailer links a task |
| `refs/heads/bean/<name>`, bean red or in conflict | The push answers the bean's waiting rework: the new head is checked again (force-push after a rebase is expected) |
| `refs/heads/bean/<name>`, bean being checked, a new commit | Refused (decided 2026-10-08, rather than queueing it as the next attempt: a queued commit behind a check that lands would have no clear meaning): "bean x is being checked (push 1, 3b42ffd); its verdict comes first. Wait for it with git push -o bean=x origin HEAD:refs/wait/any (returns at the verdict), then push again if it is red or in conflict; a landed bean takes new work as a new bean" |
| `refs/heads/bean/<name>`, the same commit again | Never reaches the gateway: git compares it with the advertised ref and prints "Everything up-to-date" without sending anything (push options included). Re-attaching to a bean's check is a push to `refs/wait/any` naming it (§4.1) |
| `refs/wait/any`, `refs/wait/all` | A wait: nothing is stored; the push holds until a verdict (§4.1) |
| `refs/heads/bean/<name>`, bean landed (or parked, dropped) | Refused: push new work as a new bean |
| `refs/heads/sprout`, `stalk`, `main` | Refused: "landing is never a push" |
| any other ref, a deletion, two beans in one push | Refused, with the rule |

Refusals happen **before** anything reaches the repository, inside the git protocol: the gateway answers `unpack ok` / `ng <ref> <reason>` on band 1 and a `remote:` line on band 2, so git prints `! [remote rejected] HEAD -> sprout (refs/heads/sprout is the engine's: landing is never a push. …)` instead of an HTTP error.

**Busy repository (added 2026-10-16).** Artifacts applies one receive-pack per repository at a time and answers one that arrives meanwhile with `artifacts_git_receive_pack_busy` (seen on staging with five beans pushed at once; git printed it and hung up, and the same push alone succeeded a moment later). The gateway absorbs this (`git/push-forward.ts`): a checked bean (or memory) push's commands-and-pack body is buffered up to 16 MiB, and while the answer is busy (status 409, 429 or 503, or `receive_pack_busy` / a `*BUSY` code in the body) and does not show the ref moved, it is sent again after about 0.2, 0.5, 1 and 2 s (±25 % jitter, each retry logged). Every other answer is final. If all five attempts are busy, git gets a refusal in the protocol: `gitstalk: push refused: the repository is busy with other pushes; push again in a few seconds`. A push over 16 MiB streams through once, as before, and is not retried. The gateway's own pushes (`git/remote-client.ts`: `bean_commit`, automation saves, seeds) and push-to-create are not retried yet.

What the engine does with an accepted push is its normal v2 flow. The push driver (§7) feeds the engine exactly what a race's Python driver would: the bean's initial invocation is answered at once with the pushed head; a red or a conflict opens a rework invocation that stays open until the author's next push, which is its result.

The intent is read from the pushed commit through the Artifacts binding (`readCommit`; retried briefly, Artifacts is eventually consistent). The bean's base is its **fork point**: the newest commit of the pushed head's history (`log`, up to 200) that is on the sprout line, so beans that landed after it are the ones a red can blame, exactly as for an agent that started from that commit.

---

## 4. Push options

The gateway adds `push-options` to the receive-pack advertisement (Artifacts does not see it: the gateway strips the capability and the options section before forwarding).

| Option | Effect |
|---|---|
| `-o wait` | Holds the push until the pre-land verdict: landed, red, conflict, parked or dropped. Progress lines as the engine reports them, a keepalive line every 15 s, a timeout after 600 s by default that says where the verdict will be |
| `-o wait=<seconds>` | Same with a timeout (at most 1800) |
| `-o task=<id>` | Links a task (overrides the trailer) |
| `-o intent=<text>` | The bean's intent (and title, its first line), instead of the commit message |
| `-o bean=<name>` | On a push to `refs/wait/any|all`: a bean to wait for (repeated, or `a,b`; `bean/<name>` accepted) |
| anything else | Ignored, and said so in a `remote:` line |

A plain `git push` works without options: it prints the received lines and returns; the verdict lands on the status ref. Without a side band (a client that did not ask for `side-band-64k`) there is nowhere to print, so the push returns the upstream report unchanged.

### 4.1 Waiting for verdicts: `refs/wait/any|all` (2026-10-08)

Non-blocking pushes are only worth it if waiting for a verdict later costs nothing. Measured before this (`research/race/ORCHESTRATED.md`, plugin-v1): workers that pushed plainly replaced the blocking push with `sleep 45` to `sleep 90` polls of the status refs, and the lead slept `sleep 420` after its last worker ended. So git now has a blocking wait that a verdict wakes:

```
git push -o bean=a -o bean=b origin HEAD:refs/wait/any    # returns at the first verdict of a or b
git push -o bean=a -o bean=b origin HEAD:refs/wait/all    # returns when neither is checking
git push -o bean=a origin HEAD:refs/wait/any              # re-attach to one bean's check
git push origin HEAD:refs/wait/any                        # every bean in flight pushed with my credential
```

- **A wait ref stores nothing.** The gateway reads the command, cancels the pack (git sends an empty one when `HEAD` is on an advertised ref), never forwards to Artifacts, and answers `ok refs/wait/any` on band 1, so git prints `* [new reference] HEAD -> refs/wait/any` and exits 0 every time; the `remote:` lines say what happened. The ref is never advertised, so the next wait is again a "new reference". Any other `refs/wait/<x>`, or a wait together with another ref, is refused in the protocol.
- **Which beans.** With `-o bean=` the named ones (unknown names are listed and ignored). Without: every bean whose latest push was by the credential's user and that is in flight (`checking`, `red`, `conflict`). Subagents of one person share a credential, so workers name their own beans; a lead may wait on all of them.
- **When it returns.** `any`: at once when a named bean is already red or in conflict (it waits for its author's push; the verdict is printed), or when none is checking; else when the first bean that was checking at the start leaves the check. `all`: when none of those is checking (red ones are printed with their verdict at the start). Each verdict that arrives is printed as `verdict for <bean>: <phase>` and the same lines `-o wait` prints; at the end `your beans: a (landed), b (checking)` and the next step (`fix b (rebase…)`, or the exact command to wait again for the beans still checking). A bean the approval rules hold (doc 32 §4, `PushBean.held`) is red to git but is never reported as one (since 2026-10-16): it is `held` in the standings, printed at the start as `<bean> is held for a person's approval:` with its `HELD` lines, a hold that arrives is `verdict for <bean>: held`, and the next step is `ask your person to approve <bean> on its page; do not push it again` (a new push needs a new approval). It does not count as waiting for its author's push, so it never ends an `any` wait at once while another bean is checking.
- **How long.** 540 s by default (under the 10-minute ceiling of an agent's shell tool, so Claude Code's Bash with `timeout: 600000` sees the answer), `-o wait=<seconds>` up to 1800; a keepalive line every 15 s. On a timeout: `no verdict after 540 s; b still checking` and the command to wait again.
- **Event-driven, both sides.** The engine's Durable Object keeps the waiting pushes in memory (`BeanWatchers`, `push/bean-wait.ts`); every save of a pushed bean (each step's events folded in, a received push, a held rework) calls `notify(bean)`, which resolves the watches of that bean. The Worker holds one RPC (`watchBeans(actor, beans, known, maxMs)`: returns at once if the beans' key differs from `known`, else when one of them changes, at most 300 s per call) and writes the keepalive from its own timer meanwhile (`push/wait-stream.ts`). The key is taken before the progress is read, so a change between the two wakes the next watch at once. A watch that fails (the object restarted on a deploy) is asked again up to three times; then the push says the verdicts will be on the status refs. One Durable Object request per change instead of one per second.
- **`-o wait` and MCP `bean_wait` use the same watch** (they polled the engine once a second before). The `remote:` hints follow the non-blocking flow: a plain push ends with `do not wait on it: take your next task; the verdict goes to refs/beans/<bean>/status` and `out of work? one blocking call wakes on your first verdict: git push -o bean=<bean> origin HEAD:refs/wait/any`; a red or conflict's fix line says `git push -f origin HEAD:refs/heads/bean/<bean>` and the wait command; MCP `bean_open` returns `push` without `-o wait` and a `wait` command.
- **Read-only credentials** cannot push, so they cannot use a wait ref (their receive-pack is refused before the commands are read); they read the status refs, or MCP `bean_wait`.

---

## 5. What the push prints

All lines start `remote: gitstalk:` (`remote: beanstalk:` until 2026-10-11, as in these staging and local runs, which predate the rename):

**Received (every accepted push):**
```
remote: beanstalk: new bean add-total received at 81c6380: "Add a total helper"
remote: beanstalk:   for task DEMO-1
remote: beanstalk: pre-land check started: your change is merged onto the sprout and the whole suite runs on that tree
```
and on a push without `-o wait` (staging, 2026-10-08):
```
remote: beanstalk:   do not wait on it: take your next task; the verdict goes to refs/beans/ev-fast/status
remote: beanstalk:   out of work? one blocking call wakes on your first verdict: git push -o bean=ev-fast origin HEAD:refs/wait/any
```

**A wait** (`git push -o bean=ev-fast -o bean=ev-slow origin HEAD:refs/wait/any`, staging):
```
remote: beanstalk: waiting for the first verdict of ev-fast (checking), ev-slow (checking)
remote: beanstalk: verdict for ev-fast: landed
remote: beanstalk: LANDED: ev-fast passed its pre-land check and is on the sprout as eb89211
remote: beanstalk:   it moves to the stalk once CI validates the sprout; git fetch origin sprout stalk
remote: beanstalk: your beans: ev-fast (green), ev-slow (checking)
remote: beanstalk:   then take your next task, or wait again: git push -o bean=ev-slow origin HEAD:refs/wait/any
 * [new reference]   HEAD -> refs/wait/any
```

**Landed (`-o wait`):**
```
remote: beanstalk: pre-land check green on the merged tree (0.1 s)
remote: beanstalk: LANDED: add-total passed its pre-land check and is on the sprout as ac12ade
remote: beanstalk:   it moves to the stalk once CI validates the sprout; git fetch origin sprout stalk
remote: beanstalk:   web: <bean page>
remote: beanstalk: validated: on the stalk at ac12ade
```

**Red:** the failing tests, the landed beans it collided with and their intent (the engine's culprits), the suite output's last lines, the fix and the link.
```
remote: beanstalk: RED: tax-in-total was not landed. Merged onto the sprout, these tests failed:
remote: beanstalk:   - test/discount.test.js > test/discount.test.js
remote: beanstalk: it collided with these landed beans (accepted behaviour; keep both):
remote: beanstalk:   - add-discount "Add percentage discounts"
remote: beanstalk:     intent: Add percentage discounts discounted(items, rate) takes rate off the cart total.
remote: beanstalk: output:
remote: beanstalk:       actual: 99.00000000000001,
remote: beanstalk:       expected: 90,
remote: beanstalk: fix: git fetch origin sprout && git rebase origin/sprout
remote: beanstalk:      then fix, commit and git push -f origin HEAD:refs/heads/bean/tax-in-total
remote: beanstalk:      and keep working; git push -o bean=tax-in-total origin HEAD:refs/wait/any waits for its next verdict
```

**Conflict:** the files, both sides of up to four hunks and who landed the sprout's side (the engine's informed conflict context, with "trunk" read as the sprout), then the same fix line.
```
remote: beanstalk: CONFLICT: conflict-total does not merge onto the sprout. Conflicts in: src/shared.ts
remote: beanstalk:   The conflicting hunks (the sprout's side, then yours):
remote: beanstalk:   src/shared.ts:
remote: beanstalk:   <<<<<<< sprout
remote: beanstalk:   export const total = 1;
remote: beanstalk:   =======
remote: beanstalk:   export const total = 2;
remote: beanstalk:   >>>>>>> your bean
remote: beanstalk:   The sprout's side was written by these landed changes: …
```

**Parked or dropped** (the engine needs a person, or an infrastructure failure), and **decision cards** (`decision card D001: the bean's spec contradicts …`) print one line each. Other reworks the engine asks for (a decision's re-execution, a rescue) print the engine's own prompt, trimmed.

Where the words come from: `push/push-messages.ts` (formatting), `push/push-events.ts` (the engine events each line follows: `preland.check`, `merge.conflict`, `land`, `green.promote`, `rework.start`, `task.parked`, `task.drop`, `decision.request`), and the rework prompt for the parts only it carries (the suite output, the hunks).

---

## 6. Refs: lines, beans, status

| Ref | What | Read with |
|---|---|---|
| `refs/heads/sprout` | The staged line: beans land here after a green pre-land check | `git fetch origin sprout` |
| `refs/heads/stalk` | The stable line: moves to validated sprout commits | `git fetch origin stalk` |
| `refs/heads/bean/<name>` | The bean's pushed head (the engine squashes it onto the sprout) | `git fetch origin bean/<name>` |
| `refs/beans/<name>/status` | An annotated tag on the bean's head: its phase and why | `git fetch origin '+refs/beans/*:refs/beans/*'` then `git cat-file -p refs/beans/<name>/status` |

The status tag's message (`push/status-publisher.ts`):
```
red: 1 failing test(s) on the merged tree

bean: tax-in-total
title: Charge 10% tax in totals
head: dc8035fd4cebb3e8319a92b25aa78d9aacbf3733
push: 1
task: DEMO-3

RED: tax-in-total was not landed. …            (the verdict's lines, as the push printed them)
```
Phases: `checking`, `red`, `conflict`, `landed` (on the sprout), `green` (validated, on the stalk), `parked`, `dropped`. The gateway writes the tag itself: it builds the tag object and a one-object pack in the Worker (`git/pack-writer.ts`) and pushes it with its own write token (`git/remote-client.ts`), one write at a time, newest wins, re-reading the ref once on a stale lease. A status write is one Artifacts push per phase change (three for a bean that lands: checking, landed, green).

Notes were the alternative; a tag per bean is one object, one ref, readable with one `cat-file`, and needs no notes merge.

---

## 7. The continuous engine

A race engine runs a fixed task list with Python driver slots and ends. A **continuous engine** (`RunConfig.continuous: true`) drives one persistent repository: no task list, beans arrive by push, it never finishes. It is the same `RunDO` and the same engine; the race-only parts are switched off, and a **push driver** stands where the Python driver stood.

**Settings** (`CONTINUOUS_SETTINGS`, `@gitstalk/shared-race/run-config`): the `demo` preset's rules (`DEMO_SETTINGS`: v2.5, dependency-aware starts, parking, the red-window reset with requeue repair, check reuse), minus what bounds a race or assumes an agent:

| Field | Demo | Continuous | Why |
|---|---|---|---|
| `tail_guard_minutes` | 3 | 0 | A person may take hours to push the fix |
| `max_bean_invocations` | 10 | 0 | Each push is an invocation; no ceiling |
| `max_rework` | 3 | 20 | Likewise for rework rounds |
| `agent_timeout` | 900 | 86400 | Unused: no watchdog in continuous mode (below) |
| `ci_seconds`, `preland_seconds` | 60, null | 0, 0 | No emulated CI latency: real suites only |
| `keep_repo` | false | true | The repository is not the engine's to delete |
| `agents` | 4 | 32 | Slots: each bean waiting for its author holds one |

The preset field is `null` (the demo preset would refuse these changes); the run's label is `<owner>/<repo>`.

**Engine changes** (all outside the four policy files other agents are changing; none of `v2-validator.ts`, `v2-check-reuse.ts`, `v2-landing.ts`, `v2-backpressure.ts` was touched):
- `engine/intake.ts` (new) and the `admit` input: a pushed bean becomes a pending task (state, order, the policy's `unstarted`), with its fork point as `pushedBase`.
- `engine/tasks.ts` `beginTask`: a pushed bean starts at `pushedBase` instead of the sprout head.
- `engine/engine.ts` `settle`: a continuous engine never shuts down when the policy is "finished".
- `engine/lifecycle.ts`: no wall-clock timer; `engine/invocations.ts`: no watchdog on a delivered invocation (a rework waits for a push, however long).

**The push driver** (`push/push-driver.ts`, inside the engine's Durable Object, synchronous around `step`): it holds an internal long poll (`push:<slot>:<n>`) on every free slot; the shell routes those replies to it instead of to HTTP waiters. An `initial` invocation is answered at once with the pushed head (`cost_source: push`, no agent cost); a `rework`/`sync`/`fixer` is held until the bean's next push, which becomes its result; a `test-author`/`reconcile`/`test-first` is answered with no commit (pushed beans carry no acceptance tests). It folds each step's events into the pushed beans (`push_beans` table, validated on read) for the waiting pushes and the status refs.

**Shell changes:** the squash job reads a continuous engine's bean at `refs/heads/bean/<name>` (the engine still names it `beans/<task>`; `push/bean-refs.ts` translates where they meet, and the explorer RPCs accept `beans/<name>` for either); each pre-land check runs in a sandbox leased for it from the gateway's runner pool (§7.1), so 32 slots cost containers only while beans are in check; the reap and the hourly sweep never delete a continuous engine's repository.

### 7.1 Pre-land capacity and timeouts

Until 2026-10-07 the 32 slots shared **two** sandboxes (`run-<engine>-sandbox-0|1`), and the runner runs every check it is sent at once. The push-replay load generator found what that does (fastify, 16 workers, `-o wait`, live gateway `48ed740e`): 16 beans in check were 8 suites at once in each 4-vCPU sandbox; every suite of the first wave ran into the runner's 300 s suite timeout, and the engine read a timed-out suite as a red check, so all 16 authors got a red with no failing test, re-pushed together after their fix delay and timed out together again. Gitstalk integrated 33 of 38 in 60 minutes (GitHub: 38 of 38 in 30). Why the load generator's own `-staging-lg` stack did 38 of 38 in 15 minutes with the same code, image, instance type (standard-4) and settings: a lone fastify suite took 34 s there at that hour and 64 to 71 s on live (the seed beans' checks; 34 to 71 s across eight runs that day), and 8 contended suites cross 300 s only when one alone takes more than about 40 s. Staging-lg sat under the cliff by luck of the hosts; its evidence arm (traced checks, heavier) on the same stack fell over it the same way (11 timeouts, 51 minutes).

Now (`src/capacity/`, `run/run-jobs.ts`):

- **One sandbox per bean in check, on demand.** A check job of a repository engine leases a sandbox (`run-<engine>-sandbox-<index>`, lowest free index first, so warm ones serve again) from the **runner pool** (`RunnerCapacity`, one Durable Object) before it starts, and releases it when the suite returns; an idle sandbox sleeps after `sleepAfter` (2 min) and leaves the pool. At most `preland_sandboxes` per repository (default **32**, a repo setting). Validations keep their CI slots (`ci_slots`, default 2, a repo setting; GitHub's merge-queue comparison builds 2 at once).
- **Waiting is not failing.** A check waits for its lease in the gateway, before anything reaches a runner; the runner starts a suite's timeout when the suite's process starts, so queue time never counts. A sandbox runs one bean's suite at a time.
- **A timeout is never a red.** A suite that ran out of time reported nothing about the change. The job runs it again (`SUITE_TIMEOUT_ATTEMPTS` = 3 runs, same instance); a bean's check (pre-land, culprit probe, card or tests-first, all in its sandbox) that times out every time fails the job, as an infrastructure failure the push prints as `DROPPED: <bean>: infrastructure failure: … suite_timeout: the suite ran past its 300 s limit 3 times on <sandbox>, so it reported nothing; this is an infrastructure delay, not a test failure, and the change was not judged`. Races take the same path (same job code). A CI slot's run (validation, bisect probe, final check) that times out three times on its own slot goes to the engine as before, a red of the shared line (the tree hangs): failing that job would abort the run, and for a repository engine abort the repository.
- **Sharing with races.** The container class's `max_instances` (48, `RUNNER_MAX_INSTANCES`) is one pool. A race reserves `agents + ci_slots + 1` when it starts and releases them when it is done (or at its wall clock plus 30 minutes). A repository's standing instances (committer + CI slots) count while it is active. Above a **floor of 2 sandboxes per repository** (always granted: neither races nor another repository can stop a repository's checks; it is the old shared pool), a lease is granted only while reservations, active repositories' standing instances and all leases fit under `max_instances - 2`, so a busy repository cannot take what races reserved; and while another repository waits, one at or above an equal share of the repositories' part gets no more. Races are never refused (they were not before); a race that starts while repositories hold many sandboxes takes its instances as the leases drain, within one check, and the runner client's capacity wait (about 4 minutes) covers that. Example: a 30-agent race (33) leaves a busy repository 10 sandboxes (48 - 2 - 33 - 3).
- **Operators:** `GET /v1/admin/capacity` (admin token) shows the reservations, the leases, and per owner how many sandboxes were granted, how many asks waited and for how long, the peak held at once and the suite timeouts.

**Fair comparisons.** GitHub runs each PR's checks on Actions (up to about 20 jobs at once for the org) and builds `max_entries_to_build` merge groups at once. The Gitstalk arm's counterparts are `preland_sandboxes` and `ci_slots`; both are repo settings (`settings.engine` in `openRepoEngine` / `POST /v1/repos`, §8.1), so a paired run states both arms' concurrency: the orchestrated harness takes `--preland-concurrency N` (with `--ci-slots`), the load generator `--bs-engine preland_sandboxes=N --bs-engine ci_slots=K` (and its GitHub arm `--ci-slots K`). Record them with the run.

**Opening an engine** (`openRepoEngine`): reads the Artifacts repo's remote, makes sure `refs/heads/sprout` and `refs/heads/stalk` exist and agree (from `settings.base_branch`, else `main`, else `master`, else the first branch; an empty repo gets an empty first commit on `main`, built in the Worker), stores the repository record, and starts the engine at that base. Idempotent per `owner/repo`; a different Artifacts repo under the same name is a 409.

---

## 8. Contracts for the repository and auth work

### 8.1 RPC on the gateway's default entrypoint (`RepoEngineRpc`, `@gitstalk/shared-race/rpc`)

```ts
openRepoEngine(input: {
  repoName: string;                                // clone URL: /git/<owner.handle>/<repoName>.git
  artifactsRepo: string;                           // existing Artifacts repo in the repositories' namespace (REPOS)
  owner: { id: string; handle: string };
  settings?: {
    suite?: RunSuite;                              // an operator's suite for every check (default: the repo's .gitstalk/checks.yml, doc 24)
    base_branch?: string;                          // where the lines start if the repo has neither
    bean_url?: string;                             // a bean's web page, "{bean}" replaced; shown in verdicts
    engine?: {                                     // over the continuous defaults (§7.1); unknown keys are refused
      preland_sandboxes?: number;                  // pre-land checks at once, one sandbox per bean (1..64, default 32)
      ci_slots?: number;                           // validations at once (1..16, default 2)
      read_maps?, evidence_promotion?, evidence_read_sets?, affected_validation?, audit_every?;  // evidence track
      checks_source?: 'suite' | 'repository';      // pin to the suite and ignore the checks file (doc 24)
    };
  };
}): Promise<RpcResult<{ engineId: string; created: boolean; base_sha: string; git_path: string }>>;

gitToken(engineId, user: { id; handle }, ttlSeconds?): Promise<RpcResult<{ token; expires_at }>>;  // until user tokens
pushedBeans(engineId): Promise<RpcResult<PushedBeanStatus[]>>;    // bean, title, task, actor, head, pushes, phase, reason, landed_sha, verdict
closeRepoEngine(engineId, { deleteRepo }): Promise<RpcResult<{ closed: true }>>;
```

Handles are `[A-Za-z0-9][A-Za-z0-9._-]{0,62}` (a token's `sub` holds 32). Errors are the usual `RpcResult` codes: `invalid_request` 400, `not_found` 404, `conflict`/`invalid_state` 409, `upstream_failed` 502.

### 8.2 Showing state: the existing read RPCs, keyed by `engineId`

`runView`, `runEvents`, `beansByPath`, `beanDetail`, `decisions`, `decide` (cards), `testsFor`, `repoTree`, `repoFile`, `repoDiff`, `repoLog`, `repoGrep`, `viewToken` (live socket) all take the engine id as `run`. A bean's ref is `beans/<name>` there (translated to `bean/<name>`). `listRuns` lists engines too (label `<owner>/<repo>`, phase `running`). `pushedBeans` adds what only pushes know (actor, task link, the verdict lines).

Admin HTTP equivalents for operators and demos: `POST /v1/repos` (with `create_artifacts_repo: true` to create a missing Artifacts repo), `POST /v1/repos/:engine/git-token`, `GET /v1/repos/:engine/beans`, `POST /v1/repos/:engine/close {delete_repo}`, and `GET /v1/admin/capacity` (the runner pool, §7.1).

### 8.3 The auth seam

```ts
// src/auth/git-credential.ts
verifyGitCredential(env: { tokenSecret: string; now(): number }, token: string): Promise<GitCredential | null>;
type GitCredential = {
  user: { id: string; handle: string };
  scopes: readonly ('repo:read' | 'bean:write')[];   // landing is never a scope
  engine: RunId | null;                              // bound engine; null for user tokens (later)
  runPrincipal: { scope: 'slot' | 'seed' | 'view'; sub: string } | null;  // race tokens only
};
mayUseEngine(credential, engineId): boolean;          // today: credential.engine === engineId
```

Every git request goes through it (race URLs too). To add user tokens: verify them here to a `GitCredential` with `engine: null` and the grant's scopes, and change `mayUseEngine` to ask the repository's access rules (owner, `repo_access`). Nothing else in the proxy changes. A valid identity without git scopes (a contributor token) gets 403; an unknown or expired token 401 with a Basic challenge (git then asks its credential helper).

---

## 9. Verification

- **Miniflare** (`pnpm check`, exit 0): `test/git-native.test.ts` drives the real Worker and engine DO with git's wire format (commands, options, side band; the fake Artifacts remote now answers real advertisements and report-status to a git user agent): an engine opened once with both lines at the base; `push-options` advertised; a push that lands with its remote lines and status ref; `-o wait`; a red push with the failing test and the fix, then the next push landing; a red that names the landed bean it collided with and its intent; a conflict quoting its hunk; refusals for the lines, other branches, deletions and a landed bean; access (404 for another repo's token, 401 without one); closing. Wire tests (`src/git/git-native-wire.test.ts`) pin object ids against git's, the pack header and trailer, option stripping, advertisement rewriting, report parsing and refusals; `push-intent.test.ts` the intent and options.
- **Local, real git** (`research/race/git_native/local_e2e.py`): the Worker under `wrangler dev`, Artifacts as real bare repos behind `git http-backend` (`stream_e2e/remotes.py`), real squashes, and real checks (`REMOTES_REAL_CHECKS=1`: each `*.test.js` with `node --test` on the merged tree, read sets by relative imports). `demo.sh` clones, lands a bean with `git push -o wait`, lands a second, pushes a parallel bean that is red against it (the verdict names it and its intent), shows a refused push to the sprout and the status refs, rebases, fixes and lands. Transcript: `exp/git-native/local-transcript.txt`. The gateway's own pushes (the first commit, the lines, every status tag) went through real `git-receive-pack`, so the pack writer is checked by git itself.
- **Staging** (`beanstalk-gateway-staging`, Artifacts namespace `beanstalk-race-staging`, real runner containers; `research/race/git_native/staging_e2e.py`, 2026-10-07): the same `demo.sh` against a fresh Artifacts repo, end to end in 73 s: clone through the credential helper, two beans landed with `git push -o wait` (pre-land checks 1.7 to 4.8 s), the parallel bean red with the failing test, the landed bean it collided with and that bean's intent, the push to the sprout rejected in the protocol, the status refs fetched and read, the fix rebased, force-pushed and landed, the stalk validated at the same commit; then the engine was closed and its repo deleted. Transcript: `exp/git-native/staging-transcript.txt`. Other agents deploy staging too: two earlier attempts failed with `runner_version_mismatch` while another branch's runner image (API 2, then 4) was rolled out; the gateway reported it as an infrastructure drop in the push's verdict.

---

- **Pre-land capacity** (§7.1, 2026-10-07): Miniflare tests for the pool's rule (`src/capacity/sandbox-pool.test.ts`: lowest index, renewal, 32 at once, the cap, race reservations, the floor, standing instances, fair share), the lease wait (`sandbox-lease.test.ts`: nothing runs while it waits, the wait is counted, an unreachable pool falls back to the floor), suite timeouts (`run/run-jobs.test.ts`: re-run on the same instance, a bean's check that always times out fails as `suite_timeout` and never as a red, a validation's goes to the engine), the pool Durable Object and a race's reservation and release (`test/runner-capacity.test.ts`), and five concurrent pushes landing on at most `preland_sandboxes` sandboxes with every lease given back (`test/git-native.test.ts`). On a separate stack (`beanstalk-gateway-staging-cap`, its own runner app at standard-4 and `max_instances` 48, Artifacts `beanstalk-race-staging-cap` / `beanstalk-repos-staging-cap`), the load generator (fastify, seed 7, closed loop, `-o wait`), first on `prototype` at `6608170` (as live), then on this change:

  | run | integrated | wall | ready→integrated med / p90 | timeouts reported as red | other reds | suite s med / max | sandboxes at once |
  |---|---|---|---|---|---|---|---|
  | before, N = 16 | 38/38 | 35.8 min | 8.5 / 28.8 min | 36 | 7 | 271 / 300 | 2 (shared) |
  | before, N = 32 | 37/38 | 25.5 min | 15.3 / 21.4 min | 37 | 13 | 231 / 300 | 2 (shared) |
  | after, N = 16 | 38/38 | 10.1 min | 1.2 / 3.4 min | 0 | 2 | 40 / 88 | 14 at peak, 0 waits |
  | after, N = 32 | 38/38 | 11.5 min | 2.5 / 7.0 min | 0 | 16 | 39 / 67 | 22 at peak, 0 waits |

  Live's run (`lg-fastify-16-s7-beanstalk`, the load generator's branch) had 101 timeouts reported as red. After the change no suite timed out at all (the pool's `timeouts` count stayed 0), every lease was back at the end, and CI minutes fell from 410 to 54 (N = 16): the timed-out suites were the cost. The 3 `error` verdicts per run are pushes refused within 3 s at the start (before and after; the load generator re-pushes), and the after-32 run's 3 `timeout` verdicts are verdicts its parser did not classify (checks of 16 to 48 s), not suite timeouts. Runs: `research/race/runs/cap-{before,after}-{16,32}/`, the pool's state every 5 s in `research/race/runs/cap-after-pool-watch.jsonl`.

- **Waiting for verdicts** (§4.1, 2026-10-08): Miniflare `test/bean-wait.test.ts` (7, the fake runner holds a `held-*` bean's check until the test releases it, so every wait is seen holding before the verdict wakes it): re-attach to a bean in check by naming it; a new commit to a bean in check refused with the wait command; wait-any woken by the second of two beans' verdicts while the first is still checking, then wait-all woken by the last; a timeout naming the beans still checking and the command to wait again; an immediate answer for a red bean and for nothing in flight (unknown name listed); `-o wait` woken by the verdict; a malformed wait ref refused. `test/git-native.test.ts`'s refusal test now reads its `-o wait` push to the end before pushing again (it raced the verdict and failed on `prototype` at `24c8608`); the shared push helpers moved to `test/git-push-helpers.ts`. Staging, own stack (`beanstalk-gateway-staging-ev`, D1 `beanstalk-forge-staging-ev` with migrations 0001 to 0004 and `beanstalk-identity-staging-ev` with 0001 to 0003, queue `beanstalk-repo-events-staging-ev`, Artifacts `beanstalk-race-staging-ev` / `beanstalk-repos-staging-ev`, its own runner app), real git 2.x, `research/race/git_native/wait_demo.sh` through `staging_e2e.py --demo wait_demo.sh`: two beans pushed plainly (2 and 4 s), one `refs/wait/any` that returned 9 s later at the fast bean's verdict with the slow one still checking, a new commit to the slow bean refused with the command, `refs/wait/all` re-attached and woken at its verdict after 39 s (its suite has a 40 s test), `git ls-remote` with no `refs/wait`; 65 s in all. Transcript: `exp/git-native/wait-staging-transcript.txt`.

## 10. Gaps and next steps

- **Slots bound beans waiting for their authors.** Each red bean holds one of 32 slots until its next push; a 33rd simultaneous red would delay new beans' checks (not lose them). Next: release a slot while its rework waits for a push (a pushed bean needs no agent seat), or grow slots on demand.
- **State size.** A continuous engine's state (tasks, invocation records) grows with every bean; races stay under the 2 MB value limit, a busy repository would not forever. Next: compact finished beans out of the engine state into the event log and the `push_beans` table.
- **Pushed beans have no acceptance tests.** The whole suite is the check; reconcile and test-author steps are answered with no commit, so a contradiction between two beans' tests goes to a decision card or parks. Next: take the tests a bean adds as its acceptance tests.
- **One bean per push**, and a bean being checked refuses a new commit (decided 2026-10-08: refused with the wait command, not queued). Next, if agents ask for it: cancel the running check and take the new head.
- **Two pushes of one new bean at once** both pass the check before the repository moves; the second reaches the repository but the engine refuses it (the push says so: "the bean's branch moved, but the engine did not take it"). Next: a per-bean lease taken before forwarding.
- **Waits live in the engine object's memory** (§4.1): a deploy that restarts the object drops them and each push asks again (three tries). Waiting pushes keep the engine object awake (it is awake while a bean is in check anyway). A wait without names covers the credential's user, so agents sharing a person's credential must name their beans.
- **Rework base.** After a red, the engine records the sprout head of the rework as the merge base; a fix pushed without rebasing still lands correctly (the runner computes the real merge base) but blames from that point.
- **Engine id from the name.** Renaming an owner or a repository changes its URL's engine; the repository side must keep the name stable or ask for a rename operation.
- **No user tokens yet**: `git` run tokens (from `gitToken`) stand in; the seam is §8.3.
- **Status writes cost Artifacts operations** (three per landed bean, more with reds); batch them per step if the bill says so.
- **Clone's default branch** is whatever the repository's `HEAD` is (the repository side's choice); `sprout` and `stalk` are fetched by name.
