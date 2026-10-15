/**
 * The edge object cache (docs/claude-opus/35-caching.md §3): a public repository's objects at a
 * commit sha (a tree, a file, the diff of two commits), which never change, read through three
 * layers above the gateway:
 *
 * 1. `isolate`: this isolate's memory, an LRU bounded by bytes;
 * 2. `colo`: the Cache API, one named cache per data centre (free, no consistency question for
 *    immutable keys; a no-op on `*.workers.dev`, so production needs the custom domain);
 * 3. `kv`: Workers KV (`OBJECTS`), global, so the first visit in a new colo is warm;
 * 4. `gateway`: the read itself (the gateway's own SQLite object cache sits behind it).
 *
 * A hit fills the layers above it; a gateway read fills all three, with `waitUntil` for the
 * colo and KV writes. Concurrent reads of one key in an isolate share one read through the
 * layers (the burst after a landing, when every open page re-renders at once). Only a successful read is stored: a "not found" (null) is answered but
 * never kept, and a failed read throws. A layer that fails (a full KV, a broken cache) is
 * logged and read as a miss; the page never fails because of the cache.
 *
 * Only a `PublicEngine` can be named here: the caller holds the grant the viewer's access
 * check made on this request, and the repository is public. Private and internal repositories
 * never reach these shared layers (they have their own KV namespace, private-object-cache.ts),
 * so a shared hit can never leak one.
 */
import { log } from '../log';
import type { PublicEngine } from '../repo-pages/event-cache';
import type { EdgeObject } from './cache-keys';
import { coloKey, kvKey } from './cache-keys';
import type { EdgeCodec } from './stored-objects';

/** Which layer answered a read. */
export type EdgeLayer = 'isolate' | 'colo' | 'kv' | 'gateway';

/**
 * What a read came to, as `edge.read` logs it and `Server-Timing` names it: a public read hit
 * a layer or missed KV (and went to the gateway); a private read hit or missed the private KV
 * namespace, counted apart from the public one.
 */
export type EdgeOutcome =
  | 'isolate-hit'
  | 'colo-hit'
  | 'kv-hit'
  | 'kv-miss'
  | 'kv-hit-private'
  | 'kv-miss-private';

/** A public read's outcome from the layer that answered it. */
export function publicOutcome(layer: EdgeLayer): EdgeOutcome {
  return layer === 'gateway' ? 'kv-miss' : `${layer}-hit`;
}

/** Stored copies in the Cache API live this long (per colo): immutable, so this only bounds storage. */
export const COLO_TTL_SECONDS = 7 * 24 * 60 * 60;
/** KV copies expire after this long (global). */
export const KV_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Values above this are not written to KV (its writes are the costly ones). */
export const KV_MAX_BYTES = 1024 * 1024;

export type EdgeObjectCacheDeps = {
  /** This deployment's origin: the host of the Cache API keys. */
  readonly origin: () => string;
  /** The named Cache API cache, or null where the runtime has none. */
  readonly colo: () => Promise<Cache | null>;
  /** The KV namespace, or null when it is not bound. */
  readonly kv: () => KVNamespace | null;
  /** Keeps a write going after the response (`waitUntil` from cloudflare:workers). */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** What the isolate layer may hold, in bytes of JSON. */
  readonly isolateBytes: number;
  /** Milliseconds, for the logged duration (default `Date.now`). */
  readonly now?: () => number;
};

/** A read's answer and the layer that gave it. */
export type EdgeAnswer<T> = { readonly value: T; readonly layer: EdgeLayer };

export type EdgeStats = {
  readonly hits: Readonly<Record<Exclude<EdgeLayer, 'gateway'>, number>>;
  /** Reads that went to the gateway. */
  readonly misses: number;
  /** Copies written to the colo or KV layer. */
  readonly writes: number;
};

