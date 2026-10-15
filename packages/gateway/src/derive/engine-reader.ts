/**
 * The derived data's reader of git objects through the repository's engine
 * (docs/claude-opus/35-caching.md §12). Commits, trees and blobs are asked of the engine's
 * RunDO (`readObjects`, served from its read index), which has usually read them already;
 * refs and history pages go to Artifacts directly, as before. Reads issued together (a level
 * of a tree walk, a batch of a diff's files) go out as one call. If the engine cannot answer,
 * the reader logs it once and reads Artifacts directly from then on, so derivation never
 * stalls on the engine.
 */
import { assertNever } from '../engine/errors';
import type { ObjectKey, ObjectRead, ObjectReadsRequest } from '../repo/object-reads';
import { MAX_OBJECT_READS, keyOf, objectKey } from '../repo/object-reads';
import type { RepoReader } from '../repo/object-cache';
import { readPath } from '../repo/object-cache';

/** Blobs per call: each is at most the index's 1 MB cap, which keeps an answer well under RPC's limit. */
export const MAX_BLOBS_PER_CALL = 16;
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** The engine's answer: the objects in request order, or why it could not read them. */
export type EngineObjects = (
  request: ObjectReadsRequest,
) => Promise<
  | { readonly ok: true; readonly value: readonly ObjectRead[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
>;

export type EngineReaderOptions = {
  /** The Artifacts repository the engine drives. */
  readonly repo: string;
  /** The engine's `readObjects`. */
  readonly engine: EngineObjects;
  /** The repository opened on Artifacts: refs, history, and the fallback. */
  readonly direct: RepoReader;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
};

/** A reader whose object reads go through the engine, everything else to `direct`. */
export function engineReader(options: EngineReaderOptions): RepoReader {
  const { direct } = options;
  const read = readBatcher(engineChunkReader(options));
  const readCommit = async (id: string): Promise<ArtifactsCommitMetadata | null> => {
    const answer = await read({ kind: 'commit', id });
    return answer.kind === 'commit' ? answer.commit : direct.readCommit(id);
  };
  const readTree = async (id: string): Promise<ArtifactsTreeEntry[] | null> => {
    const answer = await read({ kind: 'tree', id });
    return answer.kind === 'tree' ? answer.entries : direct.readTree(id);
  };
  const readBlob = async (id: string): Promise<Blob | null> => {
    const answer = await read({ kind: 'blob', id });
    if (answer.kind !== 'blob') return direct.readBlob(id);
    return answer.bytes === null ? null : new Blob([answer.bytes]);
  };
  const readFile: RepoReader['readFile'] = async ({ ref, path }) => {
    if (!COMMIT_ID.test(ref)) return direct.readFile({ ref, path });
    const commit = await readCommit(ref);
    return readPath({ readTree, readBlob }, commit?.treeHash ?? null, path);
  };
  return { readCommit, readTree, readBlob, readFile, log: (query) => direct.log(query) };
}

/**
 * Reads a chunk of objects from the engine; after the engine's first failure, from Artifacts
 * (the failure is logged once per reader).
 */
function engineChunkReader(
  options: EngineReaderOptions,
): (keys: readonly ObjectKey[]) => Promise<readonly ObjectRead[]> {
  let isEngineDown = false;
  return async (keys) => {
    if (!isEngineDown) {
      try {
        const answer = await options.engine({ repo: options.repo, reads: [...keys] });
        if (answer.ok) return answer.value;
        options.warn('engine object reads refused; reading Artifacts directly', {
          code: answer.error.code,
          message: answer.error.message,
        });
      } catch (error: unknown) {
        options.warn('engine object reads failed; reading Artifacts directly', { error });
      }
      isEngineDown = true;
    }
    return Promise.all(keys.map((key) => readDirect(options.direct, key)));
  };
}

async function readDirect(direct: RepoReader, key: ObjectKey): Promise<ObjectRead> {
  switch (key.kind) {
    case 'commit':
      return { kind: 'commit', id: key.id, commit: await direct.readCommit(key.id) };
    case 'tree':
      return { kind: 'tree', id: key.id, entries: await direct.readTree(key.id) };
    case 'blob': {
      const blob = await direct.readBlob(key.id);
      const bytes = blob === null ? null : new Uint8Array(await blob.arrayBuffer());
      return { kind: 'blob', id: key.id, bytes };
    }
    default:
      return assertNever(key.kind);
  }
}

type Waiting = { readonly key: ObjectKey } & PromiseWithResolvers<ObjectRead>;

/**
 * Collects the reads issued before the next task (a timer, so every sibling of a tree walk's
 * level has asked by then), asks for each object once, and splits them into calls of at most
 * `MAX_OBJECT_READS` objects and `MAX_BLOBS_PER_CALL` blobs.
 */
function readBatcher(
  readChunk: (keys: readonly ObjectKey[]) => Promise<readonly ObjectRead[]>,
): (key: ObjectKey) => Promise<ObjectRead> {
  const queued = new Map<string, Waiting>();
  const flush = (): void => {
    const batch = [...queued.values()];
    queued.clear();
    for (const chunk of chunks(batch)) void settle(chunk, readChunk);
  };
  return (key) => {
    const name = objectKey(key);
    const waiting = queued.get(name);
    if (waiting !== undefined) return waiting.promise;
    if (queued.size === 0) setTimeout(flush, 0);
    const next = { key, ...Promise.withResolvers<ObjectRead>() };
    queued.set(name, next);
    return next.promise;
  };
}

/** Settles every waiting read of `chunk`; never rejects (each read carries the failure). */
async function settle(
  chunk: readonly Waiting[],
  readChunk: (keys: readonly ObjectKey[]) => Promise<readonly ObjectRead[]>,
): Promise<void> {
  try {
    const reads = await readChunk(chunk.map((waiting) => waiting.key));
    const byKey = new Map(reads.map((read) => [keyOf(read), read]));
    for (const waiting of chunk) {
      const read = byKey.get(objectKey(waiting.key));
      if (read === undefined)
        waiting.reject(new Error(`the engine did not answer ${objectKey(waiting.key)}`));
      else waiting.resolve(read);
    }
  } catch (error: unknown) {
    for (const waiting of chunk) waiting.reject(error);
  }
}

function chunks(batch: readonly Waiting[]): Waiting[][] {
  const out: Waiting[][] = [];
  let current: Waiting[] = [];
  let blobs = 0;
  for (const waiting of batch) {
    const isBlob = waiting.key.kind === 'blob';
    if (current.length === MAX_OBJECT_READS || (isBlob && blobs === MAX_BLOBS_PER_CALL)) {
      out.push(current);
      current = [];
      blobs = 0;
    }
    current.push(waiting);
    if (isBlob) blobs += 1;
  }
  if (current.length > 0) out.push(current);
  return out;
}
