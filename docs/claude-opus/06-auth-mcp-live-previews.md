# Authentication, MCP tools and live previews of a branch

**The short version:**
- Agents are first-class principals that act *on behalf of* a human, never *as* one.
- Every agent token is scoped to one task, and structurally can't reach trunk, green or governance, because Artifacts tokens are per repo and agents only ever receive tokens for their own fork.
- The platform, not the prompt, enforces Meta's "Rule of Two." That is how the 2025–26 incidents (Invariant, CamoLeak, PromptPwnd, Comment and Control, the `[bot]` bypass, GitLost) are prevented by construction.
- The MCP surface is 15 task-shaped tools plus one code-mode tool. The same verbs ship as a CLI.
- A live branch can be previewed, browsed, compared with green and *attested* through MCP. No git host offers that natively today.

Sources for everything here are in `research/auth-mcp-and-previews.md`. `claude-06` and Codex `06` cover similar ground; this doc adds:
- the Artifacts token mapping;
- the session taint engine, with a GitLost walk-through;
- an incident regression suite;
- fixes for the isolation gaps in Cloudflare's Worker Previews.

---

## 1. Five principles

1. **Agents are principals.** There are distinct identities for a user, an org, an agent (harness + model + operator), an agent *instance* (one run) and a task. Trust never comes from a name; `claude-code-action` trusting anything ending in `[bot]` was a real exploit.
2. **Delegate, never impersonate.** Every agent token says who it acts for (`sub`) and who is acting (`act`, nested for sub-agents), following RFC 8693 delegation. Audit logs, the UI and commits show the chain. GitHub only added `actor_is_agent` to audit logs in February 2026; Beanstalk has it from day one.
3. **Capabilities per task, not personal access tokens.** A grant names repos, ref patterns, operations, data classes, a TTL and a budget. It is minted short-lived and bound to its audience (RFC 8707), and optionally bound to a key (DPoP or HTTP message signatures).
4. **The Rule of Two, enforced by the platform.** In one session an agent may have at most two of: *untrusted input*, *private data*, and *the ability to write externally*. GitLost showed that staging writes isn't enough when one session can do all three.
5. **Agents see what humans see.** Strip hidden Unicode, HTML comments, invisible markdown and remote image beacons from everything the API returns. CamoLeak and Comment and Control both hid instructions in content humans couldn't see.

## 2. Identity, tokens and Artifacts

```jsonc
// Beanstalk agent access token (JWT, about 15 min, refreshable within the task's lifetime)
{
  "iss": "https://beanstalk.dev", "aud": "https://beanstalk.dev/mcp",
  "sub": "user:coop",                                  // who it acts for
  "act": { "sub": "agent:claude-code/opus@coop-laptop#run-8f2",   // who is acting
           "act": { "sub": "agent:subagent/test-writer#run-8f2.3" } },
  "task": "task_418", "intent": "int_77",
  "repo": "acme/shop", "refs": ["forks/task_418/*"],   // push only to its own fork
  "ops": ["context.read", "change.submit", "preview.*", "decision.request", "marker.drop"],
  "data": ["repo:acme/shop"],                          // private data this session may read
  "budget": { "ci_minutes": 60, "artifact_ops": 5000, "usd": 3.00 },
  "cnf": { "jkt": "…" },                               // DPoP key thumbprint (optional)
  "exp": 1791000000
}
```

**Mapping onto Artifacts.** Artifacts tokens are per repo, with `read` or `write` scope and a TTL from 60 seconds to a year.
- **Agents get a fork token only.** When a task starts, Beanstalk forks the fast trunk into `forks/task_418` and mints a write token for *that fork*, with a TTL equal to the task's lifetime.
- **Trunk, green and the admin repo stay internal.** Their write tokens live only inside the committer, the promoter and the governance service.
- **An agent cannot push to main, force-push green or disable protections**, because it never holds a credential that could. That rules out the Claude Code #42849 class of incident by construction rather than by policy.
- **The token never reaches the model.** The agent's harness swaps a Beanstalk token for the Artifacts token through a Git proxy, the same pattern as `actions/checkout`. Artifacts ignores the Basic-auth username, so the swap is trivial.

