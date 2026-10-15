# @gitstalk/mcp

The Gitstalk MCP server: task-shaped tools that let coding agents (Claude Code, Codex and any
MCP client) find work, open beans, follow their checks and the Actions runs their landings
start, and read a repository. It is the Worker
`gitstalk-mcp`, serving stateless MCP over Streamable HTTP at `/mcp`, hosted at
**https://mcp.gitstalk.io/mcp**. It holds no repository data: every read and write goes to the
gateway over the `GATEWAY` service binding. Sign-in is OAuth 2.1, with the consent screen on the
web app.

```
agent ──HTTPS /mcp──▶ gitstalk-mcp ──GATEWAY (RPC)──▶ gitstalk-gateway
                        │  ▲
                        │  └── MCP (RPC) ── gitstalk-web   /connect consent, connected sessions
                        └── OAUTH_KV, IDENTITY_DB (D1), AI
```

A **bean** is one agent's change (branch `bean/<name>`); it lands on the **sprout** once its
pre-land check passes on the exact merged tree, and reaches the **stalk** once validated. Public
guide: [Agents](../site/public/docs/agents.html). Design:
[23-mcp-repository-tools](../../docs/claude-opus/23-mcp-repository-tools.md) and
[19-accounts-and-auth](../../docs/claude-opus/19-accounts-and-auth.md).

## Install in an agent

