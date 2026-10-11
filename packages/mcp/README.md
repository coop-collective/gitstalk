# @gitstalk/mcp

The Gitstalk MCP server: task-shaped tools that let coding agents (Claude Code, Codex and any
MCP client) find work, open beans, follow their checks and read a repository. It is the Worker
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
  revocation). Access tokens last 15 minutes; refresh keeps a session for 30 idle days. Scopes:
  `read` (required), `collaborate`, `write`. Grants and tokens are stored hashed in `OAUTH_KV`.
- **Personal access tokens** (`bsu_…`, made in the web app's Settings) also work as the bearer.
  Repository-bound git credentials do not.
- **Run tokens** (`bst1.…`) skip the OAuth provider; see the last section.

The web app calls this Worker's RPC (`AgentSessionsRpc`): `consentRequest`, `approveConsent`,
`denyConsent`, `agentSessions`, `revokeAgentSession`.

## Tools

Plain, task-shaped tools; there is no code mode or `execute` tool. Reads are annotated
`readOnlyHint: true`; nothing is destructive. Answers are compact JSON with handles and a
`preview_url` on the web app where useful.

| Group | Tools | Who gets them |
|---|---|---|
| Session | `whoami`, `repository_access` | Agent sessions |
| Repositories | `repo_list`, `repo_status`, `automation_list` | Agent sessions |
| Beans | `bean_open`, `bean_status`, `bean_wait` | Agent sessions (`bean_open` needs `write`) |
| Backlog | `task_list`, `task_claim`, `task_release` | Agent sessions (claims need `write` and the write role) |
| Git | `git_credentials` (a short-lived HTTPS credential for one repository, as `git credential approve` input) | Agent sessions |
| Ask and status | `ask_repo`, `work_overlaps`, `change_status`, `checks_get`, `run_status`, `preview_link` | Everyone; sessions pass `repo: "owner/name"` |
| Bean collaboration | `bean_context`, `bean_update`, `bean_thread_post`, `bean_inbox_read`, `bean_inbox_ack` | `bean_context` for any caller with a run to read; the writes and inbox for contributor run tokens only |

`bean_wait` blocks until the bean's check ends (or it reaches the stalk), up to 1,800 seconds,
so agents never sleep-poll. Each tool's full description and input schema is in code:
`src/mcp/server.ts`, `src/mcp/session-tools.ts`, `src/repos/repo-tools.ts` and
`src/mcp/collaboration-tools.ts`.

## How it calls the gateway

Every tool calls RPC methods on the `GATEWAY` binding, never HTTP. Repository tools use the
gateway's `AgentReposRpc` (`agentRepositories`, `agentOpenBean`, `agentWaitBean`,
`agentClaimTask` and so on; types in `@gitstalk/shared-race/agent-repos`); Ask and status use
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
| `src/tools/` | Ask, status, overlaps, collaboration and access implementations |
| `src/app.ts`, `src/auth/` | The run-token app (Hono) and bearer check |
| `test/` | Miniflare tests: OAuth, repository tools, access, collaboration, gateway integration |

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
`packages/shared-identity/migrations`); `AI` (Jev, a classifier model, for `ask_repo`'s picks).
Vars: `LOG_LEVEL`, `PUBLIC_URL` (issuer and resource origin), `WEB_URL`, `GIT_ORIGIN`,
`DEMO_RUN`, `ASK_CLASSIFIER`, `ASK_AI_MODEL`, `PICKER`, `JEV_GATEWAY`. No secrets. The flag
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
