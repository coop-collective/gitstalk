# 19 · Accounts and authentication

Built 2026-10-07 on branch `auth-accounts` (from `prototype` at `fed4f54`). This is Phase 1 items 1.1–1.3 and part of 1.5 from `16-product-backlog.md`: people sign up and sign in, agents connect over MCP OAuth, and git gets user tokens. Everything runs on Cloudflare: D1, KV, Workers Rate Limiting, Email Service (sign-in codes, §6), and two open-source libraries inside Workers (`@cloudflare/workers-oauth-provider`, `@simplewebauthn/server` and `/browser`). No third-party service is in any request path.

**Owner decisions applied:** 100% Cloudflare; vinext web; OAuth on MCP; passkeys are the primary sign-up path (Coop, 2026-10-07); email sign-in by six-digit code next to passkeys, with a handle step for new addresses (Coop, 2026-10-11: "i can only signup with handle, we should have a login with email, passkey, and send a code via cloudflare workers email"; §6). The magic links built on 10-07 never went on and are removed.

**Open for Coop:** deploying email sign-in to production (§6.6). Since §10 (Phase 1 polish): the Turnstile widget for live, the plugin's home (which GitHub organisation), and merging this branch so the public marketplace serves the fixed `.mcp.json` (§10.5).

## 1. What works on staging

**Live since 2026-10-07** (gateway, web and MCP on the main workers.dev stack, D1 `beanstalk-identity`, KV `beanstalk-oauth`): passkey sign-up, personal tokens on git, and Claude Code over OAuth (`claude mcp login`, `whoami`) passed on live; `20-repositories.md` §5 has the walk-through. Handles that clash with the app's routes are refused at sign-up (`shared-identity/src/reserved-handles.ts`).

Staging: `beanstalk-web-staging` and `beanstalk-mcp-staging` on the devaccounts workers.dev subdomain, D1 `beanstalk-identity-staging`, KV `beanstalk-oauth-staging`. The staging gateway was **not** redeployed (§7).

| Check (headless Chrome, CDP virtual authenticator) | Result |
|---|---|
| Sign up with a handle and a passkey; land on Settings; header shows `@handle` | pass |
| Personal access token created, shown once, listed, opens `/mcp`; revoked token refused | pass |
| OAuth: dynamic client registration, `/authorize` → web `/connect`, approve, code + PKCE (S256) → tokens (15 min access, refresh) | pass |
| Access token opens `/mcp`; `whoami` names the person; refresh issues a new token | pass |
| Settings lists the connected agent; Disconnect revokes its tokens | pass |
| Sign out; sign in again with the same passkey | pass |
| Cross-site form POST refused (403) | pass |

19 of 19 checks passed (`e2e.mjs`, kept in the session scratchpad, not the repo).

**Claude Code as the real client (twice, from a clean state):**

```bash
claude mcp add --transport http gitstalk-staging https://beanstalk-mcp-staging.<sub>.workers.dev/mcp
claude mcp list                    # beanstalk-staging … ! Needs authentication
claude mcp login gitstalk-staging # opens the browser (--no-browser prints the URL)
#   → /authorize → /login → "Create an account" → handle + passkey → /connect → Allow
#   → the browser returns to Claude Code's localhost callback
claude mcp list                    # beanstalk-staging … ✔ Connected
claude -p "Call the beanstalk-staging whoami tool…" --allowedTools mcp__beanstalk-staging__whoami
#   → handle claude-6921a6, client Claude Code, scopes read
```

Claude Code 2.1.292 identified itself with a **Client ID Metadata Document** (`client_id=https://claude.ai/oauth/claude-code-client-metadata`), not dynamic registration, used S256 PKCE, `scope=read` (from our `WWW-Authenticate` challenge) and the RFC 8707 `resource`. The consent screen shows "Claude Code, Published by claude.ai" for it, and "This app registered itself, so its name is not verified" for DCR clients. The browser half was driven by headless Chrome with a virtual authenticator; `claude mcp login` ran in a pseudo-terminal (it refuses to finish without one). A `run_status` call over the same OAuth session returned the newest staging run's sprout head.

Screenshots (night and day): `exp/auth/signup-*.png`, `login-*.png`, `consent-*.png` (and `consent-claude-code-night.png`), `settings-*.png`, `tokens-*.png`, `tokens-created-night.png` (the token is masked before the shot and revoked after).

## 2. Architecture

```
 browser ──▶ beanstalk-web (vinext)            Claude Code / Codex / any MCP client
             /signup /login /connect /settings        │  401 + resource_metadata
             /api/auth/{passkey,email}/* /auth/*       ▼
                │ D1 IDENTITY_DB              beanstalk-mcp
                │ RPC (MCP binding):            OAuthProvider (workers-oauth-provider)
                │  consentRequest, approve…     /.well-known/*, /oauth/register, /oauth/token
                └──────────────────────────────▶ /authorize → 302 web /connect?request=<id>
                                                /mcp  OAuth tokens and bsu_ PATs → tools
                                                /mcp  bst1. run tokens → unchanged run-token app
 git ──▶ beanstalk-gateway  verifyGitCredential: bst1. run tokens | bsu_/bss_ user tokens (D1)
```

- **One D1 database, `beanstalk-identity`**, bound as `IDENTITY_DB` in web, MCP and gateway. Schema in `packages/shared-identity/migrations/` (users, passkeys, web_sessions, auth_challenges, email_codes, user_tokens, audit_events, and the unused magic_links). Apply it from the web package: `wrangler d1 migrations apply beanstalk-identity --remote`.
- **Why D1, not a Durable Object.** Identity is read from three Workers and looked up by globally unique keys (handle, email, credential id, token hash, session hash). D1 gives unique constraints, joins (token → user) and later read replication, with no single-threaded hot spot. One global DO would serialise every sign-in and token check; sharding DOs by user breaks lookups by email, handle or token. Per-repository state stays in RepoDOs as `16` §3.2 plans.
- **Why no `beanstalk-identity` Worker yet.** `16` §3.1 plans one; the brief asked for functions in a shared package, so the logic is a library (`@gitstalk/shared-identity`) that each Worker calls against its own binding. Wrapping it in a Worker with RPC later changes no schema and no caller signature.
- **OAuth lives in the MCP Worker** (issuer = its origin), and the consent screen is the web app's `/connect`. On workers.dev they are two origins, so the library's cookie-bound consent helpers can't be used across them; instead `/authorize` validates the request (`parseAuthRequest`, `describeConsent`), stores it in KV for ten minutes under the hash of a random id, and redirects to `/connect?request=<id>`. The first signed-in person to open it claims it; approve/deny consume it; the web form carries the session CSRF token. In production `16` §3.1 puts both on one zone, which changes nothing here.