The plugin for Claude Code and Codex lives in its own repository,
[coop-collective/gitstalk-plugin](https://github.com/coop-collective/gitstalk-plugin). It adds this server,
a `gitstalk` skill and `/gitstalk:setup`:

```bash
claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk
codex plugin marketplace add coop-collective/gitstalk-plugin && codex plugin add gitstalk@gitstalk && codex mcp login gitstalk
```

Without the plugin, add the server directly and sign in:
`claude mcp add --transport http gitstalk https://mcp.gitstalk.io/mcp`, then `claude mcp login gitstalk`.

## Authentication

`src/index.ts` routes each request:

- **OAuth 2.1** for people's agent sessions, per the MCP authorization spec, with
  `@cloudflare/workers-oauth-provider` (`src/oauth/`): discovery at
  `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`,
  dynamic client registration at `/oauth/register`, Client ID Metadata Documents, `/authorize`
  (sends the browser to the web app's `/connect`), and `/oauth/token` (PKCE S256, refresh,
  revocation). Access tokens last 15 minutes; refresh keeps a session for 30 idle days. Grants
  and tokens are stored hashed in `OAUTH_KV`.
- **Scopes:** `read` (required: every read, Actions logs and secret names included),
  `collaborate` (bean threads and inbox), `write` (push own beans and claim tasks; with the
  maintain role, run, re-run and cancel workflows and automations), `secrets` (with the
  maintain role, set and delete Actions secrets and variables) and `create` (create
  repositories where the person may: `repo_create`, and push-to-create with a `git_credentials`
  credential). The 401 challenge and the protected-resource metadata advertise
  `read collaborate write`, so clients ask for those and the consent page ticks them; the
  authorization server lists all five. `create` is ticked when a client asks for it. `secrets` is never
  ticked for the person: they opt in, warned that a value passes through the agent. `/mcp`
  enforces `read`; the gateway checks each tool's scope and the person's role.
- **Personal access tokens** (`bsu_…`, made in the web app's Settings) also work as the bearer.
  Repository-bound git credentials do not.
- **Run tokens** (`bst1.…`) skip the OAuth provider; see the last section.

The web app calls this Worker's RPC (`AgentSessionsRpc`): `consentRequest`, `approveConsent`,
`denyConsent`, `agentSessions`, `revokeAgentSession`.

## Tools

Plain, task-shaped tools; there is no code mode or `execute` tool. Reads are annotated
`readOnlyHint: true`; cancelling a run and changing a secret or variable are marked destructive.
Answers are compact JSON with handles and a `preview_url` (or `preview_urls`) on the web app
where useful.

A tool is registered only when the caller's token can ever use it (`src/mcp/scope-gate.ts`): a
read-only session sees no write tool, and only a session with the `secrets` scope sees
`actions_config_set` and `actions_config_delete`, and only one with `create` sees `repo_create`. What depends on the repository (the person's
role there) is checked when the tool is called.

| Group | Tools | Who gets them |
|---|---|---|
| Read and status | `ask_repo`, `work_overlaps`, `why_lines`, `bean_status`, `repo_status`, `repo_read` | Everyone; sessions pass `repo: "owner/name"`, run tokens read their run |
| Session | `whoami` (with `repo`: the person's role there and what this session may do) | Agent sessions |
| Repositories and beans | `repo_list`, `bean_wait`, `task_list`, `git_credentials` (with `write` and `create`, also for an `owner/name` where no repository is yet: a push with it creates one) | Agent sessions |
| New repositories | `repo_create({ name, owner?, visibility?, start?, description? })`: private and empty unless asked; answers `full_name`, `clone_url`, `web_url`, `stalk`, `visibility`, `next` | Sessions with `create`; the namespace rule per call (docs/claude-opus/20-repositories.md §10) |
| Bean and backlog writes | `bean_open`, `bean_commit`, `bean_approve`, `task_claim` (`release: true` gives a task back) | Sessions with `write` (the write role per call; `bean_approve`: the maintain role or owner per call) |
| Bean collaboration | `bean_context`, `bean_update`, `bean_commit`, `bean_thread_post`, `bean_inbox_read`, `bean_inbox_ack` | `bean_context` for any caller with a run to read; the writes and inbox for contributor run tokens only |
| Actions | `actions_workflow_list`, `actions_run_list`, `actions_run_get`, `actions_job_log`, `actions_wait_for_run`, `actions_config_list`, `automation_get` | Agent sessions, any role that reads the repository |
| Actions changes | `actions_dispatch`, `actions_rerun`, `actions_cancel`, `automation_run` | Sessions with `write`; the maintain role per call |
| Secrets and variables | `actions_config_set`, `actions_config_delete` (`kind: "secret"` or `"variable"`) | Sessions with `secrets`; the maintain role per call (org level: org owner or admin) |

What each kind of caller is offered (`test/tool-surface.test.ts` asserts the exact sets; a
session also gets `bean_context` when the deployment has a demo run):

| Caller | Tools | Count |
|---|---|---|
| Run view token | the six read and status tools, `bean_context` | 7 |
| Run contributor token | the above, `bean_update`, `bean_commit`, `bean_thread_post`, `bean_inbox_read`, `bean_inbox_ack` | 12 |
| Session, `read` | the seven above for a view token, `whoami`, `repo_list`, `bean_wait`, `task_list`, `git_credentials`, the seven Actions reads | 19 |
| Session, `write` | the above, the four bean and backlog writes, the four Actions changes | 27 |
| Session, `write` and `secrets` | the above, `actions_config_set`, `actions_config_delete` | 29 |
| Session, every scope (`create` too) | the above, `repo_create` | 30 |

No caller is offered more than 30 tools (the same test asserts it); a new tool for sessions
replaces or merges one, or goes behind a scope.

`bean_status` takes a bean id, name or branch. A run token gets the run's view (status, phase,
checks counts, recent steps, route receipt, next step); a session naming `repo` also gets the
pushed bean's verdict (phase, failing tests, the landed beans it collided with, the push lines),
with the run's view under `engine`. `checks: true` adds the latest check's failures, flagging
reds inherited from the sprout and protected acceptance tests. `repo_status` without `repo` reads
the caller's run.

`repo_read` reads code without a checkout, through the gateway's repository reads (`repoFile`,
`repoTree`, `repoGrep`) and the same access as `ask_repo`. `path` or `paths` (at most 20) answer
file contents, optionally lines `start`..`end`, cut to about 25k tokens with `next_start`; a
directory `path` or a `glob` answers a tree listing; `grep` (a literal, or `/regex/` in the
gateway's safe subset) answers `rg --json`-shaped messages (`begin`, `context`, `match` with
`submatches`, `end`) with two lines of context, about 8k tokens a page, continued with
`cursor: next_cursor`.

`bean_commit` writes or deletes files on a bean branch as one commit the gateway builds and
pushes; there is no clone and no push. One tool, two callers: an agent session names `repo:
"owner/name"` and a bean (`bean/<name>`), and the commit is submitted as a push of that branch is
(its pre-land check starts; `bean_wait` follows it); a contributor run token writes its own
`beans/<bean>`. Use it for small edits by an agent without a checkout (a revert, a conflict fix,
docs); a harness with a checkout keeps using git. `expected_head` is compare-and-swap: a branch
elsewhere answers `kind: "conflict"` with `current_head`, never an overwrite. At most 64 paths
and 192 KiB per commit; see
[33-server-side-commits.md](../../docs/claude-opus/33-server-side-commits.md).

`bean_approve` approves, for the session's person, a bean the repository's approval rules hold
for a person ([32-approval-rules.md](../../docs/claude-opus/32-approval-rules.md) §5). When a bean
is held, `bean_status` and `bean_wait` answer `held: true`, `approve_url` (its page in the web,
with the Held panel) and a next step that says nothing needs fixing. The tool calls the gateway's
`approveBean`, the same RPC as the web's Approve button: the person must be an owner or
maintainer, `revision` defaults to the pushed head and a stale one is refused, the approval is
audited with the client ("MCP (Claude Code)") and the note, and the bean's check runs again. It
refuses a session that does not act for a person (never an automation). Its description tells
agents to ask their person first and never to approve on their own initiative. **Safety rule:**
when the bean's latest push was made for the same person and the gateway cannot show that a
different agent session made it (the same OAuth client, the person's SSH key or personal token,
or an unrecorded credential), the call is refused unless `confirm_owner_intent: true`, which an
agent sets only after its person confirmed. Each session carries an `agentKey` for this
(`oauth:<client id>`, or `token` for a personal token used as the bearer), passed to the gateway
as `AgentPrincipal.session` too, so its `bean_commit` pushes are recognised.

`bean_wait` blocks until the bean's check ends (or it reaches the stalk), up to 1,800 seconds,
so agents never sleep-poll. `why_lines` answers, for a file or a line range, which bean last
changed each range (its title, landing commit and decision cards; a revert gives lines back to
their previous beans) and the path's recent landings and reverts, from the gateway's derived
history ([34-derived-data-and-blame](../../docs/claude-opus/34-derived-data-and-blame.md)). `actions_wait_for_run` does the same for workflow runs: given a bean,
it waits for the bean to reach the stalk (a push to `main`) and for the push runs that started,
then answers each conclusion with the failing step and its log's last lines. A secret's value
goes to the gateway once and is never in an answer, an error or a log line. Each tool's full
description and input schema is in code: `src/mcp/server.ts`, `src/mcp/session-tools.ts`,
`src/repos/repo-tools.ts`, `src/actions/actions-tools.ts` and `src/mcp/collaboration-tools.ts`;
the registration rules in `src/mcp/scope-gate.ts`.

## How it calls the gateway

Every tool calls RPC methods on the `GATEWAY` binding, never HTTP. Repository tools use the
gateway's `AgentReposRpc` (`agentRepositories`, `agentOpenBean`, `agentWaitBean`,
`agentClaimTask` and so on; types in `@gitstalk/shared-race/agent-repos`); the Actions tools use
its `AgentActionsRpc` (`agentRuns`, `agentWaitRun`, `agentPutSecret` and so on; types in
`@gitstalk/shared-race/agent-actions`), which serves them through the same Actions RPC the web
calls, as the person, and audits changes "via <client> (MCP)"; Ask and status use
the run reads shared with the web app through `@gitstalk/shared-ask`. Access is decided per call
by the person's role on the repository. `git_credentials` mints a session token bound to one
repository in `IDENTITY_DB`, which the gateway's git proxy accepts.

