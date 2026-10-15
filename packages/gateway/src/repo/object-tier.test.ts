import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { CacheRead, TierRead } from './cache-stats';
import type { RepoReader } from './object-cache';
import { MAX_CACHED_BLOB_BYTES, cachedReader, sqlObjectStore } from './object-cache';
import type { ObjectTier } from './object-tier';
import {
  OBJECT_TIER_CACHE,
  OBJECT_TIER_MAX_AGE_SECONDS,
  objectTier,
  objectTierKey,
  tieredReader,
} from './object-tier';

const ROOT = 'a'.repeat(40);
const SRC = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const COMMIT = 'd'.repeat(40);
const BIG = 'f'.repeat(40);
const MISSING = '0'.repeat(40);

const PERSON = { name: 'runner', email: 'runner@gitstalk.invalid' };
const TEXT = 'export const app = 1;\n';

describe('the object tier (colo Cache API under the read index)', () => {
  it('lets a second Durable Object read what the first fetched without Artifacts', async () => {
    const repo = 'repo-tiertwodos01';
    const artifacts = countingRepo();
    const first = await runInDurableObject(env.RUNS.getByName('tier-first'), (_, state) =>
      readThroughBoth(state, { repo, artifacts }),
    );
    const callsBefore = artifacts.calls.length;
    const second = await runInDurableObject(env.DERIVED.getByName('tier-second'), (_, state) =>
      readThroughBoth(state, { repo, artifacts }),
    );

    expect(first.text).toBe(TEXT);
    expect(first.tier).toEqual(['commit miss', 'tree miss', 'tree miss', 'blob miss']);
    expect(second.text).toBe(TEXT);
    // The second object's own index is empty, so it misses there and hits the tier.
    expect(second.index).toEqual(['commit miss', 'tree miss', 'tree miss', 'blob miss']);
    expect(second.tier).toEqual(['commit hit', 'tree hit', 'tree hit', 'blob hit']);
    expect(artifacts.calls.slice(callsBefore)).toEqual([]);
  });

  it('stores objects as immutable for a bounded time and never asks Artifacts for them again', async () => {
    const repo = 'repo-tierimmutab';
    const artifacts = countingRepo();
    const { tier, settled } = testTier();
    const reader = tieredReader(artifacts.reader, repo, tier);
    await reader.readBlob(BLOB);
    await settled();
    artifacts.blobs.set(BLOB, 'changed under the same id\n');

    const again = await reader.readBlob(BLOB);
    const stored = await (
      await caches.open(OBJECT_TIER_CACHE)
    ).match(objectTierKey(tier.origin, { repo, kind: 'blob', id: BLOB }));

    expect(await again?.text()).toBe(TEXT);
    expect(stored?.headers.get('Cache-Control')).toBe(
      `public, max-age=${OBJECT_TIER_MAX_AGE_SECONDS}, immutable`,
    );
    expect(artifacts.calls).toEqual(['readBlob c']);
  });

  it('never keeps refs: log and a file at a named ref always reach Artifacts', async () => {
    const artifacts = countingRepo();
    const { tier, reads } = testTier();
    const reader = tieredReader(artifacts.reader, 'repo-tierrefsnot', tier);

    await reader.log({ ref: 'sprout', limit: 1 });
    await reader.log({ ref: 'sprout', limit: 1 });
    await reader.readFile({ ref: 'sprout', path: 'src/app.ts' });
    await reader.readFile({ ref: 'sprout', path: 'src/app.ts' });

    expect(artifacts.calls).toEqual([
      'log sprout',
      'log sprout',
      'readFile sprout',
      'readFile sprout',
    ]);
    expect(reads).toEqual([]);
  });

  it('keeps the commit a ref read returned, so the next reader of it hits', async () => {
    const artifacts = countingRepo();
    const { tier, settled, reads } = testTier();
    const reader = tieredReader(artifacts.reader, 'repo-tierloghead', tier);
    await reader.log({ ref: 'sprout', limit: 1 });
    await settled();

    const read = await reader.readCommit(COMMIT);

    expect(read?.treeHash).toBe(ROOT);
    expect(reads).toEqual(['commit hit']);
    expect(artifacts.calls).toEqual(['log sprout']);
  });

  it('keeps each repository’s objects under its own keys', async () => {
    const left = countingRepo();
    const right = countingRepo();
    const { tier, settled, reads } = testTier();
    await tieredReader(left.reader, 'repo-tierleft001', tier).readBlob(BLOB);
    await settled();

    const read = await tieredReader(right.reader, 'repo-tierright01', tier).readBlob(BLOB);

    expect(await read?.text()).toBe(TEXT);
    expect(right.calls).toEqual(['readBlob c']);
    expect(reads).toEqual(['blob miss', 'blob miss']);
  });

  it('builds no reader for a repo name that is not one key segment', async () => {
    const artifacts = countingRepo();
    const { tier, reads } = testTier();
    for (const name of ['../repo-x', 'repo/x', '', 'repo-x?y']) {
      // oxlint-disable-next-line no-await-in-loop -- one name at a time, in order
      await tieredReader(artifacts.reader, name, tier).readBlob(BLOB);
    }

    expect(reads).toEqual([]);
    expect(artifacts.calls).toHaveLength(4);
  });

  it('serves no stored object over HTTP: the key URL is not a route', async () => {
    const repo = 'repo-tierhttp001';
    const { tier, settled } = testTier();
    await tieredReader(countingRepo().reader, repo, tier).readBlob(BLOB);
    await settled();
    const key = new URL(objectTierKey(tier.origin, { repo, kind: 'blob', id: BLOB }));

    const response = await SELF.fetch(`https://gateway.test${key.pathname}`);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(TEXT);
  });

  it('keeps neither a blob over the 1 MB cap nor a not-found', async () => {
    const artifacts = countingRepo();
    artifacts.blobs.set(BIG, 'x'.repeat(MAX_CACHED_BLOB_BYTES + 1));
    const { tier, settled, reads } = testTier();
    const reader = tieredReader(artifacts.reader, 'repo-tiercaps001', tier);
    for (const id of [BIG, MISSING, BIG, MISSING]) {
      // oxlint-disable-next-line no-await-in-loop -- each read follows the last one's write
      await reader.readBlob(id);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await settled();
    }

    expect(reads).toEqual(['blob miss', 'blob miss', 'blob miss', 'blob miss']);
    expect(artifacts.calls).toEqual(['readBlob f', 'readBlob 0', 'readBlob f', 'readBlob 0']);
  });

  it('reads a failing cache as a miss and says so', async () => {
    const failing = Promise.reject(new Error('cache unavailable'));
    failing.catch(() => undefined);
    const warnings: string[] = [];
    const { tier, settled } = testTier();
    const broken: ObjectTier = {
      ...tier,
      cache: failing,
      warn: (message) => warnings.push(message),
    };
    const artifacts = countingRepo();

    const read = await tieredReader(artifacts.reader, 'repo-tierbroken1', broken).readBlob(BLOB);
    await settled();

    expect(await read?.text()).toBe(TEXT);
    expect(warnings).toEqual(['object tier read failed', 'object tier write failed']);
  });

  it('is absent without an http(s) origin', () => {
    const hooks = { defer: () => undefined, warn: () => undefined };
    expect(objectTier('', hooks)).toBeNull();
    expect(objectTier('ftp://gateway.test', hooks)).toBeNull();
    expect(objectTier(env.PUBLIC_URL, hooks)?.origin).toBe(new URL(env.PUBLIC_URL).origin);
  });
});

