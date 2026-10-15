# 35. Caching the repository UI

2026-10-14, branch `repo-ui-caching`; extended 2026-10-15, branch `cache-private-settings` (§13). What is cached where, for how long, and why private repositories never reach a shared cache (they have their own KV namespace instead). Code: `packages/web/src/query/` (browser), `packages/web/src/edge/` (edge and headers). Summaries in the web and gateway READMEs, section Caching.

## 1. Facts the design rests on

- **A Worker runs in front of Cloudflare's cache.** The CDN does not store a Worker's own response because of its `Cache-Control`; `s-maxage` there only reaches downstream proxies, which is a hazard for per-viewer data. Edge caching is explicit Worker code (Cache API, KV). Response headers speak to the browser only.
- **Cache API rules.** `cache.put` refuses a response with `Set-Cookie` and does not store `private` or `no-store` responses. It does nothing on `*.workers.dev` (production needs the custom domain). `cache.delete` purges only the current colo.
- **The gateway RPCs do not authorise.** `repoTree`, `repoFile`, `repoLog` and `repoDiff` trust the engine id; the web app checks access before every call.
- **Events already say when a head moves.** `land` carries `sha` and `target` (`trunk` is the sprout, `main` the stalk in queue mode), `green.promote` and `green.demote` (a red audit takes the stalk back) carry the new stalk `sha`, `revert` and `sprout.reset` the new sprout `sha`. The list is `LINE_MOVE_TYPES` in `@gitstalk/shared-race/events`, shared by the gateway's read index and the web app's head watcher.
- **The gateway already caches every repository's objects** (the RunDO read index, `gateway/src/repo/object-cache.ts`), with a 5 s ref memo that a landing clears. The repository's derived data (`RepoDerivedDO`) reads its objects through that index too (§12).

## 2. Classes of data

| Class | Members | Browser (TanStack Query) | Edge | Purge |
|---|---|---|---|---|
| **A. Immutable by sha** | tree at a sha, file at (sha, path), README at a sha, the diff of a (base, head) pair, a landed bean's diff while its landing stands, a finished job log, a finished run | `staleTime: Infinity`, `gcTime` 1 h, persisted in sessionStorage for every visibility (§5.3) | Public: isolate, then Cache API (per colo), then KV (global). Private and internal: KV only, under `v1:priv:` (§3). Trees, files, READMEs and diffs; job logs not yet (§9). Read only after a fresh access check | The record's cache epoch (`updated_at`) is in every key: any change to the record makes old copies unreachable (§7). `EDGE_CACHE_VERSION` handles format changes; TTLs bound storage (30 days public, 7 days private) |
| **B. Mutable repository state** | line heads, the pushed beans, bean status and verdicts, the open count, an open bean's head pair, the runs list, a running run | `staleTime` 30 s; invalidated by live events (§5) | Not cached at the edge | Live events invalidate keys; a gap in the feed refetches the events and the pushed beans |
| **C. Append-only** | the engine event log (by `seq`) | `Infinity` while the feed is live (appended by `appendBySeq`), 15 s otherwise; memory only, never persisted | The existing per-isolate `EventCache` (public only) | Its anchor check |
| **D. Per-viewer** | session, access verdict and role, CSRF token, page HTML, home panels, settings | Memory only, never persisted | **Never shared at the edge** | A viewer change clears the cache and the stored copy |
| **E. Streams** | `/api/repos/*/live`, `/api/runs/**/live`, `streams`, a bean `stream`, a job log's SSE | n/a | **Never cached** (`no-store`) | n/a |

## 3. Privacy decision

**Public repositories use the public edge (isolate, Cache API, KV). Private and internal repositories' content-addressed objects are cached in KV only, in their own key namespace, and only after the viewer's access check on that request.** The owner's decision of 2026-10-15 ("lean into KV" for private repositories), replacing the public-only rule of 2026-10-14.

Why KV and never the Cache API or the isolate memory for private data:

1. The Cache API and the isolate LRU are shared by every request in a colo and cannot be purged globally (`cache.delete` reaches one colo; an isolate's memory none). KV is one global store whose keys carry the record's cache epoch, so a change to the record makes every private entry unreachable everywhere at once, and the TTL bounds how long it lingers.
2. KV is global, so a private repository's viewers in every colo share the warm entries; the colo layers would only help the colo that filled them.
3. One fewer place private data can sit: the Cache API's stored copies are `public` responses by construction (§6).

The rules (each has a test, §13.1):

- **Access check first, on every request.** `repositoryPage`, `viewerRepoAccess` and `runAccess` run before any cache read. Every edge read takes an engine key that only a `ReadGrant` makes (`src/edge/read-grant.ts`): `PublicEngine.of(grant, engine)` for the shared layers, `PrivateEngine.of(grant, engine)` for the private KV namespace. Only the access checks make a grant (`lookupRepository` and `runAccess`, `ReadGrant.afterAccessCheck`), and `read-grant.test.ts` fails if any other module calls it. A grant lives for one request.
- **Keys.** `v1:priv:<engine>:<epoch>:<kind>:<sha>[:<sha256(path)>]` (diffs `…:diff:<base>:<head>`), apart from public keys (`v1:<engine>:…`; `priv` cannot be an engine id). Nothing about the viewer: access is checked live and the content is the same for every viewer who may read it. The epoch is the record's `updated_at`, so a settings save, a visibility change, a transfer, an archive or a deletion makes old entries unreachable.
- **KV only.** `src/edge/private-object-cache.ts` has no Cache API or isolate dependency at all; the Miniflare tests fail on any call to `caches.open` or `caches.default`.
- **TTL** 7 days (`PRIVATE_KV_TTL_SECONDS`). A deleted repository's entries are unreachable at once (the registry no longer answers the record, so no grant is made, and a recreated repository has a new epoch) and gone from KV within 7 days.
- **Size**: values over 1 MiB are not written (as for public entries).
- **Measured apart**: `edge.read` logs `result: kv-hit-private | kv-miss-private` (public reads `isolate-hit | colo-hit | kv-hit | kv-miss`), and the bean diff route says the same in `Server-Timing` (`edge;desc="kv-hit-private"`).
- **Responses** stay `private` (in practice `no-store` for private and internal repositories, §6): never `public`, `s-maxage` or anything a shared cache downstream could keep.
- A private repository's event log is still read fresh on every request (it changes; class C); only class A objects are cached.

Still true from the first design: a visibility flip needs no purge (public to private: the access check refuses non-members, and members get new private keys under the new epoch; private to public: the shared layers start empty under the new epoch); `internal` counts as private; anything carrying the viewer is `private`; nothing sets `Vary: Cookie` or `s-maxage`; keys take a `Sha`, never a ref name; the access check itself is not cached across requests (§9).

## 4. Stores

| Store | Used for | Not for | Why |
|---|---|---|---|
| **Isolate memory** (`object-cache.ts` LRU, 4 MB of JSON, held parsed; `EventCache`) | Layer 1 for class A, public only; the public event log | anything that must survive a cold isolate | Free and fastest; measured like the other layers. Concurrent reads of one key share one read (the burst after a landing) |
| **Cache API**, named cache `gitstalk-objects-v1` | Layer 2 for class A, public only: trees, files, diffs | B, C, D, E | Per colo, free, no consistency question for immutable keys; stored copies are `public, max-age=604800` |
| **KV**, binding `OBJECTS` on the web Worker | Layer 3 for class A of public repositories (`v1:…`, 30 days); the only edge layer for private and internal ones (`v1:priv:…`, 7 days, §3); values up to 1 MiB | heads, the pushed list, access verdicts, anything a pusher must see right after writing it | Global, so a new colo is warm; eventual consistency does not matter for immutable data; one write per object |
| **Gateway read index** (exists) | Layer 4 for every repository, private included; also serves the `RepoDerivedDO`'s object reads (§12) | | Authoritative for objects |

The binding is templated like every KV id (`local-gitstalk-objects`, docs/claude-opus/30 §3.2), so `pnpm env:provision <env>` creates `gitstalk-objects<suffix>` and records its id. **An existing environment must run provision once before its next deploy**; until then config generation stops with "no id for kv gitstalk-objects-…".

Read path for a class A object: run the access check, which makes the `ReadGrant`; a public repository reads isolate, Cache API, KV, gateway (`PublicEngine.of(grant)`); a private or internal one reads its KV namespace, then the gateway (`PrivateEngine.of(grant)`), and fills KV through `waitUntil`. A hit fills the layers above it; a gateway read fills all three, the Cache API and KV through `waitUntil`. Only a successful read is stored, never a not-found or an error. A failing layer is logged and read as a miss.

## 5. Browser

### 5.1 Query keys (`src/query/keys.ts`, all viewer-scoped)

`qk.repo(uid, owner, repo)` has `all`, `events()`, `pushed()`, `bean(name)`, `run(id)`, and now `jobLog(run, job)`, `runs(filter)`, `diff(base, head)`, `tree(sha)`, `file(sha, path)` and `tail(seq)` (the events after a seq, for the head watcher). `bean(name)` stays the bean's diff on day one.

The Code tab's file tree adds `folder(sha, path)` (one folder's entries, read when the reader expands it) and `paths(sha)` (every path, for Go to file), both immutable (`staleTime: Infinity`, persisted in sessionStorage for every visibility since 2026-10-15, §5.3). Their routes, `/api/repos/<owner>/<repo>/code/folder` and `/code/paths`, read the tree at the sha through the same edge object cache as the pages (public: shared layers; private: the private KV namespace, §3) and answer `immutable` for a public repository and `no-store` otherwise. The page itself sends the root and the folders on the way to the open path, cut from the tree it already read, so opening a file makes no extra request.