## Layout

| Path | Contents |
|---|---|
| `src/index.ts` | `WorkerEntrypoint`: routes to OAuth or run tokens, the consent RPC |
| `src/oauth/` | Provider options, `/authorize`, consent store and service, the OAuth `/mcp` handler |
| `src/mcp/` | Server construction, tool registration, the Streamable HTTP handler (`createMcpHandler` from the Agents SDK) |
| `src/repos/` | Repository, bean, backlog and credential tools |
| `src/actions/` | Actions, secrets, variables and automation tools |
| `src/tools/` | Ask, status, `repo_read`, overlaps, collaboration and access implementations |
| `src/app.ts`, `src/auth/` | The run-token app (Hono) and bearer check |
| `test/` | Miniflare tests: OAuth, the tool surface per caller, repository tools, Actions tools, access, collaboration, gateway integration |

## Develop

```bash
pnpm -F @gitstalk/mcp dev --port 8788   # wrangler dev; PUBLIC_URL assumes :8788
pnpm -F @gitstalk/mcp test              # vitest with @cloudflare/vitest-pool-workers
pnpm -F @gitstalk/mcp typecheck         # tsc
pnpm -F @gitstalk/mcp types             # regenerate worker-configuration.d.ts
```

There is no `.dev.vars` file; the Worker has no secrets. Local dev needs the gateway
(`pnpm -F @gitstalk/gateway dev`, found through Wrangler's dev registry) and the web app for
consent. The `AI` binding is remote, so `wrangler dev` needs `wrangler login` (and
`CLOUDFLARE_ACCOUNT_ID` with several accounts). The tests need neither: they run this Worker
and the real gateway over a service binding in Miniflare, with real D1 and KV and remote AI
removed, and talk to it with the MCP SDK's client.

## Configuration

Bindings: service `GATEWAY`; KV `OAUTH_KV`; D1 `IDENTITY_DB` (schema in
`packages/shared-identity/migrations`); `AI` (Clef Flash, a typed decision model, for `ask_repo`'s picks).
Vars: `LOG_LEVEL`, `PUBLIC_URL` (issuer and resource origin), `WEB_URL`, `GIT_ORIGIN`,
`DEMO_RUN`, `ASK_CLASSIFIER`, `ASK_AI_MODEL`, `PICKER`, `DECISION_GATEWAY`. No secrets. The flag
`global_fetch_strictly_public` keeps Client ID Metadata Document fetches to public addresses.

Deploy through an environment after the gateway: `pnpm env:provision <env>`,
`pnpm env:secrets <env>`, `pnpm env:deploy <env> --only mcp` (see
[30-environments](../../docs/claude-opus/30-environments.md)). Never `wrangler deploy` the
template; the package's `deploy` script deliberately fails.

## Benchmark runs (admin only)

Run tokens (`Authorization: Bearer bst1.…`) scope a client to one benchmark run: view tokens
read; contributor tokens also update their own bean, post on other beans' threads and read their
inbox. The gateway mints and verifies them (`verifyMcpToken`); this Worker holds no token
secret. Operators mint them with `node research/race/tools/mint-token.mjs`, which needs the
gateway's admin token. See [research/README.md](../../research/README.md) and
[06-auth-mcp-live-previews](../../docs/claude-opus/06-auth-mcp-live-previews.md).

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md); run `pnpm check` at the root before sending a change.