**How agents and humans sign in:**

| Who | How | Notes |
|---|---|---|
| MCP clients (Claude Code, Codex, Cursor, VS Code) | OAuth 2.1 through `@cloudflare/workers-oauth-provider` (current to the MCP 2026-07-28 spec); Client ID Metadata Documents first, dynamic registration only for legacy clients; check `iss` and audience | The library has a 2025 CVE (`redirect_uri`) and an external review that found weaknesses. **Pin, fuzz and audit it** |
| CLI (`bean`) | Device flow | Same token shape |
| CI and servers | RFC 8693 token exchange: an OIDC token (Beanstalk's issuer, GitHub's, or a SPIFFE JWT-SVID) becomes a task token | No long-lived secrets |
| Enterprises | Enterprise-Managed Authorization / ID-JAG (Okta, Entra), stable in MCP since June 2026 | "Authorize once, inherit everywhere" |
| Agents calling previews | Delegated token through Access managed OAuth, or Web Bot Auth / HTTP signatures | No bypass secrets in URLs |
| Third-party credentials (deploy targets) | MCP URL-mode elicitation; credentials injected at container egress | The model never sees them |

## 3. Session taint: the Rule of Two as code

Every API and MCP response carries a **provenance label**: `maintainer`, `collaborator`, `external`, `anonymous`, `agent`, or `preview-content` (anything a running branch rendered). A Durable Object per session tracks three flags:

| Flag | Set when the session… |
|---|---|
| **U**, untrusted input | reads content labelled `external`, `anonymous` or `preview-content` from an untrusted branch (fork PRs, public issues, web pages) |
| **P**, private data | reads private content outside the task's own repo, or secrets-bearing data (logs from privileged jobs, environment config) |
| **W**, external write | posts publicly (comments on public repos, public issues), pushes to public repos, or makes non-allowlisted egress |

**Rule:** a session may hold at most two flags. A tool call that would set the third is **blocked**, or **queued for human approval** with a preview of exactly what would be written. The default per tool is configurable. Sessions start with one repo in scope; adding a second private repo sets **P** explicitly.

**GitLost, replayed against this rule:**
1. An agentic workflow is triggered by an issue in a public repo. It reads the issue body: **U**.
2. Steered by the text, it reads READMEs of the org's private repos: **P**. The session now holds U and P.
3. It tries `comment.create` on the public issue, which would set **W**. **Blocked.** A decision card shows the comment's text and its source data to a human.

GitHub's "safe outputs" design staged that comment as a reviewed write, and it still leaked, because the reviewer was another model and nothing tracked what the session had read. Beanstalk blocks on *what the session read*, not on what the write looks like.

### The incident regression suite

Encode each public incident as an automated test against Beanstalk's own MCP and API, and run it in CI:

| Test | Incident | Must hold |
|---|---|---|
| `toxic-flow` | Invariant, 2025-05 | An agent asked to "look at my issues" in a public repo can't publish private data |
| `camo-exfil` | CamoLeak, 2025-10 | No remote image fetch from content an agent renders; hidden markdown stripped |
| `pr-title-injection` | PromptPwnd / s1ngularity, 2025 | PR titles and bodies never reach a privileged job's prompt or shell unlabelled |
| `comment-and-control` | 2026-04 | Base64 or hidden-comment instructions in issues can't make a job print its secrets (jobs hold no secrets; credentials are injected at egress) |
| `bot-suffix-trust` | `claude-code-action`, 2026-06 | No authorization decision depends on an actor's display name |
| `gitlost` | 2026-07 | The U+P+W replay above is blocked |
| `governance-escape` | Claude Code #42849 | No agent token can change protections, isolation policy or tokens |

## 4. The MCP surface: small, task-shaped, code-mode friendly

