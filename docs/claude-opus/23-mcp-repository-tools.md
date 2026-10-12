# 23 · MCP repository tools: agents work on a repository through MCP as well as git

Built 2026-10-07 (lane B of persistent repositories, from `prototype` at `f9a2295`). Git stays the interface: an agent clones, commits and pushes `bean/<name>` with git (`18-git-native-flow.md`). The MCP tools added here coordinate agents and explain verdicts; none of them moves code. Plain, task-shaped tools only (no code mode, no `execute`).

## 1. What a session can do

An OAuth session (or a personal `bsu_` token as a bearer) addresses any repository its person may use, named `owner/name`. Access is the git rule (merged with the collaborators lane at `b58cf65`): the session is its person's credential, the person's role (owner, maintain, write, read, or none on a public repository) capped by the session's scopes, and `mayUseEngine` decides through `repos/access.ts`. Read tools need the read role; `bean_open`, `task_claim`, `task_release` and a pushing `git_credentials` need the write role and the `write` scope (a read role gets a read-only credential). A repository the person may not see answers "repository … not found", like git's 404; every use is recorded in the repository's sessions list as the MCP client. `repository_access(repository)` (from the collaborators lane) tells an agent its role. Deploy tokens (`bsd_`) and repository-bound git credentials never open `/mcp` (401).

| Tool | Scope | What it does |
|---|---|---|
| `repo_list()` | read | The repositories the person owns or collaborates on: role, access (`write` when the role and the session's scope both allow pushing), visibility, clone URL |
| `repo_status(repo)` | read | Stalk and sprout heads, unvalidated window, beans in flight and sent back (who, phase, task), recent red validations, open cards |
| `bean_open(repo, bean, intent, task?)` | write | Reserves `bean/<name>` for a day with its intent; claims `task`; returns the branch, `start` and `push` commands and the sprout head |
| `bean_status(repo, bean)` | read | Phase (`open` while reserved), the pushed bean (actor, intent, verdict lines), rework (failing tests, conflicts, the collided-with beans with title, intent, landed sha and files changed), the journey (every line the pushes printed), `next` |
| `bean_wait(repo, bean, until?, timeout_s?)` | read | The twin of `git push -o bean=<bean> origin HEAD:refs/wait/any`: holds until the check ends (`until: "stalk"`: until validated), default 300 s, at most 1,800; the verdict wakes it (no polling); `waited_s`, `timed_out` |
| `task_list(repo)` | read | The backlog with each task's state: open, claimed (by, until), in_progress (whose bean), done |
| `task_claim(repo, task)` | write | Two-hour claim, renewed by claiming again or `bean_open` with it; refused with who holds it |
| `task_release(repo, task)` | write | Gives a task back: the person's claim and the names they reserved for it (added after the first real session, where the agent found its task already done and had no way to free it) |
| `git_credentials(repo, ttl_minutes?)` | read (push needs write) | A `bss_` token bound to that one repository, at most an hour, as `git credential approve` input with the commands to store it |

The existing read tools (`ask_repo`, `work_overlaps`, `change_status`, `checks_get`, `run_status`, `preview_link`) take an optional `repo` in a session; without it they read `DEMO_RUN` or the newest run, as before. Sessions no longer get a 404 when no run exists. The old `git_credential` (an unbound session token) is replaced by `git_credentials`.

## 2. How it works

```
MCP (packages/mcp)                         gateway (packages/gateway)
 src/repos/repo-tools.ts  ── RPC ──▶  AgentReposRpc (src/agent/agent-repos-rpc.ts)
   repo-answers.ts                      agent-access.ts: registry.byName → mayUseEngine → engine
   git-credentials.ts                   engine RunDO: push_beans + agent-store.ts
     └─ mintSessionToken(repository)      bean_reservations, task_claims (SQLite, one at a time)
        (identity D1)                   backlog.ts: .gitstalk/backlog.md or BACKLOG.md on the sprout
```

- **Shared contract:** `@gitstalk/shared-race/agent-repos` (`AgentPrincipal`, `AgentReposRpc`, inputs as Zod). The gateway trusts the MCP binding for who the person is and which scopes the session holds (as it trusts the web app) and checks access and scopes itself; the MCP Worker passes the gateway's messages to the model as tool errors.
- **Reservations and claims live in the repository's engine Durable Object** beside its pushed beans: one object, one request at a time, so two agents claiming the same task get one yes and one no. A task is `done` when ticked in the file or when a bean linked to it (`Task:` trailer, `-o task=`, or the reservation's task) landed; `in_progress` while such a bean is out or reserved.
- **Push integration:** a push of a name someone else reserved is refused in the git protocol (`ng refs/heads/bean/x bean x is reserved by @alice (bean_open)`). The holder's first push consumes the reservation; the reserved intent becomes the bean's intent (unless `-o intent`), the reserved task its task (unless the commit names one).
- **The backlog is a file in the repository** (decision taken here, instead of a separate store with an import step): `- [ ] <id>: <title>` items, detail indented below, ticked = done; ids from the text before `: `, else a slug of the title. Changing the backlog is a bean like any other. Read from the sprout (ref heads are memoised 5 s in the engine).
- **`bean_wait`** holds one `watchBeans` call on the engine object, which returns when the bean changes (2026-10-08, `18` §4.1; it polled once a second before), so the MCP Worker makes one RPC per wait and the gateway one Durable Object request per change. `bean_open` answers `push` without `-o wait` plus a `wait` command, and `next` steps say to keep working and wait only when out of work.
- **`git_credentials`** mints a session token with a new nullable `repository` column (identity migration `0003_repository_tokens.sql`). `verifyGitCredential` maps it to `engine: <that engine>`, so the git proxy opens only that repository; `resolveExternalToken` refuses it on `/mcp`. It is revoked with the session's grant (Settings → Disconnect), audited as `session_token.mint` with the repository. Like its predecessor it is visible to the model (the `16` §3.3 trade-off); the answer tells the agent to pipe it to `git credential approve`, set `credential.<host>.useHttpPath true` (one credential per repository) and, with no helper configured, use the in-memory `cache` helper.

