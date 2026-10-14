# 35. Caching the repository UI

2026-10-14, branch `repo-ui-caching`. What is cached where, for how long, and why private repositories never reach a shared cache. Code: `packages/web/src/query/` (browser), `packages/web/src/edge/` (edge and headers). Summaries in the web and gateway READMEs, section Caching.

## 1. Facts the design rests on

- **A Worker runs in front of Cloudflare's cache.** The CDN does not store a Worker's own response because of its `Cache-Control`; `s-maxage` there only reaches downstream proxies, which is a hazard for per-viewer data. Edge caching is explicit Worker code (Cache API, KV). Response headers speak to the browser only.
- **Cache API rules.** `cache.put` refuses a response with `Set-Cookie` and does not store `private` or `no-store` responses. It does nothing on `*.workers.dev` (production needs the custom domain). `cache.delete` purges only the current colo.
- **The gateway RPCs do not authorise.** `repoTree`, `repoFile`, `repoLog` and `repoDiff` trust the engine id; the web app checks access before every call.
- **Events already say when a head moves.** `land` carries `sha` and `target` (`trunk` is the sprout, `main` the stalk in queue mode), `green.promote` carries the new stalk `sha`, `revert` and `sprout.reset` the new sprout `sha`.
- **The gateway already caches every repository's objects** (the RunDO read index, `gateway/src/repo/object-cache.ts`), with a 5 s ref memo that a landing clears.

## 2. Classes of data

| Class | Members | Browser (TanStack Query) | Edge | Purge |
|---|---|---|---|---|
| **A. Immutable by sha** | tree at a sha, file at (sha, path), README at a sha, the diff of a (base, head) pair, a validated bean's diff, a finished job log, a finished run | `staleTime: Infinity`, `gcTime` 1 h, persisted for public repositories | isolate, then Cache API (per colo), then KV (global); public repositories only; read only after a fresh access check | None: the content cannot change. `EDGE_CACHE_VERSION` handles format changes; TTLs bound storage |
| **B. Mutable repository state** | line heads, the pushed beans, bean status and verdicts, the open count, an open bean's head pair, the runs list, a running run | `staleTime` 30 s; invalidated by live events (§5) | Not cached at the edge | Live events invalidate keys; gaps and reconnects refetch the events and the pushed beans |
| **C. Append-only** | the engine event log (by `seq`) | `Infinity` while the feed is live (appended by `appendBySeq`), 15 s otherwise; persisted for public repositories | The existing per-isolate `EventCache` (public only) | Its anchor check |
| **D. Per-viewer** | session, access verdict and role, CSRF token, page HTML, home panels, settings | Memory only, never persisted | **Never shared at the edge** | A viewer change clears the cache and the stored copy |
| **E. Streams** | `/api/repos/*/live`, `/api/runs/**/live`, `streams`, a bean `stream`, a job log's SSE | n/a | **Never cached** (`no-store`) | n/a |

## 3. Privacy decision

**The shared edge caches hold only public repositories' content-addressed objects, and every request still runs the viewer's access check before it reads them.**

Why not cache every repository behind the access check:

1. With private objects in a colo-wide cache, one future code path that reads the cache before the access check is a leak, and an invisible one, since no auth runs on a hit. Public-only makes such a bug harmless.
2. The gain for private repositories is small: the gateway's read index already serves their trees and blobs without Artifacts, so the edge would save one RPC and one DO hop. The browser's memory cache covers repeat views by the same person.
3. Visibility flips need no purge. Public to private: old entries stay but are unreachable, because the access check answers 404 and `PublicEngine.of` returns null. Private to public: nothing was cached.
4. `internal` counts as private.

Enforcement in code:

- Every edge function takes a `PublicEngine` (`src/repo-pages/event-cache.ts`), never a bare engine id. Only `PublicEngine.of(record, engine)` makes one, from the record `repositoryPage`, `viewerRepoAccess` or `runAccess` returned on this request.
- Keys hold the engine id, the shas and the path, nothing about the viewer, which is correct only because of the public-only gate. Keys take a `Sha`, never a ref name.
- Anything carrying the viewer is `private`; nothing sets `Vary: Cookie` or `s-maxage`. Page HTML keeps vinext's dynamic behaviour.
- The access check itself is not cached across requests (§9, deferred).

## 4. Stores