GitHub's official MCP server loaded 101 tools (about 64.6k tokens) by default until October 2025. Cursor only passes 40 tools to the model. Beanstalk ships **15 tools plus `execute`** (the table below plus `attest` from §5.3), using the stateless 2026-07-28 MCP core (no sessions to pin, header routing), which fits Workers. Cloudflare's `McpAgent` class is deprecated, so use the handler APIs.

| Tool | What it does |
|---|---|
| `task_next` / `task_claim` | Get placed work from the scheduler, with its slice, footprint, repair ticket if any, and budget |
| `context_read` | File at SHA, symbol, references, search, merge base (logged to the read set; carries markers and "being modified by" notes) |
| `change_submit` | Mark the fork's head as done. The committer takes over |
| `bean_status` | Landed / suspect / repaired / in green, with evidence (was `change_status`) |
| `bean_status` with `checks: true` | Structured failures (file, line, test, message), not log dumps (was `checks_get`) |
| `preview_ensure`, `preview_http`, `preview_browse`, `preview_compare`, `preview_logs` | §5 |
| `decision_request` | Ask a human. It becomes a card on the canvas |
| `marker_drop` | Leave a decaying note on a symbol (idea #10) |
| `ask_repo` | Run a canvas view as JSON: the same query layer humans see (`04` §5.2) |
| `execute` | Code mode: the agent writes TypeScript against the full typed API, for the long tail |

**Built so far (2026-10-04, `packages/mcp`):** the read-only slice, stateless over `createMcpHandler`, behind a run-scoped view token the gateway verifies (`verifyViewToken`): `ask_repo`, `change_status`, `checks_get`, plus `work_overlaps` (beans in flight or recently landed on given paths, with their intents), `run_status` and `preview_link` (on 2026-10-14 merged into `bean_status` and `repo_status`, with the links in their answers; `23` §6). **Code mode (`execute`) is deferred: the owner tested it and judged it highly experimental**, so the surface stays plain task-shaped tools. `packages/claude-plugin` wires the server into Claude Code with a `beanstalk` skill.

**Rules:**
- Return **handles plus short summaries**. Screenshots, traces and logs go to R2, and the agent fetches them only if it needs them.
- Annotate tools honestly (`readOnlyHint`, `destructiveHint`), and treat annotations as claims, not guarantees.
- Report per-tool scopes in `scopes_supported`, and step scopes up through `insufficient_scope`.
- **Ship the same verbs as a CLI** (`bean task next`, `bean preview compare`), with JSON output. Shell-capable agents often prefer a CLI for its token cost. MCP's real advantage is keeping auth out of the model's context. Offer both and measure which agents use.

## 5. Live previews of a branch, as tools

### 5.1 Substrate

| App type | Preview mechanism |
|---|---|
| Workers apps | **Worker Previews** (shipped 2026-09-22, built for agent loops). Up to 500 previews per Worker on Paid, 100 deployments each; the least recently deployed is evicted. Two ways in: (1) Workers Builds builds non-`main` **branches of the connected repo**; (2) a build job runs `wrangler preview` directly. **A fresh Artifacts fork is not a connected repo, so it gets no automatic preview.** For a task fork, the preview service pushes the fork's head to `preview/<task>` on the connected repo (it holds that token; agents don't), or runs `wrangler preview` in a Container. Steward solved the same problem with `cand/` branches |
| Anything else (Node, Python, Rails…) | **Containers / Sandbox** with port previews served through the owning Durable Object on custom hostnames (Sandbox SDK 1.0) |
| Already on Vercel or Netlify | Ingest their deployment events through a deployments API, so agents find every preview the same way |

**Previews at swarm scale:**
- **Always warm:** previews for green and the fast trunk.
- **On demand:** per-task previews, only when the task's footprint touches UI or API routes, with LRU eviction and TTLs. 3,000 agents can't each own one; 500 per Worker is the cap.

### 5.2 Closing Cloudflare's isolation gaps