export type EdgeObjectCache = {
  /**
   * The object, from the nearest layer that holds it, else from `load` (null: not found, not
   * stored). `codec` checks what a layer gives back.
   */
  read<T>(
    engine: PublicEngine,
    object: EdgeObject,
    codec: EdgeCodec<NonNullable<T>>,
    load: () => Promise<T>,
  ): Promise<EdgeAnswer<T>>;
  /** Hits by layer, misses and writes since this cache was made (tests and logs). */
  stats(): EdgeStats;
};

export function createEdgeObjectCache(deps: EdgeObjectCacheDeps): EdgeObjectCache {
  const isolate = lruByBytes(deps.isolateBytes);
  const flights = new Map<string, Promise<unknown>>();
  const counts = { isolate: 0, colo: 0, kv: 0, misses: 0, writes: 0 };
  const now = deps.now ?? Date.now;
  const layers = storedLayers(deps, () => {
    counts.writes += 1;
  });
  return {
    stats: () => ({
      hits: { isolate: counts.isolate, colo: counts.colo, kv: counts.kv },
      misses: counts.misses,
      writes: counts.writes,
    }),
    read: async (engine, object, codec, load) => {
      if (codec.kind !== object.kind)
        throw new TypeError(`a ${codec.kind} codec cannot read a ${object.kind}`);
      const started = now();
      const keys = await layers.keys(engine, object);
      const answer = await coalesced(flights, keys.colo, codec, () =>
        readThrough({ keys, codec, load, isolate, layers }),
      );
      if (answer.layer === 'gateway') counts.misses += 1;
      else counts[answer.layer] += 1;
      log.info('edge.read', {
        kind: object.kind,
        layer: answer.layer,
        result: publicOutcome(answer.layer),
        public: true,
        engine: engine.engine,
        ms: now() - started,
      });
      return answer;
    },
  };
}

type Isolate = ReturnType<typeof lruByBytes>;
type Layers = ReturnType<typeof storedLayers>;
type Keys = { readonly colo: string; readonly kv: string };

/**
 * One read per key at a time in this isolate: a read that finds another in flight waits for
 * it and takes its value (answered as an isolate hit). A follower whose leader found nothing
 * or failed reads for itself, so a passing failure is never shared.
 */
