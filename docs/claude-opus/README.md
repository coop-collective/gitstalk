# Gitstalk docs: second Claude set (Opus 5.5), 2026-10-03

Three sessions worked the same brief in parallel:
- **Codex:** the unprefixed files in `docs/`.
- **One Claude session:** the `claude-*` files in `docs/`.
- **This session:** this folder.

I did my research independently first (four research agents, using web search and Exa). I then read only the other sets' headings and idea titles, and wrote this set to **add to them rather than repeat them**. Where this set agrees, it points to their docs; where it disagrees, it says so (`07` §2).

## The idea in one paragraph

Treat thousands of agents like concurrent database transactions over one codebase:
- **Place work before it starts.** Predict each task's footprint, and never run colliding tasks at the same time. This is placement, not locks.
- **Let agents commit without waiting** to a fast trunk.
- **Record what every change read and wrote,** so a semantic break is traced to the exact pair of commits that caused it and handed to a fixer agent along with that cause.
- **Make the speed-versus-safety trade an explicit dial:** isolation levels per path, plus an error budget with a controller.
- **Humans read a green branch** that only moves forward on verified, attested snapshots, and act on decision cards instead of diffs.

The evidence behind it:
- Cursor found that locks reduced 20 agents to the throughput of 1–3, and that its single integrator gate became "an obvious bottleneck."
- Different agents' PRs conflict 41.7% of the time.
- GitHub's merge queue silently reverted 2,092 PRs.

The old research ideas this builds on (Crystal 2011, Cassandra 2013) failed for humans because people won't declare tasks or let a tool reassign them. With agents the forge dispatches every task and sees every read, so they now work.

## Read in this order

| File | What it is | Minutes |
|---|---|---|
| [`01-evidence.md`](01-evidence.md) | 14 findings that shape the design; what Cursor Origin is and what Cursor says it's tackling; competitor theses; Cloudflare constraints; competition rules | 8 |
| [`02-thesis-concurrency-control.md`](02-thesis-concurrency-control.md) | **The thesis.** The database-to-forge mapping, the full flow, isolation levels, reservations and recipes, a bottleneck table at 1k/10k/100k agents, the Cloudflare mapping, and objections with tests | 15 |
| [`03-ideas.md`](03-ideas.md) | 35 ideas, each with evidence, a Cloudflare mapping and a kill condition; which are theatre and which are boring but valuable | 12 |
| [`04-canvas-second-opinion.md`](04-canvas-second-opinion.md) | The Jev canvas gut call, tested against what Jev actually is: type-ahead routing, one query layer for humans and agents, a catalog that grows through review, new concurrency cards, kill criteria | 8 |
| [`05-github-actions-on-cloudflare.md`](05-github-actions-on-cloudflare.md) | Running Actions YAML unchanged on Containers: architecture, the three shim decisions, a four-tier compatibility list, published limitations, cost, Actions Doctor, where Dynamic Workers fit, phases | 10 |
| [`06-auth-mcp-live-previews.md`](06-auth-mcp-live-previews.md) | Agent principals and delegated tokens mapped onto Artifacts' per-repo tokens; the Rule of Two as a session-taint engine (GitLost replayed); an incident regression suite; a 15-tool MCP surface; previews as tools with isolation fixes and proof bundles | 10 |
| [`07-red-team-and-decisions.md`](07-red-team-and-decisions.md) | Risks with tests and dates, disagreements with the other sets, **decisions only Coop can make**, 48-hour experiments with pass thresholds, an 8-minute demo built around a live A/B race | 7 |
| [`31-gateway-engine-internals.md`](31-gateway-engine-internals.md) | The gateway's race engine (moved from `packages/gateway/README.md`, 2026-10-11): settings and presets, the driver contract, run routes and RPC, read maps, the v2.2 to v2.5 rule history, and the runner container's wire contract and measurements | reference |
| [`32-approval-rules.md`](32-approval-rules.md) | Approval rules by kind of change (2026-10-14): `.gitstalk/policy.yml`, classes computed by code (comment-only lexer, docs, tests, lockfiles, paths), routes auto/triage (Clef)/card, writer limits, receipts, and Settings → Approval rules | reference |
| [`33-server-side-commits.md`](33-server-side-commits.md) | `bean_commit`: commits built in the Worker from the changed paths only and pushed through receive-pack with compare-and-swap; the policy, API, verification against real git, and differences from claude-18 §5 | reference |
| [`34-derived-data-and-blame.md`](34-derived-data-and-blame.md) | Derived history (2026-10-14): one deriver mechanism per landing, eager or lazy, versioned; blame by bean (`why_lines`) and path history, in a Durable Object beside each repository engine | reference |
| [`35-caching.md`](35-caching.md) | Caching the repository UI (2026-10-14): data classes, the freshness policy and invalidation map in the browser, the public-only edge object cache (isolate, Cache API, KV), browser headers per route, measurement, deferred work | reference |
| [`research/`](research/) | The four sourced research memos behind all of this (about 30k words, 500+ linked sources) | reference |

## Ten takeaways

1. **The unsolved problem is coordination before code exists.** Write-path scale is crowded (Cursor Continuity, Entire, Pierre, GitLab, ERSC, Artifacts); nobody ships pre-code coordination. Cloudflare's brief asks exactly this.
2. **Nothing should block agents on the hot path.** Per-commit correctness, locks and single gates all serialized Cursor's swarm. Correctness should come by convergence, with a fast trunk, asynchronous validation and a green branch.
3. **Textual merge misses the conflicts that matter.** Read-write conflicts merge cleanly and break later. Agents read through the forge, so the forge can see them.
4. **Make the dial explicit:** isolation levels per path, plus an error budget. A team can start fully `serializable` (a well-scheduled merge queue) and loosen path by path.
5. **Demo a race, not a tour.** The same tasks run on the same engine twice: once preset as a good batched merge queue, once as Gitstalk. Score only verified changes reaching green per hour and agent-minutes spent waiting, because fast-trunk landings would win trivially. If Gitstalk doesn't win on green throughput, the thesis is wrong; find out on day 2.
6. **Jev picks; it doesn't generate.** It is ideal for type-ahead routing (about 300 ms, fractions of a cent) over a fixed map and a catalog that grows through review. Keep a fallback router.
7. **Actions YAML can run unchanged for most Linux jobs.** The cost is rebuilding GitHub's server side, a Docker host-network shim, a `*.localhost` shim for artifacts v4, and a new OIDC issuer. macOS, Windows, arm64 and GPU jobs need bring-your-own runners. Actions Doctor sets expectations before migration.
8. **Artifacts' per-repo tokens become branch protection.** Agents only ever hold fork tokens; trunk, green and governance tokens never leave Gitstalk's own services.
9. **Prevent the GitLost class by construction:** session taint enforces the Rule of Two, and every public incident becomes a regression test.
10. **Previews should be MCP verbs:** ensure, http, browse, compare against green, logs, attest. They need isolated, seeded data, because Cloudflare's Worker Previews share D1, KV, R2 and Queues with production by default.

## Before anything else

The rules require the entrant to be a **legal resident of the US or Canada**, and the winner must attend in person in San Francisco on 10-21. See `07` §3, decision 1.

## Method notes

- **Reddit couldn't be reached** (403s, no Exa index, and the archive mirror refused agents). Reddit sentiment is second-hand and marked. Hacker News threads were read comment by comment through the Algolia API.
- **Labels:** facts carry links; estimates are labelled *illustrative*; vendor numbers are marked.
- **Not in the repo:** raw search output stayed in the session scratchpad. Only the curated research memos are here.