## 3. Interfaces for the other agents

All in `packages/shared-identity/src/` (import `@gitstalk/shared-identity/<module>`); every function takes an env with `IDENTITY_DB: D1Database`.

| Need | Call | Returns |
|---|---|---|
| Who is behind a git or API token | `verifyUserToken(env, token)` (`user-tokens`) | `{ user: { id, handle, email }, scopes: ('read'\|'collaborate'\|'write')[], token: { id, kind: 'personal'\|'session', expiresAt } } \| null` |
| Who is signed in (any Worker with the binding) | `getSessionUser(request, env)` (`sessions`) | `{ id, handle, email } \| null` (email null until verified) |
| Mint a short-lived token for an agent session | `mintSessionToken(env, { userId, label, scopes, ttlSeconds?, clientId? })` | `{ token: 'bss_…', summary }`, at most one hour, revoked with the client's grant |
| Personal tokens | `createPersonalToken`, `listUserTokens`, `revokeUserToken` | audited, hashed at rest |
| Audit | `recordAudit(env, { action, actorUserId, target?, ip?, detail? }, now)` | IPs stored as a 16-char hash prefix |
| Who owns an SSH key (the SSH endpoint, after the client proved possession) | `findUserByKey(env, { fingerprint } \| { blob } \| { publicKey })` (`ssh-keys`) | `{ user, scopes: ['read','write'], key: { id, fingerprint, keyType, blob, lastUsedAt } } \| null` |
| Record a key's use | `touchKey(env, key)` (`ssh-keys`) | at most one write a minute |
| SSH keys in Settings | `addSshKey`, `listSshKeys`, `removeSshKey` (`ssh-keys`); browser-approved requests `startKeyRequest`, `describeKeyRequest`, `decideKeyRequest`, `pollKeyRequest` (`ssh-key-requests`) | §9 |

**Web app adapter (one file):** `packages/web/src/auth/user.ts` — `requireUser(request) => Promise<{ id, handle, email }>` (throws `SignInRequired`, whose `response()` is a 401), `getUser(request)`, and `currentUser()` / `currentSession()` for server components and actions. The repository agent should code against `requireUser` only.

**Gateway:** `packages/gateway/src/auth/git-credential.ts` — `verifyGitCredential(env, token, nowMs?)` returns `{ ok: true, kind: 'run', claims }` for `bst1.` run tokens (unchanged behaviour), `{ ok: true, kind: 'user', user, scopes, tokenKind }` for `bsu_`/`bss_`, or `{ ok: false, reason }`. The git proxy uses it; user credentials on race repos get **403** ("race repos take run tokens; user tokens open repositories"), so the git-native agent's repository routes only need to add a branch for `kind: 'user'` (read → fetch/clone, write → push to the person's own beans, never `sprout`/`stalk`). `GET /v1/whoami` answers who a credential is (Basic password or bearer), for people testing a token. If the git-native agent already has its own `verifyGitCredential`, merge by adding the `USER_TOKEN` branch at its top: `if (/^bs[us]_/.test(token)) return verifyUserToken(env, token)`, mapped to its result type.

**MCP RPC for the web app** (`AgentSessionsRpc` in `shared-identity/agent-sessions.ts`, implemented by `packages/mcp/src/index.ts`): `consentRequest`, `approveConsent`, `denyConsent`, `agentSessions`, `revokeAgentSession`. The web binds the MCP Worker as `MCP`.