### 5.2 Freshness policy (`src/query/policy.ts`)

| Class | `staleTime` | `gcTime` | `meta.persist` |
|---|---|---|---|
| `immutable` | `Infinity` | 60 min | true when a repository's visibility is given (public, private or internal; sessionStorage only, §5.3) |
| `appendOnly` | `Infinity` live, 15 s otherwise | 10 min | false |
| `mutable` | 30 s | 10 min | false |
| `perViewer` | 30 s | 10 min | false |

`refetchOnWindowFocus` stays on and is a no-op for `Infinity`: cached data renders immediately and is refetched in the background only when stale. An invalidation still refetches an immutable query. Applied in `useChangesFeed` (events, pushed), `BeanDiff` (immutable while its landing stands: the newest of its `land`, `bean.requeued`, `sprout.reset` naming it and `green.demote` naming it is a `land`; `hasStandingLanding`) and `RunStatus` (immutable once finished, refreshing the page once per run).

A list a live feed follows (`useChangesFeed`'s events, the head watcher's tail) does not refetch on mount (`FOLLOWED_BY_FEED`): the feed reopens at the last seq held and delivers the same catch-up.

### 5.3 Persistence

sessionStorage only, never localStorage (the data ends with the tab), buster `BUILD_ID:viewer`, cleared on a viewer change and as a sign-out form posts (`QueryProvider`). A repository's immutable queries of every visibility (since 2026-10-15; public only before). The trade-off for a private repository: its immutable data survives a reload in the same tab, never across tabs, sessions or accounts; it is shown only inside a page the server rendered after the access check, so a revoked viewer gets the 404 page, not the copy. Never persisted: secrets and their values, tokens, the CSRF token, settings, sessions, anything per viewer, the event log, moving state. `PERSIST_MAX_AGE_MS` is 60 minutes and persisted queries keep `gcTime` at least that long. The event log is not persisted: the feed changes it every second while live, the persister would serialise the whole cache each time (and a long log overflows sessionStorage), and every page that shows it hydrates a fresher server copy.

### 5.4 Invalidation map (`src/query/invalidation.ts`, `staleKeysFor`)

