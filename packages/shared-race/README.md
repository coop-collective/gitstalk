# @gitstalk/shared-race

The shared contract package for Gitstalk's Workers: the types, Zod schemas and small pure
helpers that the gateway, the web app, the MCP server and the Actions executor agree on. It
holds the gateway's RPC surface, the engine's run configuration, task and suite shapes and event
log, repositories, collaborators, deploy tokens, checks configuration, Actions and Automations,
and the repository config-directory rule. It is a TypeScript library with no Worker of its own;
it is bundled into each Worker that imports it.

Despite its name, this is the product's contract package, not benchmark-only code. The
repository engine shares its shapes with the benchmark runs, so engine types use run
vocabulary (`RunId`, `RunConfig`, `events.jsonl`).

```
gitstalk-web ──────────┐
gitstalk-mcp ──────────┼── service bindings (RpcResult<T>, Zod-validated) ──> gitstalk-gateway
gitstalk-actions-exec ─┘                                                     (implements them)
        all of the above import the shapes from @gitstalk/shared-race
```

## Key concepts

- **RPC contracts**: every gateway method answers `RpcResult<T>` (`{ ok: true, ... }` or
  `{ ok: false, error }`), with bounded output and a `truncated` flag (`rpc.ts`). Domain files
  add their own RPC types: `repos.ts`, `collaborators.ts`, `agent-repos.ts`, `accounts.ts`,
  `deploy-tokens.ts`, `engine-feed.ts`, `actions.ts`, `actions-secrets.ts`.
- **Engine inputs and events**: `run-config.ts` (integration policy, engine settings, agents),
  `task.ts` (tasks, acceptance tests, safe repository paths), `suite.ts` (what every check runs,
  as an argv, never a shell), `driver.ts` (invocations), `events.ts` (the event log, one JSON
  object per line), `ids.ts` (branded ids), `read-maps.ts` (which test files observe which
  paths), `repo-events.ts` (messages on the `repo-events` Queue).
- **Repository configuration**: `.gitstalk/` wins over the older `.beanstalk/` (`config-dir.ts`);
  `checks-config.ts` finds and reads the checks file (`checks-yaml.ts` for `checks.yml`, `checks-toml.ts` for the older `checks.toml`, `strict-yaml.ts` shared with `policy-file.ts`); `automation-file.ts`, `automation-editor.ts`,
  `automation-models.ts` and `cron.ts` cover Automations and schedules.
- **Collaboration records** (`collaboration.ts`): transport-neutral records for contributors
  posting on beans.
- **Plugin names** (`plugin.ts`): the install lines for the Claude Code and Codex plugin.

Design docs: [20-repositories.md](../../docs/claude-opus/20-repositories.md),
[22-collaborators.md](../../docs/claude-opus/22-collaborators.md),
[23-mcp-repository-tools.md](../../docs/claude-opus/23-mcp-repository-tools.md),
[24-checks-config.md](../../docs/claude-opus/24-checks-config.md),
[25-actions-and-automations.md](../../docs/claude-opus/25-actions-and-automations.md),
[26-actions-job-executor.md](../../docs/claude-opus/26-actions-job-executor.md). Public pages:
[checks](../site/public/docs/checks.html), [actions](../site/public/docs/actions.html),
[automations](../site/public/docs/automations.html).

## Layout

Each module is a named export in `package.json` (`@gitstalk/shared-race/<module>`, mapping to
`src/<module>.ts`); there is no index module.

| Group | Modules |
| --- | --- |
| Gateway RPC | `rpc`, `repos`, `collaborators`, `agent-repos`, `accounts`, `deploy-tokens`, `engine-feed`, `repo-events` |
| Engine | `ids`, `run-config`, `task`, `suite`, `driver`, `events`, `read-maps` |
| Repository config | `config-dir`, `checks-config` |
| Actions and Automations | `actions`, `actions-secrets`, `cron`, `automation-file`, `automation-editor`, `automation-models` |
| Other | `collaboration`, `plugin` |

Tests sit next to their modules (`src/*.test.ts`, including `fast-check` property tests).

Imported by `packages/gateway` (most heavily), `packages/web`, `packages/mcp`,
`packages/actions-executor` and `@gitstalk/shared-ask`. Dependencies: `zod`, `yaml`,
`smol-toml`.

## Develop

```bash
pnpm -F @gitstalk/shared-race test        # vitest, plain Node (pure modules, no bindings)
pnpm -F @gitstalk/shared-race typecheck   # tsc -p tsconfig.json
```

There is no `dev`, `types` or `.dev.vars`: the package reads no bindings.

## Configuration

None. The package holds no bindings, vars or secrets; the Workers that implement or call these
contracts are configured in their own packages. It ships inside those Workers; see
[30-environments.md](../../docs/claude-opus/30-environments.md).

## Benchmark runs (admin only)

`run-config.ts` still names the baseline `queue` policy and earlier engine variants, the
`replay` agent and pinned presets, so admin benchmark runs and the local harness share one
config and event format. The harness and its results are in [research/](../../research/README.md)
and [research/race/](../../research/race/).

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md); run `pnpm check` at the root before sending a
change.
