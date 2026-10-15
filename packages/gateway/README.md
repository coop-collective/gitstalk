# @gitstalk/gateway

The gateway is Gitstalk's control plane, deployed as the Worker `gitstalk-gateway`. It owns every repository: the registry in D1, the git data in Artifacts, and one continuous engine per repository that turns a `git push` into a bean and lands it. It is the only component that holds Artifacts tokens. People, agents and the other Workers reach repositories through it: git clients over its smart-HTTP proxy, the web app, the MCP server and the SSH server over Workers RPC, and the Actions executor through a named entrypoint. It also runs GitHub-compatible Actions and automations, and issues their OIDC tokens.

```
 git clients (HTTPS) ───────────▶ /git/<owner>/<repo>.git ─┐
 gitstalk-web  ─ GATEWAY, ACTIONS ─┐                       │
 gitstalk-mcp  ─ GATEWAY ──────────┼──▶ gitstalk-gateway ◀─┘
 gitstalk-ssh  ─ GATEWAY ──────────┘     │   │   │   │
 gitstalk-actions-executor ─ ACTIONS_JOBS ▶  │   │   └─▶ Runner containers (squash, revert, checks)
          ▲                                  │   └─────▶ Artifacts: REPOS (repositories), ARTIFACTS (benchmark runs)
          └──────── ACTIONS_EXECUTOR ◀───────┴─────────▶ D1 (FORGE, IDENTITY_DB), Queue, R2, Workers AI
```

## Key concepts