/** `readFile` at a commit through the DO's SQLite index over the tier, counting both. */
async function readThroughBoth(
  state: DurableObjectState,
  source: { readonly repo: string; readonly artifacts: ReturnType<typeof countingRepo> },
) {
  const { tier, settled, reads } = testTier();
  const index: string[] = [];
  const reader = cachedReader(tieredReader(source.artifacts.reader, source.repo, tier), {
    store: sqlObjectStore(state.storage.sql),
    refs: new Map(),
    now: () => 0,
    count: (read: CacheRead) => index.push(`${read.kind} ${read.outcome}`),
  });
  const file = await reader.readFile({ ref: COMMIT, path: 'src/app.ts' });
  await settled();
  return { text: await file?.text(), index, tier: reads };
}

/** A tier over the test Worker's Cache API whose writes the test can wait for. */
function testTier() {
  const writes: Promise<void>[] = [];
  const reads: string[] = [];
  const tier = objectTier(env.PUBLIC_URL, {
    defer: (write) => writes.push(write),
    count: (read: TierRead) => reads.push(`${read.kind} ${read.outcome}`),
    warn: () => undefined,
  });
  if (tier === null) throw new Error('the test config sets PUBLIC_URL');
  return { tier, reads, settled: () => Promise.all(writes) };
}

/** A repo with `src/app.ts`, counting the calls that reach it. */
function countingRepo() {
  const calls: string[] = [];
  const blobs = new Map<string, string>([[BLOB, TEXT]]);
  const trees: Record<string, ArtifactsTreeEntry[]> = {
    [ROOT]: [{ name: 'src', mode: '40000', hash: SRC, type: 'tree' }],
    [SRC]: [{ name: 'app.ts', mode: '100644', hash: BLOB, type: 'blob' }],
  };
  const commit: ArtifactsCommitMetadata = {
    hash: COMMIT,
    treeHash: ROOT,
    message: 'landing',
    author: PERSON,
    committer: PERSON,
    parents: [],
    authoredAt: 0,
    committedAt: 0,
  };
  const reader: RepoReader = {
    readTree: (hash) => {
      calls.push(`readTree ${hash.slice(0, 1)}`);
      return Promise.resolve(trees[hash] ?? null);
    },
    readBlob: (hash) => {
      calls.push(`readBlob ${hash.slice(0, 1)}`);
      const text = blobs.get(hash);
      return Promise.resolve(text === undefined ? null : new Blob([text]));
    },
    readCommit: (hash) => {
      calls.push(`readCommit ${hash.slice(0, 1)}`);
      return Promise.resolve(hash === COMMIT ? commit : null);
    },
    readFile: ({ ref }) => {
      calls.push(`readFile ${ref}`);
      return Promise.resolve(new Blob([TEXT]));
    },
    log: (options) => {
      calls.push(`log ${options?.ref ?? ''}`);
      return Promise.resolve([commit]);
    },
  };
  return { reader, calls, blobs };
}
