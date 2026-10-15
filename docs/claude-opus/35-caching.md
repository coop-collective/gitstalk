# 35. Caching the repository UI

2026-10-14, branch `repo-ui-caching`. What is cached where, for how long, and why private repositories never reach a shared cache. Code: `packages/web/src/query/` (browser), `packages/web/src/edge/` (edge and headers). Summaries in the web and gateway READMEs, section Caching.

## 1. Facts the design rests on

- **A Worker runs in front of Cloudflare's cache.** The CDN does not store a Worker's own response because of its `Cache-Control`; `s-maxage` there only reaches downstream proxies, which is a hazard for per-viewer data. Edge caching is explicit Worker code (Cache API, KV). Response headers speak to the browser only.
- **Cache API rules.** `cache.put` refuses a response with `Set-Cookie` and does not store `private` or `no-store` responses. It does nothing on `*.workers.dev` (production needs the custom domain). `cache.delete` purges only the current colo.
- **The gateway RPCs do not authorise.** `repoTree`, `repoFile`, `repoLog` and `repoDiff` trust the engine id; the web app checks access before every call.
- **Events already say when a head moves.** `land` carries `sha` and `target` (`trunk` is the sprout, `main` the stalk in queue mode), `green.promote` and `green.demote` (a red audit takes the stalk back) carry the new stalk `sha`, `revert` and `sprout.reset` the new sprout `sha`. The list is `LINE_MOVE_TYPES` in `@gitstalk/shared-race/events`, shared by the gateway's read index and the web app's head watcher.
- **The gateway already caches every repository's objects** (the RunDO read index, `gateway/src/repo/object-cache.ts`), with a 5 s ref memo that a landing clears. Under it, a per-colo object tier (§12) is shared by the engine's Durable Objects.

## 2. Classes of data

| Class | Members | Browser (TanStack Query) | Edge | Purge |
|---|---|---|---|---|
| **A. Immutable by sha** | tree at a sha, file at (sha, path), README at a sha, the diff of a (base, head) pair, a landed bean's diff while its landing stands, a finished job log, a finished run | `staleTime: Infinity`, `gcTime` 1 h, persisted for public repositories | isolate, then Cache API (per colo), then KV (global); public repositories only; read only after a fresh access check | The record's cache epoch (`updated_at`) is in every key: any change to the record makes old copies unreachable (§7). `EDGE_CACHE_VERSION` handles format changes; TTLs bound storage |
| **B. Mutable repository state** | line heads, the pushed beans, bean status and verdicts, the open count, an open bean's head pair, the runs list, a running run | `staleTime` 30 s; invalidated by live events (§5) | Not cached at the edge | Live events invalidate keys; a gap in the feed refetches the events and the pushed beans |
| **C. Append-only** | the engine event log (by `seq`) | `Infinity` while the feed is live (appended by `appendBySeq`), 15 s otherwise; memory only, never persisted | The existing per-isolate `EventCache` (public only) | Its anchor check |
| **D. Per-viewer** | session, access verdict and role, CSRF token, page HTML, home panels, settings | Memory only, never persisted | **Never shared at the edge** | A viewer change clears the cache and the stored copy |
| **E. Streams** | `/api/repos/*/live`, `/api/runs/**/live`, `streams`, a bean `stream`, a job log's SSE | n/a | **Never cached** (`no-store`) | n/a |

## 3. Privacy decision

**The shared edge caches hold only public repositories' content-addressed objects, and every request still runs the viewer's access check before it reads them.**

Why not cache every repository behind the access check:

1. With private objects in a colo-wide cache, one future code path that reads the cache before the access check is a leak, and an invisible one, since no auth runs on a hit. Public-only makes such a bug harmless.
2. The gain for private repositories is small: the gateway's read index already serves their trees and blobs without Artifacts, so the edge would save one RPC and one DO hop. The browser's memory cache covers repeat views by the same person.
3. Visibility flips need no purge. Public to private: old entries stay but are unreachable, because the access check answers 404 and `PublicEngine.of` returns null. Private to public: nothing was cached, and the flip moves the cache epoch anyway.
4. `internal` counts as private.
5. The browser gets the same rule: a private or internal repository's answers are `no-store` (§6), so nothing outlives sign-out or revoked access in the HTTP cache, and sign-out sends `Clear-Site-Data: "cache"` for whatever a public page left behind.

