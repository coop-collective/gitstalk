import { describe, expect, it } from 'vitest';

import type { CacheRead } from '../repo/cache-stats';
import type { ReadCache, RepoReader } from '../repo/object-cache';
import { MAX_CACHED_BLOB_BYTES, memoryObjectStore } from '../repo/object-cache';
import type { ObjectReadsRequest } from '../repo/object-reads';
import { serveObjectReads } from '../repo/object-reads';
import type { EngineObjects } from './engine-reader';
import { MAX_BLOBS_PER_CALL, engineReader } from './engine-reader';

const REPO = 'repo-engine-reader';
const COMMIT = 'c1'.repeat(20);
const TREE = 'a1'.repeat(20);
const SMALL = 'b1'.repeat(20);
const LARGE = 'b2'.repeat(20);

/** A repository in memory that counts what it is asked. */
function artifacts() {
  const calls = { commit: 0, tree: 0, blob: 0, opens: 0 };
  const reader: RepoReader = {
    readCommit: async (id) => {
      calls.commit += 1;
      return id === COMMIT ? commitMeta() : null;
    },
    readTree: async (id) => {
      calls.tree += 1;
      return id === TREE ? [{ name: 'a.ts', mode: '100644', hash: SMALL, type: 'blob' }] : null;
    },
    readBlob: async (id) => {
      calls.blob += 1;
      if (id === SMALL) return new Blob(['export const a = 1;\n']);
      if (id === LARGE) return new Blob([new Uint8Array(MAX_CACHED_BLOB_BYTES + 1)]);
      return null;
    },
    readFile: async () => null,
    log: async () => [],
  };
  return { reader, calls };
}

function commitMeta(): ArtifactsCommitMetadata {
  const person = { name: 'test', email: 'test@gitstalk.invalid' };
  return {
    hash: COMMIT,
    treeHash: TREE,
    message: 'start',
    author: person,
    committer: person,
    parents: [],
    authoredAt: 0,
    committedAt: 0,
  };
}

/** The engine's `readObjects` over an index in memory, counting its calls and reads. */
function engine(upstream: RepoReader) {
  const reads: CacheRead[] = [];
  const requests: ObjectReadsRequest[] = [];
  let opens = 0;
  const cache: ReadCache = {
    store: memoryObjectStore(),
    refs: new Map(),
    now: () => 0,
    count: (read) => reads.push(read),
    purpose: 'derived',
  };
  const open = async () => {
    opens += 1;
    return { ...upstream, [Symbol.dispose]: () => undefined };
  };
  const readObjects: EngineObjects = async (request) => {
    requests.push(request);
    return { ok: true, value: await serveObjectReads({ open, cache }, request.reads) };
  };
  return { readObjects, reads, requests, opens: () => opens };
}

function warnings() {
  const lines: string[] = [];
  return { lines, warn: (message: string) => lines.push(message) };
}

describe('the derived data’s reader through the engine', () => {
  it('asks the engine once for reads issued together, and its index serves them again', async () => {
    const repo = artifacts();
    const served = engine(repo.reader);
    const reader = engineReader({
      repo: REPO,
      engine: served.readObjects,
      direct: repo.reader,
      warn: () => undefined,
    });

    const [commit, tree, blob] = await Promise.all([
      reader.readCommit(COMMIT),
      reader.readTree(TREE),
      reader.readBlob(SMALL),
    ]);
    const again = await reader.readFile({ ref: COMMIT, path: 'a.ts' });

    expect(commit?.treeHash).toBe(TREE);
    expect(tree?.map((entry) => entry.name)).toEqual(['a.ts']);
    expect(await blob?.text()).toBe('export const a = 1;\n');
    expect(await again?.text()).toBe('export const a = 1;\n');
    expect(served.requests[0]?.reads).toHaveLength(3);
    expect(served.requests[0]?.repo).toBe(REPO);
    // Each object fetched from Artifacts once, the repeat reads all hits.
    expect(repo.calls).toMatchObject({ commit: 1, tree: 1, blob: 1 });
    expect(served.reads.filter((read) => read.outcome === 'miss')).toHaveLength(3);
    expect(served.reads.filter((read) => read.outcome === 'hit')).toHaveLength(3);
    expect(served.reads.every((read) => read.purpose === 'derived')).toBe(true);
  });

  it('opens nothing when the engine’s index holds every object asked for', async () => {
    const repo = artifacts();
    const served = engine(repo.reader);
    const reader = engineReader({
      repo: REPO,
      engine: served.readObjects,
      direct: repo.reader,
      warn: () => undefined,
    });

    await reader.readCommit(COMMIT);
    await reader.readCommit(COMMIT);

    expect(served.opens()).toBe(1);
    expect(repo.calls.commit).toBe(1);
  });

  it('splits a large batch so that no call carries more than its share of blobs', async () => {
    const repo = artifacts();
    const served = engine(repo.reader);
    const reader = engineReader({
      repo: REPO,
      engine: served.readObjects,
      direct: repo.reader,
      warn: () => undefined,
    });
    const ids = Array.from({ length: MAX_BLOBS_PER_CALL + 1 }, (_, index) =>
      index.toString(16).padStart(40, '0'),
    );

    await Promise.all(ids.map((id) => reader.readBlob(id)));

    expect(served.requests.map((request) => request.reads.length)).toEqual([MAX_BLOBS_PER_CALL, 1]);
  });

  it('reads a blob over the index’s cap from Artifacts itself', async () => {
    const repo = artifacts();
    const served = engine(repo.reader);
    const reader = engineReader({
      repo: REPO,
      engine: served.readObjects,
      direct: repo.reader,
      warn: () => undefined,
    });

    const blob = await reader.readBlob(LARGE);

    expect(blob?.size).toBe(MAX_CACHED_BLOB_BYTES + 1);
    // Once by the engine (not kept, not sent), once by the reader.
    expect(repo.calls.blob).toBe(2);
  });

  it('falls back to Artifacts with one log line when the engine throws', async () => {
    const repo = artifacts();
    const log = warnings();
    let engineCalls = 0;
    const reader = engineReader({
      repo: REPO,
      engine: async () => {
        engineCalls += 1;
        throw new Error('engine unreachable');
      },
      direct: repo.reader,
      warn: log.warn,
    });

    const commit = await reader.readCommit(COMMIT);
    const blob = await reader.readBlob(SMALL);

    expect(commit?.hash).toBe(COMMIT);
    expect(await blob?.text()).toBe('export const a = 1;\n');
    expect(engineCalls).toBe(1);
    expect(log.lines).toEqual(['engine object reads failed; reading Artifacts directly']);
  });

  it('falls back to Artifacts when the engine refuses the reads', async () => {
    const repo = artifacts();
    const log = warnings();
    const reader = engineReader({
      repo: REPO,
      engine: async () => ({ ok: false, error: { code: 'not_found', message: 'no such run' } }),
      direct: repo.reader,
      warn: log.warn,
    });

    const tree = await reader.readTree(TREE);

    expect(tree).toHaveLength(1);
    expect(log.lines).toEqual(['engine object reads refused; reading Artifacts directly']);
  });

  it('passes an Artifacts failure on the fallback to the caller', async () => {
    const repo = artifacts();
    const failing: RepoReader = {
      ...repo.reader,
      readCommit: async () => {
        throw new Error('artifacts down');
      },
    };
    const reader = engineReader({
      repo: REPO,
      engine: async () => {
        throw new Error('engine unreachable');
      },
      direct: failing,
      warn: () => undefined,
    });

    await expect(reader.readCommit(COMMIT)).rejects.toThrow('artifacts down');
  });
});
