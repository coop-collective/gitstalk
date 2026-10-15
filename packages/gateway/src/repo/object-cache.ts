/**
 * The run's read index (`docs/claude-opus/14` §11, fix 2): git objects read from Artifacts,
 * kept by object id in the RunDO's SQLite. Trees, blobs and commits never change under their
 * id, so a cached object is never stale; only refs move, and those are resolved from
 * Artifacts (or from a few seconds' memo that a landing clears). After a landing, a read of
 * the new sprout costs the new objects only, and the RunDO warms those right away.
 */

import { z } from 'zod';

import type { CacheRead, ReadPurpose } from './cache-stats';

/** The calls of an Artifacts repo handle that the explorer reads through. */
export type RepoReader = Pick<
  ArtifactsRepo,
  'readTree' | 'readBlob' | 'readCommit' | 'readFile' | 'log'
> & {
  /**
   * Makes sure the blob is held locally (a cached reader only): a blob already held is not
   * loaded, one that is not is read from Artifacts and stored. Counted as prefetch.
   */
  readonly prefetchBlob?: (id: string) => Promise<void>;
};

/** Where cached objects live: the RunDO's SQLite, or memory in tests. */
export type ObjectStore = {
  tree(id: string): ArtifactsTreeEntry[] | undefined;
  blob(id: string): Uint8Array<ArrayBuffer> | undefined;
  /** Whether a blob is stored, without loading its body. */
  hasBlob(id: string): boolean;
  commit(id: string): ArtifactsCommitMetadata | undefined;
  putTree(id: string, entries: readonly ArtifactsTreeEntry[]): void;
  putBlob(id: string, bytes: Uint8Array<ArrayBuffer>): void;
  putCommit(id: string, commit: ArtifactsCommitMetadata): void;
};

/** Named refs resolved within this long are answered from memory. */
export const REF_MEMO_MS = 5000;
/**
 * Blobs above this size are read through, not stored (a SQLite row holds at most 2 MB); the
 * object tier (`object-tier.ts`) keeps the same cap.
 */
export const MAX_CACHED_BLOB_BYTES = 1024 * 1024;
const COMMIT_ID = /^[0-9a-f]{40}$/;

const Person = z.object({ name: z.string(), email: z.string() });
/** A tree as a cache stores it (JSON). */
export const StoredTree = z.array(
  z.object({
    name: z.string(),
    mode: z.string(),
    hash: z.string(),
    type: z.enum(['tree', 'blob', 'symlink', 'gitlink', 'exec']),
  }),
);
/** A commit's metadata as a cache stores it (JSON). */
export const StoredCommit = z.object({
  hash: z.string(),
  treeHash: z.string(),
  message: z.string(),
  author: Person,
  committer: Person,
  parents: z.array(z.string()),
  authoredAt: z.number(),
  committedAt: z.number(),
});

/** What a cached reader keeps objects and refs in, and who counts its hits and misses. */
export type ReadCache = {
  readonly store: ObjectStore;
  readonly refs: RefMemo;
  readonly now: () => number;
  readonly count?: (read: CacheRead) => void;
  /** Whose reads these are (`cache-stats.ts`); absent: `demand`. */
  readonly purpose?: ReadPurpose;
};

/** Ref heads resolved recently (`log({ ref, limit: 1 })`), by ref; concurrent reads share one. */
export type RefMemo = Map<
  string,
  { readonly atMs: number; readonly head: Promise<ArtifactsCommitMetadata | null> }
>;

/**
 * A reader that answers object reads from `store` and fills it on a miss. `readFile` is
 * resolved through cached trees and blobs; `log` goes to Artifacts, except a one-commit
 * read of a named ref within `REF_MEMO_MS` of the last one (the ref's head). `count` hears
 * every object read and ref head read as a hit or a miss (`cache-stats.ts`), with `purpose`.
 */
