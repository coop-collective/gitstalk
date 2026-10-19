# Shared leaderboard: separate refresh from visits

Symptom: every visit aggregates global scores, writes a new cache entry, invalidates cached results or starts a refresh. First trace which layer does each action; a browser request count alone does not prove recomputation.

## Choose the simplest adequate producer

- For cheap queries with traffic-driven freshness, supported ISR may be enough. Time-based ISR is not a clock-driven job: a later request may receive stale content while regeneration runs. [ISR semantics](https://nextjs.org/docs/app/guides/incremental-static-regeneration)
- For expensive aggregation or freshness independent of visits, use an existing scheduled/event producer to publish a materialized snapshot. Normal visits read it. Do not add a new service if an existing producer meets the requirement.
- Coordinate refresh only if concurrent misses/updates can duplicate expensive work or publish obsolete results. A process-local promise map is not cross-isolate coordination; KV is not an atomic lock. [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## Example contract, not universal defaults

Suppose product requirements allow public rankings to lag by five minutes and, during an outage, allow explicitly marked stale data for at most thirty minutes. Those values need to come from the task/product; do not silently adopt them.

Publish complete snapshots with `computedAt`, a source/version identifier and an appropriate scope. Refresh early enough that source age plus producer delay, propagation, response residence and client residence fit the normal age limit. A five-minute schedule plus five-minute page cache does not meet a five-minute end-to-end requirement. If the age limit cannot be met, expose degraded/unavailable behavior or change the agreed contract; do not label old data fresh.

Serve the snapshot on normal loads. Keep a user's private rank/details out of the shared cache identity. On refresh failure, preserve the last good snapshot only within the agreed degraded age limit; surface its timestamp/state. Enforce any hard limit at outer caches too: an origin age check cannot protect a response served without contacting that origin.

On a cold cache, read the persistent snapshot first. If no snapshot exists, choose a bounded initialization path or a temporary unavailable response. Concurrent requests must not each start the costly aggregate. Publish only successful results; when refreshes can overlap, prevent an older completion replacing a newer version. Use bounded retries and observable failure reporting.

## Acceptance evidence

For this example, compare a warm sequence of visits with the baseline: source aggregations and refresh writes should follow the producer contract rather than visitor count. Check expiry, concurrent misses, producer failure and original data timestamps. Exercise both full-page and client navigation, and confirm private data never enters the shared result.

If using Cloudflare's Cache API, its entries are data-center-local; `cache.put`/`match` do not implement stale-while-revalidate automatically, and local deletion is not global invalidation. Account for the actual adapter/topology before claiming global freshness or deduplication. [Cache API behavior](https://developers.cloudflare.com/workers/runtime-apis/cache/)