| Store | Used for | Not for | Why |
|---|---|---|---|
| **Isolate memory** (`object-cache.ts` LRU, 16 MB; `EventCache`) | Layer 1 for class A, public only; the public event log | anything that must survive a cold isolate | Free and fastest; measured like the other layers |
| **Cache API**, named cache `gitstalk-objects-v1` | Layer 2 for class A, public only: trees, files, diffs | B, C, D, E | Per colo, free, no consistency question for immutable keys; stored copies are `public, max-age=604800` |
| **KV**, binding `OBJECTS` on the web Worker | Layer 3 for class A, public only, values up to 1 MiB | heads, the pushed list, access verdicts, anything a pusher must see right after writing it | Global, so a new colo is warm; eventual consistency does not matter for immutable data; one write per object; `expirationTtl` 30 days |
| **Gateway read index** (exists) | Layer 4 for every repository, private included | | Authoritative for objects |

The binding is templated like every KV id (`local-gitstalk-objects`, docs/claude-opus/30 §3.2), so `pnpm env:provision <env>` creates `gitstalk-objects<suffix>` and records its id. **An existing environment must run provision once before its next deploy**; until then config generation stops with "no id for kv gitstalk-objects-…".

Read path for a class A object: run the access check; `PublicEngine.of(record)` (null: read through the gateway as before); otherwise isolate, Cache API, KV, gateway. A hit fills the layers above it; a gateway read fills all three, the Cache API and KV through `waitUntil`. Only a successful read is stored, never a not-found or an error. A failing layer is logged and read as a miss.

## 5. Browser

### 5.1 Query keys (`src/query/keys.ts`, all viewer-scoped)

`qk.repo(uid, owner, repo)` has `all`, `events()`, `pushed()`, `bean(name)`, `run(id)`, and now `jobLog(run, job)`, `runs(filter)`, `diff(base, head)`, `tree(sha)`, `file(sha, path)` and `tail(seq)` (the events after a seq, for the head watcher). `bean(name)` stays the bean's diff on day one.

### 5.2 Freshness policy (`src/query/policy.ts`)

| Class | `staleTime` | `gcTime` | `meta.persist` |
|---|---|---|---|
| `immutable` | `Infinity` | 60 min | `visibility === 'public'` |
| `appendOnly` | `Infinity` live, 15 s otherwise | 60 min | `visibility === 'public'` |
| `mutable` | 30 s | 10 min | false |
| `perViewer` | 30 s | 10 min | false |

`refetchOnWindowFocus` stays on and is a no-op for `Infinity`: cached data renders immediately and is refetched in the background only when stale. An invalidation still refetches an immutable query (a requeued bean that lands again). Applied in `useChangesFeed` (events, pushed), `BeanDiff` (immutable once its landing is in the events) and `RunStatus` (immutable once finished, refreshing the page once per run).

### 5.3 Persistence

sessionStorage only (the data ends with the tab), buster `BUILD_ID:viewer`, cleared on sign-out. Only public repositories' immutable and append-only queries; `PERSIST_MAX_AGE_MS` is 60 minutes and persisted queries keep `gcTime` at least that long.

### 5.4 Invalidation map (`src/query/invalidation.ts`, `staleKeysFor`)