Enforcement in code:

- Every edge function takes a `PublicEngine` (`src/repo-pages/event-cache.ts`), never a bare engine id. Only `PublicEngine.of(record, engine)` makes one, from the record `repositoryPage`, `viewerRepoAccess` or `runAccess` returned on this request.
- Keys hold the engine id, the record's cache epoch, the shas and the hashed path, nothing about the viewer, which is correct only because of the public-only gate. Keys take a `Sha`, never a ref name.
- Anything carrying the viewer is `private`; nothing sets `Vary: Cookie` or `s-maxage`. Page HTML keeps vinext's dynamic behaviour.
- The access check itself is not cached across requests (§9, deferred).

## 4. Stores

| Store | Used for | Not for | Why |
|---|---|---|---|
| **Isolate memory** (`object-cache.ts` LRU, 4 MB of JSON, held parsed; `EventCache`) | Layer 1 for class A, public only; the public event log | anything that must survive a cold isolate | Free and fastest; measured like the other layers. Concurrent reads of one key share one read (the burst after a landing) |
| **Cache API**, named cache `gitstalk-objects-v1` | Layer 2 for class A, public only: trees, files, diffs | B, C, D, E | Per colo, free, no consistency question for immutable keys; stored copies are `public, max-age=604800` |
| **KV**, binding `OBJECTS` on the web Worker | Layer 3 for class A, public only, values up to 1 MiB | heads, the pushed list, access verdicts, anything a pusher must see right after writing it | Global, so a new colo is warm; eventual consistency does not matter for immutable data; one write per object; `expirationTtl` 30 days |
| **Gateway read index** (exists) | Layer 4 for every repository, private included | | Authoritative for objects |
| **Gateway object tier**, named cache `gitstalk-gateway-objects-v1` | Under the read index, for every repository, private included (§12): commits, trees and blobs by id, read by the RunDO and the `RepoDerivedDO` | refs, the ref memo, anything not addressed by object id | Two Durable Objects of one engine read the same objects; per colo, free |

The binding is templated like every KV id (`local-gitstalk-objects`, docs/claude-opus/30 §3.2), so `pnpm env:provision <env>` creates `gitstalk-objects<suffix>` and records its id. **An existing environment must run provision once before its next deploy**; until then config generation stops with "no id for kv gitstalk-objects-…".

Read path for a class A object: run the access check; `PublicEngine.of(record)` (null: read through the gateway as before); otherwise isolate, Cache API, KV, gateway. A hit fills the layers above it; a gateway read fills all three, the Cache API and KV through `waitUntil`. Only a successful read is stored, never a not-found or an error. A failing layer is logged and read as a miss.

## 5. Browser

### 5.1 Query keys (`src/query/keys.ts`, all viewer-scoped)

`qk.repo(uid, owner, repo)` has `all`, `events()`, `pushed()`, `bean(name)`, `run(id)`, and now `jobLog(run, job)`, `runs(filter)`, `diff(base, head)`, `tree(sha)`, `file(sha, path)` and `tail(seq)` (the events after a seq, for the head watcher). `bean(name)` stays the bean's diff on day one.

### 5.2 Freshness policy (`src/query/policy.ts`)

| Class | `staleTime` | `gcTime` | `meta.persist` |
|---|---|---|---|
| `immutable` | `Infinity` | 60 min | `visibility === 'public'` |
| `appendOnly` | `Infinity` live, 15 s otherwise | 10 min | false |
| `mutable` | 30 s | 10 min | false |
| `perViewer` | 30 s | 10 min | false |

`refetchOnWindowFocus` stays on and is a no-op for `Infinity`: cached data renders immediately and is refetched in the background only when stale. An invalidation still refetches an immutable query. Applied in `useChangesFeed` (events, pushed), `BeanDiff` (immutable while its landing stands: the newest of its `land`, `bean.requeued`, `sprout.reset` naming it and `green.demote` naming it is a `land`; `hasStandingLanding`) and `RunStatus` (immutable once finished, refreshing the page once per run).