async function coalesced<T>(
  flights: Map<string, Promise<unknown>>,
  key: string,
  codec: EdgeCodec<NonNullable<T>>,
  read: () => Promise<EdgeAnswer<T>>,
): Promise<EdgeAnswer<T>> {
  const pending = flights.get(key);
  if (pending !== undefined) {
    const value = await pending;
    if (codec.holds(value)) return { value, layer: 'isolate' };
  }
  const started = read();
  // The leader's own caller sees its failure; followers see null and read for themselves.
  const flight = started.then(
    (answer) => answer.value,
    () => null,
  );
  flights.set(key, flight);
  try {
    return await started;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}

async function readThrough<T>(input: {
  readonly keys: Keys;
  readonly codec: EdgeCodec<NonNullable<T>>;
  readonly load: () => Promise<T>;
  readonly isolate: Isolate;
  readonly layers: Layers;
}): Promise<EdgeAnswer<T>> {
  const { keys, codec, isolate, layers } = input;
  const held = isolate.get(keys.colo);
  if (held !== undefined && codec.holds(held)) return { value: held, layer: 'isolate' };
  const fromColo = await layers.readColo(keys.colo, codec);
  if (fromColo !== null) {
    isolate.put(keys.colo, fromColo.value, fromColo.text.length);
    return { value: fromColo.value, layer: 'colo' };
  }
  const fromKv = await layers.readKv(keys.kv, codec);
  if (fromKv !== null) {
    isolate.put(keys.colo, fromKv.value, fromKv.text.length);
    layers.writeBack({ ...keys, text: fromKv.text, to: ['colo'] });
    return { value: fromKv.value, layer: 'kv' };
  }
  const value = await input.load();
  // Not found: answered, never stored.
  if (value === null || value === undefined) return { value, layer: 'gateway' };
  const text = JSON.stringify(value);
  isolate.put(keys.colo, value, text.length);
  layers.writeBack({ ...keys, text, to: ['colo', 'kv'] });
  return { value, layer: 'gateway' };
}

/** A value read back from a stored layer, with its JSON (for the layers above). */
export type Stored<T> = { readonly value: T; readonly text: string };

/** The Cache API and KV layers: keys, guarded reads and background fills. */
function storedLayers(deps: EdgeObjectCacheDeps, wrote: () => void) {
  const readColo = async <T>(key: string, codec: EdgeCodec<T>): Promise<Stored<T> | null> => {
    const cache = await deps.colo();
    const response = await cache?.match(key);
    return response === undefined ? null : decode(await response.text(), codec);
  };
  const readKv = async <T>(key: string, codec: EdgeCodec<T>): Promise<Stored<T> | null> => {
    const text = await deps.kv()?.get(key, 'text');
    return text === null || text === undefined ? null : decode(text, codec);
  };
  const putColo = async (key: string, text: string): Promise<void> => {
    const cache = await deps.colo();
    if (cache === null) return;
    await cache.put(key, storedResponse(text));
    wrote();
  };
  const putKv = async (key: string, text: string): Promise<void> => {
    const kv = deps.kv();
    if (kv === null || new TextEncoder().encode(text).byteLength > KV_MAX_BYTES) return;
    await kv.put(key, text, { expirationTtl: KV_TTL_SECONDS });
    wrote();
  };
  return {
    keys: async (engine: PublicEngine, object: EdgeObject): Promise<Keys> => {
      const [colo, kv] = await Promise.all([
        coloKey(deps.origin(), engine, object),
        kvKey(engine, object),
      ]);
      return { colo, kv };
    },
    readColo: <T>(key: string, codec: EdgeCodec<T>) => guarded('colo', readColo(key, codec)),
    readKv: <T>(key: string, codec: EdgeCodec<T>) => guarded('kv', readKv(key, codec)),
    /** Writes the copy to the named layers after the response; a failed write is logged. */
    writeBack: (input: {
      readonly colo: string;
      readonly kv: string;
      readonly text: string;
      readonly to: readonly ('colo' | 'kv')[];
    }) => {
      const writes = input.to.map((layer) =>
        (layer === 'colo' ? putColo(input.colo, input.text) : putKv(input.kv, input.text)).catch(
          (error: unknown) => log.warn('edge.write failed', { layer, error }),
        ),
      );
      deps.waitUntil(Promise.all(writes));
    },
  };
}

/** A stored layer's read, with its failure logged and read as a miss. */
export async function guarded<T>(layer: 'colo' | 'kv', read: Promise<T | null>): Promise<T | null> {
  try {
    return await read;
  } catch (error: unknown) {
    log.warn('edge.read failed; reading through', { layer, error });
    return null;
  }
}

/** Stored JSON, when it parses and passes the codec; null otherwise (a miss). */
export function decode<T>(text: string, codec: EdgeCodec<T>): Stored<T> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // A corrupt copy is a miss: the read goes through and writes a good one.
    return null;
  }
  const value = codec.parse(json);
  return value === null ? null : { value, text };
}

/**
 * The copy the Cache API keeps: public (it is a public repository's immutable object) for
 * `COLO_TTL_SECONDS`, no cookies, no `Vary`. It is never handed to a client as it is: routes
 * build their own response with their own (private) headers.
 */
function storedResponse(text: string): Response {
  return new Response(text, {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${COLO_TTL_SECONDS}`,
    },
  });
}

/** Values by key, least recently read first (a `Map` keeps insertion order), bounded by bytes. */
function lruByBytes(budget: number) {
  const entries = new Map<string, { readonly value: unknown; readonly bytes: number }>();
  let total = 0;
  const drop = (key: string) => {
    total -= entries.get(key)?.bytes ?? 0;
    entries.delete(key);
  };
  return {
    get: (key: string): unknown => {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    put: (key: string, value: unknown, bytes: number): void => {
      drop(key);
      if (bytes > budget) return;
      entries.set(key, { value, bytes });
      total += bytes;
      for (const oldest of entries.keys()) {
        if (total <= budget) break;
        drop(oldest);
      }
    },
  };
}
