# Checks config: `.gitstalk/checks.toml`

Built 2026-10-07 (backlog `16` item 2.3). A persistent repository says what a bean must pass before it lands in one file, `.gitstalk/checks.toml`, read from the exact tree each check runs on. The engine and push flow are `18-git-native-flow.md`; repositories are `20-repositories.md`.

Since the rename (2026-10-10, `30-environments.md` §12) the file is `.gitstalk/checks.toml`; a tree without it but with `.beanstalk/checks.toml` (its name until then) uses that one, messages name the file read, and both paths are always protected.

## 1. The format

```toml
# .gitstalk/checks.toml
image = "node"                                    # the runner image; "node" is the only one today
command = ["node", "--test", "spec/**/*.spec.mjs"] # an argv, never a shell
timeout_seconds = 60                              # the whole suite's limit
protected_paths = ["data/schema.json", "migrations/**"]

[env]
KV_LIMIT = "3"
```

| Key | Type | Default | Rules |
|---|---|---|---|
| `image` | string | `"node"` | Only `"node"`: the runner image ships Node 25.8.1 and nothing else (§6). |
| `command` | array of strings | `["node", "--test"]` | Runs as an argv (no shell, no `npm test`). Must start with `node` and contain `--test`: the runner puts its reporters after `node` and reads node's junit report. At most 64 arguments of at most 500 characters. Options take their value with `=` (`--test-concurrency=1`); arguments after `--test` that do not start with `-` are the test files or globs, which targeted checks replace. |
| `timeout_seconds` | integer | 300 | 1 to 1800. A suite that runs out of time is re-run, never a red (`18` §7.1). |
| `protected_paths` | array of patterns | `[]` | Relative to the root, no `..`, at most 100. `*` and `?` stay within a path segment, `**` is any number of segments, a trailing `/` is everything under that directory, anything else is an exact path. `.gitstalk/checks.toml` and the approval rules' `.gitstalk/policy.yml` (`32-approval-rules.md`) are always protected on top (not the rest of `.gitstalk/`: agents tick tasks in `.gitstalk/backlog.md`, `23`; list `.gitstalk/**` to protect it all). |
| `[env]` | table of strings | none | At most 32 upper-case names; `PATH`, `HOME`, `CI`, `GIT_*`, `LD_*`, `NODE_TEST*` and `BWRAP*` are the runner's and refused. |

Any other key is refused by name (`unknown key "comand" (did you mean "command"?)`). The file is at most 16,000 characters. One suite per repository. **The starter's older draft** (only `[[check]]` tables with `name`, a shell `command` such as `"npm test"` and `timeout_seconds`, never read by anything before this) is read as what it always meant to the engine: the repository's default suite runs, and the push says so with the line to write instead. A `[[check]]` table mixed with the new keys is refused with that sentence. The TypeScript starter now writes `image = "node"`, `command = ["node", "--test"]`, `timeout_seconds = 120`, `protected_paths = []`.

Parser and validation: `packages/shared-race/src/checks-config.ts` (smol-toml 1.9.0, BSD-3-Clause, and Zod), shared by the gateway and the web so the page shows exactly what the engine runs.

## 2. What happens on a push

Every check of a repository engine (a bean's pre-land check, the sprout's validations, culprit probes, re-checks) first reads `.gitstalk/checks.toml` from the commit it checks. For a pre-land check that commit is the bean squashed onto the sprout, so **a bean that changes the file is checked by its own copy**, and every later bean inherits whatever landed.

| The tree has | The check | The push sees |
|---|---|---|
| no file | the engine's configured suite, exactly as before this file was read (`node --test`, 300 s, for every repository opened from the registry) | `gitstalk: no .gitstalk/checks.toml on this tree: the repository's default suite runs: node --test (timeout 300 s)` |
| the starter's older `[[check]]` draft | the same engine suite | `gitstalk: .gitstalk/checks.toml is the older [[check]] draft, which does not choose the suite: the repository's default suite runs: node --test (timeout 300 s)` and the line to write instead |
| an invalid file | red without running anything; one failing "test", `.gitstalk/checks.toml > the checks config is valid` | `gitstalk: .gitstalk/checks.toml is invalid:` and one line per problem (`line 2, column 19: invalid value`, `command: must be an argv array such as ["node", "--test"]; it never runs through a shell`, `image: "rust" is not available: …`), then the usual RED verdict quoting them |
| a valid file | the runner runs `command` with `env` and `timeout_seconds` | `gitstalk: checks from .gitstalk/checks.toml: node --test --test-concurrency=1 'spec/**/*.spec.mjs' (image node, timeout 60 s, env KV_LIMIT)` |

A missing file never means "no checks" (coordinator's decision at the integration, 2026-10-08, replacing the backlog's first choice): a repository without the file keeps its current behaviour, so deploying this turns no live repository red and lands nothing untested. The start page and Settings say "Default suite" in the same words.

### Protected paths

A bean's pre-land check compares the files the bean changes (the runner's squash `files`, sprout to merged tree) with the patterns **of the sprout's file** (the bean's own copy cannot unprotect itself) plus `.gitstalk/checks.toml`. If it touches one and its push may not, the check is red before any suite runs:

