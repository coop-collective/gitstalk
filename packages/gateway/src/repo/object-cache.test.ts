import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { CacheRead } from './cache-stats';
import type { RepoReader } from './object-cache';
import { REF_MEMO_MS, cachedReader, memoryObjectStore, sqlObjectStore } from './object-cache';

const ROOT = 'a'.repeat(40);
const SRC = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const COMMIT = 'd'.repeat(40);
const NEXT = 'e'.repeat(40);

const PERSON = { name: 'runner', email: 'runner@gitstalk.invalid' };

function commit(hash: string): ArtifactsCommitMetadata {
  return {
    hash,
    treeHash: ROOT,
    message: 'landing',
    author: PERSON,
    committer: PERSON,
    parents: [],
    authoredAt: 0,
    committedAt: 0,
  };
}

/** A repo with `src/app.ts`, counting the calls that reach it. */
function countingRepo() {
  const calls: string[] = [];
  const heads = { sprout: COMMIT };
  const trees: Record<string, ArtifactsTreeEntry[]> = {
    [ROOT]: [{ name: 'src', mode: '40000', hash: SRC, type: 'tree' }],
    [SRC]: [{ name: 'app.ts', mode: '100644', hash: BLOB, type: 'blob' }],
  };
  const reader: RepoReader = {
    readTree: (hash) => {
      calls.push(`readTree ${hash.slice(0, 1)}`);
      return Promise.resolve(trees[hash] ?? null);
    },
    readBlob: (hash) => {
      calls.push(`readBlob ${hash.slice(0, 1)}`);
      return Promise.resolve(hash === BLOB ? new Blob(['export const app = 1;\n']) : null);
    },
    readCommit: (hash) => {
      calls.push(`readCommit ${hash.slice(0, 1)}`);
      return Promise.resolve(commit(hash));
    },
    readFile: () => Promise.reject(new Error('the cache resolves files through trees')),
    log: (options) => {
      calls.push(`log ${options?.ref ?? ''}`);
      return Promise.resolve([commit(heads.sprout)]);
    },
  };
  return { reader, calls, heads };
}

function clock() {
  const time = { ms: 0 };
  return { now: () => time.ms, advance: (ms: number) => (time.ms += ms) };
}

describe('the read index', () => {
  it('reads each tree, blob and commit from Artifacts once', async () => {
    const repo = countingRepo();
    const cached = cachedReader(repo.reader, {
      store: memoryObjectStore(),
      refs: new Map(),
      now: () => 0,
    });

    await cached.readTree(ROOT);
    await cached.readTree(ROOT);
    const first = await cached.readBlob(BLOB);
    const second = await cached.readBlob(BLOB);
    await cached.readCommit(NEXT);
    await cached.readCommit(NEXT);

    expect(await first?.text()).toBe('export const app = 1;\n');
    expect(await second?.text()).toBe('export const app = 1;\n');
    expect(repo.calls).toEqual(['readTree a', 'readBlob c', 'readCommit e']);
  });

  it('resolves a file through cached trees, so a second read of it costs no call', async () => {
    const repo = countingRepo();
    const cached = cachedReader(repo.reader, {
      store: memoryObjectStore(),
      refs: new Map(),
      now: () => 0,
    });

    const file = await cached.readFile({ ref: COMMIT, path: 'src/app.ts' });
    const calls = repo.calls.length;
    const again = await cached.readFile({ ref: COMMIT, path: 'src/app.ts' });
    const missing = await cached.readFile({ ref: COMMIT, path: 'src/none.ts' });

    expect(await file?.text()).toBe('export const app = 1;\n');
    expect(await again?.text()).toBe('export const app = 1;\n');
    expect(missing).toBeNull();
    expect(repo.calls).toHaveLength(calls);
  });

  it('answers a named ref from memory for a few seconds, then asks again', async () => {
    const repo = countingRepo();
    const time = clock();
    const refs = new Map();
    const cached = cachedReader(repo.reader, { store: memoryObjectStore(), refs, now: time.now });

    const [first] = await cached.log({ ref: 'sprout', limit: 1 });
    repo.heads.sprout = NEXT;
    const [memoised] = await cached.log({ ref: 'sprout', limit: 1 });
    time.advance(REF_MEMO_MS);
    const [moved] = await cached.log({ ref: 'sprout', limit: 1 });

    expect(first?.hash).toBe(COMMIT);
    expect(memoised?.hash).toBe(COMMIT);
    expect(moved?.hash).toBe(NEXT);
    expect(repo.calls).toEqual(['log sprout', 'log sprout']);
  });

  it('asks again at once when the memo of refs is cleared (a landing)', async () => {
    const repo = countingRepo();
    const refs = new Map();
    const cached = cachedReader(repo.reader, { store: memoryObjectStore(), refs, now: () => 0 });

    await cached.log({ ref: 'sprout', limit: 1 });
    repo.heads.sprout = NEXT;
    refs.clear();
    const [moved] = await cached.log({ ref: 'sprout', limit: 1 });

    expect(moved?.hash).toBe(NEXT);
  });

  it('never memoises a history read or a commit id', async () => {
    const repo = countingRepo();
    const cached = cachedReader(repo.reader, {
      store: memoryObjectStore(),
      refs: new Map(),
      now: () => 0,
    });

    await cached.log({ ref: 'sprout', limit: 100 });
    await cached.log({ ref: 'sprout', limit: 100 });
    await cached.log({ ref: COMMIT, limit: 1 });
    await cached.log({ ref: COMMIT, limit: 1 });

    expect(repo.calls).toHaveLength(4);
  });

  it('keeps objects in the RunDO SQLite across readers', async () => {
    const stub = env.RUNS.getByName('object-cache-test');
    const texts = await runInDurableObject(stub, async (_, state) => {
      const repo = countingRepo();
      const reader = () =>
        cachedReader(repo.reader, {
          store: sqlObjectStore(state.storage.sql),
          refs: new Map(),
          now: () => 0,
        });
      const first = await reader().readFile({ ref: COMMIT, path: 'src/app.ts' });
      const calls = repo.calls.length;
      const second = await reader().readFile({ ref: COMMIT, path: 'src/app.ts' });
      return {
        first: await first?.text(),
        second: await second?.text(),
        callsAfterSecond: repo.calls.length - calls,
      };
    });

    expect(texts).toEqual({
      first: 'export const app = 1;\n',
      second: 'export const app = 1;\n',
      callsAfterSecond: 0,
    });
  });

  it('prefetches a blob it does not hold, and skips one it holds without loading it', async () => {
    const repo = countingRepo();
    const store = memoryObjectStore();
    const cached = cachedReader(repo.reader, { store, refs: new Map(), now: () => 0 });

    await cached.prefetchBlob?.(BLOB);
    expect(store.hasBlob(BLOB)).toBe(true);
    await cached.prefetchBlob?.(BLOB);
    await cached.readBlob(BLOB);
    expect(repo.calls).toEqual(['readBlob c']);
  });

  it('tells it from the RunDO SQLite with a lookup that loads no body', async () => {
    const stub = env.RUNS.getByName('object-cache-has-test');
    const held = await runInDurableObject(stub, async (_, state) => {
      const store = sqlObjectStore(state.storage.sql);
      const before = store.hasBlob(BLOB);
      store.putBlob(BLOB, new Uint8Array([1, 2, 3]));
      return { before, after: store.hasBlob(BLOB), other: store.hasBlob(SRC) };
    });

    expect(held).toEqual({ before: false, after: true, other: false });
  });
});