| Fresh events in a batch | Action |
|---|---|
| any | appended to `events()` by `appendBySeq` (no refetch) |
| a push, verdict, landing, promotion or demotion, decision asked or made… (`PUSHED_KINDS`) | invalidate `pushed()` |
| `task.commit` or `land` of a bean on screen | invalidate `bean(name)` |
| `land`, `green.promote`, `green.demote`, `revert`, `sprout.reset` moving a line the page shows past the commit it rendered | `router.refresh()` in a transition, after a random 0–1.5 s (Code on a line, History) |
| `ci.end`, `final.check`, `decision.made`, `bean.requeued`, `queue.eject` | History: `router.refresh()`, at most every 2 s |
| a gap | refetch `events()` and `pushed()` (`useLiveFeed`'s `onResync`). A reconnect does not: the browser resumes from `Last-Event-ID` |
| a run finishes (polled) | the run query turns immutable, one `router.refresh()` |

The head watcher (`components/repo-tabs/use-head-watcher.ts`) holds only the events after the seq the page rendered at (`tail(seq)`, through the existing `live` and `events?after=` routes), so Code and History never ship the whole log. Every event in the tail is newer than the page, so the whole tail is checked: a page restored from the client router cache refreshes at once if its line moved meanwhile. A refresh renders a newer seq and starts a new tail, so it cannot loop. `staleTimes.dynamic` stays 30 s (vinext honours it; `router.refresh()` bypasses it): most pages have no watcher, and a revoked collaborator would keep what was rendered for that long.

## 6. Response headers (`src/edge/http-cache.ts`)

A private or internal repository's answers are never kept by the browser (`byVisibility`): a kept copy outlives sign-out and revoked access, and a fresh one is reused without any access check.

| Route | Condition | `Cache-Control` | Validator |
|---|---|---|---|
| `/api/repos/o/r/events?after=N` | public | `private, no-cache` | `ETag: W/"v1.<engine>.<last seq>.<last ts>"`; a matching `If-None-Match` gets 304, after the access check |
| same | private, internal | `no-store` | none |
| `/api/repos/o/r/pushed` | public | `private, no-cache` | none |
| same | private, internal | `no-store` | none |
| `/api/repos/o/r/*` | 404, 400, 5xx | `no-store` | none |
| the `live` routes, `streams`, `stream`, a job log's SSE | always | `no-store` | none |
| `/api/runs/[run]/beans/[bean]/diff` | public | `private, no-cache` (the URL names a bean, and a demoted, reset, requeued bean gets a new pair under it) | `ETag: "v1.<base>..<head>"`; a match is a 304 before the diff is read |
| same | private, internal; benchmark race | `no-store` | none |
| `…/actions/runs/[run]/jobs/[job]/log?download=1` | public, job finished and every line stored | `private, max-age=31536000, immutable` | none |
| same | otherwise | `no-store` | none |
| `…/actions/runs/[run]` | public, finished | `private, max-age=3600` | none |
| same | otherwise | `no-store` | none |
| `POST /auth/signout` | always | `no-store` | `Clear-Site-Data: "cache"` |
| repository pages, `/media/**`, `/setup.sh` | | unchanged | |

`?after=N` reads only the tail from the gateway for a private repository (a public one's comes from the isolate's `EventCache`). `fetchJson(..., { httpCache: 'revalidate' })` (request `cache: 'no-cache'`) lets the browser revalidate the events, the watcher's tail and bean diffs (the Changes tab and the canvas's decision cards) with their ETags; everything else keeps `no-store` requests.

Stored Cache API copies carry their own headers (`public, max-age=604800`, no `Set-Cookie`, no `Vary`) and are never handed to a client as they are: routes build their own response.

## 7. Keys (`src/edge/cache-keys.ts`)

- Cache API: `https://<WEB_URL host>/__edge/v1/<engine>/<epoch>/tree/<sha>`, `…/file/<sha>/<sha256(path)>`, `…/diff/<base>..<head>`. The path is hashed here too: a URL would fold `.`, `..` and the empty path into one key.
- KV, public: `v1:<engine>:<epoch>:tree:<sha>`, `…:file:<sha>:<sha256(path)>`, `…:diff:<base>:<head>` (KV keys are at most 512 bytes).
- KV, private and internal: `v1:priv:<engine>:<epoch>:tree:<sha>`, `…:file:<sha>:<sha256(path)>`, `…:diff:<base>:<head>` (`privateKvKey`). No Cache API key exists for them.
- `<epoch>` is the record's `updated_at` (letters and digits), which the registry moves on every update: visibility, name, owner (transfer), archive, settings.
- `worker/index.ts` answers `/__edge/*` with a 404 before anything else.
- **Purge path.** To stop serving a public repository's cached objects (a takedown, a secret committed and removed), change its record: any settings save moves the epoch, and every layer's old copies become unreachable at once (they expire: 7 days per colo, 30 days in KV, LRU in the isolate). A deleted or now-private repository's entries are unreachable as before. The same holds for a private repository's KV entries (a settings save moves its epoch; they expire within 7 days). Bump `v1` when a payload changes shape. Gitstalk has no force-push: a history rewrite would have to move the epoch too.

## 8. Measurement