export function cachedReader(handle: RepoReader, cache: ReadCache): RepoReader {
  const { store } = cache;
  const purpose = cache.purpose ?? 'demand';
  const count = (kind: CacheRead['kind'], isHit: boolean, as: ReadPurpose = purpose): void =>
    cache.count?.({ kind, outcome: isHit ? 'hit' : 'miss', purpose: as });
  const readTree = async (id: string): Promise<ArtifactsTreeEntry[] | null> => {
    const cached = store.tree(id);
    count('tree', cached !== undefined);
    if (cached !== undefined) return cached;
    const entries = await handle.readTree(id);
    if (entries !== null) store.putTree(id, entries);
    return entries;
  };
  const fetchBlob = async (id: string): Promise<Blob | null> => {
    const blob = await handle.readBlob(id);
    if (blob === null) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length <= MAX_CACHED_BLOB_BYTES) store.putBlob(id, bytes);
    return new Blob([bytes], { type: blob.type });
  };
  const readBlob = async (id: string): Promise<Blob | null> => {
    const cached = store.blob(id);
    count('blob', cached !== undefined);
    return cached === undefined ? fetchBlob(id) : new Blob([cached]);
  };
  const prefetchBlob = async (id: string): Promise<void> => {
    // A blob already held needs no read, and no body loaded to find out.
    const isHeld = store.hasBlob(id);
    count('blob', isHeld, 'prefetch');
    if (!isHeld) await fetchBlob(id);
  };
  const readCommit = async (id: string): Promise<ArtifactsCommitMetadata | null> => {
    const cached = store.commit(id);
    count('commit', cached !== undefined);
    if (cached !== undefined) return cached;
    const commit = await handle.readCommit(id);
    if (commit !== null) store.putCommit(id, commit);
    return commit;
  };
  const log: RepoReader['log'] = async (options) => {
    const ref = options?.ref;
    const isHeadRead = ref !== undefined && options?.limit === 1 && (options.offset ?? 0) === 0;
    if (!isHeadRead || COMMIT_ID.test(ref)) return handle.log(options);
    const memo = cache.refs.get(ref);
    const isMemoHit = memo !== undefined && cache.now() - memo.atMs < REF_MEMO_MS;
    count('ref', isMemoHit);
    if (isMemoHit) {
      const head = await memo.head;
      return head === null ? [] : [head];
    }
    const head = handle.log({ ref, limit: 1 }).then((commits) => commits[0] ?? null);
    const entry = { atMs: cache.now(), head };
    cache.refs.set(ref, entry);
    try {
      const resolved = await head;
      if (resolved !== null) store.putCommit(resolved.hash, resolved);
      return resolved === null ? [] : [resolved];
    } catch (error: unknown) {
      if (cache.refs.get(ref) === entry) cache.refs.delete(ref);
      throw error;
    }
  };
  const resolveTree = async (ref: string): Promise<string | null> => {
    if (COMMIT_ID.test(ref)) return (await readCommit(ref))?.treeHash ?? null;
    const [head] = await log({ ref, limit: 1 });
    return head?.treeHash ?? null;
  };
  const readFile: RepoReader['readFile'] = async ({ ref, path }) =>
    readPath({ readTree, readBlob }, await resolveTree(ref), path);
  return { readTree, readBlob, readCommit, readFile, log, prefetchBlob };
}

/** The blob at `path` under the tree `root`, read level by level; null when absent or a tree. */
export async function readPath(
  reads: Pick<RepoReader, 'readTree' | 'readBlob'>,
  root: string | null,
  path: string,
): Promise<Blob | null> {
  let current = root;
  const segments = path.split('/');
  for (const [index, segment] of segments.entries()) {
    if (current === null) return null;
    // oxlint-disable-next-line no-await-in-loop -- each level is read from the one above
    const entry = (await reads.readTree(current))?.find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    if (index === segments.length - 1)
      return entry.type === 'tree' ? null : reads.readBlob(entry.hash);
    current = entry.type === 'tree' ? entry.hash : null;
  }
  return null;
}

/** The store in the RunDO's SQLite (table `git_objects`, created on first use). */
export function sqlObjectStore(sql: SqlStorage): ObjectStore {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS git_objects (
       id TEXT NOT NULL,
       kind TEXT NOT NULL,
       body BLOB NOT NULL,
       PRIMARY KEY (id, kind)
     )`,
  );
  const get = (id: string, kind: string): ArrayBuffer | undefined => {
    const row = sql
      .exec<{ body: ArrayBuffer }>(
        'SELECT body FROM git_objects WHERE id = ? AND kind = ?',
        id,
        kind,
      )
      .toArray()[0];
    return row?.body;
  };
  const has = (id: string, kind: string): boolean =>
    sql.exec('SELECT 1 FROM git_objects WHERE id = ? AND kind = ?', id, kind).toArray().length > 0;
  const put = (id: string, kind: string, body: ArrayBuffer | Uint8Array): void => {
    sql.exec('INSERT OR IGNORE INTO git_objects (id, kind, body) VALUES (?, ?, ?)', id, kind, body);
  };
  const getJson = <S extends z.ZodType>(
    id: string,
    kind: string,
    schema: S,
  ): z.infer<S> | undefined => {
    const body = get(id, kind);
    if (body === undefined) return undefined;
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    // A row this code cannot read is a miss: the object is read from Artifacts again.
    return parsed.success ? parsed.data : undefined;
  };
  const putJson = (id: string, kind: string, value: unknown): void => {
    put(id, kind, new TextEncoder().encode(JSON.stringify(value)));
  };
  return {
    tree: (id) => getJson(id, 'tree', StoredTree),
    blob: (id) => {
      const body = get(id, 'blob');
      return body === undefined ? undefined : new Uint8Array(body);
    },
    hasBlob: (id) => has(id, 'blob'),
    commit: (id) => getJson(id, 'commit', StoredCommit),
    putTree: (id, entries) => putJson(id, 'tree', entries),
    putBlob: (id, bytes) => put(id, 'blob', bytes),
    putCommit: (id, commit) => putJson(id, 'commit', commit),
  };
}

/** A store in memory (tests and the timing harness). */
export function memoryObjectStore(): ObjectStore {
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  const commits = new Map<string, ArtifactsCommitMetadata>();
  return {
    tree: (id) => trees.get(id),
    blob: (id) => blobs.get(id),
    hasBlob: (id) => blobs.has(id),
    commit: (id) => commits.get(id),
    putTree: (id, entries) => trees.set(id, [...entries]),
    putBlob: (id, bytes) => blobs.set(id, bytes),
    putCommit: (id, commit) => commits.set(id, commit),
  };
}