Worker Previews isolate Durable Objects and Containers automatically. They do **not** isolate:
- D1, KV, R2 and Queues, which **share production data** unless rebound;
- service bindings, Workflows, cron triggers and routes, which **call production**.

The data leak and the production calls are the most important things to fix.

```toml
# .beanstalk/preview.toml
[data]
d1 = { schema = "migrations/", seed = "seeds/demo.sql", seed_rng = 42 }   # fresh per preview, deterministic
kv = { seed = "seeds/kv.json" }
r2 = { copy_prefix = "fixtures/" }
[users]
test = [{ email = "alice@test", role = "admin" }, { email = "bob@test", role = "viewer" }]
[flows]                                   # what agents should verify
checkout = "e2e/checkout.spec.ts"
[health] path = "/healthz"
```

1. **Provision per-preview D1, KV, R2 and Queues automatically from the manifest**, with a deterministic seed. **Refuse** to bind a preview to production resources unless policy allows it.
2. **Compose dependent Workers.** If the app binds `auth-service`, deploy `auth-service`'s matching preview too and rebind it, so nothing silently calls production.
3. **Preview-scoped secrets only.** Fork and untrusted branches get no secrets, synthetic data and restricted egress.
4. **Cost guards.** TTL, idle teardown, a cap on Durable Object alarm rates (someone's runaway alarm loop cost $34k in 8 days), and a spending cap per preview.
5. **Protected by default.** Humans sign in through SSO with Access. Agents use delegated tokens (Access managed OAuth) or signed requests, never long-lived bypass secrets in query strings.
6. **An OAuth callback broker** at `auth.previews.<domain>` sends logins back to the right preview. That fixes the redirect-URI mismatch that breaks Google, Supabase and GitHub logins on preview URLs.

### 5.3 The preview tools

| Tool | Does | Returns |
|---|---|---|
| `preview_ensure(ref)` | Create or wake the preview for a fork, task, fast trunk or green, and wait until healthy (idempotent; the agent gets a ready event, not a polling loop) | URL, deployment ID, SHA, seed ID |
| `preview_http(ref, method, path, as)` | Server-side request through the auth wall as `anon`, a seeded user, or the agent | Status, headers, truncated body, timing, `traceId` |
| `preview_browse(ref, script, viewports)` | Run a Playwright script in Browser Run (200 concurrent browsers per account). One code-mode tool instead of 30 click tools | Screenshot, video and trace handles; console errors; failed requests; accessibility snapshot path |
| `preview_compare(base="green", head=ref, flows)` | **Behavior diff**: the same browser build, viewport, seed and clock on both sides. Pixel and DOM diff, new console errors, HTTP response diffs, performance deltas | A verdict per flow, plus artifact handles |
| `preview_logs(ref, traceId \| since)` | Per-preview logs and traces from Workers Observability | Structured events |

After a run, **`attest`** turns it into a signed **proof bundle** on the change: commit, deployment, scripts, artifact hashes and verdicts. Isolation policy can require a proof bundle for changes that touch flows listed in the manifest.

### 5.4 The loop, end to end

1. An agent finishes a checkout UI task and calls `change_submit`.
2. It calls `preview_ensure("forks/task_418")`. The preview service pushes the fork's head to `preview/task_418` on the connected repo, Workers Builds deploys it, and the agent gets a ready event.
3. It calls `preview_compare(base="green", head="forks/task_418", flows=["checkout"])`. The result: a pixel diff on the order summary, no new errors, and LCP +40 ms.
4. Taint check: preview content is `preview-content` from the agent's own branch, and is treated as untrusted if the branch came from outside.
5. It calls `attest`. The proof bundle attaches to the change, and the green-delta card shows *before / after / diff* side by side.
6. A human looks at a picture, not a diff, and approves or comments in place.

**Agents are weak judges of UX.** A ProofShot thread on HN put it bluntly: "coding agents are very bad at detecting UX issues." Proof bundles exist to make human review fast; they don't replace it. Visual diffs flake without fixed seeds, clocks and fonts, so the manifest pins all three.