```
gitstalk: changes protected paths (data/schema.json): refused for a deploy token acting for @coop-chk
gitstalk: RED: schema was not landed. Merged onto the sprout, these tests failed:
gitstalk:   - data/schema.json > changes a protected path
gitstalk: output:
gitstalk:   This bean changes protected paths: data/schema.json.
gitstalk:   The sprout protects .gitstalk/checks.toml, data/schema.json (protected_paths in .gitstalk/checks.toml; .gitstalk/checks.toml always).
gitstalk:   Only the owner or a maintainer, pushing with a personal token or an SSH key, may change them;
gitstalk:   this push was by a deploy token acting for @coop-chk.
```

**Who may:** the repository's owner or a collaborator with the maintain role, pushing with their own credential (a personal token `bsu_` or an SSH key). Agent session tokens (`bss_`, MCP), deploy tokens (`bsd_`) and engine tokens never may, whoever they act for; the push line names who was allowed (`allowed for @coop-chk (owner, with a personal token)`). So an agent cannot weaken the checks it is judged by, and the backlog's "refused or flagged" is **refused** (a red the author reworks by dropping the change); there is no flag-and-ask card yet (§6). The decision is made per push from the credential the gateway verified (`checks/protected-access.ts`), kept on the pushed bean, and applied when its check runs.

## 3. How it is built

```
git push ─▶ push-proxy: credential + role ─▶ protectedAccess on the PushBean
engine: squash job (runner) ─▶ landing_trees(sha → bean, onto, files)       RunDO SQLite
engine: check job ─▶ planCheck: read checks.toml at sha (and at onto for a pre-land check)
                     ├─ protected change, not allowed ─▶ red, no runner call
                     ├─ missing or older draft ─▶ runner /v1/check with the engine's suite
                     ├─ invalid ─▶ red, no runner call
                     └─ valid ─▶ runner /v1/check with cmd, env, suite_timeout_seconds
                     lines ─▶ check_lines(sha) ─▶ preland.check event fold ─▶ remote: lines
```

