/**
 * This isolate's private object cache, bound to the Worker: the `OBJECTS` KV namespace (its
 * `v1:priv:` keys) and `waitUntil`. It holds no data itself; nothing private is kept in the
 * isolate or the Cache API. Server-only.
 */
import { env, waitUntil } from 'cloudflare:workers';

import type { PrivateObjectCache } from './private-object-cache';
import { createPrivateObjectCache } from './private-object-cache';

export const privateObjects: PrivateObjectCache = createPrivateObjectCache({
  kv: () => env.OBJECTS,
  waitUntil,
});
