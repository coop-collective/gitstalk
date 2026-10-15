/**
 * The gateway's object tier (`docs/claude-opus/35-caching.md` §12): git objects by id in the
 * colo's Cache API, between the Durable Objects' own caches and Artifacts. The engine's
 * RunDO (under its SQLite read index) and the `RepoDerivedDO` read the same repository's
 * objects; through this tier the second reader in a colo finds what the first fetched.
 *
 * Only commits, trees and blobs by object id, never refs: an id names the same bytes forever,
 * so an entry is never stale. Private repositories' objects are kept too, under rules that
 * make that safe (§12): keys are `v1`, the Artifacts repo name and the object id, so one
 * repository's reader never addresses another's entries; the cache is a named cache under the
 * gateway's own origin, which no route serves; and only Durable Object code, holding a repo
 * name it stored or was handed after an access check, builds a tier reader.
 */
import type { TierKind, TierRead } from './cache-stats';
import type { RepoReader } from './object-cache';
import { MAX_CACHED_BLOB_BYTES, StoredCommit, StoredTree, readPath } from './object-cache';

/** The named cache; a new payload format gets a new name and a new key prefix. */
export const OBJECT_TIER_CACHE = 'gitstalk-gateway-objects-v1';
/**
 * Seven days per colo: an object is never stale, so this only bounds how long a deleted
 * repository's objects outlive it in a colo (unreachable all the while, §12).
 */
export const OBJECT_TIER_MAX_AGE_SECONDS = 7 * 24 * 3600;
/** Key path prefix under the gateway's origin; the router never serves it. */
export const OBJECT_TIER_PATH = '/__objects/v1';

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Artifacts repo names (`repo-<id>`, `run-…`): no slash, so a name is one key segment. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What a tier reader needs from its Durable Object. */
export type ObjectTier = {
  /** The colo's named cache (`caches.open(OBJECT_TIER_CACHE)`). */
  readonly cache: Promise<Cache>;
  /** The gateway's own origin (`PUBLIC_URL`); keys live under it. */
  readonly origin: string;
  /** Keeps a cache write alive past the read (`ctx.waitUntil`). */
  readonly defer: (write: Promise<void>) => void;
  /** Hears every object read as a hit or a miss. */
  readonly count?: (read: TierRead) => void;
  /** A failing cache call: logged, and the read goes on as a miss. */
  readonly warn: (message: string, fields: Readonly<Record<string, unknown>>) => void;
};

/**
 * The tier for a Durable Object, or null when `publicUrl` is not an http(s) origin (the tier is
 * then simply absent: every read goes to Artifacts as before).
 */
export function objectTier(
  publicUrl: string,
  hooks: Omit<ObjectTier, 'cache' | 'origin'>,
): ObjectTier | null {
  if (!URL.canParse(publicUrl)) return null;
  const { origin, protocol } = new URL(publicUrl);
  if (protocol !== 'https:' && protocol !== 'http:') return null;
  return { cache: caches.open(OBJECT_TIER_CACHE), origin, ...hooks };
}

/** The key of an object of `repo` (exported for tests; nothing else should build keys). */
export function objectTierKey(
  origin: string,
  object: { readonly repo: string; readonly kind: TierKind; readonly id: string },
): string {
  return `${origin}${OBJECT_TIER_PATH}/${object.repo}/${object.kind}/${object.id}`;
}

/**
 * A reader of the Artifacts repo `repo` that answers commits, trees and blobs by id from the
 * tier and fills it on a miss. `readFile` at a commit id walks trees through the tier; at a
 * named ref, and `log`, it goes to Artifacts (a ref's head commit is then kept by its id). A repo name that cannot be one key segment gets
 * the handle unchanged.
 */