- `checks/repository-checks.ts` decides (`planCheck`, `decide`, `protectedGuard`); `checks/check-store.ts` keeps the squashes and lines (500 rows each); `run/run-jobs.ts` asks it before every check when the engine reads repository checks; `push/push-events.ts` prints the lines before the check's verdict.
- The config is read through the Artifacts binding. A commit not readable yet (the runner's candidate push is eventually consistent) is a retryable job failure, **never** "no file": a missing commit must not land a bean without checks.
- **No runner change** (runner API stays 4): the runner already takes `cmd`, `env` and `suite_timeout_seconds`.
- `RunConfig.checks_source` (`suite` | `repository`) says where an engine's checks come from. Engines opened from the registry get `repository`; an operator who opens an engine with `settings.suite` (load tests, paired comparisons) gets `suite`, and `settings.engine.checks_source` pins either. **Engines opened before this change** have no field: a continuous engine with the default suite reads repository checks (`checksSourceOf`), so existing repositories switch when the gateway is deployed (§6).

## 4. On the web

- **Settings → Checks** (everyone with a role; read-only, since the file changes by a maintainer's bean): the effective config of the stalk (what runs, image, time limit, environment, protected paths including `.gitstalk/checks.toml`) and the file itself behind a disclosure; "Default suite" (no file, or the older draft) with what runs and how to choose another; or "Invalid" with every problem.
- **The start page's "What counts as green"** shows the same summary (`components/repository/checks-config.tsx`, `ChecksSummary`), ready for the Checks tab of backlog 2.7 to reuse.

Screenshots (staging, night and day, phone): `exp/checks-config/`.

## 5. Verified

**Tests** (`pnpm check` exits 0):
- `shared-race/src/checks-config.test.ts`: examples for every key and message, and fast-check properties: every valid config written as TOML reads back equal; any input (text or binary) never throws and an invalid answer always has a non-empty reason; any unknown key is named; each of the runner's own variables is refused by name; every valid config gives a suite the runner contract (`RunSuite`) accepts; directory patterns cover everything under them and nothing beside; `*` never crosses `/`; flagged files are a subset of the changed ones and always include the checks file.
- `gateway/src/checks/repository-checks.test.ts`: the decision table, protected paths taken from the sprout not the bean, validations not guarded, who may change protected paths per credential and role, the starter's file valid.
- `gateway/test/checks-config.test.ts`, end to end through the Worker, the engine DO, the fake Artifacts and the fake runner (whose squashes now land in the fake trunk repo as the real runner's candidates do): no file runs the default suite and lands; the starter's older draft keeps landing beans on the default suite; an agent's change to the checks is refused; the owner's checks then run with their argv, env and timeout for later beans, and a protected migration is refused; an invalid file is a red naming both problems.

**Staging** (`beanstalk-gateway-staging-checks` with its runner on standard-2, `beanstalk-web-staging-checks`, Artifacts `beanstalk-race-staging-checks` / `beanstalk-repos-staging-checks`, D1 `beanstalk-forge-staging-checks` and `beanstalk-identity-staging-checks`): passkey sign-up as `coop-chk` in headless Chrome, three repositories from the web, a personal token and two deploy tokens from the web, then real `git push -o wait` by hand. The run below is on this branch after merging `origin/prototype` (MCP repository tools, repository tabs); an earlier run before the merge gave the same verdicts. Transcript: `exp/checks-config/staging-transcript.txt`; Settings → Checks for each repository and the empty start page in night, day and phone (no sideways scroll): `exp/checks-config/*.png`.

| Repository | Push | Credential | Result |
|---|---|---|---|
| `greeter-ts` (TypeScript starter) | `add-truncate` | owner, personal token | `checks from .gitstalk/checks.toml: node --test (image node, timeout 120 s)`, green 6.2 s, landed and validated, 19 s for the push |
| | `shout` (a failing test) | owner | red, `test/shout.test.ts > shouts with an exclamation mark` |
| | `weaken-checks` | deploy token | refused: `.gitstalk/checks.toml` is protected |
| | `bad-checks` (`command = "npm test"`) | owner | allowed to change it, then red: `command: must be an argv array …` |
| `kv-layout` (empty start, `spec/*.spec.mjs`, ESM) | `notes` | deploy token | (lane run, before the integration decision) `no .gitstalk/checks.toml …: no checks run`, landed and validated, 19 s; since the integration this runs the default suite (`20` §9) |
| | `setup` (adds the checks above) | owner | `node --test --test-concurrency=1 'spec/**/*.spec.mjs' (image node, timeout 60 s, env KV_LIMIT)`, green 6.4 s; the spec asserts `KV_LIMIT` is `"3"` and sits where `node --test`'s defaults would not look, so the green proves both |
| | `off-by-one` | deploy token | red, `spec/kv.spec.mjs > keeps KV_LIMIT keys from the checks environment`, naming `setup` as the bean it collided with |
| | `schema` | deploy token | refused: `data/schema.json` is protected by the file |
| | `get-or` (a new spec) | deploy token | green under the repository's checks, landed |
| `rust-sum` (a Rust crate) | `crate` (`image = "rust"`, `command = ["cargo", "test"]`) | owner | red, three problems named: the image, `command` must start with `node`, and must run `node --test` |

## 6. Open items and decisions for Coop

1. **Other languages (the image question).** The runner image has only Node, and its check reads node's junit reporter, so a Rust or Python suite cannot run; the file says so precisely instead of pretending. Options, not built:
   - *A second runner image per toolchain* (`runner-rust`: Debian + rustup stable + cargo cache; `runner-python`: uv + CPython), each its own Container class and `max_instances`, chosen by `image`. The runner binary is the same; the check needs an **exit-code mode** (green = exit 0; failing tests from a JUnit file the command writes, when it can: `cargo nextest --profile ci`, `pytest --junitxml`), a runner API 5 change. Cost: images of 1 to 2 GB (Rust) built and pushed per deploy, cold starts, and dependencies fetched with no network at check time (vendored or snapshotted like `/opt/arena-deps`).
   - *Sandbox SDK* with a per-repository Dockerfile: most general, but builds per repository and a new trust boundary.
   - Recommendation: keep `node` until a real user needs another language; then add `runner-rust` behind `image = "rust"` with the exit-code mode, measured like fastify (`packages/gateway/container/README.md`).
2. **Dependencies.** Nothing is installed at check time and suites run offline, so only zero-dependency projects (or the image's arena snapshots, deliberately not exposed in the file) work. A repository with `node_modules` needs an install step with a cache keyed by the lockfile; not designed yet.
3. ~~Existing repositories switch on deploy~~ **Decided at the integration (2026-10-08): they do not.** A repository without the file, or with the starter's older `[[check]]` draft, runs the engine's suite as before (`decide` in `checks/repository-checks.ts`, `readChecksConfig`'s `legacy`). Proven by `shared-race/src/checks-config.test.ts` (the draft reads as `legacy`, protects only the checks file), `gateway/src/checks/repository-checks.test.ts` (missing and legacy run the engine's configured suite, an agent's protected change is still refused) and `gateway/test/checks-config.test.ts` end to end (no file: the default suite ran once and the bean landed; the old draft pushed by the owner, then an agent's bean: both ran `node --test` and landed). Protected-path changes by deploy tokens and agents stay refused.
4. **Refused, not flagged.** A protected change by an agent is a red the author must drop. A "flag" variant (land it after a maintainer approves a decision card) waits for decision routing (Phase 3).
5. **Deploy tokens never change protected paths**, even ones a maintainer made for CI. If CI should, a per-token "may change checks" setting is the place.
6. **Validations read the checks of the tree they validate** (the sprout head), so a landed config change applies to the next validation at once.
7. Seen on staging, not this lane's (backlog 2.2): **a deleted repository's name cannot be used again** by its owner: `/new` answers "Engine r0bb8… drives another repo." because the engine id is derived from `<owner>/<name>` and the closed engine still holds its old record. And a creation whose web request was cut off left its name reserved ("You already have a repository named …") but unlisted. The registry should free the engine id on delete and release or finish half-made rows.