- **Repositories.** A record in the `FORGE` D1 database (owner, name, visibility, profile, redirects after a rename or transfer) and a git repository in the `REPOS` Artifacts namespace. Creating one seeds its first commit (an empty start, a template, or an import of a public git repository) on both lines. Owners are people or organizations. See [20-repositories.md](../../docs/claude-opus/20-repositories.md).
- **The engine and landing.** Each repository has a continuous engine in a `RunDO` Durable Object. A bean is one agent's change, pushed to `bean/<name>`. The engine squashes it onto the **sprout** (the staged line) once its pre-land check passes on the exact merged tree, and moves the **stalk** (the stable line) only to validated sprout commits. A bean's phase is published as the tag `refs/beans/<name>/status`. Checks come from `.gitstalk/checks.yml` (an older `checks.toml`, and `.beanstalk/` from before the rename, are still read), read from the tree being checked. See [18-git-native-flow.md](../../docs/claude-opus/18-git-native-flow.md) and [24-checks-config.md](../../docs/claude-opus/24-checks-config.md).
- **The git proxy.** `/git/<owner>/<repo>.git/*` serves clone, fetch and push. A push must be one `refs/heads/bean/<name>`; it is forwarded to Artifacts with a token the client never sees, then submitted to the engine, and the answer carries `remote:` lines (`git push -o wait` holds it for the verdict). Pushes to `sprout`, `stalk`, `main`, other branches and deletions are refused. Public repositories clone without a credential. `GET /v1/whoami` tells you whom a token belongs to.
- **Credentials.** One function, `verifyGitCredential` (`src/auth/git-credential.ts`), accepts people's tokens (`bsu_`, and `bss_` minted for an MCP session, checked against `IDENTITY_DB`), deploy tokens (`bsd_`), Actions job tokens (`bsj_`) and the gateway's own signed tokens (`bst1.`); `mayUseEngine` then decides what the holder may do. See [19-accounts-and-auth.md](../../docs/claude-opus/19-accounts-and-auth.md).
- **Collaborators and organizations.** Collaborators hold `read`, `write` or `maintain` on a repository, by invitation. An organization's repositories also grant access through the member's org role. Organization-level Actions secrets and variables live here too. See [22-collaborators.md](../../docs/claude-opus/22-collaborators.md) and [28-organizations.md](../../docs/claude-opus/28-organizations.md).
- **Repository events.** Engines publish landings, promotions, reverts, decisions and bean events to the `gitstalk-repo-events` queue. This Worker consumes it, writes the D1 indexes (beans, activity, daily counts) and tells Actions when the stalk moved.
- **Derived history.** Blame by bean and path history, computed from each change on the sprout through one mechanism: a deriver `{name, version, eager, compute(changeset, parentState)}` whose rows are kept by path and chain position. Eager derivers advance on each landing; a read advances what it needs first; a version bump recomputes. They live in `RepoDerivedDO` (one per repository engine, beside its `RunDO`), fed by the `repo-events` consumer after each indexed batch, so the engine's own object does no extra work. Served as `whyLines` and `pathHistory` (RPC) and MCP's `why_lines`. See [34-derived-data-and-blame.md](../../docs/claude-opus/34-derived-data-and-blame.md).
- **Actions.** Workflows in `.github/workflows/` run unchanged: `ActionsRepoDO` (one per repository) indexes workflows, schedules and minutes; `ActionsRunDO` (one per run) owns the job graph, timeouts, cancellation and the live log relay. Jobs run on `gitstalk-actions-executor`, one container per job; logs go to R2. See [25-actions-and-automations.md](../../docs/claude-opus/25-actions-and-automations.md) and [26-actions-job-executor.md](../../docs/claude-opus/26-actions-job-executor.md).
- **Commits on the server: one commit flow.** `bean_commit`, the automation builder and Settings → Approval rules all commit through one core (`src/commit/server-commit.ts`, run in the `RunDO`): the shared path rules and size caps, idempotency (one key's tries at a time), the build from changed paths, compare-and-swap on the bean branch, the push and its report-status, and the engine's submit. `bean_commit` writes files to a bean branch without a clone. For an agent session on a repository (`Gateway.agentCommitBean`, the write scope and role) it commits `bean/<name>` and submits it to the engine as a push of that branch is; for a race run's contributor token (`Gateway.beanCommit`, `POST /v1/runs/:run/beans/:bean/commits`) it commits the token's own `beans/<bean>`. Either way the `RunDO` reads only the trees on the changed paths, builds the blobs, trees and commit in the Worker (`src/commit/`), and pushes a pack through receive-pack with a token it minted, using `expected_head` as compare-and-swap. The web editors' saves (`RunDO.repoSaveFile`, `src/commit/file-save.ts`) are the same flow with their own parameters: a new bean named from its commit (`automation-<slug>-<short>`, `rules-<short>`) that must not exist yet, the person as author, and the web's idempotency key per save attempt. See [33-server-side-commits.md](../../docs/claude-opus/33-server-side-commits.md).
- **Automations.** An automation file compiles to a single-job workflow on the same executor. Its agent loop calls the gateway's model proxy (`POST /v1/automations/model/chat/completions`) with its job token; the proxy calls Workers AI through AI Gateway and enforces a monthly budget per repository. Edits from the web's automation builder are saved as beans, so they land through the pre-land check like any other change.
- **OIDC issuer.** The gateway mounts the issuer from `@gitstalk/shared-oidc` at `/_actions/oidc` (discovery, JWKS, the job token endpoint) and gives each job `ACTIONS_ID_TOKEN_REQUEST_URL` and `_TOKEN`. A request token is valid only while its job runs. Without the OIDC secrets, jobs get no OIDC variables and the routes answer `503`.
- **The runner container.** The `Runner` Container Durable Object drives the Rust image in [`container/`](container/README.md): squash and batch merges (with a structural merge tier), reverts, ref updates and sandboxed test suites. `RunnerCapacity` (one instance) shares the pool between engines (one pre-land sandbox per bean in check) and benchmark runs, and holds Actions leases against the executor's limit.

Public docs: [git](../site/public/docs/git.html), [repositories](../site/public/docs/repositories.html), [checks](../site/public/docs/checks.html), [collaborators](../site/public/docs/collaborators.html), [Actions](../site/public/docs/actions.html), [automations](../site/public/docs/automations.html), [architecture](../site/public/docs/architecture.html).

## RPC entrypoints

RPC between Workers goes through service bindings, never HTTP. The binding is the trust boundary: the gateway does not authenticate RPC callers, so the calling Worker authenticates its users first and passes a `Viewer` or principal. Shared types live in `@gitstalk/shared-race` (`rpc`, `repos`, `collaborators`, `agent-repos`, `actions` and others).

| Entrypoint | Bound by | What it serves |
|---|---|---|
| `Gateway` (default export) | `gitstalk-web` (`GATEWAY`), `gitstalk-mcp` (`GATEWAY`), `gitstalk-ssh` (`GATEWAY`) | Repositories (create, import, list, update, archive, transfer, delete, files, activity), deploy tokens, collaborators and invitations, account rename and close, repository reads (tree, file, diff, log, grep; MCP's `repo_read` uses tree, file and grep), engines (`openRepoEngine`, `gitToken`, `pushedBeans`, `engineFeeds`), derived history (`whyLines`, `pathHistory`), the agent tools behind MCP (`agentRepositories`, `agentOpenBean`, `agentWaitBean`, backlog and task claims, bean collaboration threads, inbox and `beanCommit`), the automation editor, token checks (`verifyMcpToken`, `verifyViewToken`), and git over SSH (`sshKeyLookup`, `sshGit`). Also the HTTP routes and the queue consumer |
| `Actions` | `gitstalk-web` (`ACTIONS`) | Workflows, runs, dispatch, cancel, logs; repository and organization secrets and variables |
| `ActionsJobs` | `gitstalk-actions-executor` (`ACTIONS_JOBS`) | The executor's job reports and logs, authenticated by each job's report token, and the repository directory for its cache sweep |
| `StubActionsExecutor` | none (`ACTIONS_EXECUTOR_MODE = "stub"`) | An echo executor for local work and tests |

The method-level contract (bounds, error codes) for the run and repository read methods is in [31-gateway-engine-internals.md](../../docs/claude-opus/31-gateway-engine-internals.md), "RPC for the web app".

## Read index hit rate

Each engine's `RunDO` reads git objects from Artifacts through one cache tier, the read index (`src/repo/object-cache.ts`): commits, trees and blobs kept by id in its SQLite (blobs up to 1 MB), plus a 5 s memo of ref heads that a landing clears. Git objects never change under their id, so nothing in it is ever stale.

Who reads through it:

- **The engine's jobs**, through `src/repo/read-through-port.ts` (since 2026-10-14): the approval gate's merge diff and policy file, a repository's `.gitstalk/checks.toml` at each checked commit, culprit diffs, conflict line ranges and file reads, whenever they name a commit id. A branch read and every write go to Artifacts as before. Each such call is still metered as one Artifacts operation, as the port call it replaces was.
- **The warm-up** after every landing (`warmLine` in `src/adapters/repo-explorer.ts`): it walks the new line head's trees and fetches every blob it does not hold, so the explorer and the next job find them.
- **The explorer** (the web's code view, MCP reads) and server-side commits.

Every read counts as a hit or a miss, by kind (`commit`, `tree`, `blob`) and for the ref memo apart (`src/repo/cache-stats.ts`), and by purpose: `demand` (a reader asked), `prefetch` (the warm-up) or `derived` (the `RepoDerivedDO` reading through the engine). The warm-up fetches each new object exactly once by design, so its misses can never be hits of their own; they are reported apart and kept out of the hit rates. Reads that bypass the index (a `log` page, a ref given as a commit id) are not counted. The counts are kept in memory on the infra meter (`src/run/infra-meter.ts`) and stored with its existing writes, so counting costs no SQLite write of its own.

They are reported as `cache` in `runView` (RPC and `GET /v1/runs/:run`) and in `summary.json`'s `infra`: `hits`, `misses` and `hit_rate` (null before any read) for `objects` (the three kinds together), each kind and `ref_memo`, for demand reads at the top level, for the warm-up under `cache.prefetch` (a hit there is an object already held), and for the derived data's reads through the engine under `cache.derived`.

Measured:

- **Staging, before (2026-10-14, `research/race/runs/stg-scion-*fastify-16-s*`, six runs):** objects 0.65 to 0.67, trees about 0.89, blobs 0 (573 to 578 misses a run), ref memo 0 (54 to 59 misses). Every one of those reads was the warm-up's: in a headless load test nobody else read through the index, because the jobs read Artifacts directly. The warm-up's re-walk of unchanged trees made the tree rate look good, and its first fetch of each blob made the blob rate 0.
- **Offline replay, after** (`src/repo/read-index-replay.test.ts`: the 38 fastify beans' recorded paths on a 407-file tree, each landing's merge diff read by the gate, then warmed): with the gate reading through the index, its 638 object reads cost 319 Artifacts reads (blob demand hit rate 0.50: every stalk side was warmed, every bean side is new), the warm-up then finds the bean's side held (prefetch misses 703 to 422), and the run's Artifacts object reads fall from 1,380 to 780. The replay's warm-up alone (143 tree and 560 blob fetches, 39 ref reads) matches staging's shape (173 to 176, 573 to 578, 54 to 59). A staging run with the change has not been made; it should show demand hit rates where there were none, and `prefetch.blob.misses` lower by the gate's bean-side blobs.
- **Derived data through the index** (2026-10-15): `RepoDerivedDO` reads its objects through the engine (`readObjects`, counted under `cache.derived`), so it no longer fetches the landed objects again; see Caching below. A per-colo Cache API tier was tried for this and dropped (docs/claude-opus/35-caching.md §12).
- **Not done:** keeping the ref memo across landings by setting it to the landed commit (compare-and-swap) instead of clearing it, which would turn the warm-up's one `log` per landing into a hit. Projected, not measured.

## Caching

The gateway's read index above is the last cache tier and the only one that holds every
repository, private ones included: objects by id in each engine's SQLite, and the 5 s ref memo a
landing clears. The repository's derived data (`RepoDerivedDO`) reads its commits, trees and
blobs through it too: `RunDO.readObjects` (`src/repo/object-reads.ts`, a Durable Object RPC only,
objects by validated id, never refs) serves them from the index and fetches a miss once, and
`src/derive/engine-reader.ts` batches the reads issued together and falls back to Artifacts, with
a log line, when the engine cannot answer. Its counts are `cache.derived`, apart from the
engine's own. In the offline replay of the fastify load test (`read-index-replay.test.ts`) this
takes derivation's 638 Artifacts reads to 0 and the total from 1,418 to 780, in 169 calls
([docs/claude-opus/35-caching.md](../../docs/claude-opus/35-caching.md) §12). The web app adds its own tiers in front of it for **public repositories only**
(`packages/web` README, Caching; design in
[docs/claude-opus/35-caching.md](../../docs/claude-opus/35-caching.md)): its isolate's memory,
the colo's Cache API and a global KV namespace, keyed by engine, the record's `updated_at` (so
any registry update purges them) and commit sha, and the browser caches with TanStack Query.
The line-move event types the read index warms on (`LINE_MOVE_TYPES`,
`@gitstalk/shared-race/events`) are the ones the web's head watcher refreshes on.

The gateway does not authorise RPC calls (`repoTree`, `repoFile`, `repoLog`, `repoDiff` trust the
engine id; the service binding is the trust boundary), so it never decides what may be cached
across viewers: the web app checks access on every request and caches only objects of a record
that check returned as public. Nothing in the gateway changes for this; a format change of what
the RPCs return means bumping the web's `EDGE_CACHE_VERSION`, since its copies outlive a deploy.

The repository events queue (`repo-events`) is where a future signed-out heads snapshot in KV
would be written, on `bean.landed`, `stalk.promoted` and `bean.reverted` (deferred until
measurements show the anonymous Code tab is dominated by its log reads).

## Layout

| Path | Contents |
|---|---|
| `src/index.ts` | The default `Gateway` entrypoint, Durable Object and entrypoint exports |
| `src/app.ts`, `src/routes/` | The Hono app: `/git`, `/v1/repos`, `/v1/whoami`, `/v1/actions`, `/v1/automations`, `/_actions/oidc`, and the benchmark routes |
| `src/repos/` | Registry, repositories, collaborators, deploy tokens, people, engine feed, cleanup |
| `src/push/`, `src/git/` | Push = submit, the push driver, status tags; pkt-line, receive-pack, pack writing, forwarding to Artifacts |
| `src/engine/`, `src/run/` | The engine (policies, landing, checks, decisions) and `RunDO`, its Durable Object |
| `src/checks/`, `src/read-maps/` | Checks config and protected paths; per-test read maps for affected-test selection |
| `src/agent/`, `src/collaboration/` | MCP-facing repository tools; bean threads, inbox and discovery |
| `src/commit/` | The one server-side commit flow (`server-commit.ts`) and its callers: `bean_commit` (`bean-commit.ts`) and the web editors' saves (`file-save.ts`); the tree builder, idempotency and the per-key queue |
| `src/actions/`, `src/automations/` | Actions (DOs, workflow parsing, job graph, secrets, OIDC, model proxy); automation editor |
| `src/runner/`, `src/capacity/` | The `Runner` Container class and its client; `RunnerCapacity` |
| `src/auth/`, `src/ssh/` | Credentials and tokens, SSH keys; the gateway's half of git over SSH |
| `src/repo-events/` | Queue consumer and D1 index |
| `src/derive/` | Derived history: the deriver mechanism, `bean_blame` and `path_history`, `RepoDerivedDO` and its RPC |
| `src/adapters/` | Artifacts access, repository storage, repository reads |
| `migrations/` | `FORGE` D1 schema |
| `test/` | Workers-pool tests with fakes for Artifacts, the git remote and the runner |
| `container/` | The runner image (Rust crate `runner`) |

## Develop

```bash
cp .dev.vars.example .dev.vars        # then fill in the secrets below
pnpm -F @gitstalk/gateway dev         # wrangler dev; needs Docker (runner) and a Cloudflare login (Artifacts is remote-only)
pnpm -F @gitstalk/gateway test        # vitest on Miniflare; no network
pnpm -F @gitstalk/gateway typecheck
pnpm -F @gitstalk/gateway types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
cargo test -p runner                  # the runner container's tests
pnpm check                            # at the root, before you report work as done
```

`ADMIN_TOKEN` and `RUN_TOKEN_SECRET` must each be at least 32 characters; a shorter one makes every request answer `500 misconfigured`. `.dev.vars.example` does not list `ACTIONS_SECRETS_KEY` yet; add it (32 random bytes, base64) to use Actions secrets locally.

## Configuration

All names below come from `wrangler.jsonc`; values are never committed.

- **Durable Objects:** `RUNS` (`RunDO`), `RUN_INDEX` (`RunIndex`, deprecated: read only by the one-time backfill into D1, deleted next release), `RUN_STREAMS` (`RunStreamDO`), `DERIVED` (`RepoDerivedDO`), `RUNNER` (`Runner`, a container class), `RUNNER_CAPACITY` (`RunnerCapacity`), `ACTIONS_REPOS` (`ActionsRepoDO`), `ACTIONS_RUNS` (`ActionsRunDO`).
- **Container:** `Runner`, image `./container/Dockerfile`, build context the repository root, `standard-4`, `max_instances` 48 (must equal `RUNNER_MAX_INSTANCES`).
- **Artifacts:** `REPOS` (namespace `gitstalk-repos`, people's repositories), `ARTIFACTS` (`gitstalk-race`, benchmark run repositories).
- **D1:** `FORGE` (`gitstalk-forge`, migrations in `migrations/`; it also holds the run list, `runs`, and the kill switch, `gateway_flags`), `IDENTITY_DB` (`gitstalk-identity`, schema in `packages/shared-identity/migrations`).
- **Queue:** `REPO_EVENTS`, producer and consumer of `gitstalk-repo-events`.
- **Cron trigger:** `17 * * * *`, the spend guards' hourly sweep of race repos (`scheduled()`, `src/run/scheduled-sweep.ts`). Nothing to provision.
- **R2:** `ACTIONS_LOGS` (`gitstalk-actions-logs`). **Analytics Engine:** `PRODUCT_EVENTS`. **Workers AI:** `AI`.
- **Service:** `ACTIONS_EXECUTOR` (`gitstalk-actions-executor`).
- **Vars:** `LOG_LEVEL`, `ARTIFACTS_NAMESPACE`, `RUN_TOKEN_TTL_SECONDS`, `ARTIFACTS_TOKEN_TTL_SECONDS`, `WEB_URL`, `PUBLIC_URL`, `RUNNER_MAX_INSTANCES`, `ACTIONS_EXECUTOR_MODE` (`service` or `stub`), `ACTIONS_MAX_INSTANCES`, `ACTIONS_MONTHLY_MINUTES`, `ACTIONS_JOB_TIMEOUT_MINUTES`, `ACTIONS_CONCURRENT_JOBS`, `AUTOMATIONS_AI_GATEWAY`, `AUTOMATIONS_MONTHLY_USD`.
- **Secrets (required):** `ADMIN_TOKEN` (admin API), `RUN_TOKEN_SECRET` (signs `bst1.` tokens), `ACTIONS_SECRETS_KEY` (encrypts Actions secrets at rest).
- **Secrets (optional, OIDC):** `OIDC_SIGNING_KEYS`, `OIDC_REQUEST_SECRET`, `OIDC_REQUEST_SECRET_PREVIOUS`, and the var `OIDC_ISSUER_URL` (default `<gateway>/_actions/oidc`). Generate keys with `packages/shared-oidc/scripts/oidc-keys.mjs`.

`wrangler.jsonc` is a template. Deploy through an environment: `pnpm env:provision <env>`, `pnpm env:secrets <env>`, then `pnpm env:deploy <env> --only gateway`, which also stamps the runner image with its commit. See [30-environments.md](../../docs/claude-opus/30-environments.md). Never `wrangler deploy` the template; the package's `deploy` script fails on purpose.

## Benchmark runs (admin only)

The gateway also hosts the benchmark machinery used to compare Gitstalk with a merge queue: `/v1/runs` (create, seed, start, stop, events, decision cards, the driver's long-poll API), `/v1/admin` (halt switch, sweep, capacity, the one-time RunIndex backfill) and the live page at `/runs/:run`. All of it requires `ADMIN_TOKEN` or tokens it issues. The engine's settings, the driver contract and the benchmark notes are in [31-gateway-engine-internals.md](../../docs/claude-opus/31-gateway-engine-internals.md); the tooling is in [research/README.md](../../research/README.md) and [research/race/](../../research/race/).

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md), and run `pnpm check` at the root before you open a pull request.