## 3. Verified

- **Tests** (`pnpm check` exits 0): gateway `test/agent-repos.test.ts` (11: listing and access, someone else's private repository is missing, public is read-only, scopes, reservation then push takes the reserved intent and task, reserved name refused in the protocol and at `bean_open`, pushed name not reopened, a red with failing tests and the collided bean's intent and files, waits (green, reserved, bad input), backlog absent / claim contention / ticked / unknown / release, in-progress task, repository-bound session tokens push to their repository and 404 elsewhere), `src/agent/backlog.test.ts` (4); MCP `test/repo-tools.test.ts` (9, through the MCP Worker over Streamable HTTP with the real gateway bundle on Miniflare: tool list (no `execute`), every tool's answer and errors, scopes, a credential that pushes and is refused elsewhere and as a bearer, read-only credential refused on push, deploy token refused on `/mcp`), `test/oauth.test.ts` updated for `git_credentials`; identity `user-tokens.test.ts` (bound tokens).
- **Staging** (own stack: `beanstalk-{gateway,mcp,web}-staging-b`, D1 `beanstalk-identity-staging-b` and `beanstalk-forge-staging-b` (migrations applied), KV `beanstalk-oauth-staging-b`, Artifacts `beanstalk-race-staging-b` / `beanstalk-repos-staging-b`, its own runner container app): `claude mcp add --transport http gitstalk-b …/mcp`, then `claude mcp login gitstalk-b --no-browser` in a pseudo-terminal while headless Chrome with a CDP virtual authenticator signed up `lane-b-c97275`, ticked collaborate and write on the consent page (`exp/mcp-repo-tools/consent-write-collaborate.png`) and created `shop-3952` from the TypeScript starter; "✔ Connected". A two-task backlog was landed as the owner with git.
- **Real Claude Code session** (2.1.292, Sonnet, `--max-budget-usd 2`, git isolated from the person's keychain): `task_list` → `task_claim slugify` → `bean_open` → `git_credentials` → `git credential approve` as told → clone; found `slugify` already on the sprout, switched to `word-count` (claim, `bean_open`), implemented with a test, `node --test` green, plain `git push` (remote printed "for task word-count"), `bean_wait` → green after 4 s, `bean_status` → green with its journey. 14 turns, 67 s, **$0.24**. Second session: `task_release slugify` → open, `repo_status`, `task_list` (word-count done by its bean). 5 turns, **$0.12**. Third session, after merging the collaborators lane and redeploying staging-b (FORGE migration `0003_collaborators` applied): `repository_access` (owner, may push) → `task_claim slugify` → `bean_open` → tick it in `.gitstalk/backlog.md` → `git push -o wait` LANDED and validated (pre-land 6.0 s) → `task_list` shows both tasks done. 9 turns, **$0.17**. Total model spend for the three sessions: **$0.53**. Redacted transcripts: `exp/mcp-repo-tools/session-1-claim-open-push-wait.txt`, `session-2-release.txt`, `session-3-after-roles-merge.txt` (tokens masked; the raw ones are Claude Code's own `~/.claude/projects/…-scratchpad-lane-b-cc/*.jsonl`).

## 4. Gaps and next

- **Not deployed live.** Before it is: apply identity migration `0003` to `beanstalk-identity`, set `GIT_ORIGIN` in the MCP's vars (added to `wrangler.jsonc`), deploy gateway then MCP.
- Roles end to end: `agent-repos.test.ts` invites a write and a read collaborator; the writer contends with the owner for a task and a bean name, the reader reads and is refused `bean_open` and claims, an outsider gets 404; `repo-tools.test.ts` checks the same through MCP.
- `preview_url` in repository answers still links `/runs/<engine>`; repository pages are `/<owner>/<repo>`.
- A repository-bound credential keeps working for its hour if the person loses access to the repository (it is bound to the engine, like deploy tokens); revoking the agent's session revokes it.
- Claims expire after two hours with no heartbeat beyond re-claiming; a long task needs the agent to claim again or push.

## 5. Actions, secrets and automations (2026-10-12)

**Why.** In the owner's session (Claude Code with the plugin, repository `coop/test`) the agent built a vinext app and `.github/workflows/deploy.yml`, then said "Gitstalk doesn't run GitHub Actions" (it does: a bean reaching the stalk is a push to `main`, doc 25 §2), found no tool to see the run its landing started, to read its log or to set `CLOUDFLARE_API_TOKEN`, and its OAuth link asked only for `read`. These tools and the scope change close that loop: push → `actions_wait_for_run` → read the failing step → fix → push.

### 5.1 Scope model

| Scope | Grants (always capped by the person's role, as on the web) | Asked for by default | Ticked on the consent page |
|---|---|---|---|
| `read` | Every read: repositories, runs, jobs, logs, workflows, secret names, variables, automations | yes | always (cannot untick) |
| `collaborate` | Bean threads, requests, inbox | yes | yes |
| `write` | Push own beans, claim tasks; with maintain: dispatch, re-run, cancel, run automations | yes | yes |
| `secrets` | With maintain: set and delete secrets and variables (repository; org level with org owner or admin) | no | never: the person ticks it, with a warning that a value passes through the agent and its model provider |

- **Advertised:** the protected resource's `scopes_supported` (RFC 9728) and the `scope` of the 401 `WWW-Authenticate` challenge are `read collaborate write` (`DEFAULT_SCOPES`, the library's `requiredScopes`, which it advertises and does not enforce). MCP clients, Claude Code and Codex among them, request the challenge's scopes, so the consent page opens with those three ticked. The authorization server's `scopes_supported` lists all four. Before, both advertised `read` only, so clients asked for `read` and the person had to tick the rest.
- **Enforced:** `/mcp` needs `read` (403 `insufficient_scope` otherwise); each tool's scope is checked in the gateway, and the refusal says how to get it ("reconnect the agent and tick secrets on the consent page"); the secret tools add the Settings link.
- **Personal tokens** may hold `secrets` too (Settings → Tokens lists it). Git credentials ignore it.

### 5.2 Tools

| Tool | Scope, role | What it does |
|---|---|---|
| `actions_workflow_list(repo)` | read, read role | Workflows and automations on the stalk: state (active, or invalid with problems), triggers (`push (main)`, `workflow_dispatch`, `schedule (…)`, Gitstalk events), dispatch inputs, unsupported events, jobs. No enable/disable: the product has none (an invalid file never runs) |
| `actions_run_list(repo, workflow?, status?, event?, branch?, sha?, bean?, limit?, cursor?)` | read | Runs newest first with `run_url`; `bean` = the push runs its stalk move started; a `branch` that is not a name of the stalk answers none |
| `actions_run_get(repo, run)` | read | Jobs and steps with status, conclusion, durations, `failed_step`; the commit, the beans the stalk move carried, inputs, `run_url`, `next` |
| `actions_job_log(repo, run, job?, tail?, grep?, max_bytes?)` | read | `[step] line` text, newest last; default the first failed job, 80 lines, 12 KB; at most 2,000 lines and 48 KB; `grep` keeps matching lines (case-insensitive). Streams the R2 chunks through a bounded tail (at most 40 pages of 50 chunks) |
| `actions_wait_for_run(repo, bean? / run? / workflow?, timeout_s?)` | read | Holds until the runs finish: `bean` waits for it to reach the stalk (the engine's watch, as `bean_wait`), then for the push runs it started (60 s for them to appear); `run` one run; `workflow` its newest run. Default 600 s, at most 1,800. `outcome`: completed, running, no_run, bean_not_on_stalk; each failed job's failing step and last 30 log lines |
| `actions_dispatch(repo, workflow, inputs?, ref?)` | write, maintain | `workflow_dispatch` on the stalk head |
| `actions_rerun(repo, run)` | write, maintain | The whole run again as a new run: same workflow source, commit, event, payload, inputs, origin (so D4 gives it the same secrets) and beans. Re-running only failed jobs is not supported. Automations re-run with `automation_run` |
| `actions_cancel(repo, run)` | write, maintain | Cancels a queued or running run |
| `actions_secret_list(repo)` | read, any role | Names (never values), source (repository or org), who and when, `preland_allowed`, `overridden`; `settings_url` |
| `actions_secret_set(repo, name, value, level?)` | secrets, maintain (org: owner or admin) | Write-only: the value is never in an answer, an error or a log. Keeps a repository secret's pre-land toggle. A new org secret reaches only this repository (`selected`); an existing one keeps its reach |
| `actions_secret_delete(repo, name, level?)` | secrets, maintain | |
| `actions_variable_list` / `_set` / `_delete` | read (any role) / secrets, maintain | Values readable; same levels and reach rules |
| `automation_get(repo, automation)` | read | The file on the stalk, triggers, harness, model, bot, memory ref, problems, its 10 newest runs |
| `automation_run(repo, automation)` | write, maintain | A manual run (every automation takes `workflow_dispatch`); one at a time |

`repo_status` gained `stalk_runs` (the runs at the stalk head: "what happened to my last landing"), `bean_status`'s `next` for `landed` and `green` points at `actions_wait_for_run`, and `repository_access` answers `may.run_workflows` and `may.set_secrets`. Every tool takes `repo: "owner/name"`; a run of another repository is not found.

### 5.3 How it works

```
MCP src/actions/actions-tools.ts ── RPC ──▶ AgentActionsRpc (gateway src/agent/agent-actions-rpc.ts)
    actions-answers.ts (run_url, settings_url,     actions-target.ts: scope → openRepository (404 when hidden)
    summary, next)                                   → the person's own actionsRpc / actionsEntriesRpc
                                                     (maintain checks as for the web), via = client name
                                                   agent-runs.ts, agent-run-wait.ts, agent-entries.ts,
                                                   agent-automation.ts, agent-run-views.ts (pure)
```

- **Contract:** `@gitstalk/shared-race/agent-actions` (Zod inputs, snake_case answers).
- **Same rules as the web:** the gateway opens the repository as the other agent tools do, then calls the Actions RPC the web calls with the person as viewer, so roles, archive refusals and messages are identical. The session's scope is checked first.
- **Audit:** secret and variable changes made through MCP write the same `repository_audit` / `actions_org_audit` lines, with `NAME · via Claude Code (MCP)` (the `via` option of `actionsRpc` and `actionsEntriesRpc`).
- **Beans on runs:** a push run's request keeps the beans its stalk move carried (`RunRequest.beans`, in the run's stored record; older runs have none). That is how `bean` filters and waits find a landing's runs, and how `actions_run_get` names them.
- **Re-run:** `ActionsRepoDO.rerun` reads `ActionsRunDO.rerunSeed()` (the request, with the payload as JSON for RPC) and creates a new run with the next number.
- **Waiting:** the bean part holds on the engine's `watchBeans`; runs have no watch yet, so the gateway reads their status every 1 to 5 seconds (backing off) inside the one RPC, bounded by `timeout_s`.

### 5.4 Verified

- `pnpm check` exits 0. Gateway `test/agent-actions.test.ts` (12): a landing's push run followed by bean, with the failing step, its log tail and the secret masked; workflows; runs by workflow, bean, sha and branch; log tail, grep and bounds; dispatch with inputs, re-run (of a dispatch and of a push), cancel, a bounded wait on a hanging run; refusals (read-only session `insufficient_scope`; write collaborator `forbidden` for dispatch, re-run and cancel; stranger 404; a maintainer may); secret names to a reader, setting needing `secrets` and maintain, the value never returned, audit `via Claude Code (MCP)`, org level refused on a person's repository; variables; automations. `src/agent/agent-run-views.test.ts` (5). MCP `test/actions-tools.test.ts` (7), through Streamable HTTP with the real gateway and its repo-events queue: the deploy loop (secret set, workflow pushed, `actions_wait_for_run` by bean, log, run get, run list by bean, `repo_status.stalk_runs`), lists, dispatch, bounded wait, cancel, re-run, automations, the permission matrix, and the secret value never in any tool answer or any line the MCP Worker logged. `test/oauth.test.ts`: the challenge and metadata advertise the new defaults; the secrets scope is granted only when ticked.

- **Staging** (gitstalk.dev, 2026-10-12; gateway `ab65d8fb`, web `2ab34a82`, MCP `1a28c9cd`; production not deployed). `pnpm env:smoke staging` ok. A raw MCP HTTP client (Node `fetch`, no SDK): the 401 challenge said `scope="read collaborate write"`, the protected-resource metadata the same, the authorization server all four; dynamic registration, PKCE S256, a passkey sign-up in headless Chrome; the consent page opened with read, collaborate and write ticked and secrets unticked; the test ticked secrets and the token came back `read collaborate write secrets`. 35 tools, no `execute`. `actions_secret_set DEPLOY_TOKEN` (a random value), `actions_variable_set REGION`, then `git_credentials` and real git pushed `bean/add-ci` adding `ci.yml` (push and dispatch, a step printing `$TOKEN` and `vars.REGION`), `slow.yml` and an automation. `actions_wait_for_run(bean: add-ci)` returned after 43 s with `CI #1 success (13 s) beans=add-ci`; `actions_job_log` read `[Deploy] deploying with *** to eu-e2e`; `repo_status.stalk_runs` named the run; `actions_dispatch(CI, who: agents)` then `grep: hello agents` read `[Greet] hello agents`; `actions_rerun` ran #3 with the same inputs; `slow.yml`'s wait with `timeout_s: 20` returned `running` after 21 s, `actions_cancel` then a wait gave `cancelled`; secret and variable lists; `automation_run(note)` succeeded and its log read `noted by the automation`; delete variable and secret. The secret's value was in no tool answer. Claude Code 2.1.296 with an isolated config: `claude plugin marketplace add` of the plugin branch installed `gitstalk` 0.10.0; `claude mcp login` against staging asked for `scope=read+collaborate+write` and connected. A headless `claude -p` session was not run: the isolated config has no Anthropic login, and the owner's was not to be used. Test accounts and the repository were deleted (one more, from a first run that stopped at the OAuth callback before saving its handle, is left on staging: an empty `e2e-` account).

### 5.5 Gaps

- No re-run of failed jobs only, and no workflow enable/disable (the product has neither).
- Runs have no completion watch, so `actions_wait_for_run` reads run rows every few seconds inside the gateway (one RPC for the agent).
- Doc 25 §4.4's always-protected workflow paths are still a design (§7.13): today an agent session can land a workflow change on a repository whose `checks.toml` does not protect `.github/**`.