| Fresh events in a batch | Action |
|---|---|
| any | appended to `events()` by `appendBySeq` (no refetch) |
| a push, verdict, landing… (`PUSHED_KINDS`) | invalidate `pushed()` |
| `task.commit` or `land` of a bean on screen | invalidate `bean(name)` |
| `land`, `green.promote`, `revert`, `sprout.reset` moving a line the page shows past the commit it rendered | `router.refresh()` in a transition, now (Code on a line, History) |
| `ci.end`, `final.check`, `decision.made`, `bean.requeued`, `queue.eject` | History: `router.refresh()`, at most every 2 s |
| a gap or a reconnect | refetch `events()` and `pushed()` (`useLiveFeed`'s `onResync`) |
| a run finishes (polled) | the run query turns immutable, one `router.refresh()` |

The head watcher (`components/repo-tabs/use-head-watcher.ts`) holds only the events after the seq the page rendered at (`tail(seq)`, through the existing `live` and `events?after=` routes), so Code and History never ship the whole log. Every event in the tail is newer than the page, so the whole tail is checked: a page restored from the client router cache refreshes at once if its line moved meanwhile. A refresh renders a newer seq and starts a new tail, so it cannot loop. `staleTimes.dynamic` is now 120 s (vinext honours it; `router.refresh()` bypasses it).

## 6. Response headers (`src/edge/http-cache.ts`)

| Route | Condition | `Cache-Control` | Validator |
|---|---|---|---|
| `/api/repos/o/r/events?after=N` | found | `private, no-cache` | `ETag: W/"seq-<last seq>"`; a matching `If-None-Match` gets 304, after the access check |
| `/api/repos/o/r/pushed` | found | `private, no-cache` | none |
| `/api/repos/o/r/*` | 404, 400, 5xx | `no-store` | none |
| the `live` routes, `streams`, `stream`, a job log's SSE | always | `no-store` | none |
| `/api/runs/[run]/beans/[bean]/diff` | bean validated (`green`) | `private, max-age=31536000, immutable` | `ETag: "<base>..<head>"` |
| same | any other bean | `private, max-age=30` | same ETag |
| same | benchmark race (platform admin) | `no-store` | none |
| `…/actions/runs/[run]/jobs/[job]/log?download=1` | job finished | `private, max-age=31536000, immutable` | none |
| same | running | `no-store` | none |
| `…/actions/runs/[run]` | finished | `private, max-age=3600` | none |
| same | running | `no-store` | none |
| repository pages, `/media/**`, `/setup.sh` | | unchanged | |

`fetchJson(..., { httpCache: 'revalidate' })` (request `cache: 'no-cache'`) lets the browser revalidate the events, the watcher's tail and bean diffs with their ETags; everything else keeps `no-store` requests.

Stored Cache API copies carry their own headers (`public, max-age=604800`, no `Set-Cookie`, no `Vary`) and are never handed to a client as they are: routes build their own response.

## 7. Keys (`src/edge/cache-keys.ts`)

- Cache API: `https://<WEB_URL host>/__edge/v1/<engine>/tree/<sha>`, `…/file/<sha>/<encodeURIComponent(path)>`, `…/diff/<base>..<head>`.
- KV: `v1:<engine>:tree:<sha>`, `v1:<engine>:file:<sha>:<sha256(path)>`, `v1:<engine>:diff:<base>:<head>` (paths hashed: KV keys are at most 512 bytes).
- `worker/index.ts` answers `/__edge/*` with a 404 before anything else.
- Purge: never for class A; bump `v1` when a payload changes shape. A deleted or now-private repository's entries are unreachable and expire (7 days per colo, 30 days in KV).

## 8. Measurement

- `edge.read` log per object read through `src/log.ts`: `{ kind, layer: isolate|colo|kv|gateway, public: true, engine, ms }` (no shas).
- `Server-Timing: edge;desc="colo-hit";dur=1.8` on the bean diff route for a public repository. Pages cannot carry it: vinext streams a page's headers before its reads finish, so pages rely on the `edge.read` logs.
- `createEdgeObjectCache(...).stats()`: hits by layer, misses, writes.
- Development only: `QueryProvider` logs `query.fetch` with how often each kind of key was served from the cache or fetched (`src/query/cache-counter.ts`).
- Manual check after deploying to the custom domain: the second load of a public bean diff shows `isolate-hit` or `colo-hit`, and Workers Logs show the `edge.read` layer mix.

## 9. Deferred (each needs measurement or an owner decision)

- An isolate memo of the access check (anonymous viewers and public records only, about 5 s). It needs the owner to accept a 5 s window after a public-to-private flip.
- A KV heads snapshot for signed-out readers of public repositories, written by the gateway's `repo-events` consumer on `bean.landed`, `stalk.promoted` and `bean.reverted`; not for signed-in viewers (read-after-write).
- A gateway `repoSnapshot(run, ref, path)` RPC (the Code tab's four or five RPCs in one).
- Client-side `tree` and `file` queries (the keys exist); moving `BeanDiff` to `diff(base, head)`.
- Edge-caching finished job logs (the key format has room; the Actions control plane reads them, not the engine).
- One SSE for `RunStatus` polling and the job log; one repository SSE shared across tabs (BroadcastChannel).
- A per-tab `loading.tsx` that keeps the owner, the name and the current tab.

## 10. Where this differs from the plan it came from

- **Isolate layer.** The plan kept `"use cache"` as layer 0 above the Cache API. A `"use cache"` hit never enters the function, so it could not be measured, and its arguments (its key) cannot carry a `PublicEngine`. The edge cache has its own isolate LRU instead, measured as `isolate`; `"use cache"` is no longer used for trees and files.
- **Bean diff immutability.** The plan made a diff immutable once the bean landed. A bean landed on the sprout can be reset and requeued with a new pair under the same URL, so the route says `immutable` only once it is validated (`green`). On the client, `BeanDiff` is immutable from its landing, because a later landing still invalidates it through the feed.
- **Head watcher.** The plan reused `useChangesFeed`. That needs the whole event log on Code and History; the watcher holds only the events after the rendered seq, through the same routes and one SSE per view.
- **Server-Timing** is on the bean diff route only (pages stream their headers first).
- **Component tests** drive TanStack's `QueryObserver` (what `useQuery` wraps) under plain vitest; the repository has no DOM testing library.
- **Cache API key host** is `WEB_URL` (the deployment's origin), not the request's host, since reads also happen outside a request's URL.
- The `AGENTS.md` note the plan asked for is moot: `AGENTS.md` already names packages `@gitstalk/*`.