/** A cached reader that records every hit and miss it counts. */
function countedReader(now: () => number = () => 0) {
  const repo = countingRepo();
  const reads: CacheRead[] = [];
  const cached = cachedReader(repo.reader, {
    store: memoryObjectStore(),
    refs: new Map(),
    now,
    count: (read) => reads.push(read),
  });
  return { cached, reads };
}

describe('the read index’s hit and miss counts', () => {
  it('counts a first read as a miss and a repeated read as a hit, by kind', async () => {
    const { cached, reads } = countedReader();

    await cached.readTree(ROOT);
    await cached.readTree(ROOT);
    await cached.readBlob(BLOB);
    await cached.readBlob(BLOB);
    await cached.readCommit(NEXT);
    await cached.readCommit(NEXT);

    expect(reads).toEqual([
      { kind: 'tree', outcome: 'miss', purpose: 'demand' },
      { kind: 'tree', outcome: 'hit', purpose: 'demand' },
      { kind: 'blob', outcome: 'miss', purpose: 'demand' },
      { kind: 'blob', outcome: 'hit', purpose: 'demand' },
      { kind: 'commit', outcome: 'miss', purpose: 'demand' },
      { kind: 'commit', outcome: 'hit', purpose: 'demand' },
    ]);
  });

  it('counts the ref memo apart from objects, a miss again once the memo expires', async () => {
    const time = clock();
    const { cached, reads } = countedReader(time.now);

    await cached.log({ ref: 'sprout', limit: 1 });
    await cached.log({ ref: 'sprout', limit: 1 });
    time.advance(REF_MEMO_MS);
    await cached.log({ ref: 'sprout', limit: 1 });

    expect(reads).toEqual([
      { kind: 'ref', outcome: 'miss', purpose: 'demand' },
      { kind: 'ref', outcome: 'hit', purpose: 'demand' },
      { kind: 'ref', outcome: 'miss', purpose: 'demand' },
    ]);
  });

  it('counts nothing for reads that bypass the cache', async () => {
    const { cached, reads } = countedReader();

    await cached.log({ ref: 'sprout', limit: 100 });
    await cached.log({ ref: COMMIT, limit: 1 });

    expect(reads).toEqual([]);
  });

  it('counts a prefetch apart from demand reads: a fetch as a miss, a held blob as a hit', async () => {
    const { cached, reads } = countedReader();

    await cached.prefetchBlob?.(BLOB);
    await cached.prefetchBlob?.(BLOB);
    await cached.readBlob(BLOB);

    expect(reads).toEqual([
      { kind: 'blob', outcome: 'miss', purpose: 'prefetch' },
      { kind: 'blob', outcome: 'hit', purpose: 'prefetch' },
      { kind: 'blob', outcome: 'hit', purpose: 'demand' },
    ]);
  });

  it('counts every read of a prefetching reader as prefetch', async () => {
    const repo = countingRepo();
    const reads: CacheRead[] = [];
    const cached = cachedReader(repo.reader, {
      store: memoryObjectStore(),
      refs: new Map(),
      now: () => 0,
      count: (read) => reads.push(read),
      purpose: 'prefetch',
    });

    await cached.readTree(ROOT);
    await cached.log({ ref: 'sprout', limit: 1 });

    expect(reads).toEqual([
      { kind: 'tree', outcome: 'miss', purpose: 'prefetch' },
      { kind: 'ref', outcome: 'miss', purpose: 'prefetch' },
    ]);
  });
});
