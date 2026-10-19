# Roadmap

What is left to build in Gitstalk, as of 2026-10-15. It is drawn from the phased backlog in [`docs/claude-opus/16-product-backlog.md`](docs/claude-opus/16-product-backlog.md) §4, checked against the code on `main`. Each item links its design document when one exists.

**To take an item,** open a proposal pull request ([`CONTRIBUTING.md`](CONTRIBUTING.md#proposing-a-change)), even when a design document exists: the proposal says what you will build and how. Small fixes in the last section can go straight to a pull request. Work outside this list is welcome too.

Keep this file current: a pull request that finishes or starts an item updates its row.

| Section | What is in it |
|---|---|
| [Partly built](#partly-built) | Shipped in part; the rest is open |
| [Not started](#not-started) | No code yet, with or without a design |
| [Small follow-ups](#small-follow-ups) | Fixes and clean-ups, good first contributions |
| [Owner tasks](#owner-tasks) | Accounts, domains and decisions only Coop can do |
| [Done](#done) | What exists, and where it is documented |

## Partly built

| Area | Built | Open | Docs |
|---|---|---|---|
| **Decision cards over MCP and on the web** | Cards are raised by the engine and approval rules; held beans are approved on the web and by `bean_approve` | `decision_request` and the card tools over MCP; answering cards on the web; a grantable scope so agents may answer (backlog 2.5, 2.7) | [`22`](docs/claude-opus/22-collaborators.md) §6, [`23`](docs/claude-opus/23-mcp-repository-tools.md), [`32`](docs/claude-opus/32-approval-rules.md) |
| **Live Ask at product speed** | Per-request memoisation and a read index in the run's Durable Object | D1 FTS5 term index, an answer cache keyed by sprout sha, measured against 2 s live and 300 ms repeated (backlog 2.8) | [`13`](docs/claude-opus/13-ask-explorer-design.md), [`14`](docs/claude-opus/14-repository-experience.md) §11 |
| **Checks for more languages** | `.gitstalk/checks.yml` with Node checks on the exact merged tree | Images for other languages; an install step and dependency cache for checks; the `required:` key; serving the JSON Schema URL | [`24`](docs/claude-opus/24-checks-config.md) §1, §6 |
| **Organizations** | Orgs with roles, invite by handle, base permission, internal visibility, transfer | Teams; email invitations; org handle rename; repository search; an org-wide people and sessions view (backlog 3.1, 3.2) | [`28`](docs/claude-opus/28-organizations.md) §6–7 |
| **Audit log** | Identity, repository and org access logs | Export; the full `sub`/`act` actor chain; linking the agent session (backlog 3.5) | [`32`](docs/claude-opus/32-approval-rules.md) §8, [`28`](docs/claude-opus/28-organizations.md) |
| **Automations** | `.gitstalk/automations/*.yml` compiled to Actions jobs; event, schedule and manual triggers; per-run and monthly spend caps; visual builder | `repository_dispatch` and email-in triggers; MCP connections and Gitstalk MCP tools inside runs; typed outputs beyond a bean (comments, cards, notifications, review receipts); run logs over MCP; harness choice; memory page (backlog 4.2–4.4, 4.7) | [`25`](docs/claude-opus/25-actions-and-automations.md) §7.11, §7.14 |
| **GitHub Actions compatibility** | Control plane, one container per job running act, live logs, OIDC, secrets and variables, dependency cache | `pull_request`, `merge_group`, `repository_dispatch`, `workflow_run`, `workflow_call`, tag pushes; `environment:` with approval cards; larger runners; a native step runner; cache v2 and artifacts v4 on R2; `GITHUB_STEP_SUMMARY`; a warm container pool | [`25`](docs/claude-opus/25-actions-and-automations.md) §6.2, [`26`](docs/claude-opus/26-actions-job-executor.md) §6, [`27`](docs/claude-opus/27-ci-dependency-cache.md) §11 |
| **Code search** | `repo_read` grep within one repository (no index) | Indexed search, then across repositories and semantic: the `CodeIndex`, FTS5, Vectorize and `repo_symbols` design | [`claude-15`](docs/claude-15-fast-reads-and-search-on-edge.md) |
| **Streaming changesets** | Built for races (`stream_diffs`, a `RunStreamDO` per run) | Repositories: the agent side reporting its edits; a direct browser-to-gateway WebSocket | [`claude-17`](docs/claude-17-streaming-diffs.md) |
| **Derived history** | Blame by bean (`why_lines`) and path history | "Why" in the web file view; `overlap_index`, `test_impact` and `symbol_index` derivers; lifting the 256-commit base | [`34`](docs/claude-opus/34-derived-data-and-blame.md) "Later" |
| **Repository UI speed** | TanStack Query, edge cache (Cache API and KV, private repositories in KV) | Code, History and the runs list still render on the server: move them to client queries; client `tree` and `file` queries; one shared SSE; a `repoSnapshot` RPC | [`35`](docs/claude-opus/35-caching.md) §9, §13.2 |
| **Engine at scale** | Continuous repository engine, sprout window, revert-first, pre-land sandbox pool | Compact engine state (2 MB value limit); free a red bean's slot while it waits; the error-budget controller; claim heartbeats; one fork per bean (blocked on Artifacts) | [`claude-18`](docs/claude-18-lessons-from-scion.md) §10, [`31`](docs/claude-opus/31-gateway-engine-internals.md) |
| **Optional test skipper** | Restricted JS/TS pre-land module selection, off by default; local paired runner replay | Broader adapters and a hosted agent replay before enabling; no deployment yet | [`09l`](docs/09l-optional-test-skipper.md), [benchmark](research/test-skipper/README.md) |
| **Forge-owned tests** | A test author with fail-first proof, off by default | A real race with the given tests hidden, then a default | [`31`](docs/claude-opus/31-gateway-engine-internals.md), [`11`](docs/claude-opus/11-experiments-summary.md) E1 |
| **Clef triage evaluation** | Clef routes approval triage; `scripts/clef-triage-eval.mjs` | A recorded live evaluation; comparison with human decisions | [`32`](docs/claude-opus/32-approval-rules.md) §8 |
| **Git over SSH** | Built and tested in `packages/ssh` | Public launch (Spectrum, see owner tasks); protocol v1 | [`21`](docs/claude-opus/21-git-over-ssh.md) |

## Not started

| Area | What it is | Docs |
|---|---|---|
| **Cloud agents (Phase 5)** | Run Claude Code, Codex or Gemini CLI in a Cloudflare Sandbox per session: start, stop and watch from the web and over MCP (`session_start`); your own provider keys, encrypted and called through AI Gateway; budgets per session, repository and org; agent automations on cloud sessions. The largest open area | Backlog 5.1–5.5, [`cloud-agents` public page](packages/site/public/docs/cloud-agents.html) (planned), [`17`](docs/claude-opus/17-cloud-agent-swarm.md) (a research rig, not this feature) |
| **Notifications and inbox** | Decisions asked of me, my bean fell off, red for N minutes; in app and by email with a daily digest; reply by email to decide (Email Routing). Settings → Notifications is a placeholder today | Backlog 3.3, [`29`](docs/claude-opus/29-settings.md) §7 |
| **Taint labels on MCP results** | Provenance labels on returned text; hidden Unicode and HTML comments stripped; the Rule of Two as a session-taint engine | Backlog 3.6, [`06`](docs/claude-opus/06-auth-mcp-live-previews.md) §3 |
| **Previews as MCP verbs** | `preview_ensure`, `_http`, `_browse`, `_compare`, `_logs` and `attest` on isolated, seeded data | Backlog phase 6, [`06`](docs/claude-opus/06-auth-mcp-live-previews.md) §5, [`claude-06`](docs/claude-06-identity-mcp-and-previews.md) |
| **Insights tab** | k-th green per day, waiting time, spend by person and session, rework and fall-off rates | Backlog phase 6; `repo_daily` in [`20`](docs/claude-opus/20-repositories.md) §4 holds the first counts |
| **`gitstalk` CLI** | Device-flow sign-in, a git credential helper, the same verbs as MCP | Backlog phase 6, [`claude-16`](docs/claude-16-checkout-protocol-and-live-edits.md) |
| **Live edits** | Tiers 1 and 2: an event stream under 1 s and `refs/wip` checkpoints | [`claude-16`](docs/claude-16-checkout-protocol-and-live-edits.md) |
| **GitHub mirror and PR export** | Optional, user-enabled two-way sync with another forge | Backlog phase 6 |
| **Dynamic Worker runner** | Actions steps in a Worker isolate instead of a container | [`25`](docs/claude-opus/25-actions-and-automations.md) §0.4, §3.9 |
| **Status page** | Public service status beside the existing `/admin` | Backlog phase 6 |
| **Greenhouse view** | A spatial view of the repository | [`14`](docs/claude-opus/14-repository-experience.md) concept B |
| **Runner egress allowlist** | Containers run with `enableInternet = true` today | [`31`](docs/claude-opus/31-gateway-engine-internals.md) |

## Small follow-ups

Good first contributions; most need no proposal.

- **Compressed pushes** are answered 415 (`packages/gateway/src/push/push-proxy.ts`).
- **`preview_url`** links to `/runs/<id>`, which is not found for non-admins ([`23`](docs/claude-opus/23-mcp-repository-tools.md) §4).
- **Flaky test:** `packages/gateway/test/bean-approval.test.ts` sometimes fails with "EnvironmentTeardownError: Closing rpc while resolve was pending".
- **Retire `RunIndex`:** tombstone the Durable Object class, drop its bindings, the backfill and `POST /v1/admin/runs/backfill` ([`31`](docs/claude-opus/31-gateway-engine-internals.md), "Retiring RunIndex" step 2).
- **Drop the empty `magic_links` table** ([`19`](docs/claude-opus/19-accounts-and-auth.md) §6.7).
- **SSH `sk-` keys:** [`19`](docs/claude-opus/19-accounts-and-auth.md) §9 says they are refused, [`21`](docs/claude-opus/21-git-over-ssh.md) says accepted; make code and docs agree.
- **Deleting a repository** leaves its per-run Actions Durable Objects ([`27`](docs/claude-opus/27-ci-dependency-cache.md) §10.8), and a half-made creation keeps its name reserved ([`24`](docs/claude-opus/24-checks-config.md) §6.7).
- **Repository Code tab:** a per-file "last change" column and syntax-highlighted diffs ([`20`](docs/claude-opus/20-repositories.md) §6).
- **Actions over MCP:** re-run only failed jobs; enable or disable a workflow ([`23`](docs/claude-opus/23-mcp-repository-tools.md) §5.5).
- **Per-repository social image** in `og:image` ([`29`](docs/claude-opus/29-settings.md) §7).
- **Index lag outliers** of 45–50 s on the repository event queue ([`20`](docs/claude-opus/20-repositories.md) §7).
- **Cursor and Gemini CLI** sign-up lines are untested end to end ([`19`](docs/claude-opus/19-accounts-and-auth.md) §10.2).

## Owner tasks

Not open to contributors; listed so nobody duplicates them.

- Turnstile and email sign-in switched on in production (needs the widget keys and a sender domain).
- SSH on port 22: the Spectrum Worker-target beta, a Pro zone, `SSH_HOST` and the host-key fingerprint ([`21`](docs/claude-opus/21-git-over-ssh.md), [`30`](docs/claude-opus/30-environments.md) §13.2).
- Automatic deploys from the private deploy repository: `CLOUDFLARE_API_TOKEN` and `GITSTALK_SECRETS_JSON` per environment, and the faster `upstream-main` trigger ([`30`](docs/claude-opus/30-environments.md) §13.7).
- Retire the old `beanstalk-*` stack and its workers.dev addresses; move repositories to a `gitstalk` org ([`30`](docs/claude-opus/30-environments.md) §12.3).
- Send the Artifacts team the asks A1–A7 and B1–B6 ([`claude-18`](docs/claude-18-lessons-from-scion.md)).

## Done

| Area | Docs |
|---|---|
| The engine: pre-land checks on the exact merged tree, the sprout window, revert-first, reconcile, dependency-aware starts; races and the published benchmark | [`31`](docs/claude-opus/31-gateway-engine-internals.md), [`11`](docs/claude-opus/11-experiments-summary.md), [`README`](README.md) |
| Accounts: passkeys, email codes, MCP OAuth for Claude Code and Codex, the plugin, Home, product analytics | [`19`](docs/claude-opus/19-accounts-and-auth.md) |
| Repositories: create, import public repositories, push to create, rename, archive, delete; tabs Code, Changes, History, Ask, People, Actions, Automations, Settings | [`20`](docs/claude-opus/20-repositories.md) |
| Git-native flow: push to `bean/<name>`, push options, status refs, verdicts in `remote:` lines | [`18`](docs/claude-opus/18-git-native-flow.md) |
| Collaborators, roles and visibility | [`22`](docs/claude-opus/22-collaborators.md) |
| Repository MCP tools and bean collaboration (`bean_context`, `bean_update`, threads, `work_overlaps`) | [`23`](docs/claude-opus/23-mcp-repository-tools.md), [`09e`](docs/09e-bean-collaboration-implementation.md) |
| Checks config | [`24`](docs/claude-opus/24-checks-config.md) |
| GitHub Actions and Automations | [`25`](docs/claude-opus/25-actions-and-automations.md), [`26`](docs/claude-opus/26-actions-job-executor.md), [`27`](docs/claude-opus/27-ci-dependency-cache.md) |
| Organizations | [`28`](docs/claude-opus/28-organizations.md) |
| Settings, profiles and avatars | [`29`](docs/claude-opus/29-settings.md) |
| Environments, self-hosting, staging and production deploys | [`30`](docs/claude-opus/30-environments.md), [self-hosting page](packages/site/public/docs/self-hosting.html) |
| Approval rules and held beans | [`32`](docs/claude-opus/32-approval-rules.md) |
| Server-side commits (`bean_commit`) | [`33`](docs/claude-opus/33-server-side-commits.md) |
| Blame by bean and path history | [`34`](docs/claude-opus/34-derived-data-and-blame.md) |
| Caching the repository UI | [`35`](docs/claude-opus/35-caching.md) |
| Public docs site | [`packages/site/public/docs/`](packages/site/public/docs/) |
