/**
 * Git objects by id, served from a repository engine's read index (`object-cache.ts`) to the
 * repository's derived data (`derive/engine-reader.ts`, docs/claude-opus/35-caching.md §12).
 * The engine's RunDO has usually read a landing's commits, trees and blobs already (the
 * approval gate, the warm-up), so derivation reading through it spares Artifacts a second
 * fetch of each. Objects only: no refs, no engine state. Blobs over the index's cap are not
 * sent; the reader fetches those itself.
 */
import { z } from 'zod';

import { assertNever } from '../engine/errors';
import type { ReadCache, RepoReader } from './object-cache';
import { MAX_CACHED_BLOB_BYTES, cachedReader } from './object-cache';

/** Object reads in one request (the reader sends a few blobs per call; see its batcher). */
export const MAX_OBJECT_READS = 64;
/** A SHA-1 or SHA-256 object id, lowercase hex. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const ObjectKey = z.object({
  kind: z.enum(['commit', 'tree', 'blob']),
  id: z.string().regex(OBJECT_ID, 'object ids are 40 or 64 lowercase hex characters'),
});
export type ObjectKey = z.infer<typeof ObjectKey>;

/** What the derived data asks its engine for: objects of the Artifacts repository `repo`. */
export const ObjectReadsRequest = z.object({
  repo: z.string().min(1),
  reads: z.array(ObjectKey).min(1).max(MAX_OBJECT_READS),
});
export type ObjectReadsRequest = z.infer<typeof ObjectReadsRequest>;

/** One object read; null when the repository has no such object. */
export type ObjectRead =
  | {
      readonly kind: 'commit';
      readonly id: string;
      readonly commit: ArtifactsCommitMetadata | null;
    }
  | { readonly kind: 'tree'; readonly id: string; readonly entries: ArtifactsTreeEntry[] | null }
  | { readonly kind: 'blob'; readonly id: string; readonly bytes: Uint8Array<ArrayBuffer> | null }
  /** A blob over the index's cap: not sent, the reader fetches it from Artifacts. */
  | { readonly kind: 'oversized-blob'; readonly id: string };

/** A repository opened for reading (an Artifacts handle), released after use. */
export type OpenedRepo = RepoReader & { [Symbol.dispose](): void };

/** Where the engine reads what its index does not hold, and the index it reads through. */
export type ObjectSource = {
  /** Opens the repository; called at most once per request, on the first miss. */
  readonly open: () => Promise<OpenedRepo>;
  readonly cache: ReadCache;
};

/**
 * Answers `reads` in order through the read index: a hit is served from it, a miss is read
 * from Artifacts, stored, then served. A request whose objects are all held opens nothing.
 */
export async function serveObjectReads(
  source: ObjectSource,
  reads: readonly ObjectKey[],
): Promise<ObjectRead[]> {
  const repo = lazyRepo(source.open);
  try {
    const reader = cachedReader(repo.reader, source.cache);
    return await Promise.all(reads.map((key) => serveRead(reader, key)));
  } finally {
    await repo.release();
  }
}

/** The key an answer stands for (an oversized blob answers a blob read). */
export function keyOf(read: ObjectRead): string {
  return objectKey({ kind: read.kind === 'oversized-blob' ? 'blob' : read.kind, id: read.id });
}

export function objectKey(key: ObjectKey): string {
  return `${key.kind}:${key.id}`;
}

async function serveRead(reader: RepoReader, key: ObjectKey): Promise<ObjectRead> {
  switch (key.kind) {
    case 'commit':
      return { kind: 'commit', id: key.id, commit: await reader.readCommit(key.id) };
    case 'tree':
      return { kind: 'tree', id: key.id, entries: await reader.readTree(key.id) };
    case 'blob': {
      const blob = await reader.readBlob(key.id);
      if (blob === null) return { kind: 'blob', id: key.id, bytes: null };
      if (blob.size > MAX_CACHED_BLOB_BYTES) return { kind: 'oversized-blob', id: key.id };
      return { kind: 'blob', id: key.id, bytes: new Uint8Array(await blob.arrayBuffer()) };
    }
    default:
      return assertNever(key.kind);
  }
}

/** A repository handle opened on first use, and released after if it was. */
function lazyRepo(open: () => Promise<OpenedRepo>): {
  readonly reader: RepoReader;
  readonly release: () => Promise<void>;
} {
  let opened: Promise<OpenedRepo> | undefined;
  const handle = (): Promise<OpenedRepo> => (opened ??= open());
  return {
    reader: {
      readCommit: async (id) => (await handle()).readCommit(id),
      readTree: async (id) => (await handle()).readTree(id),
      readBlob: async (id) => (await handle()).readBlob(id),
      readFile: async (options) => (await handle()).readFile(options),
      log: async (options) => (await handle()).log(options),
    },
    release: async () => {
      if (opened === undefined) return;
      // A failed open has already failed the reads that waited on it; nothing to release.
      await opened.then(
        (repo) => repo[Symbol.dispose](),
        () => undefined,
      );
    },
  };
}