- Gateway: derivation's reads through the engine are `cache.derived` in the engine's `runView` and `summary.json` (`objects`, `commit`, `tree`, `blob`), apart from the engine's own demand and prefetch counts (§12).
- `edge.read` log per object read through `src/log.ts`: `{ kind, layer, result, public, engine, ms }` (no shas). `result` counts KV apart for public and private: `isolate-hit`, `colo-hit`, `kv-hit`, `kv-miss` (public) and `kv-hit-private`, `kv-miss-private`.
- `Server-Timing: edge;desc="colo-hit";dur=1.8` on the bean diff route (`kv-hit-private` / `kv-miss-private` for a private repository; a public miss is now `kv-miss`, formerly `gateway-read`). Pages cannot carry it: vinext streams a page's headers before its reads finish, so pages rely on the `edge.read` logs.
- `createEdgeObjectCache(...).stats()`: hits by layer, misses, writes.
- Development only: `QueryProvider` logs `query.fetch` with how often each kind of key was served from the cache or fetched (`src/query/cache-counter.ts`). "Served" counts an observer that reads (enabled, with a `queryFn`) and finds fresh data; watching observers and stale data that is fetched again are not counted.
- Manual check after deploying to the custom domain: the second load of a public bean diff shows `isolate-hit` or `colo-hit`, and Workers Logs show the `edge.read` layer mix.

## 9. Deferred (each needs measurement or an owner decision)

- An isolate memo of the access check (anonymous viewers and public records only, about 5 s). It needs the owner to accept a 5 s window after a public-to-private flip.
- A KV heads snapshot for signed-out readers of public repositories, written by the gateway's `repo-events` consumer on `bean.landed`, `stalk.promoted` and `bean.reverted`; not for signed-in viewers (read-after-write).
- A gateway `repoSnapshot(run, ref, path)` RPC (the Code tab's four or five RPCs in one).
- Client-side `tree` and `file` queries (the keys exist); moving `BeanDiff` to `diff(base, head)`.
- Edge-caching finished job logs, public or private (the key format has room; the Actions control plane reads them, not the engine).
- Taking the KV miss off the critical path of a cold read (racing it with the gateway would double gateway reads, the cost this layer exists to save), and a cap on KV writes per crawl.
- A canvas drawing for `green.demote` (the race reducer ignores it; the race feed has a line).
- One SSE for `RunStatus` polling and the job log; one repository SSE shared across tabs (BroadcastChannel).
- ~~A per-tab `loading.tsx` that keeps the owner, the name and the current tab.~~ Done differently (§13.3): the header is the repository layout's, so every skeleton sits under the real header.
- Reusing a hover prefetch for the navigation that follows it (vinext fetches a dynamic page twice: the prefetch and the navigation, §13.3).
- A revisit after the router's 30 s shows a tab's skeleton: moving the server-rendered tabs' reads (Code's tree and files, History, the runs list) to client queries would remove it (§13.2).

## 10. Where this differs from the plan it came from

