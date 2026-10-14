/**
 * This isolate's edge object cache, bound to the Worker: the named Cache API cache, the
 * `OBJECTS` KV namespace and `waitUntil`. Module scope on purpose: the isolate layer is the
 * cache across requests, and it holds only public repositories' objects. Server-only.
 */
import { env, waitUntil } from 'cloudflare:workers';

import { EDGE_CACHE_NAME } from './cache-keys';
import type { EdgeObjectCache } from './object-cache';
import { createEdgeObjectCache } from './object-cache';

/** Beside the event logs (tens of MB at most) in a 128 MB isolate. */
const ISOLATE_BYTES = 16 * 1024 * 1024;

export const publicObjects: EdgeObjectCache = createEdgeObjectCache({
  origin: () => env.WEB_URL,
  colo: () => namedCache(EDGE_CACHE_NAME),
  kv: () => env.OBJECTS,
  waitUntil,
  isolateBytes: ISOLATE_BYTES,
});

/** The named cache, or null where the runtime has no Cache API (plain Node, in tests). */
async function namedCache(name: string): Promise<Cache | null> {
  return 'caches' in globalThis ? caches.open(name) : null;
}