A list a live feed follows (`useChangesFeed`'s events, the head watcher's tail) does not refetch on mount (`FOLLOWED_BY_FEED`): the feed reopens at the last seq held and delivers the same catch-up.

### 5.3 Persistence

sessionStorage only (the data ends with the tab), buster `BUILD_ID:viewer`, cleared on sign-out. Only public repositories' immutable queries; `PERSIST_MAX_AGE_MS` is 60 minutes and persisted queries keep `gcTime` at least that long. The event log is not persisted: the feed changes it every second while live, the persister would serialise the whole cache each time (and a long log overflows sessionStorage), and every page that shows it hydrates a fresher server copy.

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
- KV: `v1:<engine>:<epoch>:tree:<sha>`, `…:file:<sha>:<sha256(path)>`, `…:diff:<base>:<head>` (KV keys are at most 512 bytes).
- `<epoch>` is the record's `updated_at` (letters and digits), which the registry moves on every update: visibility, name, owner (transfer), archive, settings.
- `worker/index.ts` answers `/__edge/*` with a 404 before anything else.
- **Purge path.** To stop serving a public repository's cached objects (a takedown, a secret committed and removed), change its record: any settings save moves the epoch, and every layer's old copies become unreachable at once (they expire: 7 days per colo, 30 days in KV, LRU in the isolate). A deleted or now-private repository's entries are unreachable as before. Bump `v1` when a payload changes shape. Gitstalk has no force-push: a history rewrite would have to move the epoch too.

## 8. Measurement

- Gateway object tier: `cache.edge` in the RunDO's infra meter (`objects`, `commit`, `tree`, `blob`; hits and misses apart from the read index's), and an `object tier` log line from the `RepoDerivedDO` with the same shape after each read or derivation round (§12).
- `edge.read` log per object read through `src/log.ts`: `{ kind, layer: isolate|colo|kv|gateway, public: true, engine, ms }` (no shas).
- `Server-Timing: edge;desc="colo-hit";dur=1.8` on the bean diff route for a public repository. Pages cannot carry it: vinext streams a page's headers before its reads finish, so pages rely on the `edge.read` logs.
- `createEdgeObjectCache(...).stats()`: hits by layer, misses, writes.
- Development only: `QueryProvider` logs `query.fetch` with how often each kind of key was served from the cache or fetched (`src/query/cache-counter.ts`). "Served" counts an observer that reads (enabled, with a `queryFn`) and finds fresh data; watching observers and stale data that is fetched again are not counted.
- Manual check after deploying to the custom domain: the second load of a public bean diff shows `isolate-hit` or `colo-hit`, and Workers Logs show the `edge.read` layer mix.

## 9. Deferred (each needs measurement or an owner decision)

