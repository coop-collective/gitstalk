/**
 * The private object cache (docs/claude-opus/35-caching.md §3): a private or internal
 * repository's objects at commit shas (a tree, a file, the diff of two commits), read through
 * Workers KV (`OBJECTS`, its own `v1:priv:` key namespace) above the gateway.
 *
 * KV only. The isolate memory and the Cache API are shared, per colo, and cannot be purged, so
 * nothing private is ever put in either: this module has no dependency on them at all. KV is
 * global and every key carries the record's cache epoch, so a settings save, a visibility flip,
 * a transfer, an archive or a deletion makes every old entry unreachable at once; entries expire
 * after `PRIVATE_KV_TTL_SECONDS`.
 *
 * Only a `PrivateEngine` can be named here, and only a `ReadGrant` makes one: the viewer passed
 * the access check on this request before any read. Keys hold nothing about the viewer, as the
 * content is the same for every viewer who may read the repository.
 */
import { log } from '../log';
import type { EdgeObject } from './cache-keys';
import { privateKvKey } from './cache-keys';
import type { EdgeOutcome } from './object-cache';
import { KV_MAX_BYTES, decode, guarded } from './object-cache';
import type { PrivateEngine } from './read-grant';
import type { EdgeCodec } from './stored-objects';

/** Private KV entries expire after a week (global). */
export const PRIVATE_KV_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Which layer answered a private read. */
export type PrivateLayer = 'kv' | 'gateway';

export type PrivateAnswer<T> = { readonly value: T; readonly layer: PrivateLayer };

/** The part of a KV namespace the private cache uses. */
export type PrivateKv = {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>;
};

export type PrivateObjectCacheDeps = {
  /** The KV namespace, or null when it is not bound. */
  readonly kv: () => PrivateKv | null;
  /** Keeps a write going after the response (`waitUntil` from cloudflare:workers). */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** Milliseconds, for the logged duration (default `Date.now`). */
  readonly now?: () => number;
};

export type PrivateStats = {
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
};

export type PrivateObjectCache = {
  /** The object from KV, else from `load` (null: not found, not stored). */
  read<T>(
    engine: PrivateEngine,
    object: EdgeObject,
    codec: EdgeCodec<NonNullable<T>>,
    load: () => Promise<T>,
  ): Promise<PrivateAnswer<T>>;
  stats(): PrivateStats;
};

/** A private read's outcome, counted apart from public ones. */
export function privateOutcome(layer: PrivateLayer): EdgeOutcome {
  return layer === 'kv' ? 'kv-hit-private' : 'kv-miss-private';
}

export function createPrivateObjectCache(deps: PrivateObjectCacheDeps): PrivateObjectCache {
  const counts = { hits: 0, misses: 0, writes: 0 };
  const now = deps.now ?? Date.now;
  const store = async (key: string, text: string): Promise<void> => {
    const kv = deps.kv();
    if (kv === null || new TextEncoder().encode(text).byteLength > KV_MAX_BYTES) return;
    await kv.put(key, text, { expirationTtl: PRIVATE_KV_TTL_SECONDS });
    counts.writes += 1;
  };
  return {
    stats: () => ({ ...counts }),
    read: async (engine, object, codec, load) => {
      if (codec.kind !== object.kind)
        throw new TypeError(`a ${codec.kind} codec cannot read a ${object.kind}`);
      const started = now();
      const key = await privateKvKey(engine, object);
      const answer = await readThrough({ key, codec, load, kv: deps.kv }, (text) =>
        deps.waitUntil(
          store(key, text).catch((error: unknown) =>
            log.warn('edge.write failed', { layer: 'kv', public: false, error }),
          ),
        ),
      );
      if (answer.layer === 'kv') counts.hits += 1;
      else counts.misses += 1;
      log.info('edge.read', {
        kind: object.kind,
        layer: answer.layer,
        result: privateOutcome(answer.layer),
        public: false,
        engine: engine.engine,
        ms: now() - started,
      });
      return answer;
    },
  };
}

async function readThrough<T>(
  input: {
    readonly key: string;
    readonly codec: EdgeCodec<NonNullable<T>>;
    readonly load: () => Promise<T>;
    readonly kv: () => PrivateKv | null;
  },
  writeBack: (text: string) => void,
): Promise<PrivateAnswer<T>> {
  const stored = await guarded('kv', readKv(input.kv(), input.key, input.codec));
  if (stored !== null) return { value: stored.value, layer: 'kv' };
  const value = await input.load();
  // Not found: answered, never stored. A failed load throws: nothing is stored either.
  if (value === null || value === undefined) return { value, layer: 'gateway' };
  writeBack(JSON.stringify(value));
  return { value, layer: 'gateway' };
}

async function readKv<T>(kv: PrivateKv | null, key: string, codec: EdgeCodec<T>) {
  const text = await kv?.get(key, 'text');
  return text === null || text === undefined ? null : decode(text, codec);
}