**Scopes** (one vocabulary for PATs, session tokens and OAuth): `read` (MCP read tools, git fetch), `collaborate` (bean threads and inbox), `write` (push to your own beans). Landing on the stalk and repository settings are never grantable. OAuth requires `read` (advertised as the resource's required scope; the consent page always includes it).

## 4. MCP

- `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414): issuer, `/authorize`, `/oauth/token` (also revocation), `/oauth/register` (RFC 7591), S256 only, CIMD supported (`global_fetch_strictly_public` flag).
- An unauthenticated `/mcp` gets `401` with `WWW-Authenticate: Bearer … resource_metadata=…, scope="read"`; a token without `read` gets the step-up `403 insufficient_scope`.
- Access tokens 15 minutes; refresh tokens 30 days, idle-sliding. Grants, codes and tokens are stored hashed in `OAUTH_KV` with props encrypted by the library.
- An OAuth session sees the read tools plus `whoami` and `git_credential` (a one-hour `bss_` token, never wider than the session's read/write; visible to the model, the trade-off `16` §3.3 accepts until the `bean` CLI credential helper). Collaboration writes still need contributor run tokens: there are no persistent repositories or beans owned by people yet (Phase 2).
- Until Phase 2, a session reads one run: `DEMO_RUN`, or the newest run the gateway lists.
- **View and contributor tokens keep working** for existing links: a bearer starting `bst1.` goes to the unchanged run-token app before the OAuth provider sees it. A `bsu_` personal token also works as a bearer on `/mcp` (`resolveExternalToken`).
- Connected agents are listed from KV, which is eventually consistent: a new grant can take up to a minute to appear in Settings (the page says so).

## 5. Sign-in and security

- **Passkeys (primary):** discoverable credentials (`residentKey: required`), `attestation: none`, ES256/RS256/EdDSA via `@simplewebauthn/server`. Each options request stores a single-use challenge for five minutes (hashed handle in the `__Host-bs_challenge` cookie). Sign-up creates user + passkey + session + audit in one D1 batch; a handle race is caught by the unique constraint. RP ID is the request host (workers.dev is on the public suffix list, so the full host is the RP). A person can add passkeys and remove any but the last.
- **Sessions:** 32 random bytes in `__Host-bs_session` (HttpOnly, Secure, SameSite=Lax, Path=/), SHA-256 in D1, 30 days sliding (one write a day), sign out and sign out everywhere.
- **CSRF:** every state-changing endpoint checks `Origin` (or `Sec-Fetch-Site: same-origin` when the origin is withheld); signed-in forms also carry a session-bound token (hash of the session secret); passkey endpoints require `application/json`.
- **Rate limits:** Workers Rate Limiting binding `SIGNIN_RATE_LIMIT`, 10 per minute per key (keys hashed): per IP for passkey ceremonies, per IP for sending codes and separately for checking them, per address, per handle and per signed-in person (§6). Email codes add a D1 cap of five codes an address an hour.
- **Turnstile** (§10.1): the start of a passkey sign-up or sign-in (the `options` step) and the email form carries a Turnstile token; the server redeems it at Siteverify and requires `success`, the surface's action (`signup` or `signin`) and this deployment's hostname, after the rate limit. On only when both `TURNSTILE_SITE_KEY` and the `TURNSTILE_SECRET_KEY` secret are set (coordinator's decision, 2026-10-08); with either missing it is off and logged as half configured, so sign-in and sign-up work exactly as without it.
- **Constant-time compares** for token and CSRF checks; every secret stored only as SHA-256; tokens never logged (logs carry ids and reasons only).
- **Audit events** in D1: `user.signup` and `session.signin` (detail `method`: `passkey` or `email`), `session.signout`/`signout_all`, `passkey.add`/`remove`, `email_code.send` (detail `purpose`), `email.add`, `token.create`/`revoke`, `session_token.mint`, `oauth.grant`/`deny`/`revoke`.
- Account pages send `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy: same-origin` and `no-store`. (`no-referrer` made Chrome send `Origin: null` on form posts, which the origin check refused; caught on staging.)
- OAuth redirect URIs: a fuzz test of 11 variants (path traversal, trailing slash, extra query, case, other host, https on loopback, fragment, `javascript:`, scheme-relative, userinfo tricks) never redirects; another port on loopback is allowed by design (RFC 8252 §7.3). Plain PKCE and missing PKCE are refused. `workers-oauth-provider` is pinned to 1.2.3 (`16` notes its 2025 redirect-URI CVE).

## 6. Email sign-in by code

Built 2026-10-11 (branch `auth-email-sign-in`). It replaces the magic links of 10-07, which never went on. Two ways in, on one page: **a passkey** or **an email address and a six-digit code**. A new address chooses a handle; a passkey is then offered, skippable.

### 6.1 The flows

`/login` and `/signup` render the same flow (`web/components/account/sign-in-flow.tsx`); steps are `?step=` on the entry page (`web/src/auth/sign-in-steps.ts`), and `next` (a path on this site only, `NextPath`) rides on every step and every form.

| Who | Steps |
|---|---|
| Returning, passkey | `/login` → "Continue with a passkey" (discoverable credential), or pick the passkey from the email field's autofill (WebAuthn conditional UI, where the browser supports it and Turnstile is off) → `next` |
| Returning, email | `/login` → email → "Continue with email" → `?step=code` "Check your email" → code → signed in → `next` |
| New, email | same as above; the verified address has no account → `?step=handle` "Choose your handle" → account created with the address verified → `?step=passkey` "Add a passkey for faster sign-in" (Add, or Skip) → `next` |
| New, passkey | `/signup` → handle → "Create account with a passkey" → `next`. No email: Settings → Emails and Settings → Passkeys say how to add one, and the last passkey cannot be removed until an address is verified |
| Existing account without email | Settings → Emails → address → "Send code" → code → "Verify address"; from then on email sign-in works for it |
| Agent (OAuth) | the agent's `/authorize` → `/connect?request=…` → signed out: `/login?next=/connect?request=…` → any of the above (handle step if new) → back to `/connect` → Allow |

Every email step is a plain form post to `POST /api/auth/email/<step>` (`web/src/auth/email-routes.ts`), answered with a 303, so it works without JavaScript: `start`, `verify`, `handle` (signed out) and `add`, `confirm` (Settings, signed in, CSRF token). Only the passkey ceremonies need JavaScript.

### 6.2 Codes (`shared-identity/src/email-codes.ts`)

- Six uniformly random digits (rejection sampling), **10 minutes**, **single use**, **five tries**. A wrong code says how many tries are left; the fifth wrong try, an expired code or a used one sends the person back to ask for a new one.
- The browser that asked keeps a random 32-byte **ticket** in `__Host-bs_email` (HttpOnly, 10 minutes); the `email_codes` row (migration `0007`) is keyed by the ticket's SHA-256, and the code is stored only as **HMAC-SHA-256 under `EMAIL_SIGNIN_KEY`**, bound to the ticket. A database read alone cannot recover a code (a plain hash of six digits falls to a million guesses), and a code is useless without the ticket of the browser that asked.
- Every check spends a try before comparing (one `UPDATE … attempts = attempts + 1 … RETURNING`), so parallel guesses cannot exceed five; the comparison is constant-time; the right code is claimed once (`used_at`).
- At most **five codes per address per hour** (counted in D1): with five tries each, at most 25 guesses in a million per address per hour. On top, the rate limiter: sending is limited per IP and per address, checking per IP (separate budgets from the passkey ceremonies, whose autofill asks for options on each sign-in page load).
- **No enumeration:** asking for a code sends the same mail and gives the same answer whether or not the address has an account. Only after the code is entered does the flow differ (sign in, or choose a handle), when the person has proved they read that inbox.
- Addresses are trimmed and lower-cased (`Email` in `users.ts`); `users.email` is `UNIQUE COLLATE NOCASE` and set only once verified.
- Audit: `email_code.send` (purpose), then `session.signin` or `user.signup` with `method: email`, and `email.add` from Settings.

### 6.3 New accounts (`shared-identity/src/email-sign-in.ts`)

- A verified address with no account gets a **pending sign-up**: `base64url(email, expiry) . HMAC` under `EMAIL_SIGNIN_KEY`, in `__Host-bs_signup` (HttpOnly, 15 minutes). The handle step accepts only a pending sign-up that verifies and has not expired, so nobody can create an account for an address they did not prove.
- Handles follow the same rules as everywhere (`Handle`: 2–39 characters, reserved words refused, `isHandleTaken` covers people, organizations and retired handles). The user row, the session and the audit row are one D1 batch; a handle race is caught by the unique constraint. If another tab created an account for the same address meanwhile, that account is signed in instead.
- Sessions open exactly as for passkeys: `openSessionStatements` (`sessions.ts`) is the one place that inserts a session and its audit row, used by passkey sign-up and sign-in and by both email paths.

### 6.4 Sending (Cloudflare Email Service)

- The web binds `send_email` as `EMAIL` (Email Sending, not Email Routing's `send_email`, which reaches only verified destination addresses). Mail comes from `Gitstalk <signin@<EMAIL_SENDER_DOMAIN>>`: `gitstalk.io` in production, `gitstalk.dev` on staging, set per environment in `env.jsonc` (`overrides.web.vars.EMAIL_SENDER_DOMAIN`). Email sign-in is on only when the domain, the binding and the `EMAIL_SIGNIN_KEY` secret are all present; otherwise every email control is hidden and the routes answer 404.
- Text: "Your Gitstalk sign-in code is 123456. It expires in 10 minutes. If you didn't ask for it, ignore this email." (plain text and simple HTML; the subject is "123456 is your Gitstalk sign-in code"; Settings sends "verification code").
- Identity code sends through the `EmailPort` (`shared-identity/src/email.ts`); `emailServicePort` wraps the binding, and tests use `testing/capturing-email.ts`. Locally Miniflare simulates the binding and prints each message's subject (with the code), so `vite dev` sends nothing.
- `pnpm env:provision <env>` onboards the domain to Email Sending when it is not yet (`wrangler email sending enable`, which adds the SPF, DKIM and bounce MX records) and generates `EMAIL_SIGNIN_KEY`; `pnpm env:smoke` checks that `/login` shows the email form exactly when a domain is set. Both `gitstalk.io` and `gitstalk.dev` were already onboarded (2026-10-11; DKIM `cf-bounce._domainkey`, bounce MX `cf-bounce`, `_dmarc` `p=reject`), so sending needs no dashboard step.

### 6.5 Verified on staging (2026-10-11)

Deployed to staging only: migration `0007` applied to `gitstalk-identity-staging`, web `gitstalk-web-staging` version `1ae0970e`, then `5767b0fa` (2026-10-12, the branch merged with main: vinext 1.1.0, TanStack Query), on which the walk-through and the passkey `claude mcp login` run below were repeated. `pnpm env:smoke staging` passes (including "/login (email sign-in on)").

To receive real mail without sending to anyone else, Email Routing was turned on for `gitstalk.dev` and two addresses, `e2e-a@` and `e2e-b@gitstalk.dev`, route to a small capture Worker (`gitstalk-e2e-inbox-staging`, kept in the session scratchpad, not the repo) that keeps the newest code per address for ten minutes behind a bearer token. So the codes went through Email Sending, real SMTP delivery (about 20 s) and Email Routing; no staging-only hook exists in the product. Headless Chrome with a CDP virtual authenticator:

| Check | Result |
|---|---|
| `/login?next=/settings/tokens` → email → code page names the address | pass |
| Wrong code → "That code is not right. 4 tries left." | pass |
| Right code, new address → "Choose your handle", `next` kept | pass |
| Reserved handle (`admin`) refused | pass |
| Account created → passkey offered → Add a passkey → lands on `next` | pass |
| Sign out → email code again → signed straight in at `next` | pass |
| Sign out → "Continue with a passkey" → `next` | pass |
| Sign out → passkey from autofill (conditional UI) → `next` | pass |
| Settings → Emails → change to `e2e-b@` by code → verified | pass |
| Sign out → sign in with `e2e-b@` → same account | pass |
| Account deleted | pass |
| `claude mcp login` (Claude Code 2.1.296, staging MCP): agent link → `/login?next=/connect…` → Create an account → handle + passkey → consent → Allow → ✔ Connected, `whoami` = the new handle | pass |
| The same with email sign-up (code → handle → Skip the passkey) → consent → Allow → ✔ Connected, `whoami` = the new handle | pass |

Every test account (`email-…`) was deleted through Settings → Account; a final query found none left. The capture Worker, its KV namespace and the two routing rules stay for the next run (delete them, or turn Email Routing off for `gitstalk.dev`, when no longer wanted).

### 6.6 Production

Production's `env.jsonc` sets `EMAIL_SENDER_DOMAIN` to `gitstalk.io` and its local secrets file holds a new `EMAIL_SIGNIN_KEY`; nothing was deployed there. To turn it on: `pnpm env:provision production` (applies migration `0007`; the domain is already onboarded), then `pnpm env:deploy production --only web` and `pnpm env:smoke production`. CI deploys read secrets from `GITSTALK_SECRETS_JSON`: run `pnpm env:secrets production --to-github <owner>/<deploy-repo>` first, or provision generates a different key there (harmless before launch: it only invalidates codes in flight).

### 6.7 Rough edges

- The passkey autofill asks for sign-in options on each load of the sign-in start page, which counts against the per-IP passkey limit (10 a minute); a person reloading the page many times in a minute, or many people behind one address, can see "Too many attempts" on the passkey button. Email has its own budgets.
- With Turnstile on, autofill is off (the options request needs a token before anyone has interacted); the button and email still work.
- An account has one address: Settings changes it rather than adding a second.
- The table `magic_links` is unused and stays until a later migration drops it, so a deployment still running older code during a rollout keeps working.

## 7. Not done, and why

- **Gateway staging not redeployed.** The staging gateway hosts other agents' live races (its RunDOs would pick up this branch's code mid-race, and its container image would rebuild). `verifyGitCredential` and `/v1/whoami` are covered by Miniflare tests (5) instead. Deploying it needs only the `IDENTITY_DB` binding added to the staging template.
- `beanstalk-web-staging` was redeployed from this branch (previous version `17a5b302`, deployed by another agent at 06:56Z; `wrangler rollback` restores it).
- Not in this change: orgs/teams, a separate identity Worker. Since done: the six-digit email code (§6), Turnstile, the plugin's OAuth `.mcp.json`, Home and product events (§10); repository-scoped authorization (`20`, `22`).

## 8. Tests

| Package | New tests | What |
|---|---|---|
| `shared-identity` | 33 | passkey sign-up/sign-in/add/remove with a software ES256 authenticator (real CBOR and DER), wrong origin, challenge expiry and single use, handle races; sessions (sliding, revoke, everywhere, CSRF); tokens (hash at rest, scopes, expiry, revoke, ownership, session tokens die with their client); the real rate-limit binding; handles; same-origin checks |
| `mcp` | 25 | discovery metadata and the 401 challenge, DCR, authorize → consent → token, wrong/missing PKCE, code replay, refresh, revocation, deny, consent claimed by one person, connected sessions and revoke (with session git tokens), redirect-URI fuzz, PATs on `/mcp`, run tokens still routed to the old path |
| `gateway` | 5 | `verifyGitCredential` for run, personal and session tokens; `/v1/whoami`; user tokens refused on race repos |
| `web` | 4 | safe `next` paths, relying party, cross-site refusal |
| `shared-identity` (2026-10-11) | 17 | email codes (`test/email-sign-in.test.ts`): the agreed text, HMAC-only storage, single use, spaces typed in a code, the asking browser's ticket only, ten-minute expiry, five tries then refused, five codes an address an hour, sign-in and Settings codes kept apart; no enumeration (same answer and same mail for a known and an unknown address); existing account signed in with a session like a passkey's and audited `method: email`; new address → pending sign-up → account with the address verified; forged, foreign-key or expired pending sign-ups refused; taken, retired handles refused; a second tab's account signed in; Settings add then sign in; an address another account has refused |
| `web` (2026-10-11) | 5 | `next` kept on the code, handle and passkey steps; mode kept; a `next` that leaves the site never carried; step errors and tries read, junk ignored |

## 9. Connecting git

Added 2026-10-07 on the worktree branch after `068fd97`. **The problem (Coop, live):** he signed up with a passkey kept in 1Password, then `git clone` asked for a user name and password. Git over HTTPS only knows Basic credentials, and a passkey cannot be typed into a terminal.

**Owner decisions, in order:** an OAuth credential helper (dropped), SSH-signed HTTPS passwords (dropped), then the final design: **real SSH for keys** (another agent builds the SSH endpoint: Spectrum → Worker `connect()` → container SSH server, key auth against the keys below), set up **entirely through Claude** with the plugin, no separate CLI. Until the SSH endpoint is live, setup finishes with HTTPS and a token and says so.

### What a person runs

```bash
claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk && claude "/gitstalk:setup <owner>/<repo>"
```

`claude "/gitstalk:setup …"` runs the plugin command as the session's first prompt (checked with Claude Code 2.1.x; a folder Claude Code has not seen first asks to trust it). The command (`commands/setup.md` in the plugin repository, coop-collective/gitstalk-plugin) drives the bundled script `scripts/gitstalk-setup.sh` (POSIX sh: macOS, Linux, WSL, Git Bash; `gitstalk-setup.ps1` for PowerShell):

1. `detect`: platform, `ssh-keygen` (OpenSSH), browser opener, whether headless, the deployment's git origin and SSH host (`GET <web>/api/setup`), the git credential helper already set for that host, and one `option` line per key: the **1Password SSH agent** (`~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`, `~/.1password/agent.sock`, Windows' `\\.\pipe\openssh-ssh-agent`), the running **ssh-agent** (`ssh-add -L`), **`~/.ssh/*.pub`**, and **generate**.
2. Claude asks one question (AskUserQuestion) listing them, 1Password first; "Other" lets the person say what they want. With nothing found it generates `~/.ssh/gitstalk_ed25519` (no passphrase, since a script cannot type one; `ssh-keygen -p` adds one).
3. `register`: sends the **public key** and the machine's name to `POST <web>/api/ssh-keys/request` (rate limited per IP) and gets an eight-letter code (RFC 8628 alphabet) and a poll secret. With a browser (`open`, `xdg-open`, `$BROWSER`, `wslview`, `start`; not over SSH, not on Linux without a display) it opens `<web>/settings/keys/add?code=…`; otherwise it prints the URL and code for another device. The page (styled as the agent consent screen) shows the machine, key type, code and **fingerprint** to compare with the terminal; the signed-in person clicks Add key (a passkey only when signed out). The script polls `POST /api/ssh-keys/poll` until approved, denied or expired (ten minutes).
4. While `SSH_HOST` is empty, the first approved poll also hands over, once, a personal token "git on <machine>" (read and write, 90 days). The script gives it to **git's own credential helper** for the Gitstalk host: the one git already uses (macOS: `osxkeychain` from the system config), else `osxkeychain` / `manager` / `libsecret` / `store` scoped to `credential.https://<gateway>/.helper` only (an empty value first, so other helpers are not consulted for that host). The token is never printed. **Removing the key in Settings revokes that token too** (it is minted with `oauth_client_id = ssh-key:<id>`).
5. `remote <owner>/<repo>` clones (or re-points `origin`): `ssh://git@<SSH_HOST>/<owner>/<repo>.git` once SSH is live (and an `~/.ssh/config` block for that host only, with `IdentityAgent` for an agent key), HTTPS until then. `verify` calls `/v1/whoami` with the stored credential and `git ls-remote` on the repository.

Other agents: `curl -fsSL <web>/setup.sh | sh -s -- detect` (the web serves the plugin's scripts with its own address filled in; `<web>/setup.ps1` for Windows), steps in `AGENTS-snippet.md`.

### The three ways in, on the repository start page

| Tab | For | What it shows |
|---|---|---|
| **Plugin** (default) | People with Claude Code, Codex | the line above with this repository; Codex's `mcp add` line and what to ask it |
| **HTTPS** | git by hand | `git clone <url>`, a token from Settings, Tokens at git's password prompt; the token-in-URL form as a last resort, with why not (plain text in `.git/config` and shell history) |
| **Env vars** | CI and scripts | the owner makes a **deploy token** right there; the block below is filled in with it (shown once) |

```bash
export GITSTALK_TOKEN=bsd_…        # deploy token for this repository
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='credential.https://<gateway host>.helper'
export GIT_CONFIG_VALUE_0='!f() { echo "username=x"; echo "password=$GITSTALK_TOKEN"; }; f'
# or, as a header: GIT_CONFIG_KEY_0='http.https://<gateway host>/.extraheader'
#                  GIT_CONFIG_VALUE_0="Authorization: Bearer $GITSTALK_TOKEN"
```

`GIT_CONFIG_*` needs git 2.31+. It is for clean machines: on a machine that already has a helper for the host, git asks that helper first.

### Deploy tokens

`bsd_…`, stored hashed in the **gateway's FORGE D1** beside the registry (`gateway/migrations/0002_deploy_tokens.sql`), so a token follows its repository through a rename and dies with it. One repository, `read` or `read`+`write`, 7/30/90/365 days, last use (time and a coarse "US · git/2.53.0"), revoke; made and listed by the owner only (repository Settings → Deploy tokens, and the Env vars tab). `verifyGitCredential` maps one to the repository's engine (like a run's `git` token, so `mayUseEngine` opens that engine only), with the scopes of its access, pushing as the person who made it. RPC: `DeployTokensRpc` (`shared-race/deploy-tokens.ts`) on the gateway entrypoint.

### What git shows without a credential

Measured with git 2.53: for a **401**, git first prompts `Username for 'https://…':` (or, with `GIT_TERMINAL_PROMPT=0`, fails with `could not read Username … terminal prompts disabled`) and **never shows the `WWW-Authenticate` realm**; once a credential was sent and refused, git prints a `text/plain` body as `remote:` lines before `fatal: Authentication failed`. A **403** body is printed at once with no prompt, but 403 would stop git asking credential helpers, so repositories keep 401 (race URLs keep their old texts). The body (`gateway/src/auth/connect-hint.ts`) names the three ways in:

```
remote: Gitstalk: this git is not connected to your account yet. Pick one:
remote:   1. Claude Code (easiest): /gitstalk:setup
remote:      not installed? claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk
remote:   2. HTTPS: make a token at <web>/settings/tokens and paste it at git's password prompt
remote:   3. CI and scripts: a deploy token in GITSTALK_TOKEN (the repository page, tab "Env vars")
```

(For a refused credential the first line reads "that credential was refused (expired, revoked, or not for this repository)".)

### For the SSH endpoint

`findUserByKey(env, { fingerprint } | { blob } | { publicKey })` after the SSH userauth signature check, then `touchKey`. Keys: ed25519, ECDSA P-256/384/521, RSA ≥ 2048 bits; `sk-` (security-key) types are refused for now. A key is on one account at a time (unique fingerprint among live keys). `SSH_HOST` in the web's vars turns setup over to SSH: `/api/setup` reports it, setup stops asking for an HTTPS token and writes ssh remotes.

### Verified

- **Tests:** `shared-identity/test/ssh-keys.test.ts` (key parsing with fingerprints `ssh-keygen -l` printed for ed25519, ECDSA 256/384/521 and RSA; refusals; `findUserByKey` by fingerprint, blob and line; `touchKey` once a minute; removal; one account per key; requests: approve, code claimed by the first viewer, deny, expiry, HTTPS token delivered once and revoked with the key). `gateway/test/deploy-tokens.test.ts` (read vs write, other repositories 404, push refused for read, last use recorded, whoami, revoke, expiry, repository deleted, owner-only, the 401 hint texts). `web/src/setup/setup-api.test.ts`, `repositories.test.ts` (plugin line, Env vars block). Script tests `test/setup-tests.sh` in the plugin repository (27 checks then; the web's canonical copy of the scripts is `web/src/setup/scripts/`, a fake Gitstalk with `git http-backend`, throwaway agents and keys in a throwaway HOME, `GIT_CONFIG_NOSYSTEM`, store helper, never the person's keychain or agent): macOS (git 2.53), Debian 12 (dash), Ubuntu 24.04, Alpine (busybox sh); `setup-tests.ps1` (13 checks) in PowerShell 7.4 on Linux. **Real Windows was not tested.** `pnpm check` exits 0.
- **Staging** (`beanstalk-{gateway,web,mcp}-staging-cred`, D1 `beanstalk-identity-staging-cred` / `beanstalk-forge-staging-cred`, KV `beanstalk-oauth-staging-cred`, Artifacts `beanstalk-race-staging-cred` / `beanstalk-repos-staging-cred`): headless Chrome with a CDP virtual authenticator, the script in an isolated HOME with a throwaway "1Password" agent: **24 of 24** — sign-up, repository, Plugin/HTTPS/Env vars tabs (tab remembered), deploy token from the Env vars tab used by both env forms, git with no or a refused credential (hint as `remote:` lines), detect lists the agent key, register opens the page with the same fingerprint, Add key, token stored and never printed, clone, verify, `git push -o wait` LANDED, Remove in Settings → next git command refused with the hint, device code approved from a second browser holding the same passkey, push lands again, deploy token revoked in repository Settings → refused, repository deleted.
- **Live** (2026-10-07, no race running; D1 migrations `beanstalk-forge` 0002 and `beanstalk-identity` 0002 applied first; gateway `1cda4d87`, web `4e61b89d`, MCP `aa349222`; Wrangler secrets left as they were, `ADMIN_TOKEN` answers 200 before and after): the same walk-through, **25 of 25**, including no sideways scroll at phone width; the bean landed in 23.7 s. It ran as a new account `cred-smoke-live2` because the existing `beanstalk-smoke` passkey lived in an earlier session's virtual authenticator and cannot sign in any more. A first attempt as `cred-smoke-live` stopped after creating `cred-smoke-live/greeter` (a test-harness wait, not the product); that repository and the two accounts are left for Coop to delete.

### Rough edges

- **Git over SSH itself is not live**; until `SSH_HOST` is set, setup's HTTPS token is what git uses (90 days, then run setup again). The key is registered now, so switching is `remote` once more.
- After a key or token is removed, the **first** git command shows the hint; git then erases the stored credential, and the next one in a terminal asks `Username for …` (git's behaviour for a 401) before showing the hint again.
- With 1Password's agent, listing keys needs 1Password unlocked; signing (once SSH is live) will ask 1Password to approve per its settings.
- Windows: `gitstalk-setup.ps1` is tested in PowerShell 7 on Linux only.
- Generated keys have no passphrase (said in the output, with the command to add one).

## 10. Phase 1 polish: Turnstile, the plugin line, Home, product events

Built 2026-10-07 on a worktree branch from `prototype` at `b58cf65`: backlog `16` items 1.4, 1.6, 1.7 and the Turnstile half of 1.2. Email sign-in came later (§6).

### 10.1 Turnstile on sign-in and sign-up

- **Where:** `/signup` and `/login` render a managed widget (explicit rendering, `components/account/turnstile.tsx`, one widget id per form, reset after every try because a token is redeemed once). The passkey `options` step sends the token as `turnstile`; the email forms send Turnstile's own `cf-turnstile-response` field. Adding a passkey (signed in) and the `verify` step (bound to the options step's challenge) take none.
- **Server:** `@gitstalk/shared-identity/turnstile` (`verifyTurnstile`): POST to Siteverify with the secret, the token and the client IP, a 10 s timeout; `success`, `action` equal to the surface's, and `hostname` in the allowlist (`TURNSTILE_HOSTNAMES`, default the request's own host) are all required; a network error, a non-2xx or an answer that does not parse fails closed (503 "the human check is not answering"); anything else refused is a 403 with "Complete the check above, then try again." It runs after the existing rate limit, so a flood is limited before it costs Siteverify calls.
- **Config:** `TURNSTILE_SITE_KEY` (var, public), `TURNSTILE_SECRET_KEY` (Wrangler secret, read only in `web/src/auth/turnstile.ts`), `TURNSTILE_HOSTNAMES`, `TURNSTILE_TEST_KEYS`. Cloudflare's test keys answer without an action and with `hostname: example.com` (and `metadata.result_with_testing_key`), so their results are accepted only with `TURNSTILE_TEST_KEYS=allow` (staging) and refused everywhere else: a test secret left on live cannot open sign-in.
- **Live today:** off (empty site key), so nothing changes on live until Coop creates the widget (§10.5).

### 10.2 The agent line (1.4)

- **`/signup/agent`** (web) prints one block per harness: Claude Code, Codex, Cursor, Gemini CLI, any MCP client, each with Copy. On the hosted deployment (its `MCP_URL` equals the plugin's) Claude Code and Codex get the plugin line; any other deployment gets `mcp add` lines for its own address (the plugin would connect to the hosted server). Signed out it is the sign-up page; signed in it says "Connect another agent". Commands live in `web/src/setup/agent-installs.ts`; the marketing site's picker (`site/public/site.js`) carries the same text.

```bash
claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk && claude mcp login plugin:gitstalk:gitstalk
codex plugin marketplace add coop-collective/gitstalk-plugin && codex plugin add gitstalk@gitstalk && codex mcp login gitstalk
```

- **`.mcp.json` fix:** the plugin's URL was `${BEANSTALK_MCP_URL:-https://…/mcp}`. Claude Code expands that; **Codex 0.160 does not** (`codex mcp login gitstalk` failed with "invalid MCP server URL `${BEANSTALK_MCP_URL:-…}`", reproduced against the public marketplace). The URL is now literal, with no auth header; `web/src/setup/agent-installs.test.ts` reads the file and keeps it equal to the web's constant. Another deployment adds its own server (`claude mcp add --transport http gitstalk <url>`).
- **Cursor and Gemini CLI** lines follow those clients' documented MCP OAuth (`cursor-agent mcp login`, Gemini's `/mcp auth`); they were not run here and are marked so on the page and the site ("untested").
- **Marketplace:** since 2026-10-11 the plugin and its marketplace are their own public repository, `coop-collective/gitstalk-plugin` (default branch `main`, `.claude-plugin/marketplace.json` lists the plugin at the root, `source: "./"`); both CLIs install from it (plugin 0.9.0). Until 2026-10-15 this repository kept a `.claude-plugin/marketplace.json` whose one entry pointed there (`source: {source: "url", url: "https://github.com/coop-collective/gitstalk-plugin.git"}`; the `github` source type clones over SSH and fails without a GitHub key, the HTTPS `url` type does not), so installs made from `disturbing/beanstalk` could move to the new home (it is now removed; an install from the old marketplace re-adds `coop-collective/gitstalk-plugin`): Claude Code with `claude plugin marketplace update gitstalk` and `claude plugin update gitstalk@gitstalk` (verified 0.8.0 to 0.9.0, Claude Code 2.1.296), Codex with `codex plugin marketplace upgrade gitstalk` and `codex plugin add gitstalk@gitstalk` (verified, Codex 0.162.0). It may move to a `gitstalk` organisation later (§10.5).

### 10.3 Home (1.6)

- **First steps:** "Get started" lists connect an agent session, create or import a repository, push a first bean, each ticked from facts Home already has (sessions, repositories, a repository whose engine grew a bean); the panel goes once all three are done (`web/src/home/first-steps.ts`). New accounts land on Home after sign-up (it was Settings).
- **The demo repository** (`demo/beanstalk-shop`, the recorded v2.5 run) is a row in "Your repositories" for everyone, with a `demo` pill.
- **Your sessions within 5 s:** connected agents come from the MCP Worker's grant list, which is a KV list and can lag a new grant by up to a minute. `withSettlingSessions` (`shared-identity/agent-sessions.ts`) adds approvals from the last two minutes from the `oauth.grant` audit rows in D1 (read-your-writes) that the list does not show yet and no later `oauth.revoke` undid; they show as "connecting" (Settings shows them without Disconnect until the grant id is known). Home's panel asks `GET /api/sessions` every 3 s until a session is connected and settled, then every 30 s, only while the page is visible. Measured on staging: the Claude Code session appeared on an open Home **2.9–3.6 s** after Allow (three runs), without a reload.

### 10.4 Observability and product events (1.7)

- **Logs:** people and sessions are logged as `user_id` / `session_id` = `h_` + 16 hex of SHA-256 (`logIdentity`, `hashedId` in `shared-identity/product-events.ts`): web sign-up and sign-in, consent decisions, repository created; every OAuth request in the MCP Worker (`mcp session request`, session = the OAuth client); a bean pushed in the gateway (session = the credential).
- **Analytics Engine** dataset `product_events` (binding `PRODUCT_EVENTS` in web and gateway), one point per event: `index1` and `blob2` the hashed user, `blob1` the event, `blob3` a short detail, `double1` 1. Events: `signup` (detail `passkey`), `connect` (the client's name, e.g. "Claude Code"), `repo_create` (`template`, `empty` or `import`), `bean_push` (the credential kind). "First repository" and "first bean" are the distinct people per event. A missing binding records nothing; a failing write never fails the request.
- **Admin read:** `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm product-events [--days 30] [--dataset product_events]` (`scripts/product-events.mjs`; the token needs Account Analytics Read). The SQL:

```sql
SELECT blob1 AS event, SUM(_sample_interval) AS events, COUNT(DISTINCT blob2) AS people
FROM product_events WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY event
```

### 10.5 What Coop decides or does

1. **Turnstile on live:** create a managed widget for `beanstalk-web.devaccounts-1password.workers.dev` (and later the product domain) in the dashboard or with `wrangler turnstile widget create`, put its site key in `packages/web/wrangler.jsonc` `TURNSTILE_SITE_KEY`, and `wrangler secret put TURNSTILE_SECRET_KEY` on `beanstalk-web` (from the widget, never in the repo). Leave `TURNSTILE_TEST_KEYS` empty on live. Put the secret first: until both are set, Turnstile stays off (a site key alone does not lock anyone out).
2. **The plugin's home** (decided 2026-10-11: `coop-collective/gitstalk-plugin`, plugin at its root; the rest of this item is the earlier analysis): keep `disturbing/beanstalk` or create an organisation repository (the backlog's `beanstalkdev/beanstalk-plugin`). For a separate repository: copy `packages/claude-plugin` to the new repository's root as `plugins/gitstalk/` (or its root) with a `.claude-plugin/marketplace.json` whose `plugins[0].source` points at it (`name: gitstalk` for both marketplace and plugin keeps every command unchanged); then change `PLUGIN_MARKETPLACE` in `shared-race/src/plugin.ts` and `PLUGIN_REPO` in `site/public/site.js`. No repository was created here.
3. **Merge and push this branch** to `prototype` (the public default branch): until then the public marketplace still serves the `${BEANSTALK_MCP_URL:-…}` URL, so the Codex line fails at `codex mcp login` (Claude Code's works already).
4. **Deploy live** web (vars and the `PRODUCT_EVENTS` binding), gateway (`PRODUCT_EVENTS`) and MCP (log fields). No D1 migration is needed.

### 10.6 Verified

- **Tests:** `shared-identity/test/turnstile.test.ts` (setup on only with both keys, off with either missing; the gate never asks Siteverify while off and requires a good token when on; success with secret and IP sent, missing and oversized tokens never sent, refused, wrong action, wrong host, test keys only when allowed, Siteverify down/throwing/nonsense fails closed), `test/product-events.test.ts` (hashed points, no raw id, no binding, failing binding, log fields; settling sessions shown until the list has them, dropped after revoke or after two minutes, never another person's) with real D1; web `src/home/first-steps.test.ts`, `src/setup/agent-installs.test.ts` (the plugin's `.mcp.json` is literal, no header, equal to the web's constant; per-deployment lines). `pnpm check` exits 0.
- **Staging** (`beanstalk-{web,mcp,gateway}-staging-acct`, D1 `beanstalk-identity-staging-acct` and `beanstalk-forge-staging-acct`, KV `beanstalk-oauth-staging-acct`, Artifacts `beanstalk-race-staging-acct` / `beanstalk-repos-staging-acct`, dataset `product_events_staging_acct`, Turnstile test keys), headless Chromium with a CDP virtual authenticator, real Claude Code 2.1.292 and Codex 0.160.1 in isolated config directories (pseudo-terminals): **22 of 22**, run before and again after merging `origin/prototype` (MCP repository tools, repository tabs) into this branch (`exp/accounts-polish/e2e-results.json` is the post-merge run): sign-up options without a token 403, with a token 200, sign-in options without a token 403; `/signup/agent` lines for the deployment; sign-up through the widget and a passkey lands on Home; 0 of 3 with the demo row and no sessions; `claude mcp login` → consent → Allow → **the session on the open Home in 2.9 s**, `claude mcp list` ✔ Connected; `codex mcp login` → Allow → exit 0, OAuth; a scripted DCR + PKCE client with `write`: `whoami` names the person; New repository → 2 of 3; `git_credentials(repo)` (doc 23) mints a `bss_` credential; clone and `git push -o wait` of `bean/readme-line` validated on the stalk → the checklist is gone; no sideways scroll at 390 px on Home, `/signup/agent`, Settings. Then with the always-fail test secret: sign-in refused (403) with the message (`12-login-turnstile-refused-day.png`). `pnpm product-events` on the staging dataset counted the walk-throughs, and `wrangler tail` showed hashed `user_id`/`session_id` on an OAuth request (`exp/accounts-polish/evidence.txt`).
- **The verbatim lines against live, up to the browser only** (`exp/accounts-polish/plugin-check.txt`): Claude Code installed the plugin from the public marketplace and `claude mcp login plugin:gitstalk:gitstalk` printed an authorization URL that redirects (302) to the live web's `/connect`; Codex with this branch's marketplace (local path) installed the plugin and `codex mcp login gitstalk` did the same. No account was created and nothing approved on live.
- Screenshots: `exp/accounts-polish/01-…12-*.png` (night, day, phone).
- **Torn down** after the runs: Workers `beanstalk-{web,mcp,gateway}-staging-acct` and the container application `beanstalk-gateway-staging-acct-runner`, D1 `beanstalk-identity-staging-acct` and `beanstalk-forge-staging-acct`, KV `beanstalk-oauth-staging-acct`, the three repositories in Artifacts `beanstalk-repos-staging-acct` (Wrangler cannot delete an empty namespace; `beanstalk-race-staging-acct` was never created). The Analytics Engine dataset `product_events_staging_acct` cannot be deleted; its points expire with Analytics Engine retention.

### 10.7 Rough edges

- Before the merge with the MCP repository tools (`23`), a deployment with no runs answered every OAuth `/mcp` request 404 "no run to read yet" (the first staging runs set `DEMO_RUN`); the post-merge run needed no `DEMO_RUN`.
- Settling sessions are matched to listed grants by client and a 30 s window; two approvals of the same client within 30 s show as one until the list catches up.
- The Turnstile test widget says "For testing only" on staging, as Cloudflare draws it.

## 11. Platform admins and the admin area (2026-10-10)

Owner: "remove the 'look at races' stuff from what normal users see and put it behind an admin panel."

- **Who.** The web Worker's `PLATFORM_ADMINS` var: comma-separated handles, any case, a leading `@` allowed; empty (the template's default) means nobody. `isPlatformAdmin(user, configured)` is in `packages/web/src/admin/platform-admins.ts`; the server gate (`requirePlatformAdmin`, `platformAdminOf`, `redirectToAdmin`) in `src/admin/admin-gate.ts`. To make someone an admin, set `overrides.web.vars.PLATFORM_ADMINS` in `environments/<env>/env.jsonc` (or in `GITSTALK_ENV_CONFIG`) and deploy the web package (`30` §3, §4). It is a var, not a secret: handles are public. Admin follows the handle, so renaming an admin account drops admin until the var is updated.
- **Where.** `/admin` (the handle `admin` is reserved): an overview (people, disabled accounts and organizations counted from `IDENTITY_DB`; repositories are not counted because the registry has no count call), Benchmark runs (`/admin/runs`, the old landing), Watch the race (`/admin/race`), each run's repository, Files and Engine (`/admin/runs/<run>…`), and the demo gate (`/admin/demo-gate`). Admins reach it from "Admin" in the account menu.
- **Everyone else** gets the ordinary 404 on every admin page, never a 403. The old URLs `/race`, `/races` and `/runs/<run>…` send an admin to the same admin page (the query is kept, so a gateway `live_url` with `?key=` still works) and 404 for anyone else. `/api/runs/<run>/…` (live events, stream diffs, bean diffs) answer admins only. A repository's own feed, `/api/repos/<owner>/<repo>/live`, is unchanged.
- **Demo gate.** Opening it now needs an admin as well as `DEMO_PASSWORD`, and a race's decision card needs both. A repository's cards stay with its maintainers. The login page no longer shows the gate, and the header's "Close demo gate" moved to the gate's page.
- **Gone for normal users.** The header's "Benchmark runs" and "Watch the race", the login page's demo-gate section, the 404's "reaped after its race", Home's `demo/beanstalk-shop` row, and the signed-out benchmark landing at `/` (where the site does not answer `/`, the app now sends you to sign in).
- **Tests.** `src/admin/*.test.ts` cover the handle rule and the old-URL mapping. They also scan `app/` to check that every admin page, run API and old URL goes through the gate, and that no page or component outside the race views links to a race.
- **Left.** The MCP `preview_url` links (`bean_status`, `repo_status`, `ask_repo`) still point at `<web>/runs/<run>`. These are race runs, so they now 404 for non-admins. The marketing site keeps its own "The race" section and its `#race` nav anchor, neither of which links into the app.