- **Isolate layer.** The plan kept `"use cache"` as layer 0 above the Cache API. A `"use cache"` hit never enters the function, so it could not be measured, and its arguments (its key) cannot carry a `PublicEngine`. The edge cache has its own isolate LRU instead, measured as `isolate`; `"use cache"` is no longer used for trees and files.
- **Bean diff immutability.** The plan made a diff immutable once the bean landed. Even a validated bean can be demoted, reset and requeued with a new pair under the same URL, so the route never says `immutable`: public answers revalidate with the pair as ETag (a 304 costs one `beanDetail`), private ones are not kept. On the client, `BeanDiff` is immutable while its landing stands (§5.2).
- **Head watcher.** The plan reused `useChangesFeed`. That needs the whole event log on Code and History; the watcher holds only the events after the rendered seq, through the same routes and one SSE per view.
- **Server-Timing** is on the bean diff route only (pages stream their headers first).
- **Component tests** drive TanStack's `QueryObserver` (what `useQuery` wraps) under plain vitest; the repository has no DOM testing library.
- **Cache API key host** is `WEB_URL` (the deployment's origin), not the request's host, since reads also happen outside a request's URL.
- The `AGENTS.md` note the plan asked for is moot: `AGENTS.md` already names packages `@gitstalk/*`.

## 11. Review (privacy and freshness), and what changed

| Finding | Outcome |
|---|---|
| Private diffs, job logs and runs kept by the browser for up to a year, reusable with no access check | Fixed: `immutable` and `fresh-for` for public repositories only (`byVisibility`), `no-store` otherwise; `Clear-Site-Data: "cache"` at sign-out; the decision card reads through `fetchJson` with `revalidate` |
| No purge path for edge copies | Fixed: the record's cache epoch in every key (§7) |
| Private event logs and pushed lists in the disk cache | Fixed: `no-store` for private and internal repositories |
| Events ETag named no engine | Fixed: engine, last seq and last timestamp |
| Cache API keys folded `.`, `..` and the empty path together | Fixed: the path is hashed |
| Router cache raised to 120 s | Reverted to 30 s |
| `green.demote` ignored, so Code and History stayed on a demoted stalk; `decision.request` did not refresh the pushed list | Fixed: shared `LINE_MOVE_TYPES`, `GreenDemote` in the web schema, both in `PUSHED_KINDS` |
| `immutable` on a bean-named diff URL; client `BeanDiff` immutable after a requeue | Fixed: revalidate on the server, `hasStandingLanding` on the client |
| 304s paid for the full read; `?after=` read the whole log | Fixed: the diff's 304 comes before the read; private tails are read from the gateway by seq; public ones from the `EventCache` (the events route now uses it too) |
| The persister re-serialised the event log every second | Fixed: events are not persisted |
| Every watcher refreshed at once; concurrent isolate misses | Fixed: 0–1.5 s jitter; one read per key per isolate |
| Double fetching on remount; resync on every reconnect | Fixed: `FOLLOWED_BY_FEED`; resync only on a gap |
| A just-finished job's partial log kept for a year | Fixed: `immutable` needs `page.complete` |
| Isolate LRU undercounted heap | Fixed: budget 4 MB of JSON |
| Dev counter inflated "served" | Fixed |
| Cold reads pay a KV miss; KV writes unbounded per crawl | Deferred (§9) |

## 12. Derived data reads through the engine's read index (2026-10-15)

Code: `packages/gateway/src/repo/object-reads.ts` (served by `RunDO.readObjects`), `packages/gateway/src/derive/engine-reader.ts` (the `RepoDerivedDO`'s reader); tests `derive/engine-reader.test.ts`, `test/engine-objects.test.ts` and the second case of the offline replay `repo/read-index-replay.test.ts`.

**Why.** PR #2's read index work found that the engine's `RunDO` and the derived-data `RepoDerivedDO` fetched the same objects from Artifacts separately: the approval gate and the warm-up read each landing through the RunDO's SQLite index, then derivation read the same landing's commits, changed trees and both sides of each changed file straight from Artifacts.

**Design.** The `RepoDerivedDO` asks the repository's engine for commits, trees and blobs by id over Durable Object RPC (`env.RUNS.getByName(engine).readObjects({ repo, reads })`). The engine serves them through its read index: a hit from SQLite, a miss read from Artifacts, stored, then served. Refs (`sprout`, `stalk` heads) and history pages still go to Artifacts directly, as before.

- *Narrow.* Objects only, never refs or engine state. At most 64 reads a call; each id must be 40 or 64 lowercase hex, the kind `commit`, `tree` or `blob` (Zod), and `repo` must be the Artifacts repository the engine drives, or the call is refused. A Durable Object RPC that no route reaches; only gateway code holds the `RUNS` binding. Blobs over the index's 1 MB cap are not sent (`oversized-blob`): the derived reader fetches those itself.
- *Batched.* Reads issued together (the two commits of a range, a level of the tree walk, a batch of 8 changed files) go out as one call, at most 16 blobs a call so that an answer stays far under the RPC size limit. The replay: 169 calls for 638 object reads over 38 landings, about 4 a landing.
- *Never stalls derivation.* If the engine throws or refuses, the reader logs one warning (`engine object reads failed` or `refused; reading Artifacts directly`) and reads Artifacts directly for the rest of that read or round.
- *Counted.* The engine counts derivation's reads as purpose `derived` on its infra meter, reported as `cache.derived`, apart from the engine's own demand reads (`cache.objects`) and the warm-up (`cache.prefetch`), so neither hit rate is inflated by the other. A call that opens the repository (any miss) counts one Artifacts operation.
- *Addressing.* The `RepoDerivedDO` is named by the engine id; the gateway passes `engine` with `repo` on every `observe`, `whyLines` and `pathHistory` call (from the repo-events feed and the registry record).

**Measured (offline replay).** The fastify load test's 38 landings on a 407-file tree (`test/fixtures/fastify-landings.json`): the gate's diff through the index, the warm-up, then derivation's `changesIn`.

| | Engine (gate and warm-ups) | Derivation | Artifacts reads |
|---|---|---|---|
| Derivation reads Artifacts itself | 780 | 638 (76 commits, 256 trees, 306 blobs) | **1,418** |
| Derivation reads through the engine | 780 (unchanged) | **0** (`cache.derived`: 638 hits, 0 misses) | **780** (−45%) |

**Why the per-colo Cache API tier was dropped (owner's decision 2026-10-15).** The first version of this change put a Cache API tier (`gitstalk-gateway-objects-v1`) under both Durable Objects. The same replay gave the same 780, but only when both objects ran in one colo, and it depended on the Cache API working inside Durable Objects in production (unverified; it does nothing on `*.workers.dev`). It also put private repositories' bytes in a shared per-colo cache with a 7-day window that no purge could close. Reading through the engine removes the duplicate fetches across colos, needs no Cache API, and keeps private data only in the engine's own storage, which repository deletion already removes.

## 13. Private repositories in KV, the browser cache on every tab, and Settings navigation (2026-10-15)

Branch `cache-private-settings`, after the owner's decisions of 2026-10-15.

### 13.1 Private repositories in KV

§3 now holds the rule; the code is `src/edge/read-grant.ts` (`ReadGrant`, `PrivateEngine`), `src/edge/private-object-cache.ts` and `private-objects.ts`, `privateKvKey` in `cache-keys.ts`, and `cachedReadsFor` in `src/repo-pages/cached-reads.ts` (which replaced `sharedReadsFor`: the grant picks the shared layers or the private namespace). The bean diff route reads a private diff through the same namespace. Tests, by rule:

| Rule | Test |
|---|---|
| Only the access checks make a grant, so no read skips the check | `src/edge/read-grant.test.ts` (source scan: `ReadGrant.afterAccessCheck` only in `repositories/flows.ts` and `admin/admin-gate.ts`) |
| Signed out, a non-member, a revoked member, a reader of a repository made private: a 404 and no KV read | `src/edge/private-object-cache.workers.test.ts` (Miniflare, real KV, behind the real `lookupRepository`); `bean-diff-answer.workers.test.ts` (refused run access) |
| An authorised viewer hits KV on the second read | both Miniflare files (`kv-hit-private` in `Server-Timing`), `cached-reads.test.ts` |
| A settings save or a visibility flip moves the epoch; the old entry is unreachable | `private-object-cache.workers.test.ts`, `bean-diff-answer.workers.test.ts`, `cached-reads.test.ts` |
| Keys never collide across repositories, epochs or with public keys | `cache-keys.test.ts`, `private-object-cache.workers.test.ts` |
| Nothing private touches `caches.default` or the named cache | `private-object-cache.workers.test.ts` (every test fails on any Cache API call; a first test proves the watch works); `bean-diff-answer.workers.test.ts` (public colo and KV keys stay empty; poisoned public entries are never served) |
| 7-day TTL, own namespace | `private-object-cache.workers.test.ts` |

### 13.2 The browser cache on every tab

Audit of `app/[owner]/[repo]/**` (what each view's data goes through on a revisit):

| View | Data | Browser cache |
|---|---|---|
| Header and tabs | access check | Drawn once by the repository layout, kept mounted across every tab and settings section (13.3) |
| Code (tree, blob, README) | server render; objects through the edge caches (public shared, private KV) | Router cache (30 s, `staleTimes.dynamic`); `HeadWatcher` keeps the line fresh (`tail(seq)` query) |
| Code: file tree, Go to file | `useTreeFolders` (`folder(sha, path)`), `GoToFile` (`paths(sha)`); routes read through the edge caches | TanStack Query, immutable, persisted for every visibility; the page seeds the root and the open path's folders |
| Changes | `useChangesFeed`: events (append-only), pushed (mutable) | TanStack Query, live feed; no refetch on remount |
| A bean | `BeanDiff` / `StreamedBeanDiff` (hydrated) | TanStack Query, immutable while its landing stands; persisted for every visibility |
| History | server render | Router cache; `HeadWatcher` |
| People | server render; sessions through `useQuery` (`home-sessions`) | Router cache; TanStack Query, per viewer, memory only |
| Actions: runs list | server render | Router cache |
| Actions: run | `RunStatus` `useQuery`, polls while live, immutable once finished | TanStack Query (seeded by each server render) |
| Actions: job log | server render; a live job's lines over SSE | Router cache; the stream is class E, never cached |
| Automations, New, Edit | server render, forms | Router cache |
| Ask | server render; live canvas over SSE | Router cache; the stream is never cached |
| Settings (each section) | server render, forms, per viewer | Router cache; the section nav is the settings layout's, kept mounted; never persisted (secret names only to those who may see them, never values) |

Every client fetch of repository data already went through TanStack Query; the views that re-rendered from scratch on a revisit were the header and the settings nav, now layouts. Persistence (§5.3) now covers private and internal repositories' immutable queries in sessionStorage. Not done: moving server-rendered tabs (Code, History, the runs list) to client queries (§9 has the tree and file keys); a revisit after the router's 30 s still shows the tab's skeleton under the kept header.

### 13.3 Settings navigation: cause and fix

The report: switching to Settings, and between sections, reloaded the page or remounted the repository shell. Measured with Playwright on a production build under `wrangler dev` (stub gateway, seeded D1 and sessions), Code → Settings → sections → Changes → Code → back, for a public and a private repository:

- **No document load before or after**: every step was a client navigation (no `document` request, page state kept). The visible "reload" was a remount.
- **Cause.** The repository layout drew nothing: every page drew its own header (`RepositoryShell`, `ActionsShell`, the people and files pages) and every settings section drew the header *and* the section nav (`RepositorySettingsFrame` inside each `page.tsx`). vinext swaps the page segment on navigation, so the header's DOM was replaced on every tab click (checked: the header node never survived a navigation), and the settings frame drew it without the Changes count, so the tab bar jumped on entering Settings. The Settings tab linked to `/settings`, whose page only redirects, so the click cost two RSC round trips with nothing on screen (settings has no loading boundary, by design, so the redirect is a real status).
- **Fix.** `app/[owner]/[repo]/layout.tsx` draws the header once (`RepositoryFrame`: the open tab from the address via `repoTabOf`, the last Changes count a page reported via `OpenChangesCount`, keyed by repository). `app/[owner]/[repo]/settings/layout.tsx` draws the section nav (`RepositorySettingsLayout`; the current section is marked from the address by `SettingsNav`); each section page draws its title, notices and forms. The Settings tab links to the viewer's first section (`settingsTabHref`). After: the header node survives Code → Changes → Settings → sections → Changes, the section nav survives section changes, and the access checks are unchanged (404 before streaming for non-members, the section redirect for roles without it, checked by `route-tree.test.ts` and by hand).

Request counts per step (all requests / RSC fetches / documents; the same for both repositories):

| Step | Before | After |
|---|---|---|
| Settings tab | 10 / 2 / 0 | 9 / 1 / 0 |
| Settings → Collaborators | 4 / 2 / 0 | 4 / 2 / 0 |
| Settings → Branches | 2 / 2 / 0 | 2 / 2 / 0 |
| Settings → General | 0 / 0 / 0 | 0 / 0 / 0 |
| Changes tab | 8 / 2 / 0 | 9 / 2 / 0 |
| Code tab | 1 / 0 / 0 | 1 / 0 / 0 |
| Back (Changes) | 2 / 1 / 0 | 1 / 0 / 0 |
| Back (Settings → General) | 1 / 1 / 0 | 0 / 0 / 0 |
| Settings tab again | 0 / 0 / 0 | 1 / 1 / 0 |
| Settings → Collaborators again | 0 / 0 / 0 | 0 / 0 / 0 |
| Total | 28 / 10 / 0 | 27 / 8 / 0 |

Two RSC fetches on a first visit are the hover prefetch (`IntentLink`) and the navigation; vinext does not reuse a dynamic page's prefetch for the navigation (deferred, §9). A real reload can still happen after a deploy: a tab holding the old build that asks for a chunk the new build no longer serves reloads once (`ChunkReloadGuard`), and Settings pulls the most chunks a tab has not loaded yet.
