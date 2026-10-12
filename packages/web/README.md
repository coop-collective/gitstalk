# @gitstalk/web

The Gitstalk web app: repositories, accounts, organisations, settings, Automations and the Ask
explorer, for the people who work alongside agents. It is a [vinext](https://github.com/cloudflare/vinext)
app (the Next.js App Router on Vite) deployed as the Worker `gitstalk-web`. It owns no repository
data: every read and write goes to the gateway over service-binding RPC, and accounts live in
the shared identity database. Git over HTTPS is served on this host too
(`<GIT_ORIGIN>/<owner>/<repo>.git`), forwarded to the gateway.

```
browser ──▶ gitstalk-web (worker/index.ts)
              ├─ SITE      ──▶ gitstalk-site     marketing pages and /docs, when bound
              ├─ GATEWAY   ──▶ gitstalk-gateway  repositories, engine reads, git, live events
              ├─ ACTIONS   ──▶ gitstalk-gateway  (Actions entrypoint) workflows and runs
              ├─ MCP       ──▶ gitstalk-mcp      OAuth consent, connected agent sessions
              └─ IDENTITY_DB (D1), MEDIA (R2), IMAGES, AI
```

Names as everywhere in Gitstalk: a **bean** is one agent's change (branch `bean/<name>`); the
**sprout** is the staged line where a bean lands once its pre-land check passes; the **stalk** is
the stable line that only moves to validated sprout commits. See the public
[overview](../site/public/docs/index.html) and [repositories](../site/public/docs/repositories.html) pages.

## Pages

| Route | What it is |
|---|---|
| `/` | Home when signed in: first steps, your repositories and organisations, invitations, connected agent sessions, recent activity. Signed out, the marketing landing (when `SITE` is bound) or `/login` |
| `/login`, `/signup`, `/signup/agent` | One sign-in flow (`components/account/sign-in-flow.tsx`): continue with a passkey (autofill where supported) or an email and six-digit code; a new address picks a handle, then is offered a passkey; `/signup` also creates an account from a handle and a passkey. Turnstile when configured; `next` is kept on every step. Sign-up through your agent's own OAuth flow |
| `/connect` | OAuth consent for an agent, opened by `gitstalk-mcp`'s `/authorize` |
| `/new`, `/<owner>` | Create a repository; a person's or organisation's page |
| `/<owner>/<repo>` | The start page until the first bean, then the Code tab (`tree`, `blob`) on the stalk |
| `/<owner>/<repo>/ask`, `/files` | Ask, the generated explorer: a question becomes a view spec with removable chips, then a fixed arrangement of files, beans, decisions and checks |
| `/<owner>/<repo>/changes`, `/history`, `/people` | Beans (open, landed, parked) and a bean's detail; stalk and sprout history with validation verdicts; who has access |
| `/<owner>/<repo>/actions`, `/automations` | Workflows and their runs (job logs streamed); automations defined in `.gitstalk/automations/`, with a builder and editor |
| `/<owner>/<repo>/settings/*` | General, visibility, branches, checks, collaborators, deploy tokens, secrets, Actions, social image, danger zone |
| `/orgs`, `/orgs/new`, `/orgs/<org>/settings/*` | Organisations: members, repository defaults, secrets, audit log, danger zone |
| `/settings/*` | Profile, account, emails (add or change the sign-in address by code), passkeys, SSH keys, personal access tokens, sessions, notifications |
| `/setup.sh`, `/setup.ps1`, `/api/setup` | Git setup scripts for agents without the plugin, pointed at this deployment |
| `/<owner>/<repo>.git/...`, `/v1/whoami` | Git smart HTTP and the credential check, forwarded to the gateway |
| `/api/repos/<owner>/<repo>/live` | A repository's new engine events as Server-Sent Events |
| `/media/*` | Uploaded avatars, organisation icons and social images from R2 |
| `/admin/*` | Platform admin area (see below); everyone else gets a 404 |

Design notes: accounts and auth in [19](../../docs/claude-opus/19-accounts-and-auth.md),
repositories in [20](../../docs/claude-opus/20-repositories.md), the repository experience and
Ask in [14](../../docs/claude-opus/14-repository-experience.md) and
[13](../../docs/claude-opus/13-ask-explorer-design.md), Actions and automations in
[25](../../docs/claude-opus/25-actions-and-automations.md), organisations in
[28](../../docs/claude-opus/28-organizations.md), settings in [29](../../docs/claude-opus/29-settings.md).

## How it works

- **Entry.** `worker/index.ts` wraps vinext's App Router handler. When an environment binds
  `SITE` (the site on the same origin, as on gitstalk.io), the marketing paths (`/docs`, root
  `.html` files, `/` when signed out) go to the site Worker. It also answers `robots.txt` and
  `sitemap.xml` and adds security headers to every response.
- **Gateway RPC.** Server components and route handlers read bindings through
  `import { env } from 'cloudflare:workers'` and call the gateway's RPC methods on `GATEWAY`
  (types in `@gitstalk/shared-race`), validating answers with Zod. The gateway does not
  authenticate RPC calls; the binding is the trust boundary, so this app checks the session
  and the viewer's role before every call.
- **Ask** is shared with the MCP server through `@gitstalk/shared-ask`. A deterministic keyword
  router classifies questions by default. A picker orders what a page shows: `"rules"`, or
  `"jev"`, which asks Jev (a classifier model on Workers AI) and falls back to the rules when it
  is slow or off-catalog. Every pick leaves a receipt on the page.
- **Live updates.** vinext cannot hold a WebSocket upgrade, so the `/api/.../live` routes open
  the gateway's WebSocket feed through the binding and stream Server-Sent Events to the browser.

## Client data

Pages render on the server; data a client component reads or keeps live goes through
TanStack Query (`src/query/`). `QueryProvider` (`components/query/query-provider.tsx`) wraps
every page in `app/layout.tsx` with one client per tab, given the viewer's id.

- **Keys** come from `qk` in `src/query/keys.ts` only, and every key holding private data
  carries the viewer (`'anon'` when signed out): `qk.repo(uid, owner, repo).events()`. An
  area's `all` key is a prefix of its queries, for invalidation.
- **Defaults** (`make-query-client.ts`): fresh for 30 s, kept 10 minutes, refetched on window
  focus, no background polling, one retry.
- **Server prefetch**: a server component fills `getServerQueryClient()` (`server.ts`, one per
  request) and passes `dehydrate(...)` to a `HydrationBoundary`.
- **Fetching**: `fetchJson(path, guard, { signal })` (`fetch-json.ts`) reads a same-origin path
  and checks the JSON with a type guard; failures are `FetchJsonError` with a `failure.reason`.
  `schemaGuard` turns a `zod/mini` schema into that guard; client code imports `zod/mini`, never
  `zod`.
- **Live feeds**: `useLiveFeed` (`use-live-feed.ts`) opens a Server-Sent Events feed once the
  query has its snapshot and appends batches with `appendBySeq` (by `seq`: repeats dropped,
  order kept, a gap or a reconnect refetches the snapshot). Its `staleTime` goes to the
  query: `Infinity` while live, 15 s while disconnected.
- **Mutations** stay server actions. `useActionWithInvalidation` wraps `useActionState` and
  invalidates the given keys when the returned state is a success. An action that changes what
  another page shows calls `revalidatePath` or `revalidateTag` (or redirects): the client
  router reuses a page it showed in the last 30 s (`experimental.staleTimes` in
  `next.config.ts`), and only those clear it.
- **Persistence** is opt-in: `meta: { persist: true }` keeps a successful query in
  sessionStorage (`gitstalk-query`) for 15 minutes, for this build and viewer only. Signing in
  or out clears the cache and the stored copy.
- **Server caching**: `cacheForRequest` (`vinext/cache`) memoises a factory per request;
  `keyedForRequest` (`src/server/request-memo.ts`) does the same per key (the access check,
  a tab's engine reads, Ask's data, the header's profile). Prefer it to React's `cache()` for anything a layout reads: vinext
  probes layouts outside React's render, so `cache()` reads twice. `"use cache"` with
  `cacheLife` and `cacheTag` works, but the default cache handler is in memory, per isolate.
- **Status before streaming**: vinext runs the layouts above a route's first `loading.tsx`
  before it streams, and nothing below it; a page under a skeleton can only render a
  not-found page inside a 200. So a 404 or redirect that must be the response's status lives
  either in a layout at or above the loading file, or in a page no loading file encloses:
  - `app/[owner]/[repo]/layout.tsx`: the repository access check (every repository route).
  - `[repo]/(tabs)/`: the skeleton for the tabs with no check of their own (Code, tree, blob,
    Files, People, Actions, Automations, New automation).
  - `[repo]/changes/` and `history/`: a layout redirects home when the engine is unusable
    (`engineTab`), above their skeletons; a bean's page (`changes/[bean]`) has none, so an
    unknown bean is a 404. `ask/`: the layout redirects to the start page until something
    grew (`askPage`), above Ask's skeleton.
  - `[repo]/settings/`: a layout answers 404 to anyone without a role (`settingsAccess`), and
    no skeleton, so a section's redirect is real too. Run pages (`actions/runs/[run]`,
    `automations/runs/[run]`) and `automations/edit/[file]` have no skeleton either.
  - `app/[owner]/(profile)/` (unknown owner), `app/orgs/(list)/` (`/orgs` signed out).

  `src/server/route-tree.test.ts` reads the tree: no layout under a loading file, and no page
  under one calls `notFound`, `redirect` or a status helper unless a layout above the boundary
  made that check first. A query that names something missing inside the explorers (`?bean=`,
  `?file=`) still renders its not-found page inside the stream.
- **Prefetch**: links are `IntentLink` (`components/shell/intent-link.tsx`): they prefetch on
  hover, focus or touch, never because they scrolled into view (each prefetch is a server
  render with its gateway reads).

## Layout

| Path | Contents |
|---|---|
| `worker/index.ts` | Worker entry: site forwarding, search files, response headers |
| `app/` | Routes (thin): pages, route handlers, server actions' forms |
| `components/` | UI by area: `shell`, `repository`, `repo-tabs`, `home` (Ask), `explorer`, `actions`, `automations`, `settings`, `orgs`, `account`, `admin`, plus the benchmark views (`canvas`, `race`, `runs`) |
| `src/server/` | Server actions and page data loaders |
| `src/auth/`, `src/account/`, `src/security/` | Sessions, the sign-in steps (`sign-in-steps.ts`) and email-code routes (`email-routes.ts`), passkeys, Turnstile, sign-out, response headers |
| `src/repositories/`, `src/repo-pages/`, `src/changes/`, `src/history/`, `src/code/` | Gateway clients and the repository tabs' view models |
| `src/actions/`, `src/automations/` | Actions client (gateway or fixture fake), log streaming, the automation builder |
| `src/live/`, `src/stream/` | WebSocket-to-SSE bridges |
| `src/setup/` | Setup scripts (`scripts/`) and their API |
| `src/site/` | Site forwarding, page metadata, `robots.txt` and `sitemap.xml` |
| `src/forge/`, `src/race/`, `src/recorded/`, `src/admin/` | Benchmark runs and the admin gate |
| `fixtures/` | Two recorded benchmark runs (generated, not hand-edited) |

The setup scripts in `src/setup/scripts/` have a twin in the plugin repository
([coop-collective/gitstalk-plugin](https://github.com/coop-collective/gitstalk-plugin), `scripts/`), which
runs the script tests; change both together.

## Develop

```bash
pnpm install                                                # from the repo root
cp packages/web/.dev.vars.example packages/web/.dev.vars    # DEMO_PASSWORD, EMAIL_SIGNIN_KEY; optional Turnstile, email
cd packages/web && npx wrangler d1 migrations apply gitstalk-identity --local   # once, local accounts
pnpm -F @gitstalk/web dev          # vite dev, http://localhost:5173
pnpm -F @gitstalk/web test         # vitest on the app's pure modules (src/**/*.test.ts)
pnpm -F @gitstalk/web typecheck    # tsc
pnpm -F @gitstalk/web build        # vite build into dist/ (the Worker and its assets)
pnpm -F @gitstalk/web preview      # build, then run the built Worker with wrangler dev
pnpm -F @gitstalk/web types        # regenerate worker-configuration.d.ts after a wrangler.jsonc change
```

Local dev is not offline. The `AI` binding is remote (`"remote": true`), so `vite dev` opens a
remote session at start-up: it needs `wrangler login`, and with several accounts
`CLOUDFLARE_ACCOUNT_ID` set, or it fails before serving a page. Nearly every page also needs
the gateway: run `pnpm -F @gitstalk/gateway dev` (and `pnpm -F @gitstalk/mcp dev --port 8788`
for agent consent) in other terminals; Wrangler's dev registry connects the service bindings.
Setting `ACTIONS_SOURCE=fixtures` in `.dev.vars` swaps the Actions control plane for the app's
own fake. Email sign-in works locally with `EMAIL_SENDER_DOMAIN` set in `.dev.vars` (any
domain): Miniflare simulates the `EMAIL` binding, sends nothing, and prints each message's
subject, which carries the code.

The tests run under plain vitest (no Miniflare): view models, the gateway and Actions clients
against fakes, auth helpers, site forwarding and search headers, the setup API, and the
benchmark reducer.

## Configuration

Bindings (`wrangler.jsonc`): services `GATEWAY`, `ACTIONS` (the gateway's `Actions`
entrypoint) and `MCP`; D1 `IDENTITY_DB` (schema in `packages/shared-identity/migrations`);
R2 `MEDIA`; `IMAGES`; rate limit `SIGNIN_RATE_LIMIT`; Analytics Engine `PRODUCT_EVENTS`;
`AI`; Email Service `EMAIL` (`send_email`, sign-in codes); static `ASSETS`. Environments that serve the site on this origin add `SITE`.

Vars: `LOG_LEVEL`, `ASK_CLASSIFIER`, `ASK_AI_MODEL`, `PICKER`, `JEV_GATEWAY`,
`EMAIL_SENDER_DOMAIN`, `TURNSTILE_SITE_KEY`, `TURNSTILE_HOSTNAMES`, `TURNSTILE_TEST_KEYS`,
`GIT_ORIGIN`, `MCP_URL`, `DOCS_URL`, `WEB_URL`, `SEARCH_INDEXING`, `SSH_HOST`,
`SSH_HOST_KEY_FINGERPRINT`, `ACTIONS_SOURCE`, `PLATFORM_ADMINS`. Each is explained in
`wrangler.jsonc`.

Secrets: `DEMO_PASSWORD` and `EMAIL_SIGNIN_KEY` (required; the second is the HMAC key for email
codes and pending sign-ups, generated by `pnpm env:provision`), `TURNSTILE_SECRET_KEY`
(optional; Turnstile is on only with both it and the site key). Email sign-in is on when
`EMAIL_SENDER_DOMAIN` names a domain onboarded to Cloudflare Email Sending (set per
environment in `env.jsonc`; provision onboards it).

Deploy through an environment: `pnpm env:provision <env>`, `pnpm env:secrets <env>`, then
`pnpm env:deploy <env> --only web` (see
[30-environments](../../docs/claude-opus/30-environments.md)). Never `wrangler deploy` the
template; the package's `deploy` script deliberately fails.

## Benchmark runs (admin only)

Handles listed in `PLATFORM_ADMINS` see `/admin`: platform counts, the benchmark runs
(`/admin/runs`, each with a run home, Files explorer and replay canvas), the side-by-side race
(`/admin/race`) and the demo gate for decision cards (`/admin/demo-gate`, which also needs
`DEMO_PASSWORD`). `/race`, `/races` and `/runs/...` redirect admins there
and 404 for everyone else. Recorded runs replay from `fixtures/`, built by
`node research/race/tools/build-fixtures.mjs`; see [research/README.md](../../research/README.md).

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md); run `pnpm check` at the root before sending a change.
