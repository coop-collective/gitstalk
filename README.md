# Gitstalk

**Watch your work grow like a beanstalk.**

Gitstalk is an agent-first git forge built on Cloudflare. When many coding agents work on one codebase, a merge queue makes them wait in line. Gitstalk lets them land without waiting: it checks every change on the exact tree it would land on, sends a failure back to the agent that wrote the change together with the change that broke it, and asks a human only when two specifications genuinely disagree. Agents grow together.

- A **bean** is one agent's change: a branch named `bean/<name>`.
- The **sprout** is the staged line. A bean lands there as soon as its pre-land check passes on the exact merged tree.
- The **stalk** is the stable line. It moves only to sprout commits that passed validation, so it stays green.

## Use it

The hosted service is at **[gitstalk.io](https://gitstalk.io)**, with documentation at [gitstalk.io/docs](https://gitstalk.io/docs). Agents connect over MCP at `https://mcp.gitstalk.io/mcp`. The Claude Code and Codex plugin lives in its own repository, [coop-collective/gitstalk-plugin](https://github.com/coop-collective/gitstalk-plugin):

```bash
claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk
codex plugin marketplace add coop-collective/gitstalk-plugin && codex plugin add gitstalk@gitstalk && codex mcp login gitstalk
```

Any git client works too: clone over HTTPS and push a `bean/<name>` branch to propose a change. Git over SSH is built ([`packages/ssh`](packages/ssh/README.md)) but not yet open on gitstalk.io, because SSH on port 22 needs a paid Cloudflare plan.

## Architecture

Every piece is a Cloudflare Worker. Workers call each other through service bindings (Workers RPC), and three Rust containers do the work that needs a real filesystem.

```
                         browsers                 agents (MCP)          git clients
                            │                          │               HTTPS │   │ SSH
                            ▼                          ▼                     │   ▼
  gitstalk-site ◀─SITE─ gitstalk-web ──MCP──▶ gitstalk-mcp                   │  gitstalk-ssh ── SSH server
  (marketing, docs)      (vinext app)              │                         │      │          container
                            │                      │                         │      │
                            └──────────────┬───────┴─────────────────────────┘──────┘
                                           ▼   service bindings (RPC) / git smart HTTP
                                    gitstalk-gateway ──────────────▶ runner containers
                                    repositories, engines,           (squash, check, revert)
                                    git proxy, Actions, OIDC
                                     │        │         ▲
                     ACTIONS_EXECUTOR│        │         │ ACTIONS_JOBS
                                     ▼        │         │
                          gitstalk-actions-executor ── job containers (GitHub Actions via act)
                                              │
    storage: Artifacts (git) · D1 (forge, identity) · Durable Objects (engines, Actions runs)
             KV (OAuth) · R2 (logs, dependency cache, media) · Queues (repository events) · Workers AI
```

The gateway is the only component that holds Artifacts tokens; every repository read or write goes through it. Agents never merge to the stable line themselves. A longer walkthrough is in the public docs ([architecture](packages/site/public/docs/architecture.html)) and in each package's README.

## Repository layout

| Path | Contents |
|---|---|
| [`packages/gateway`](packages/gateway/README.md) | Control plane: repositories, the per-repository engine, git smart-HTTP proxy, RPC entrypoints, Actions, automations, OIDC issuer; owns the runner container ([`container/`](packages/gateway/container/README.md)) |
| [`packages/web`](packages/web/README.md) | The web app (vinext, Next.js App Router on Workers) |
| [`packages/mcp`](packages/mcp/README.md) | The MCP server agents connect to, with OAuth |
| [`packages/ssh`](packages/ssh/README.md) | Git over SSH; owns the SSH server container ([`container/`](packages/ssh/container/README.md)) |
| [`packages/actions-executor`](packages/actions-executor/README.md) | Runs GitHub Actions jobs and the dependency cache; owns the job container ([`container/`](packages/actions-executor/container/README.md)) |
| [`packages/site`](packages/site/README.md) | Marketing site and public documentation (static assets) |
| [`packages/shared-*`](packages/) | Libraries bundled into the Workers: [`shared-race`](packages/shared-race/README.md) (RPC and engine contracts), [`shared-identity`](packages/shared-identity/README.md), [`shared-ask`](packages/shared-ask/README.md), [`shared-media`](packages/shared-media/README.md), [`shared-oidc`](packages/shared-oidc/README.md) |
| [`research/`](research/README.md) | Experiments, the benchmark harness and its recorded runs, prototypes; not part of the build |
| [`docs/`](docs/README.md) | Design documents and experiment write-ups (`docs/claude-opus/` is the most current set) |
| [`scripts/`](scripts/) | Repository tooling: environments and deploys, Rust checks, the public-docs check |
| [`environments/`](environments/example/) | Deploy environments; only `example/` is public |

## Contributing quick start

Prerequisites: Node 24 or later, pnpm 11 (the version is pinned in `package.json`'s `packageManager`), the Rust toolchain named in [`rust-toolchain.toml`](rust-toolchain.toml) (`rustup toolchain install` in the repository root installs it, with clippy and rustfmt), and Docker for building the container images. Wrangler is a workspace dev dependency, so `pnpm install` brings it.

```bash
pnpm install
pnpm check                          # format, lint, typecheck, TypeScript tests, Rust fmt/clippy/tests
pnpm -F @gitstalk/<package> test    # one package's tests
pnpm -F @gitstalk/<package> dev     # run one Worker locally (wrangler dev, or vite for the web app)
```

Local development of the gateway, web app and MCP server needs `wrangler login`, because Artifacts and Workers AI bindings are remote-only; the site runs offline. Each package's README lists its commands and the `.dev.vars` it needs. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Self-hosting

You can run your own copy on a Cloudflare account with Workers Paid, Containers, Artifacts and Workers AI. An environment is one directory under `environments/<name>/` (copy `environments/example/`); the scripts create its resources, push its secrets and deploy every package in order:

```bash
pnpm env:provision <env>            # create D1, KV, R2, queues; record ids; migrate D1
pnpm env:secrets <env>              # push Worker secrets (never printed)
pnpm env:deploy <env>               # deploy every package (--dry-run, --only <package>)
pnpm env:smoke <env>                # smoke-test the deployed stack
```

The `wrangler.jsonc` files in `packages/` are templates: never `wrangler deploy` one directly (each package's `deploy` script refuses on purpose). The full guide is [`docs/claude-opus/30-environments.md`](docs/claude-opus/30-environments.md), with a shorter public version at [self-hosting](packages/site/public/docs/self-hosting.html). The code is Apache-2.0 (see [License](#license)); if you run your own copy for others, give it your own name and logo ([TRADEMARKS.md](TRADEMARKS.md)).

## Benchmark results

The same 38 real changes from fastify's history (merged upstream pull requests, each with its own tests) were pushed in parallel to a GitHub repository using GitHub's merge queue and Actions, and to a Gitstalk repository, with CI capacity matched. Time from "ready" to merged, median:

| Parallel workers | GitHub merge queue | Gitstalk | Faster |
|---|---|---|---|
| 4 | 2.9 min | 0.7 min | 4.1x |
| 8 | 3.7 min | 0.8 min | 4.6x |
| 16 (three seeds) | 6.6-7.1 min | 0.8-1.1 min | 6.5-8.9x |

Every run landed all 38 changes correctly on both forges. The 4- and 8-worker rows are one seed each, and CI minutes are not like for like. Method, caveats, the synthetic 30-agent arena and every recorded run: [`research/README.md`](research/README.md), [`research/race/loadgen/README.md`](research/race/loadgen/README.md) and [`docs/claude-opus/11-experiments-summary.md`](docs/claude-opus/11-experiments-summary.md).

## Scaling to thousands of agents

Anthropic's source-control team reached a conclusion close to the one Gitstalk is built on: at agent scale, a merge queue with a global lock doesn't work. They [test after merge, accept that concurrent changes conflict, and let Claude fix the conflicts](https://www.anthropic.com/engineering/redesigning-source-control), at 30,000 merges a day. Their other rule is that global ref state is the scaling problem, so it should be kept small.

Gitstalk's target shape follows from both rules. Every Artifacts repository is its own Durable Object, so each bean gets its own fork and only the engine writes the sprout and the stalk. Writes then grow with the number of forks, not with one object's throughput. Today every bean is a `bean/<name>` branch of the repository, a workaround for fork bugs. By our estimate from Artifacts' published limits, that holds to roughly 1,000 active agents and one fork per bean to 10,000; the largest run we have measured is 30 agents.

We are asking the Artifacts team for:

| Ask | Why |
|---|---|
| Fix forks created after the parent has new pushes (`delta base is missing`, upload-pack 500) and make new forks readable at once | Unblocks one fork per bean |
| Forks share objects with their parent (copy-on-write), billed on unique objects | 10,000 forks of a 10 GB repository must not cost 100 TB |
| Control plane 2,000 → 20,000 requests per 10 s per namespace, or one binding across several namespaces | 10,000 agents and burst starts |
| A higher git rate for a busy repository, 10 GB repositories, more account storage | Real monorepos |
| Server-side calls: ref list and compare-and-swap, `createCommit`, `diff` and merge-base, changed paths in push events | Each one removes traffic instead of needing a higher limit |

The reasoning, the load estimates at 1,000 and 10,000 agents, and the message for the Artifacts team are in [`docs/claude-18-lessons-from-scion.md`](docs/claude-18-lessons-from-scion.md).

## License

Gitstalk is licensed under the [Apache License, Version 2.0](LICENSE) (Apache-2.0), copyright 2026 Coop. See [LICENSE](LICENSE) for the terms and [NOTICE](NOTICE) for attributions. The Apache License does not cover the Gitstalk name or logos; [TRADEMARKS.md](TRADEMARKS.md) explains how you may use them.

## Community

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md): report vulnerabilities privately, not in public issues
- [Code of Conduct](CODE_OF_CONDUCT.md)
- Source: [github.com/coop-collective/gitstalk](https://github.com/coop-collective/gitstalk)
- Releases: [github.com/coop-collective/gitstalk/releases](https://github.com/coop-collective/gitstalk/releases), with notes for each version deployed to gitstalk.io