- An isolate memo of the access check (anonymous viewers and public records only, about 5 s). It needs the owner to accept a 5 s window after a public-to-private flip.
- A KV heads snapshot for signed-out readers of public repositories, written by the gateway's `repo-events` consumer on `bean.landed`, `stalk.promoted` and `bean.reverted`; not for signed-in viewers (read-after-write).
- A gateway `repoSnapshot(run, ref, path)` RPC (the Code tab's four or five RPCs in one).
- Client-side `tree` and `file` queries (the keys exist); moving `BeanDiff` to `diff(base, head)`.
- Edge-caching finished job logs (the key format has room; the Actions control plane reads them, not the engine).
- Taking the KV miss off the critical path of a cold read (racing it with the gateway would double gateway reads, the cost this layer exists to save), and a cap on KV writes per crawl.
- A canvas drawing for `green.demote` (the race reducer ignores it; the race feed has a line).
- One SSE for `RunStatus` polling and the job log; one repository SSE shared across tabs (BroadcastChannel).
- A per-tab `loading.tsx` that keeps the owner, the name and the current tab.

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

## 12. Gateway object tier (2026-10-15)

Code: `packages/gateway/src/repo/object-tier.ts`; tests `object-tier.test.ts` and the second case of the offline replay `read-index-replay.test.ts`.

**Why.** PR #2's read index work found that the engine's RunDO and the derived-data `RepoDerivedDO` fetch the same objects from Artifacts separately: the RunDO's approval gate and warm-up read each landing through its SQLite index, then derivation reads the same landing's commits, changed trees and both sides of each changed file straight from Artifacts, and blobs never hit in a per-object cache. Each Durable Object's own cache cannot help the other. A per-colo Cache API tier between the Durable Objects and Artifacts can.

**What it holds.** Commits, trees and blobs by object id (40 or 64 hex), never refs or the ref memo. A one-commit `log` of a named ref still goes to Artifacts every time, but the commit it returns is kept by its id, so derivation's `readCommit` of a landed head hits. Blobs over the read index's 1 MB cap are read through and not kept; a not-found is never kept. Stored as `public, max-age=604800, immutable`, never with `Set-Cookie`; writes run past the read (`ctx.waitUntil`). A failing cache read or write is logged and read as a miss; it never fails a read.

**Privacy decision: the tier holds private repositories' objects.** Unlike the web's edge caches (§3), its readers are internal and already authorised, so §3's risk (a code path that reads a shared cache before the access check, an invisible leak) has no path here:

1. *Who can reach it.* Only the two Durable Objects build a tier reader, from an Artifacts repo name they stored (the RunDO's `repos.repo.name`) or were handed by the gateway after the web or MCP access check (the `RepoDerivedDO`'s `repo`, from the registry record). No route serves `/__objects/` (a request to a key's path answers 404, tested), and the cache is a named cache, which the CDN never consults for incoming requests.
2. *Keys.* `<PUBLIC_URL origin>/__objects/v1/<Artifacts repo name>/<kind>/<object id>`. The repo name must be one key segment (`[A-Za-z0-9][A-Za-z0-9._-]*`), or the reader is built without the tier. A reader of repository A never addresses repository B's entries, even for an identical object id (tested); it reads its own copy from Artifacts. A repository's Artifacts name is `repo-<12 random [a-z0-9]>` (`artifactsRepoName`), so it is not guessable and never reused. Race repos are named by run id (`runRepoName`), so a reused run id would reuse the name; races are operator benchmark runs, not people's repositories, and content addressing keeps such a hit correct.
3. *Deletion: content addressing plus a short TTL, not a purge.* The Cache API cannot purge other colos, so the tier does not fail closed on deletion. A deleted repository's entries become unreachable instead: `deleteRepository` removes the registry record first and then closes the engine, so no access check passes and no engine id or repo name reaches either Durable Object again, and the name is never reused. An object id names the same bytes forever, so an entry is never stale. `max-age` is 7 days, not 30, to bound how long a deleted private repository's bytes stay in a colo's cache; a takedown of a committed secret in a private repository waits out those 7 days in the colos that read it (the accepted cost).
4. *Visibility does not matter here.* The gateway's Durable Objects do not know a repository's visibility, and nothing reads this tier for a viewer without the upstream access check, so a visibility flip changes nothing in it.

Public-only was considered and rejected: the gateway would have to look visibility up in the registry for every reader, the gain is the same for private repositories, and §3's risk has no path here, since every caller of the two Durable Objects is already past the check.

**Measured (offline replay).** The fastify load test's 38 landings on a 407-file tree (`test/fixtures/fastify-landings.json`). Each landing: the gate's diff read through the index, the warm-up, then derivation's `changesIn`. Both Durable Objects in one colo:

| | Engine (gate and warm-ups) | Derivation | Artifacts reads |
|---|---|---|---|
| Without the tier | 780 | 638 (76 commits, 256 trees, 306 blobs) | **1,418** |
| With the tier | 780 (unchanged: its index misses become tier misses) | **0** (all hits) | **780** (−45%) |

The tier's own hit rate is 0.46 (638 hits, 741 misses; blobs 306 of 866). If the two Durable Objects run in different colos the gain is zero and nothing else changes. Production check after deploying to the custom domain: `cache.edge` in a repository engine's summary, and the `object tier` log lines.

**Open point.** The Cache API inside Durable Objects works in Miniflare; in production the counters show whether it does there (all misses means it does nothing, and reads behave as before).
