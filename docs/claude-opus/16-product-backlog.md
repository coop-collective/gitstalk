# The official product: scope, architecture and phased backlog

> **Decisions taken (Coop, 2026-10-06):**
> - **Automations connect through direct MCP only:** apps' own MCP servers, no Composio. Every Composio item in this plan is dropped.
> - **Licence (Coop, 2026-10-14):** Apache-2.0, as the competition rules require (`LICENSE`, `NOTICE`, `TRADEMARKS.md`). The repository was under FSL-1.1-ALv2 until then.
> - **Demo engine:** decided after the real races. v2.5 with dependency starts and the tail fix is racing now.
> - **Sign-up (Coop, 2026-10-07):** passkeys are the primary sign-up path; email magic links are built and tested but switched off and hidden until a sender domain is configured (`19-accounts-and-auth.md` §6).
> - **Name and domain:** decided 2026-10-10: the product is **Gitstalk** (the growing-beanstalk metaphor stays). "Beanstalk" collided with the existing Beanstalk git hosting service (beanstalkapp.com) and AWS Elastic Beanstalk, and beanstalk.ai was taken. Production will be gitstalk.io and staging gitstalk.dev; until they are set up the hosted service keeps its workers.dev addresses (`30-environments.md` §12).


Written 2026-10-06 for Coop, from the `prototype` branch. This is a plan, not a build: every phase is sized so a separate agent can take it. Names as before: a **bean** is one change (an agent's or a person's), the **sprout** is the staged line, the **stalk** is the stable line.

Inputs: `AGENTS.md`, `README.md`, this folder's `06`, `11`, `14` and `15`, `docs/claude-06-identity-mcp-and-previews.md`, `docs/github-repository-map/`, `packages/site/public/*.html`, the wrangler configs of every package, Cursor's Automations docs (fetched 2026-10-05) and Cloudflare's Email Service docs and limits page.

**Where we stand in one paragraph.** The engine is real and measured (v2.4 on Cloudflare: 37 of 40 green, 30th green at 8.9 min against the queue's 19.9). Everything around it is a race rig: a repository exists only inside a *run*, access is HMAC run tokens plus an admin token, the web app's only sign-in is `DEMO_PASSWORD`, the MCP server is read-only behind hand-minted view tokens, and the marketing site promises a one-line agent sign-up, Codex subscriptions, cloud agents and BYO keys, none of which exist. There is no D1 anywhere yet. The product backlog below turns runs into persistent repositories with people, sessions and automations, all on Cloudflare.

---

## Contents

1. Product scope and principles
2. Information architecture and key screens (wireframes)
3. Architecture: packages, services, data model, auth, runs to repositories
4. Phased backlog (Phase 0 = the 10-14 submission)
5. Risks and open decisions for Coop
6. The first three build tasks
- Appendix A: marketing promises against the backlog
- Appendix B: Cloudflare product map
- Appendix C: Cursor Automations, what we take and what we change

---

## 1. Product scope and principles

**What Gitstalk is:** a git forge where a team's coding agents (local or cloud, any harness) land work on one codebase without queueing, and people decide what the product means. The official app is the place a person signs up (usually through their agent), creates or imports a repository, connects sessions, answers decision cards, and sets up automations that feed work in.

**Principles** (each one is a test a design or PR must pass):

| # | Principle | What it means in practice |
|---|---|---|
| P1 | **Agent-first** | The main way in is pasting one command into an agent. Every human action has an MCP verb (and later a CLI verb) with the same name and the same result. A screen that only a browser can drive is a bug, except consent and decisions. |
| P2 | **Humans decide meaning** | Agents do mechanics: landing, rework, reconcile, revert. People get decision cards, never diff queues. Merging to the stalk is never an agent capability (`AGENTS.md`). |
| P3 | **Cloudflare-only** | Compute, storage, auth, email, queues, scheduling, AI routing, observability, analytics and previews all run on Cloudflare products (Appendix B). No Auth0, Clerk, Resend, Postgres, PostHog-as-our-analytics, Sentry-as-our-errors, Vercel or GitHub as a dependency. Open-source libraries running inside a Worker are fine; a third-party *service* in the request path is not. The one sanctioned exception is **Composio**, and only as an optional, org-enabled integration broker for Automations (§3.6). User-supplied model providers (Anthropic, OpenAI, Google, xAI) are the user's choice, routed through AI Gateway, never our dependency. |
| P4 | **Code computes, Jev picks, nothing writes layout** | Kept from `14`. Jev (via Workers AI and AI Gateway) only classifies and orders candidates that code produced; every pick has a receipt; rules answer when Jev is slow or offline. |
| P5 | **Delegate, never impersonate** | Every agent is a session principal acting for a person (`sub` plus `act`). The UI says "a6, Claude Code session of coop", never "12 agents". |
| P6 | **Measured, not projected** | Every number on the site and in the app is computed from recorded data; predictions are drawn differently (dashed) and labelled. |
| P7 | **Clean code** | `AGENTS.md` stack and rules: pnpm workspace, Hono in `WorkerEntrypoint`, RPC over service bindings, generated `Env`, vitest with real Miniflare bindings, structured logs, `pnpm check` green. |

**Out of scope for the product** (until a phase says otherwise): wiki, discussions, releases and packages, security alerts, GitHub Actions compatibility, a marketplace, billing. A GitHub mirror and PR export are Phase 6 options, not dependencies.

---

## 2. Information architecture and key screens

### 2.1 The map

```
gitstalk.io
├── /                         signed out: marketing (today's packages/site)  │ signed in: Home
├── /signup  /signup/agent  /signup/human      (agent-first: paste one command)
├── /login                    email magic link, passkey
├── /connect                  OAuth consent for an agent session (MCP) and device codes
├── /new                      new repository: empty, import from a git URL, or start from the demo
├── /inbox                    decisions and asks waiting on me, across repositories
├── /settings                 me: profile, emails, passkeys, connected sessions, provider keys, notifications
├── /races                    benchmark runs (today's /runs/:run and /race live here)
├── /:org                     org home: repositories, people, teams, sessions
│   ├── /-/people  /-/teams  /-/sessions  /-/connections  /-/settings
│   └── /:repo                repository shell with tabs:
│       ├── Code          (default) the stalk on the left, the generated explorer + Ask on the right; files are detail views
│       ├── Beans         in flight, landed, fell off; filter by person, session, area; a bean's journey
│       ├── Stalk         the line's history: landings, validations, promotions, reverts; the engine view for developers
│       ├── Decisions     open cards first (who must answer), then decided, with both specs and the outcome
│       ├── Checks        pre-land checks and validations, red stories with culprit and time to green; check config
│       ├── Insights      throughput (kth green), where time went, spend by person and session, rework rates
│       ├── Automations   triggers → tools → outputs; runs and their outputs
│       └── Settings      general, access, engine policy (window, isolation), checks, sessions policy, danger zone
└── /:org/:repo/beans/:bean · /files/:ref/*path · /decisions/:id · /checks/:id · /automations/:id
```

Changes against today's app (`14` §11): **Files folds into Code** as a detail view (the brief's "Code with the stalk plus the generated explorer"); the **Engine** tab becomes the developer view inside **Stalk**; **Insights**, **Automations** and **Settings** are new; `/runs/:run` stays reachable under `/races` and as "Benchmark runs".

Who sees what: Viewer (read), Member (read, connect sessions, open beans, answer cards they own), Admin (settings, automations with external writes, invites), Owner (danger zone, org deletion). Sessions inherit at most their owner's role, narrowed by the grant chosen on the consent screen.

### 2.2 Onboarding: agent-first

```
 marketing /                       agent pastes one line                      browser opens /connect
┌──────────────────────────┐   ┌──────────────────────────────────┐   ┌────────────────────────────────────┐
│ Run a swarm of coding    │   │ $ claude plugin marketplace add … │   │ Connect Claude Code to Gitstalk   │
│ agents on one codebase.  │──▶│   && claude plugin install …      │──▶│ (no account yet)                   │
│ [Sign up with agent] ◀── │   │   && claude mcp login plugin:…    │   │ Email [ you@team.dev        ]      │
│ [Sign up as human]       │   │ ✓ plugin installed                │   │ [Turnstile]   [Send sign-in link]  │
└──────────────────────────┘   │ ↗ opening browser to sign in…     │   └──────────────┬─────────────────────┘
                               └──────────────────────────────────┘                  │ magic link (Email Service)
                                                                                      ▼
┌──────────────────────────────────────────────┐   ┌───────────────────────────────────────────────┐
│ Allow "Claude Code on coop-laptop" to act    │   │ You're in. Your agent is connected.           │
│ for you?                                     │   │ Back in your terminal, try:                    │
│  • read your repositories                    │   │   "put this project on gitstalk"               │
│  • open and submit beans                     │──▶│   "what changed on coupons yesterday?"         │
│  • never land on the stalk or change settings│   │ Or: [Import a repo] [Open the demo repository] │
│ Handle [coop]  Org [coop (personal)]         │   │ Add a passkey for next time  [Add passkey]     │
│ Scope: (•) all my repos  ( ) pick…  [Allow]  │   └───────────────────────────────────────────────┘
└──────────────────────────────────────────────┘
```