export function tieredReader(handle: RepoReader, repo: string, tier: ObjectTier): RepoReader {
  if (!REPO_NAME.test(repo)) return handle;
  const slot = (kind: TierKind, id: string): Slot => ({
    tier,
    key: objectTierKey(tier.origin, { repo, kind, id }),
    kind,
    id,
  });
  const through = <T>(kind: TierKind, id: string, codec: Codec<T>, read: () => Promise<T | null>) =>
    readThrough(slot(kind, id), codec, read);
  const readTree = (id: string) => through('tree', id, TREE, () => handle.readTree(id));
  const readBlob = (id: string) => through('blob', id, BLOB, () => handle.readBlob(id));
  const readCommit = (id: string) => through('commit', id, COMMIT, () => handle.readCommit(id));
  const readFile: RepoReader['readFile'] = async (options) => {
    if (!OBJECT_ID.test(options.ref)) return handle.readFile(options);
    const commit = await readCommit(options.ref);
    return readPath({ readTree, readBlob }, commit?.treeHash ?? null, options.path);
  };
  const log: RepoReader['log'] = async (options) => {
    const commits = await handle.log(options);
    // A ref's head is resolved from Artifacts every time, but the commit it names is
    // immutable: kept under its id, the next reader's `readCommit` of it is a hit.
    const [head] = commits;
    if (options?.limit === 1 && head !== undefined && OBJECT_ID.test(head.hash))
      keep(slot('commit', head.hash), await COMMIT.encode(head));
    return commits;
  };
  return { readTree, readBlob, readCommit, readFile, log };
}

/** A stored body and its media type. */
type Encoded = { readonly body: string | ArrayBuffer; readonly type: string };

/** How one kind is stored: `encode` null means the value is not kept (an oversized blob). */
type Codec<T> = {
  encode(value: T): Promise<Encoded | null>;
  /** undefined: an entry this code cannot read, which counts as a miss. */
  decode(response: Response): Promise<T | undefined>;
};

type Slot = {
  readonly tier: ObjectTier;
  readonly key: string;
  readonly kind: TierKind;
  readonly id: string;
};

async function readThrough<T>(
  slot: Slot,
  codec: Codec<T>,
  read: () => Promise<T | null>,
): Promise<T | null> {
  if (!OBJECT_ID.test(slot.id)) return read();
  const cached = await lookUp(slot, codec);
  slot.tier.count?.({ kind: slot.kind, outcome: cached === undefined ? 'miss' : 'hit' });
  if (cached !== undefined) return cached;
  const value = await read();
  // Only a found object is kept, never a not-found: an id read too early may exist later.
  if (value !== null) keep(slot, await codec.encode(value));
  return value;
}

async function lookUp<T>(slot: Slot, codec: Codec<T>): Promise<T | undefined> {
  try {
    const response = await (await slot.tier.cache).match(slot.key);
    return response === undefined ? undefined : await codec.decode(response);
  } catch (error: unknown) {
    slot.tier.warn('object tier read failed', { kind: slot.kind, error });
    return undefined;
  }
}

/** Writes past the read: a failing write is logged and costs only a later miss. */
function keep(slot: Slot, encoded: Encoded | null): void {
  if (encoded === null) return;
  const response = new Response(encoded.body, {
    headers: {
      'Content-Type': encoded.type,
      'Cache-Control': `public, max-age=${OBJECT_TIER_MAX_AGE_SECONDS}, immutable`,
    },
  });
  slot.tier.defer(
    slot.tier.cache
      .then((cache) => cache.put(slot.key, response))
      .catch((error: unknown) => {
        slot.tier.warn('object tier write failed', { kind: slot.kind, error });
      }),
  );
}

const JSON_TYPE = 'application/json';

/** JSON bodies, read back through `parse` (undefined: a body this code cannot read). */
function jsonCodec<T>(parse: (value: unknown) => T | undefined): Codec<T> {
  return {
    encode: (value) =>
      Promise.resolve({
        body: JSON.stringify(value),
        type: JSON_TYPE,
      }),
    decode: async (response) => parse(await response.json()),
  };
}

const TREE = jsonCodec<ArtifactsTreeEntry[]>((value) => {
  const parsed = StoredTree.safeParse(value);
  return parsed.success ? parsed.data : undefined;
});
const COMMIT = jsonCodec<ArtifactsCommitMetadata>((value) => {
  const parsed = StoredCommit.safeParse(value);
  return parsed.success ? parsed.data : undefined;
});

/** Blobs as their bytes; one over the read index's 1 MB cap is read through, never kept. */
const BLOB: Codec<Blob> = {
  encode: async (blob) =>
    blob.size > MAX_CACHED_BLOB_BYTES
      ? null
      : { body: await blob.arrayBuffer(), type: 'application/octet-stream' },
  decode: async (response) => new Blob([await response.arrayBuffer()]),
};