- The OAuth flow **is** the sign-up: no account means the consent page first asks for an email, creates the user and a personal org, then grants the session. That makes "That's the whole sign-up" true.
- Human sign-up is the same page without the agent half: email → magic link → Home with "Connect your first agent" as step one.
- Codex, Cursor, Gemini CLI and any MCP client get the same flow through their own MCP-login command; `/signup/agent` shows the command per harness.

### 2.3 Home after sign-up (signed-in `/`)

```
┌ gitstalk   [⌘K Ask across your repos…]                        Inbox ●2   coop ▾ ┐
│                                                                                    │
│  Two decisions need you, and billing has been red for 6 minutes.   ● picked        │  ← lead sentence (Jev picks
│                                                                                    │     which computed fact leads)
│ ┌ Needs you ─────────────────────────────┐ ┌ Growing now ──────────────────────┐   │
│ │ D014 acme/shop  Totals with shipping?  │ │ acme/shop   ●●●○ 4 beans, 3 sess. │   │
│ │   two specs · asked 4 min ago [Decide] │ │ coop/notes  ○    1 bean checking   │   │
│ │ D015 acme/shop  Currency rounding      │ │ acme/api    —    nothing growing   │   │
│ │ R007 acme/shop  red since #212 [Story] │ └───────────────────────────────────┘   │
│ └────────────────────────────────────────┘ ┌ Your sessions ─────────────────────┐  │
│ ┌ Repositories ──────────── [New] ───────┐ │ a6 Claude Code · coop-laptop  writing│ │
│ │ acme/shop   stalk #208  ▁▃▅▇ 31 today  │ │ c2 Codex · cloud           reworking │ │
│ │ acme/api    stalk #97   ▁▁▂  4 today   │ │ [Connect another agent]             │ │
│ │ coop/notes  stalk #12   ▁    1 today   │ └─────────────────────────────────────┘ │
│ └────────────────────────────────────────┘ ┌ Automations ───────────────────────┐  │
│ ┌ What happened ─────────────────────────┐ │ PostHog bugs → beans  ran 09:00,   │  │
│ │ 31 beans reached acme/shop's stalk …   │ │   opened 3 beans                    │  │
│ │ Automation opened 3 beans from PostHog │ └─────────────────────────────────────┘ │
│ └────────────────────────────────────────┘                                          │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Empty state (first visit): the "Needs you" column becomes a three-step checklist (connect an agent ✓, create or import a repo, invite a teammate), and "Repositories" offers the demo repository (`beanstalk-shop` replay) so the first minute shows the product working.

### 2.4 Repository shell and the Code tab

```
┌ gitstalk   acme / shop  ☆  private                  [⌘K Ask the beanstalk…]   Inbox ●2  coop ▾ ┐
│ Code  Beans 4  Stalk  Decisions ●2  Checks ●1  Insights  Automations  Settings                 │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ sprout #212 ● red · stalk #208 · window 6/16 · 3 people, 5 sessions active · live ●  14:02      │ ← status line
├───────────────────────────────┬────────────────────────────────────────────────────────────────┤
│ THE STALK                     │  billing has been red for 6 minutes: coupon-cap.test.ts        │
│  tip ○ t044 a6 writing        │  [What changed on coupons?] [Why red?] [Who's on billing?]     │
│      ◐ t045 c2 checking       │ ─────────────────────────────────────────────────────────────  │
│  ─ sprout ─────────────       │  Growing now  │ What happened │ Files                          │
│  🌱 #212 t041 Coupons cap  ✗  │  t044 a6 (coop)  billing/coupons.ts  writing  ⟳ streaming     │
│  🌱 #211 t039 Tracking mail   │  t045 c2 (dana)  billing/tax.ts      pre-land check ▓▓▓░       │
│  ─ stalk ──────────────       │                                                                │
│  🍃 #208 t038 …               │  Files   billing/ ●2 in flight   cart/   orders/   users/      │
│  🍃 #207 …   (40 folded)      │   README.md  · last bean t031 "Docs for coupons"               │
│  ◒ Fertilized by coop         │                                                                │
│ ▶ ▮▮ ▮ ▮▮▮ ▮ ─────────●  now  │                                                                │
└───────────────────────────────┴────────────────────────────────────────────────────────────────┘
 Clone: git clone https://gitstalk.io/acme/shop.git   (credential: bean CLI or session token)
```

This is today's Nightshift home (`14` §11) with three product changes: real repository identity (`acme/shop`), real people and sessions in the status line, and a clone affordance. Other tabs reuse the same shell: **Beans** is the explorer opened on a filterable list with the journey as detail; **Decisions** and **Checks** lead with what's open and who must act; **Stalk** is the line's history plus the engine view; **Insights** is the race metrics generalised to a living repo (kth green per day, waiting time, spend per person and session, rework rate, Jev vs rules agreement).

### 2.5 The Automations tab

List view:

```
┌ acme / shop · Automations                                                   [New automation] ┐
│ Templates: [PostHog errors → beans] [Sentry issue → bean] [Daily stalk digest → email]        │
│            [Red for 30 min → page owner] [Webhook → bean] [Email bugs@ → bean]                │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ● PostHog errors → beans      every hour · PostHog (via Composio)   last: 09:00 ✓ 3 beans    │
│ ● Decision waiting > 2h → email   event: decision.opened            last: 08:12 ✓ 1 email    │
│ ○ Weekly insight digest       Mondays 08:00 · paused                 last: —                  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Editor (one screen, top to bottom, the same shape as the MCP verb `automation_create`):

```
┌ PostHog errors → beans ─────────────────────────────────────────────────── [Run now] [Save] ┐
│ WHEN   (any of)                                                                              │
│   [⏱ Schedule  every hour ▾ / cron 0 * * * *]                                               │
│   [+ Webhook] [+ Gitstalk event ▾ bean.landed · red · decision.opened · stalk.moved]        │
│   [+ App event ▾ (Composio trigger: posthog.error_tracking.issue_created)] [+ Email to …@]    │
│ USING  tools                                                                                 │
│   PostHog · error_tracking_list_issues, error_tracking_get_issue   connection: acme (Dana) ✓ │
│   [+ Add tool]  source: ( ) Direct MCP server  (•) Composio                                  │
│ DO     (•) Recipe  ( ) Agent                                                                 │
│   For each issue with status "active" and occurrences ≥ 5 in the last 24 h                   │
│   not already linked to a bean (dedupe key: posthog issue id)                                │
│   → Jev classifies: bug | noise | duplicate-of-open-bean   (receipt kept)                    │
│   → if bug: create bean  intent: "{title}: {summary}", area guess: {top frame path}          │
│ OUTPUTS allowed                                                                              │
│   [✓ Create bean (queued, unassigned)] [✓ Comment on bean] [ ] Decision card                 │
│   [ ] Notify email   [ ] External write (Slack, Linear…) → needs approval each time          │
│ RUN AS   (•) Me (coop)  ( ) Org service principal (admins)     Budget  $0.50 / run · 20 / day │
│ VISIBLE  ( ) Only me  (•) Members can view  ( ) Members can edit                             │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Runs  09:00 ✓ 41 issues read · 3 bugs · 3 beans opened (t051 t052 t053) · 2.1 s · $0.002 ▸   │
│       08:00 ✓ 38 issues read · 0 new                                               ▸        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

The design is in §3.6.

---

## 3. The architecture

### 3.1 Packages and services (target)

```
                       ┌─────────────── one zone: gitstalk.io ───────────────┐
 browser ──────────────▶  beanstalk-web (vinext)  ── marketing (static, from site) + app
 Claude Code / Codex /  │        │ RPC                                                  │
 Cursor / Gemini CLI ───▶  beanstalk-mcp  (OAuthProvider wraps /mcp; /authorize → web)  │
 git clone/push ────────▶  beanstalk-gateway  /git/*  (proxy → Artifacts)               │
 webhooks ──────────────▶  beanstalk-automations  /hooks/*                              │
 inbound mail ──────────▶  Email Routing → beanstalk-automations email()                │
                       └───────────────────────────────────────────────────────────────┘
       service-binding RPC between all of them; nothing calls another Worker over HTTP

 beanstalk-identity     users, orgs, teams, memberships, web sessions, magic links, passkeys,
                        session principals, grants, provider keys (encrypted), audit.  D1 identity, KV (OAuth store),
                        Email Service (send), Turnstile, Rate Limiting binding, Secrets Store (KEK)
 beanstalk-gateway      RepoDO per repository (engine + line + beans + checks + decisions),
                        RaceDO (today's RunDO, kept for benchmarks), git proxy, Runner containers,
                        Artifacts, D1 forge (cross-repo index), Queues (repo events out, Artifacts events in), R2 (event archive, blobs cache)
 beanstalk-mcp          MCP server (createMcpHandler) + @cloudflare/workers-oauth-provider; tools call gateway/identity/automations by RPC
 beanstalk-web          vinext app; reads by RPC; SSE/WebSocket bridge to RepoDO live feed; AI binding for Jev picks
 beanstalk-automations  AutomationDO per automation (schedule alarms, dedupe keys, run history), Workflows (one instance per run),
                        connectors: direct MCP (Agents SDK MCP client) and Composio; Queue consumer for repo events; R2 run logs
 beanstalk-notify       Queue consumer: in-app inbox rows + email digests and alerts via Email Service (small; may fold into identity)
 beanstalk-agents       (Phase 5) cloud sessions: one Sandbox per session running Claude Code / Codex / Gemini CLI; AI Gateway for model calls
 beanstalk-site         stays as the static marketing source until web serves it; then retired or kept as an asset package
 packages/gateway/container        Rust container (unchanged role: squash, check on the exact tree, compose, revert)
 packages/shared-*      shared-race → shared-forge (repo, bean, event, RPC contracts); new shared-auth (principals, scopes, token claims)
 packages/cli           (Phase 6) `bean` CLI: device flow, git credential helper, same verbs as MCP
```

**Why these boundaries.** Identity is its own Worker so the MCP Worker, web and gateway all ask one place "who is this and what may they do", and so its D1 and secrets have one owner. The gateway stays the data plane (git, engine, runner) because those three share the per-repo Durable Object. Automations is separate because it holds third-party connections and untrusted input (session taint, `06` §3): keeping it out of the gateway keeps the blast radius small.

**Domain.** One zone, one origin for web, MCP and git, so the session cookie is `__Host-` scoped and the OAuth `/authorize` page shares it. Routes: `/mcp*` and `/authorize|/token|/register|/.well-known/oauth-*` → mcp Worker; `/*.git/*` → gateway; `/hooks/*` → automations; everything else → web. Needs a domain on the account (decision D3).

### 3.2 Data model

Authoritative state for one repository stays in its **RepoDO's SQLite** (the engine already works this way per run). **D1** holds identity and the cross-repo indexes that lists, dashboards, search and permissions need. Rows flow from RepoDO to D1 through a Queue, so D1 is never on the landing hot path.

**D1 `identity`** (owned by `beanstalk-identity`):

| Table | Key columns |
|---|---|
| `users` | id, primary_email, handle (unique), name, avatar_r2_key, created_at, disabled_at |
| `user_emails` | user_id, email, verified_at |
| `passkeys` | credential_id, user_id, public_key, sign_count, transports, name, created_at, last_used_at |
| `magic_links` | token_hash, email, purpose (login, signup, invite, oauth_continue), redirect, expires_at, used_at, ip_hash |
| `web_sessions` | id_hash, user_id, created_at, expires_at, last_seen_at, user_agent, revoked_at |
| `orgs` | id, slug (unique, shared namespace with handles), name, kind (personal, team), created_by |
| `memberships` | org_id, user_id, role (owner, admin, member, viewer) |
| `teams`, `team_members` | id, org_id, slug, name · team_id, user_id |
| `invites` | id, org_id, email, role, team_id, token_hash, invited_by, expires_at, accepted_at |
| `session_principals` | id (`s_…`), owner_user_id, harness (claude-code, codex, cursor, gemini-cli, other), model, host (local, cloud), label ("coop-laptop"), oauth_client_id, grant_scope_json, created_at, last_seen_at, revoked_at |
| `provider_keys` | id, owner (user or org), provider (anthropic, openai, google, xai), ciphertext, kek_version, last4, created_at |
| `audit_events` | id, at, actor_user_id, actor_session_id, org_id, repo_id, action, target, ip_hash, detail_json (archived to R2 monthly) |
| `waitlist` | email, source, created_at, confirmed_at (Phase 0, folded into users later) |

OAuth clients, grants and tokens live in **KV** because `workers-oauth-provider` stores them there (`OAUTH_KV`); the grant's `props` carry `{ userId, sessionPrincipalId, orgScope, repoScope, ops }`.

**D1 `forge`** (owned by `beanstalk-gateway`):

| Table | Key columns |
|---|---|
| `repos` | id, org_id, name, visibility (private, internal, public), artifacts_name, default_line (stalk), created_by, created_at, archived_at, settings_json (engine policy, checks, sessions policy) |
| `repo_access` | repo_id, principal (user, team), role |
| `beans` (index) | repo_id, bean_id, intent, state, owner_user_id, session_id, source (session, automation, human), opened_at, landed_idx, promoted_at, fell_off_reason |
| `decisions` (index) | repo_id, id, state, asked_of (user ids), asked_at, decided_by, decided_at |
| `repo_daily` | repo_id, day, landed, promoted, red_validations, reworks, spend_usd (Insights rollups) |
| `term_index` | repo_id, ref_sha, path, token (FTS5 virtual table; the live-Ask fix from `14` §11) |
| `races` | today's RunIndex rows, moved here |

**RepoDO SQLite** (one per repository; today's RunDO tables generalised): `events` (append-only, compacted; older segments to R2 by day), `line` (sprout and stalk entries), `beans`, `invocations`, `checks`, `tickets` (red validations), `decisions`, `sessions_present` (heartbeats), `footprints`, `read_sets`, `settings`, `progress_snapshots` (ephemeral streaming diffs).

**AutomationDO SQLite** (one per automation): `definition` (versioned), `runs` (id, trigger, started_at, status, cost, output summary), `dedupe` (external_key → bean_id, first_seen), `connections_used`. Run logs and tool payloads go to R2 (`automations/<id>/<run>.jsonl`), short summaries in SQLite.

**Analytics Engine** datasets: `product_events` (sign-up, connect, repo created, bean opened, decision answered, automation run) and `engine_metrics` (per-landing latencies). This replaces any third-party product analytics.

### 3.3 Auth design

**Humans.**
- **Email magic link** through Cloudflare **Email Service** (`send_email` binding on `beanstalk-identity`, from `signin@<domain>`). A 32-byte token, stored hashed in D1, single use, 15 minutes, bound to the browser that asked (a short-lived pre-auth cookie), so a forwarded link can't sign in someone else's browser. Requests are gated by **Turnstile** and the **Rate Limiting** binding (per email and per IP). A six-digit code is shown alongside the link for people who read mail on another device.
- **Passkeys** (WebAuthn) as the second sign-in method once a user exists. Cloudflare has no hosted passkey product; the Worker verifies assertions with WebCrypto (ES256, RS256) through an open-source library such as `@simplewebauthn/server`. That is a library, not a service, so it keeps P3. Recommended from Phase 1 as "add a passkey" after first sign-in; magic link stays the recovery path.
- **Web session:** opaque random id in a `__Host-bs_session` cookie (HttpOnly, Secure, SameSite=Lax), the hash in D1 `web_sessions`, 30 days sliding. D1 read replication keeps the lookup local; revocation is a row update. No JWT in the browser.
- **Access** is used only for the internal admin console (`/admin`, operators) and later for protecting previews. Not for customers.

**Agents (MCP).**
- `beanstalk-mcp` wraps its handler in **`@cloudflare/workers-oauth-provider`** (OAuth 2.1, PKCE, Client ID Metadata Documents first, dynamic client registration for older clients, `/.well-known/oauth-protected-resource`). `06` §2 warns the library had a 2025 `redirect_uri` CVE: pin the version, add redirect-URI fuzz tests, and review before launch.
- `/authorize` renders the consent page from §2.2. If the browser has no web session it runs the magic-link sign-up inline and comes back. On approval identity creates a `session_principals` row (harness and label from the client metadata, editable) and the grant's `props` carry the principal. Access tokens are short-lived (15 min) with refresh, audience-bound to `/mcp`.
- Scopes, aligned with `06` §4: `repo:read`, `bean:write` (open, submit, rework its own beans), `decision:request`, `preview:*` (later), `automation:write` (admins only). Never `stalk:write` or `settings:write`: those are not grantable to sessions at all.
- `claude mcp login plugin:gitstalk:gitstalk` (Claude Code), Codex's, Cursor's and Gemini CLI's MCP OAuth flows all hit the same endpoints. The plugin's `.mcp.json` drops the `Authorization: Bearer ${GITSTALK_TOKEN}` header (that header disables OAuth fallback in some clients). Race view tokens keep working on a separate path for benchmarks.

**Git.** Agents and people push over smart HTTP to the gateway proxy, which already swaps a Gitstalk credential for a short-lived Artifacts token server-side (agents never hold Artifacts tokens). The credential becomes a **bean-scoped git token** minted by identity for a session principal: push only to `refs/heads/beans/<id>` the session owns, read the repo, TTL one hour. Two ways to get it:
1. **Phase 2:** MCP tool `bean_open` returns the remote URL and configures nothing; the plugin's skill runs a tiny credential helper script that calls a local MCP-authenticated endpoint. Fallback: the tool returns a one-hour token. *Trade-off:* a token in the model's context. It is push-only to one bean and short-lived, so acceptable for Phase 2, flagged.
2. **Phase 6:** `bean` CLI as a git credential helper (`git config credential.helper bean`), device flow, tokens in the OS keychain. Nothing in the model's context.

People push with a personal token from Settings (scoped like a session, labelled "human").

**Provider keys (BYOA, Phase 5).** Anthropic, OpenAI, Google and xAI keys are envelope-encrypted: a data key per row, wrapped by a KEK in **Secrets Store**, ciphertext in D1. Keys are decrypted only inside `beanstalk-agents` at session start and sent per request through **AI Gateway** (logging, rate limits, spend caps). They never reach the browser or MCP responses.

**Authorization checks** live in one place: `identity.authorize(principal, action, resource)` over RPC, with a per-request cache. The gateway's existing `git-access.ts` rules (push only to your bean, no deletes, no `sprout`/`stalk`) stay and gain the principal check.

**Session taint (Rule of Two).** A SQLite DO per session principal tracks U, P, W flags (`06` §3). Phase 2 ships the labels on returned text; Phase 4 enforces it for automations, which are the first place untrusted external input meets private data and external writes.

### 3.4 How runs become persistent repositories

| Today (race) | Product (repository) |
|---|---|
| `POST /v1/runs` creates `race-<run>` in namespace `beanstalk-race`, seeds `sprout`/`stalk`, starts a fixed task list, ends, is reaped | `POST repos.create` creates Artifacts repo `r-<repoId>` in namespace `beanstalk` (empty, from an import URL via Artifacts `.import()`, or forked from the demo template), seeds `stalk` = `sprout` = default branch, and never ends |
| RunDO keyed by run id; one `RunConfig` | **RepoDO** keyed by repo id; `RunConfig` splits into repo settings (policy, window, checks, isolation) and per-bean options |
| Tasks come from the arena and the driver's long poll | Beans come from sessions (`bean_open {intent}`), placed work (`task_next`), people (web "New bean"), and automations |
| Agent "done" = the driver posts an invocation result | `change_submit {bean}` over MCP (or a push with `Gitstalk-Submit: true` trailer later) marks the bean's head ready; the engine takes over exactly as now |
| Rework = the driver resumes the session | Rework = `bean_status` returns `next: rework` with the ticket; the connected session picks it up (the plugin's skill already polls). Cloud sessions are resumed by `beanstalk-agents` |
| Checks = the arena's test command, emulated CI | Checks from `.gitstalk/checks.toml` in the repo (command, image, timeout, protected paths), run in the Runner container on the exact merged tree |
| Decision cards to `DEMO_PASSWORD` holders | Cards routed to the owners of the clashing specs (the people whose sessions opened the beans), then repo admins; answered in web, inbox, or email reply (Email Routing) |
| `events.jsonl` per run | `events` table per repo, compacted; daily segments in R2; races still export `events.jsonl` byte-for-byte so `research/race` tools keep working |
| Reaped after the run | Repos live until deleted; idle RepoDOs hibernate; races keep their reap and spend guard |

**Races stay.** A race is a benchmark that creates a throwaway repository from a template and drives it with the harness. `RaceDO` (today's RunDO) stays for reproducibility and the marketing numbers, and the race views move under `/races`. The product engine is the same code path with the race-only parts (arena, slots, replay agents) behind an adapter.

**Continuous engine changes** (the real work in Phase 2): an open-ended task set (no "done"), idle hibernation with alarms, heartbeats for sessions so a vanished session's bean is released after a timeout, per-repo concurrency limits, and an upgrade path for settings while beans are in flight.

### 3.5 Agents: BYOA

| Kind | How it joins | What we run | Phase |
|---|---|---|---|
| **Local session** (Claude Code, Codex, Cursor, Gemini CLI, any MCP client) | The plugin or an MCP config + OAuth login | Nothing: the person's own harness, plan and keys. **Codex with a ChatGPT subscription works here** with no API key, which makes the site's "Connect Codex" claim true for local sessions | 1–2 |
| **Cloud session** (Claude Code, Codex CLI, Gemini CLI headless) | "Start a cloud session" in web or `session_start` over MCP | One **Sandbox** (Containers) per session running the harness against our MCP with a session token; git via the proxy; models through AI Gateway with the user's key | 5 |
| **Cloud session on a subscription** (Codex ChatGPT plan, Claude Max) | Would need the user's CLI login inside our sandbox | **Not recommended:** the subscription's terms may not allow hosted use, and we'd hold a long-lived login. Mark as "local only" on the site until checked | — |
| **Grok** | xAI key through AI Gateway | xAI ships no first-party coding CLI we can confirm; a Grok-backed session needs a harness (for example an open-source CLI that speaks the OpenAI API). Mark "keys welcome" as "for automations and the Ask model" until a harness is chosen | 5 |

**Workers AI is never a coding worker** (`AGENTS.md`). It and Jev classify, rank and summarise; coding is always a real harness.

### 3.6 Automations

**What Cursor ships (fetched 2026-10-05, `cursor.com/docs/cloud-agent/automations`).** Automations run cloud agents in the background. Triggers: a schedule (presets or cron); source-control events from GitHub, GitLab and Bitbucket (PR opened, pushed, merged, comment, CI completed, labels…); Slack (new message, reaction, channel created); a custom authenticated webhook; Linear (issue created, status changed, cycle end); Sentry (issue created or updated); PagerDuty (incident triggered, acknowledged, resolved). Instructions are plain language (`/automate` or a web form). Tools: open a PR (default), comment on a PR, request reviewers, send to and read Slack, any MCP server, memories across runs (default) and computer use. Repository scope: none, one, or a multi-repo environment. "Run as" me or a team service account; visibility private, members can view, or members can edit. Billed as cloud-agent usage. Templates: bug and vulnerability review, Slack bug triage, daily digest, CI failure triage, review-comment fixes, Sentry investigation.

**Ours: the same shape, two changes.**
1. **Outputs are typed Gitstalk objects, not free-form agent actions.** An automation's job is to *feed and tend the stalk*: create beans, comment on beans, raise decision cards, notify people. Coding happens in a bean, by a session, under the normal pre-land check. So an automation that finds a bug never edits code itself; it opens a bean that a session (local or cloud) takes.
2. **Two execution kinds.**
   - **Recipe** (default, cheap, deterministic): trigger → MCP tool calls → a filter and a mapping → outputs. Jev may classify ("bug, noise, or duplicate of an open bean?") with a receipt; Workers AI may draft the bean's intent sentence. No coding model involved. The PostHog example is a recipe.
   - **Agent**: trigger → a cloud session (Phase 5) with the automation's instructions and an allowlist of tools; its outputs are still limited to the typed list. This is Cursor's model, and it waits for cloud sessions.

**Triggers.**

| Trigger | Cloudflare mechanism |
|---|---|
| Schedule (presets, cron) | AutomationDO alarm, recomputed after each run (per-automation; avoids a global cron fan-out) |
| Webhook | `POST /hooks/<automation>/<token>` on `beanstalk-automations`, HMAC or bearer secret, body to R2, run enqueued |
| Gitstalk event | RepoDO publishes `bean.opened`, `bean.landed`, `bean.fell_off`, `validation.red`, `stalk.moved`, `decision.opened`, `decision.decided` to the `repo-events` **Queue**; the automations consumer matches subscriptions |
| Git push | Artifacts event subscriptions (`cf.artifacts.repo.pushed`) to a **Queue** |
| App event (Sentry issue, PostHog error, Linear issue…) | Composio triggers delivered to our webhook, or the app's own webhook pointed at us |
| Email | **Email Routing**: `<repo>+bugs@in.<domain>` → `email()` handler on `beanstalk-automations` |
| Manual | "Run now" in web, `automation_run` over MCP |

**Tool connections.** One `ToolConnector` interface, two providers:

| Provider | How | Where tokens live | Use for |
|---|---|---|---|
| **Direct MCP** (Cloudflare-native) | Agents SDK MCP client connects to the app's own remote MCP server (PostHog, Sentry, Linear, Stripe, Cloudflare and others host one), OAuth handled by the client | Our AutomationDO / identity, encrypted with the Secrets Store KEK | First-party MCP servers; anything with a URL. Ships first (Phase 4a) |
| **Composio** (the sanctioned third party) | Composio hosts OAuth connections and exposes tools (and triggers) over MCP or its API; our Worker calls it with a Composio key (Wrangler secret) and the org id as the Composio user/entity id | Composio | The long tail of apps without a good MCP server, and app triggers. Phase 4b, **off by default per org** |

**How Composio fits "no third parties".** Gitstalk's own platform (auth, data, compute, email, scheduling, analytics) stays Cloudflare-only; Composio is an *integration the customer turns on*, like connecting Slack to GitHub. Rules to keep it honest:
- Off until an org admin enables it, with a clear notice that tool calls and their data pass through Composio and that Composio holds those app tokens.
- Never on the sign-in, git, engine or decision paths. If Composio is down, only Composio-backed automations fail.
- Every connector is behind `ToolConnector`, so any Composio automation can move to a direct MCP connection without changing its definition.
- Its outputs are labelled `external` for session taint.

**Outputs and safety.**

| Output | Writes where | Default |
|---|---|---|
| Create bean (queued, unassigned, or offered to a named person's sessions) | inside the repo | allowed |
| Comment on a bean, attach evidence | inside the repo | allowed |
| Raise a decision card | inside the repo | allowed, rate-limited |
| Notify (in-app, email via Email Service) | to org members | allowed |
| External write (post to Slack, update a Linear issue, comment on PostHog) | outside | **needs approval per run** (a card with the exact payload) unless an admin sets "trusted" |

Rule of Two: reading app data (PostHog errors) sets **U**; reading private repo content sets **P**; an external write sets **W**. A run may hold two. Creating a bean is an internal write, so the PostHog example runs unattended; posting back to Slack after reading private code is blocked or queued.

**Execution.** Trigger → `automation-runs` **Queue** → a **Workflow** instance per run (durable steps: fetch, classify, dedupe, write outputs; retries per step; `sleep` for backoff) → outputs through gateway RPC → run summary in AutomationDO, full log in **R2**, counts in **Analytics Engine**. Budgets (dollars, runs per day, outputs per run) are checked before each step; Jev and Workers AI calls go through **AI Gateway** for caching and spend limits.

**The PostHog example, end to end.** Schedule fires hourly → Workflow step 1 calls PostHog's `error_tracking` list tool (direct MCP or Composio) → step 2 filters to active issues with five or more occurrences in 24 h → step 3 drops issues whose PostHog id is in `dedupe` → step 4 asks Jev, per issue, "bug, noise, or duplicate of one of these open beans?" over the issue title, top frame and the open beans' intents → step 5 for each bug calls `bean_open {intent, area_hint, evidence_url, source: automation}` → the bean appears at the tip of the stalk as queued; a connected session can take it with `task_next`, or the owner's cloud session does if the automation says so → step 6 records the PostHog id → bean mapping and posts a summary to the run log.

**MCP verbs** (P1): `automation_get` (lists without a name), `automation_create` (from a template or a definition JSON), `automation_run`, `automation_runs`. So "automatically look at bugs in PostHog and post them as beans" can be said to an agent and becomes this definition.

---

## 4. The phased backlog

Estimates are **agent-days** for one agent (S < 1, M 1–3, L 4+), mine unless a doc gives one. "Coop" marks owner-only work. Today is 2026-10-06; the deadline is **2026-10-14, 11:59 pm PDT**.

### Overview

| Phase | Goal | Window | Effort | Parallel lanes |
|---|---|---|---|---|
| **0** | Secure the competition submission | 10-06 → 10-14 | ~6 agent-days + Coop's recording | 3 lanes |
| **1** | Accounts and the front door: sign up through an agent, sign in, Home shell | 10-15 → 10-24 (T2/T3 may start 10-07 on separate Workers) | ~11 | identity · MCP OAuth · web shell |
| **2** | Persistent repositories: create or import, connect sessions, land beans without the race driver | 10-24 → 11-14 | ~18 | engine · git/auth · web tabs · MCP write verbs |
| **3** | Teams and people: orgs, invites, roles, sessions page, inbox, notifications, passkeys, audit | 11-07 → 11-21 | ~10 | identity · web · notify |
| **4** | Automations: triggers, direct MCP then Composio, typed outputs, Workflows | 11-17 → 12-05 | ~14 | runtime · connectors · web |
| **5** | Cloud sessions and BYOA: Sandbox-hosted harnesses, provider keys via AI Gateway, budgets | 12-01 → 12-19 | ~12 | sandbox host · keys · web |
| **6** | Depth: Insights, previews, streaming diffs, search, `bean` CLI, Jev eval, GitHub mirror | from 12-08, ongoing | 20+ | independent items |

Dependencies:

```
Phase 0 ──────────────────────────────────────────────▶ (submission, 10-14)
Phase 1  identity ──┬──▶ MCP OAuth ──┬──▶ Phase 2 (repos need principals)
                    └──▶ web shell ──┘        │
                                              ├──▶ Phase 3 (teams need repos for access)
                                              ├──▶ Phase 4 (automations output beans; 4a needs only Phase 2's bean_open)
                                              └──▶ Phase 5 (cloud sessions need bean verbs + provider keys from Phase 3)
Phase 6 items each depend only on Phase 2, except previews (needs Phase 5's Sandbox host)
```

---

### Phase 0: the submission (by 2026-10-14)

**Goal:** a judge can watch the video, read the README, deploy it, run a race, and see the numbers we claim. Nothing in this phase changes the engine's defaults or the deployed demo path except fixes.

| # | Item | Acceptance | Size | Lane |
|---|---|---|---|---|
| 0.1 | **Licence notice** (D1) | `LICENSE` matches the decision; README, site footer and video close say the same thing. **Done 2026-10-14:** Apache-2.0 with `NOTICE` and `TRADEMARKS.md`; README, site, `AGENTS.md` and every manifest say Apache-2.0 | S + Coop | A |
| 0.2 | **Pin the engine for the demo** | Gateway defaults now run v2.5 rules, which have **no real-agent Cloudflare run**. Either pin the demo and README numbers to `V24_SETTINGS`, or run v2.5 for real (0.3). The README, site and script quote only measured versions. **Done 2026-10-06:** `demo` pins v2.5 + dependency starts + the tail fix (`DEMO_SETTINGS`), measured in 0.3; `v24` keeps `V24_SETTINGS` | S | B |
| 0.3 | **2–3 more real-agent seeds on Cloudflare** (v2.4 or v2.5 vs queue) | `research/race/runs/cf-*` added; `kth_green.py` table in README and `15` updated; site's "1.6–2.3×, three runs" claim matches the runs exactly. **Done 2026-10-06 (runs, README, `11`, `15`):** seeds 7/11/13 for the queue, v2.4 and every v2.5 phase (`11`, "CF v2.5 phase matrix"); the site's claim is the marketing pass's to align | M (+ ~$15–25 agent spend) | B |
| 0.4 | **Live Ask fast enough to show** | Per-request memoisation in `ForgeSource` (`14` §11 fix 1); the coupons question on a live run under 5 s, recorded runs unchanged | S | C |
| 0.5 | **Spend guard and auto-reap** before Artifacts billing (from 10-14/15) | Every race reaps its repo after the final check; a per-run dollar cap aborts runs; a nightly reap of anything older than 24 h; one race's infra cost measured and written down | S–M | A |
| 0.6 | **Clean-account run instructions** | A fresh Cloudflare account follows README "Run it" to a deployed gateway, web and a replay race with no undocumented step; a `scripts/deploy-all` helper; `pnpm check` green | S | A |
| 0.7 | **Marketing truth pass** | No dead links (14 `href="#"` in the footer today: remove or point to real pages); the plugin command works as printed, or the copy says "coming soon" (the `beanstalkdev/beanstalk-plugin` marketplace repo and `claude mcp login` need Phase 1); "cloud agents" and "keys welcome" marked as coming; Privacy and Terms pages exist before any email is collected (Appendix A) | S | C |
| 0.8 | **Waitlist backend** for `/human` | Form posts to a Worker route, Turnstile verified server-side, email stored in D1 `waitlist`, confirmation sent through Email Service (domain onboarded), rate-limited | S–M | C |
| 0.9 | **Video script v2 and recording** | `12-demo-script.md` updated to the measured numbers and the Nightshift home (not the old canvas beats); 8 minutes; recorded; uploaded | M + **Coop** | B |
| 0.10 | **Submission text and public repo** | Repo public (or the required access given), `main` holds the submitted state, run instructions and licence note linked, video linked; Workers + Artifacts use spelled out | S + **Coop** | A |

**Stretch, only if 0.1–0.10 are done by 10-11:** a 30-second "connect your session" moment in the video, from Phase 1's T2 and T3 on a separate deployment. If it is not solid by 10-12, it stays out.

**Done when:** submitted, with every number in the video traceable to a run directory.

---

### Phase 1: accounts and the front door (~11 agent-days)

**Goal:** a new person pastes one command into Claude Code or Codex, signs up in the browser, and lands on Home with their session listed. A returning person signs in by magic link. Races keep working untouched.

**Status (2026-10-07, branch `auth-accounts`, `19-accounts-and-auth.md`):** 1.1 done as a library rather than a Worker (`@gitstalk/shared-identity` on one D1 `beanstalk-identity`, bound in web, MCP and gateway; tested with real D1). 1.2 done with passkeys as the primary method (owner decision) and magic links built, tested and switched off until a sender domain exists; Turnstile and the six-digit code not yet. 1.3 done: `beanstalk-mcp` is an OAuth 2.1 server and protected resource (`workers-oauth-provider` 1.2.3, DCR, CIMD, PKCE S256, refresh, revocation), consent on web `/connect`, and `claude mcp login` completed against staging with Claude Code itself; session principals are the OAuth grants for now (no `session_principals` table yet); tools read one run until Phase 2. 1.5 partly: `/login`, `/signup`, `/connect`, `/settings` (passkeys, connected agents, sign out everywhere), `/settings/tokens`; the `DEMO_PASSWORD` gate stays beside sign-in. Personal access tokens (`bsu_`) and session git tokens (`bss_`, from the MCP `git_credential` tool) verify in the gateway through `verifyGitCredential`; repository authorization for them is Phase 2 (2.4). **Since (2026-10-07, `19` §10):** Turnstile on sign-in and sign-up (server-side Siteverify, off on live until Coop's widget); 1.4 done except the organisation decision (the plugin installs from `disturbing/beanstalk`, `.mcp.json` literal so Codex works, `/signup/agent` per harness); 1.6 done (first steps, the demo repository for everyone, sessions on Home within 3 s); 1.7 done (hashed ids in logs, Analytics Engine `product_events`, `pnpm product-events`).

| # | Item | Acceptance | Size |
|---|---|---|---|
| 1.1 | `packages/identity` Worker skeleton, D1 `identity` schema and migrations, `shared-auth` types | `wrangler types` generated; RPC `whoami`, `authorize`, `createUser`, `createSessionPrincipal`; vitest with real D1 | M |
| 1.2 | Magic-link sign-in and sign-up | Email Service sends from the onboarded domain; Turnstile and Rate Limiting on the request; token hashed, single-use, 15 min, browser-bound; six-digit code fallback; `__Host-bs_session` cookie; sign-out and "sign out everywhere" | M |
| 1.3 | MCP OAuth in `beanstalk-mcp` with `workers-oauth-provider` | `claude mcp login` and Codex's MCP login both complete; consent page creates a session principal; the six read tools work with the OAuth token, scoped to repos the user can read; view tokens still work for races; redirect-URI fuzz tests pass | M–L |
| 1.4 | Plugin and marketplace | `beanstalkdev/beanstalk-plugin` (or the chosen org) published with `.mcp.json` using OAuth (no bearer header); the site's command works verbatim; `/signup/agent` shows commands for Claude Code, Codex, Cursor and Gemini CLI | S–M |
| 1.5 | App shell in `packages/web`: signed-in layout, `/login`, `/signup/*`, `/connect`, `/settings` (profile, connected sessions with revoke), signed-out `/` serves the marketing page | Same origin; `DEMO_PASSWORD` gate replaced by "repo admin" for decisions on the demo repo; light and dark themes; phone width | M |
| 1.6 | Home (empty state and the demo repository) | First-visit checklist; the demo repo (`beanstalk-shop` replay) is listed for every new user; "Your sessions" shows the connected session within 5 s of login | M |
| 1.7 | Observability and analytics | Structured logs with `user_id` and `session_id` (hashed in logs); Analytics Engine `product_events` for sign-up, connect, first repo | S |

**Done when:** from a clean machine, the site's command → browser → Home with "Claude Code on <label>" listed, in under two minutes, and `ask_repo` answers about the demo repo through OAuth.

---

### Phase 2: persistent repositories (~18 agent-days)

**Goal:** a person creates or imports a repository, their sessions open and submit beans over MCP and plain git, the engine lands them continuously, and the repository tabs show it live. No race driver involved.

| # | Item | Acceptance | Size |
|---|---|---|---|
| 2.1 | **RepoDO**: generalise RunDO into an open-ended engine (task set grows, no "done", hibernation, heartbeats, released beans after timeout, settings changes while running); RaceDO keeps race-only parts behind an adapter | All existing engine, parity and determinism tests pass for races; new tests for a 48-hour simulated repo with beans arriving at random | L (5) |
| 2.2 | Repo lifecycle: `repos.create` (empty, import from a public git URL via Artifacts `.import()`, demo template), rename, archive, delete; D1 `forge` **(built 10-07; archive 10-07: `20` §8)** | Create in under 5 s; import of a 50 MB public repo completes and the stalk equals its default branch; delete reaps Artifacts and the DO | M |
| 2.3 | Checks config: `.gitstalk/checks.toml` (command, image, timeout, protected paths) run by the Runner on the exact merged tree | A Node repo and a Rust repo each get correct pre-land checks; a missing file means "no checks, land on clean merge" with a warning | M |
| 2.4 | Git auth for principals: bean-scoped git tokens from identity; proxy checks principal + bean ownership; people's personal tokens | Push to own bean works; push to another's bean, `sprout`, `stalk` or a deletion is refused (403); compressed pushes supported (today 415) | M |
| 2.5 | MCP write verbs: `bean_open`, `task_next`/`task_claim`, `change_submit`, `decision_request`, heartbeat; `bean_status.next` drives rework; plugin skill updated | A stock Claude Code session with the plugin and no driver takes a bean from open to stalk, including one red-and-rework cycle | L (4) |
| 2.6 | Repo event Queue: RepoDO → `repo-events` → D1 indexes (`beans`, `decisions`, `repo_daily`) **(built 10-07: `20` §7; staging lag median ~3 s, worst 7 s)** | Lists in web are under 200 ms from D1; indexes catch up within 5 s of an event | M |
| 2.7 | Web: `/:org/:repo` shell and tabs Code, Beans, Stalk, Decisions, Checks, Settings (general, access, engine policy, checks); `/new`; repository list on Home and org page **(10-07: `/:owner/:repo` with Code, Changes, History (validated versus landed), Ask, People, Settings (general, visibility, collaborators, archive, delete); `/new`; Home; `20`)** | Tabs work live on a real repo; Files folds into Code; Engine view under Stalk; decision answering by repo admins and spec owners | L (4) |
| 2.8 | Live Ask at product speed: term index (D1 FTS5) and test import closures computed on landing, answer cache keyed by sprout sha | Under 2 s for a live answer, under 300 ms repeated (`14` §11 target) | M |

**Status (2026-10-08, `20-repositories.md`):** 2.3 is built (`24-checks-config.md`): `.gitstalk/checks.toml` is read from each checked tree, an invalid file is a red naming every problem, protected paths are refused unless a maintainer pushes them; a repository without the file keeps the engine's default suite (`node --test`), and the starter's older format is still read. 2.2 and most of 2.7 are built. Repositories live in a D1 registry (`forge`), are owned by a person (personal namespace; orgs wait for Phase 3), start empty (a README), from the TypeScript starter or as an import, and are renamed, re-described, made public or private and deleted from Settings. `/<owner>/<repo>` shows a start page until the first bean starts, then the same home as a race (stalk, Growing now, What happened, Ask, Files, beans, decisions, checks). Signed-in `/` is Home (repositories, recent activity, New repository); the benchmark landing moved to `/races` for signed-in people. On a separate staging stack, a passkey sign-up, a template repository, a personal-token clone and `git push -o wait` of a bean landed and validated in 18 s. Since then: collaborators (`22`), archive, History with validation verdicts (the Stalk tab folded into it) and engine events in Home's activity through the `repo-events` queue (`20` §7 to §9). Not yet: Insights, org pages.

**Done when:** Coop's own small project, imported, takes ten beans from two people's sessions (one Claude Code, one Codex) to the stalk in one afternoon without any operator command.

---

### Phase 3: teams, people, sessions, notifications (~10 agent-days)

| # | Item | Acceptance | Size |
|---|---|---|---|
| 3.1 | Team orgs: create org, invite by email (Email Service), roles, teams, repo access by team | Invite → magic link → member; role changes take effect on the next request; the last owner can't leave | M |
| 3.2 | People and Sessions pages (org and repo): who is active, which sessions, what each is growing, revoke | "3 people, 5 sessions active" in the status line comes from real heartbeats; revoking a session ends its MCP and git access within a minute | M |
| 3.3 | Inbox and notifications: decisions asked of me, my bean fell off, red for N minutes; in-app plus email (per-user settings, daily digest); reply-by-email to decide (Email Routing) | A decision card emails its two owners; replying "keep left" decides it; unsubscribe links work | M |
| 3.4 | Passkeys | Add, name, remove; sign in with a passkey on Chrome, Safari, Firefox; magic link stays as recovery | M |
| 3.5 | Audit log | Every grant, revoke, role change, settings change and decision recorded with actor chain (`sub`/`act`); org admins can view and export | S–M |
| 3.6 | Taint labels on returned text (`06` §3, first half) | Every MCP response carries provenance labels; hidden Unicode and HTML comments stripped | S |

---

### Phase 4: Automations (~14 agent-days)

| # | Item | Acceptance | Size |
|---|---|---|---|
| 4.1 | `packages/automations` Worker: AutomationDO, definition schema (versioned), Workflows runtime, `automation-runs` Queue, R2 logs, budgets | Definitions validate with Zod; a run is resumable after a Worker restart; budget overrun stops a run between steps | L (4) |
| 4.2 | Triggers: schedule (alarms), webhook (HMAC), Gitstalk events (Queue), manual; then Artifacts push and email-in | Each trigger has a test with real bindings; duplicate deliveries do not double-run (idempotency key) | M |
| 4.3 | 4a **Direct MCP connector** (Agents SDK MCP client + OAuth), connections page per org | PostHog's own MCP server connected by OAuth; tools listed and allowlisted per automation | M |
| 4.4 | Typed outputs: create bean, comment, decision card, notify; external writes behind per-run approval; Rule-of-Two enforcement | The PostHog recipe opens beans unattended; a Slack post after reading private code is queued as a card | M |
| 4.5 | 4b **Composio connector** (decision D4): org-level enable with notice, connections, triggers via webhook | A Composio-backed Sentry trigger opens a bean; disabling Composio stops only those automations | M |
| 4.6 | Web: Automations tab (list, editor, runs), templates (PostHog errors, Sentry issue, daily digest, red too long, webhook, email-in) | The §2.5 editor round-trips to the same JSON as `automation_create` | M–L |
| 4.7 | MCP verbs: `automation_get/create/run/runs` | "Automatically look at bugs in PostHog and post them as beans" said to Claude Code creates a working automation | S |

---

### Phase 5: cloud sessions and BYOA (~12 agent-days)

| # | Item | Acceptance | Size |
|---|---|---|---|
| 5.1 | `packages/agents`: Sandbox host, one Sandbox per cloud session, image with Claude Code, Codex CLI and Gemini CLI; session token injected; egress allowlist | A cloud Claude Code session takes a bean to the stalk; killing the sandbox releases the bean | L (4) |
| 5.2 | Provider keys: add, test, rotate, delete; envelope encryption with Secrets Store KEK; calls through AI Gateway with per-org spend caps | A key is never logged, returned, or visible in the sandbox's environment listing to the model (injected at egress where possible) | M |
| 5.3 | Start, stop and watch cloud sessions in web and over MCP (`session_start`); logs streamed | Start to first tool call under 60 s cold | M |
| 5.4 | Agent automations (the Cursor model) on top of 5.1 | An automation of kind "agent" runs in a cloud session with its tool allowlist and typed outputs only | M |
| 5.5 | Budgets per session, per repo, per org; spend in Insights | A session over budget is paused with a card to its owner | S–M |

---

### Phase 6: depth (independent items, pick by value)

| Item | Cloudflare products | Size |
|---|---|---|
| Insights tab: kth green per day, waiting time, spend by person and session, rework and fall-off rates, Jev vs rules | D1 rollups, Analytics Engine | M |
| Streaming a bean's changeset while it is written (`14` streaming note) | RepoDO ephemeral snapshots, WebSocket | M (2–2.5) |
| Previews as MCP verbs: `preview_ensure/_http/_browse/_compare/_logs`, `attest` (`06` §5) | Worker Previews, Sandbox, **Browser Rendering**, R2, Workers Observability | L |
| Code search across repos (term index, then semantic) | D1 FTS5, **Vectorize**, Workers AI embeddings | M–L |
| `bean` CLI: device flow, git credential helper, same verbs as MCP | (client) + identity device endpoints | M |
| Jev eval (60 questions, 20 lead situations) and per-decision Jev-or-rules flags | Workers AI, AI Gateway | M |
| Dependency-aware starts and planning (E4, `start_order: dependency`) after a real-agent race | RepoDO | M |
| Forge-owned tests (E1): test author with fail-first proof | Runner, sessions | L |
| GitHub mirror and PR export (optional, user-enabled; would be a second sanctioned third party) | Queues, Workflows | L |
| Greenhouse spatial view (`14` concept B) | web | L |
| Avatars and social cards | **Images**, R2, Browser Rendering for OG images | S |
| Status page and admin console | Access, Workers Observability | S–M |

---

## 5. Risks and open decisions

### Risks

| Risk | Effect | Mitigation |
|---|---|---|
| **Licence vs. rules**: the rules require MIT, Apache-2.0 or BSD | Ineligibility if the repository is under anything else | Resolved 2026-10-14: Apache-2.0 (D1, 0.1) |
| **Demo numbers vs. shipping defaults**: gateway defaults to v2.5 rules, which are simulated only | A judge reruns and gets different behaviour from what the video shows | 0.2 pins or 0.3 measures; README states which |
| **Artifacts billing starts ~10-14/15**, and the shared account caps containers at 48 | Surprise cost; races fail at scale | 0.5 spend guard and reap before 10-14 |
| **Email Sending is in beta**, needs Workers Paid and an onboarded domain, and new accounts start with conservative daily quotas | Magic links throttled on a launch spike | Onboard the domain in Phase 0 (0.8 exercises it); request a limit increase early; the six-digit code and passkeys reduce sends; queue and retry |
| **`workers-oauth-provider` security** (2025 `redirect_uri` CVE, external review findings) | Account takeover via MCP login | Pin, fuzz redirect URIs, review consent flows; short tokens; principal revocation |
| **MCP client OAuth differences** (Claude Code, Codex, Cursor, Gemini CLI each implement discovery and CIMD/DCR differently) | "One command" fails for some harnesses | Test matrix per harness in 1.3; keep the bearer-token path for clients that can't do OAuth, documented |
| **Phase 0 collision**: Phase 1 work deploying over the demo | Broken demo days before submission | Phase 1 deploys to new Worker names until 10-15; no change to `beanstalk-web`/`-gateway` routes before submission except Phase 0 fixes |
| **RepoDO generalisation** breaks race parity | Lost reproducibility of the published numbers | RaceDO keeps the race code path; parity and determinism tests are a merge gate |
| **Composio** contradicts "no third parties" in spirit | Owner and user trust | Optional, per-org, off by default, behind `ToolConnector`, direct MCP first (§3.6) |
| **Codex/Claude subscriptions in the cloud** may breach provider terms | Account bans, liability | Local only until checked; cloud sessions use API keys |
| **Token in model context** for git in Phase 2 | Leak via prompt injection | Push-only to one bean, one-hour TTL; Phase 6 credential helper removes it |
| **Scale of a single RepoDO** at 100+ concurrent sessions | Hot DO, slow landings | E4 showed the committer 1–3% busy at 1,000 agents; measure before sharding; move reads to D1 indexes (2.6) |
| **Live Ask latency** (22 s measured on a live run) | The headline feature feels broken | 0.4 now, 2.8 for real |

### Decisions only Coop can make

| # | Decision | Options | My recommendation | Needed by |
|---|---|---|---|---|
| D1 | **Licence for the submission** | **Decided 2026-10-14 (Coop): Apache-2.0**, as the rules require. From 2026-10-04 to 2026-10-14 the repository was under FSL-1.1-ALv2 | — | Done |
| D2 | **Demo engine version** | pin v2.4 (measured) or run v2.5 for real seeds and ship it | Run 2 seeds of v2.5 vs queue if budget allows; otherwise pin v2.4 | 10-08 |
| D3 | **Domain and naming** | which domain for app, MCP, git and email (`beanstalk.dev`? the site's command uses `beanstalkdev`); GitHub org for the plugin marketplace | One apex domain, same origin for app, MCP and git | 10-08 (Email Service onboarding needs it) |
| D4 | **Composio** | (a) direct MCP only; (b) direct MCP first, Composio as optional per-org broker; (c) Composio first | (b) | Phase 4 start |
| D5 | **Marketing site home** | keep `packages/site` static on the apex and the app on a subdomain, or serve marketing from the vinext app on one origin | One origin, marketing served by web for signed-out `/` | Phase 1 start |
| D6 | **Passkeys in Phase 1 or 3** | Phase 1 (better first impression) or Phase 3 | Phase 3; magic link plus OAuth is enough to launch | Phase 1 start |
| D7 | **Who may assign work to whose sessions** (`14` §11) | sessions take placed work from anyone in the repo, only from their owner, or opt-in per session | Owner-controlled per repo, default "only my own and unassigned beans" | Phase 2 |
| D8 | **Cloud sessions with subscriptions** (Codex ChatGPT plan, Claude Max) | support, local only, or ask providers | Local only; site copy updated | Phase 0 copy pass |
| D9 | **Grok support** | which harness, or "keys for automations and Ask only" | The latter until a harness is chosen | Phase 5 |
| D10 | **Public repositories and anonymous read** | private-only at launch, or public repos | Private and internal first; public in Phase 6 with abuse controls | Phase 2 |
| D11 | **Pricing and quotas** (the footer links to Pricing) | free beta with caps, or paid | Free beta with per-org caps on containers, sessions and automation runs | Phase 3 |
| D12 | **Waitlist vs open sign-up** after the deadline | keep early access, or open | Open sign-up through agents from Phase 1, with org caps | Phase 1 |

---

## 6. The first three build tasks

Each is written to hand to one agent as-is. All three follow `AGENTS.md` (load `clean-code-typescript`, `gitstalk-packages`, and the Cloudflare skills named), work on their own branch, run `pnpm check`, and do not commit or deploy unless Coop asks.

### Task 1 (Phase 0, lane A): submission readiness pack

> **Goal.** Make the repo safe and reproducible for judges by 10-12, without changing engine behaviour.
>
> **Do:**
> 1. **Spend guard.** In `packages/gateway`, reap a race's Artifacts repo after its final check (today reap is a manual admin route, `src/run/run-reap.ts`); add a per-run `max_usd` abort in `RunConfig` (default off for existing presets) and an hourly alarm in `RunIndex` that reaps anything older than 24 h. Tests with real bindings.
> 2. **Infra cost.** Measure one replay race's Workers requests, DO requests, container seconds and Artifacts operations from Workers Observability and the Artifacts dashboard; write the numbers into `docs/claude-opus/15-explainer-for-coop.md` §2 "Cost".
> 3. **Clean-account deploy.** Add `scripts/deploy-all.mjs` (gateway, mcp, web, site in order, using Wrangler, reading `.dev.vars`), and fix every gap you hit following README "Run it" on an account that has never seen Gitstalk (ask Coop for one, or use a fresh Wrangler profile and list what you could not verify).
> 4. **Engine pin.** Add a `demo` preset that equals `V24_SETTINGS` and make the README and `research/race/REMOTE.md` commands use it explicitly, so the published numbers are reproducible regardless of defaults (do not change the defaults).
>
> **Don't:** touch the web UI, the site copy, or the licence (Coop's D1).
> **Done when:** `pnpm check` passes; a replay race run with the README commands reaps itself and reports its cost; the deploy script works from a clean clone; the doc numbers are updated.
> **Skills:** `clean-code-typescript`, `gitstalk-packages`, `durable-objects`, `wrangler`, `workers-best-practices`. **Size:** M (2 days).

### Task 2 (Phase 0 → 1): `packages/identity` with the waitlist and magic links

> **Goal.** The Cloudflare-only identity service, starting with what Phase 0 needs (a real waitlist) and ending with magic-link sign-in that Phase 1 builds on. Deploy target is a new Worker, `beanstalk-identity`; nothing existing changes.
>
> **Do:**
> 1. Create `packages/identity` per `gitstalk-packages` (Hono in a `WorkerEntrypoint`, `wrangler.jsonc` with today's `compatibility_date`, observability on, generated types). Bindings: D1 `identity`, `send_email` (`EMAIL`), Turnstile secret, Rate Limiting, KV `OAUTH_KV` (reserved for Task 3).
> 2. Migrations for `users`, `user_emails`, `orgs` (personal), `memberships`, `magic_links`, `web_sessions`, `session_principals`, `waitlist`, `audit_events` as in `16` §3.2. New `packages/shared-auth` with the principal, scope and grant-props types (`Ulid`-style branded ids).
> 3. Routes: `POST /waitlist` (Turnstile Siteverify server-side, rate-limited, D1 insert, confirmation email with text and HTML), `POST /login/request` (Turnstile, rate limit per email and IP, 32-byte token hashed, 15 min, single use, browser-bound pre-auth cookie, six-digit code), `GET /login/verify` and `POST /login/code` (create user and personal org on first sign-in, set `__Host-bs_session`), `POST /logout`, `POST /logout/all`.
> 4. RPC (`WorkerEntrypoint` methods): `whoami(sessionCookie)`, `createSessionPrincipal(userId, client)`, `revokeSessionPrincipal`, `authorize(principal, action, resource)` (owner-of-personal-org only for now), `audit(event)`. Write the RPC contract first and commit it, so Task 3 can start against it.
> 5. Point `packages/site/public/human.html`'s form at `POST /waitlist` (the only change outside the package), keeping the current UI.
>
> **Don't:** add any non-Cloudflare service; store raw tokens; log emails in clear (hash them in logs).
> **Done when:** vitest with real D1, KV and a mocked Email binding covers token expiry, reuse, wrong browser, rate limits and Turnstile failure; a real email arrives from the onboarded domain in a manual check (needs D3); `pnpm check` passes.
> **Skills:** `clean-code-typescript`, `gitstalk-packages`, `cloudflare-email-service`, `turnstile-spin`, `workers-best-practices`, `wrangler`. **Size:** M (3 days). **Blocked by:** D3 (domain) for the live email only.

### Task 3 (Phase 1): MCP OAuth sign-up through the agent

> **Goal.** `claude mcp login plugin:gitstalk:gitstalk` (and Codex's MCP login) signs a new or returning person in through the browser and leaves a session principal behind, so the site's one-line sign-up is true.
>
> **Do:**
> 1. In `packages/mcp`, wrap the existing `createMcpHandler` in `@cloudflare/workers-oauth-provider` (pinned version): `/mcp` as the API route, `/authorize`, `/token`, `/register`, protected-resource and authorization-server metadata; Client ID Metadata Documents plus dynamic registration; access tokens 15 min, refresh 30 days.
> 2. `/authorize` page (server-rendered, the greenhouse tokens from `14` §6): if no web session, run Task 2's magic-link flow inline and return; then the consent screen from `16` §2.2 (label editable, scope "all my repos" or pick); on approve call `identity.createSessionPrincipal` and complete with props `{ userId, sessionPrincipalId, ops }`.
> 3. Tools: accept OAuth tokens and keep the view-token path for races. With an OAuth token, `ask_repo` and friends read only repos the user may read (for now: the demo repo for everyone, plus races the user created).
> 4. `packages/claude-plugin/.mcp.json`: remove the bearer header so the client uses OAuth; keep `BEANSTALK_MCP_URL`. Document the per-harness commands for `/signup/agent`.
> 5. Tests: the full code flow with PKCE in vitest; redirect-URI fuzz cases (open redirect, mismatched scheme, fragment, localhost variants); a revoked principal's token fails within one refresh.
>
> **Don't:** deploy over the current `beanstalk-mcp` before 10-15 (use `beanstalk-mcp-next`); grant any write scope (Phase 2).
> **Done when:** on a clean machine, the site's command → browser → consent → `ask_repo` on the demo repo works in Claude Code and in Codex; `pnpm check` passes.
> **Skills:** `clean-code-typescript`, `agents-sdk`, `gitstalk-packages`, `workers-best-practices`. **Size:** M–L (3–4 days). **Depends on:** Task 2's RPC contract (step 4), not its completion.

---

## Appendix A: marketing promises against the backlog

| The site says (`packages/site/public`) | True today? | Made true by |
|---|---|---|
| "Getting started is installing the plugin… It installs the plugin and signs you in" | No: the marketplace repo isn't published and the MCP server takes a hand-minted bearer token | 1.3, 1.4 (Task 3); copy says "coming" until then (0.7) |
| "Works with Claude Code, Codex, Cursor, Gemini CLI and any MCP client" | Partly: any client with a bearer header can read a race | 1.3 test matrix |
| "Sign up as a human… early access" | No backend (the form only shows a thank-you) | 0.8 (Task 2) |
| The repository home "live today" | Yes, for races and the demo replay; for real repositories on staging (10-07, `20`) | 2.7 for real repos |
| "Sprout… others get its updates instantly" | Simulated only (`live_sync` off by default) | Real-agent race with `live_sync`, then a repo setting (Phase 2/6) |
| "1.6–2.3× sooner… three runs" | Close: needs the exact runs cited | 0.3 |
| "Ask the repo anything… your agents can ask the same questions" | Yes (`ask_repo`); live answers are slow | 0.4, 2.8 |
| "Broken work goes back to its author" | Yes in races (driver) | 2.5 for real sessions |
| "Agents are sessions owned by people on your team" | Placeholder attribution (`packages/web/src/people/`) | 1.6, 3.2 |
| "Connect Codex… use your ChatGPT or Codex plan. No API key needed" | Not yet (no OAuth); true for local sessions once 1.3 lands | 1.3; cloud use stays local-only (D8) |
| "Cloud agents" | No | Phase 5 |
| "Bring your Anthropic, Google or Grok keys" | No | 5.2; Grok per D9 |
| Footer: Docs, Pricing, Changelog, About, Blog, Careers, Contact, Privacy, Terms | 14 links go to `#` | 0.7 (remove or minimal pages; Privacy and Terms required before 0.8) |
| "Open source under the Apache License 2.0" | True since 2026-10-14 | D1 |

## Appendix B: Cloudflare product map

| Capability | Cloudflare product | Notes |
|---|---|---|
| App and site | **Workers** (vinext, static assets) | `packages/web`, `packages/site` |
| APIs, RPC | Workers + service bindings | No Worker-to-Worker HTTP |
| Per-repo engine state | **Durable Objects (SQLite)** | RepoDO, RaceDO, AutomationDO, session-taint DO |
| Git storage | **Artifacts** | One repo per repository; events to Queues |
| Merges, checks | **Containers** (Runner) | Rust, git 2.47, Mergiraf as a separate binary |
| Cloud agent sessions, previews of non-Worker apps | **Sandbox** (Containers) | Phase 5, Phase 6 |
| Identity and indexes | **D1** (with read replication, FTS5) | `identity`, `forge` |
| OAuth store, small caches | **KV** | `workers-oauth-provider` needs it |
| Event archives, logs, blobs, avatars | **R2** | |
| Fan-out, decoupling | **Queues** | repo events, automation runs, Artifacts events, notifications |
| Durable multi-step jobs | **Workflows** | automation runs, imports, cloud-session lifecycle |
| Schedules | DO **alarms**; Cron Triggers for global sweeps | |
| Email sign-in, invites, notifications | **Email Service** (Email Sending, beta, Workers Paid) | onboarded domain; transactional only |
| Inbound mail (reply to decide, email-to-bean) | **Email Routing** | `email()` handler |
| Bot protection | **Turnstile** | sign-up, magic link, waitlist |
| Abuse limits | **Rate Limiting** binding | per email, IP, principal |
| Secrets, encryption keys | Wrangler secrets, **Secrets Store** | KEK for provider keys |
| Model calls, Jev, BYO keys | **AI Gateway**, **Workers AI** (`typesafe/jev`) | spend limits, caching, logs |
| Semantic search | **Vectorize** + Workers AI embeddings | Phase 6 |
| Product analytics | **Analytics Engine** | replaces third-party analytics |
| Logs, traces | **Workers Observability** (Logs, Traces) | |
| Previews and screenshots | **Worker Previews**, **Browser Rendering** | Phase 6 |
| Images | **Images** | avatars, social cards |
| Admin console, preview protection | **Access** | operators only |
| Passkeys | *No Cloudflare product*: WebAuthn verified in a Worker with an open-source library | allowed under P3 |
| App tool connections | *Not Cloudflare*: **Composio** (sanctioned, optional) or direct remote MCP servers via the Agents SDK MCP client (Cloudflare-native) | §3.6 |
| GitHub mirror | *Not Cloudflare* (GitHub), optional | Phase 6, opt-in |

## Appendix C: Cursor Automations, what we take and what we change

| Cursor | Gitstalk |
|---|---|
| Triggers: schedule, GitHub/GitLab/Bitbucket events, Slack, webhook, Linear, Sentry, PagerDuty | Schedule, webhook, **Gitstalk events** (landed, red, decision, stalk moved), Artifacts push, **email-in**, app events via Composio or the app's webhook |
| Plain-language instructions; `/automate` | Plain language in an agent (`automation_create`) or the editor; stored as a typed definition |
| Tools: open PR, comment, reviewers, Slack, MCP, memories, computer use | Tools: MCP via direct connections or Composio; memory = the AutomationDO's dedupe and notes |
| The automation's agent writes code and opens PRs | Outputs are typed: **create bean**, comment, decision card, notify. Code is written in beans by sessions under the pre-land check |
| Run as me or a service account; private / members view / members edit | Same, plus Rule-of-Two enforcement and per-run approval for external writes |
| Billed as cloud-agent usage | Recipes cost cents (Jev, Workers AI, Workflows); agent automations bill as cloud sessions with budgets |
| Templates: bug review, Slack triage, digest, CI triage, Sentry investigation | Templates: PostHog errors → beans, Sentry issue → bean, daily stalk digest, red too long → page owner, webhook → bean, email → bean |
