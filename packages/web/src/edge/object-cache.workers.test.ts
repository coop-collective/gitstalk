/**
 * The edge object cache on Miniflare: the real Cache API and the real `OBJECTS` KV namespace.
 * A "fresh isolate" is a new cache instance (its memory layer starts empty) over the same colo
 * and KV, as a recycled isolate or another one in the same data centre would see them.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { RunId, Sha } from '@gitstalk/shared-race/ids';

import type { RepoTree } from '@gitstalk/shared-ask/repo/repo-types';
import type { FileBlob } from '../repo-pages/engine-reads';
import { PublicEngine } from '../repo-pages/event-cache';
import { ReadGrant } from './read-grant';
import type { EdgeObject } from './cache-keys';
import { EDGE_CACHE_NAME, coloKey, kvKey } from './cache-keys';
import type { EdgeObjectCacheDeps } from './object-cache';
import { COLO_TTL_SECONDS, createEdgeObjectCache } from './object-cache';
import { FILE_CODEC, TREE_CODEC } from './stored-objects';

const ORIGIN = 'https://gitstalk.test';
const UPDATED_AT = '2026-10-14T12:00:00.000Z';
const SHA = Sha.parse('d'.repeat(40));

let engines = 0;
/** A new public engine per test, so tests share no keys. */
function publicEngine(): PublicEngine {
  engines += 1;
  const engine = PublicEngine.of(
    ReadGrant.afterAccessCheck({ visibility: 'public', updated_at: UPDATED_AT }),
    RunId.parse(`edgecache${engines}`),
  );
  if (engine === null) throw new Error('a public record names a public engine');
  return engine;
}

/** Background writes, awaited by the test instead of left to the runtime. */
function background() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    settle: () => Promise.all(pending.splice(0)),
  };
}

function edgeCache(
  writes: ReturnType<typeof background>,
  overrides: Partial<EdgeObjectCacheDeps> = {},
) {
  return createEdgeObjectCache({
    origin: () => ORIGIN,
    colo: () => caches.open(EDGE_CACHE_NAME),
    kv: () => env.OBJECTS,
    waitUntil: writes.waitUntil,
    isolateBytes: 1024 * 1024,
    ...overrides,
  });
}

/** A gateway read of one tree that counts its calls. */
function countingTree(sha: Sha = SHA) {
  let calls = 0;
  const tree: RepoTree = { ref: sha, sha, files: [{ path: 'README.md', size: 12 }] };
  return {
    calls: () => calls,
    load: () => {
      calls += 1;
      return Promise.resolve(tree);
    },
    tree,
  };
}

describe('reading through the layers', () => {
  it('misses once, then answers from this isolate, the colo, and KV in turn', async () => {
    const writes = background();
    const engine = publicEngine();
    const object: EdgeObject = { kind: 'tree', sha: SHA };
    const gateway = countingTree();

    const first = edgeCache(writes);
    expect((await first.read(engine, object, TREE_CODEC, gateway.load)).layer).toBe('gateway');
    await writes.settle();
    expect(first.stats()).toMatchObject({ misses: 1, writes: 2 });
    expect((await first.read(engine, object, TREE_CODEC, gateway.load)).layer).toBe('isolate');

    // A fresh isolate in the same colo.
    const second = edgeCache(writes);
    const fromColo = await second.read(engine, object, TREE_CODEC, gateway.load);
    expect(fromColo).toEqual({ value: gateway.tree, layer: 'colo' });

    // Another colo: nothing in its Cache API, but KV is global.
    await (await caches.open(EDGE_CACHE_NAME)).delete(await coloKey(ORIGIN, engine, object));
    const third = edgeCache(writes);
    expect((await third.read(engine, object, TREE_CODEC, gateway.load)).layer).toBe('kv');
    await writes.settle();
    // The KV hit filled that colo again.
    const fourth = edgeCache(writes);
    expect((await fourth.read(engine, object, TREE_CODEC, gateway.load)).layer).toBe('colo');

    expect(gateway.calls()).toBe(1);
  });

  it('stores the colo copy as public, for a week, without cookies or Vary', async () => {
    const writes = background();
    const engine = publicEngine();
    const object: EdgeObject = { kind: 'tree', sha: SHA };
    await edgeCache(writes).read(engine, object, TREE_CODEC, countingTree().load);
    await writes.settle();
    const stored = await (
      await caches.open(EDGE_CACHE_NAME)
    ).match(await coloKey(ORIGIN, engine, object));
    expect(stored?.headers.get('cache-control')).toBe(`public, max-age=${COLO_TTL_SECONDS}`);
    expect(stored?.headers.get('set-cookie')).toBeNull();
    expect(stored?.headers.get('vary')).toBeNull();
    await stored?.text();
  });

  it('answers a missing file without storing it, and reads it again next time', async () => {
    const writes = background();
    const engine = publicEngine();
    const object: EdgeObject = { kind: 'file', sha: SHA, path: 'gone.ts' };
    let calls = 0;
    const missing = (): Promise<FileBlob | null> => {
      calls += 1;
      return Promise.resolve(null);
    };
    const cache = edgeCache(writes);
    expect(await cache.read(engine, object, FILE_CODEC, missing)).toEqual({
      value: null,
      layer: 'gateway',
    });
    await writes.settle();
    expect(await env.OBJECTS.get(await kvKey(engine, object))).toBeNull();
    await cache.read(engine, object, FILE_CODEC, missing);
    expect(calls).toBe(2);
    expect(cache.stats().writes).toBe(0);
  });

  it('shares one read among concurrent reads of the same object', async () => {
    const writes = background();
    const engine = publicEngine();
    const object: EdgeObject = { kind: 'tree', sha: SHA };
    const gateway = countingTree();
    const cache = edgeCache(writes);
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => cache.read(engine, object, TREE_CODEC, gateway.load)),
    );
    await writes.settle();
    expect(gateway.calls()).toBe(1);
    expect(answers.map((answer) => answer.value)).toEqual(
      Array.from({ length: 5 }, () => gateway.tree),
    );
    expect(answers.filter((answer) => answer.layer === 'gateway')).toHaveLength(1);
  });

  it('lets a concurrent read whose leader failed read for itself', async () => {
    const writes = background();
    const engine = publicEngine();
    const object: EdgeObject = { kind: 'tree', sha: SHA };
    const gateway = countingTree();
    const cache = edgeCache(writes);
    const failing = (): Promise<RepoTree> => Promise.reject(new Error('gateway down'));
    const [leader, follower] = await Promise.allSettled([
      cache.read(engine, object, TREE_CODEC, failing),
      cache.read(engine, object, TREE_CODEC, gateway.load),
    ]);
    await writes.settle();
    expect(leader.status).toBe('rejected');
    expect(follower.status === 'fulfilled' ? follower.value.value : null).toEqual(gateway.tree);
    expect(gateway.calls()).toBe(1);
  });

  it('keeps nothing from a failed read', async () => {
    const writes = background();
    const engine = publicEngine();
    const object: EdgeObject = { kind: 'tree', sha: SHA };
    const cache = edgeCache(writes);
    await expect(
      cache.read(engine, object, TREE_CODEC, () => Promise.reject(new Error('gateway down'))),
    ).rejects.toThrow('gateway down');
    await writes.settle();
    expect(await env.OBJECTS.get(await kvKey(engine, object))).toBeNull();
    expect(
      await (await caches.open(EDGE_CACHE_NAME)).match(await coloKey(ORIGIN, engine, object)),
    ).toBeUndefined();
  });

  it('reads a corrupt or misshapen stored copy as a miss and writes a good one', async () => {
    const writes = background();
    const engine = publicEngine();
    const object: EdgeObject = { kind: 'tree', sha: SHA };
    await env.OBJECTS.put(await kvKey(engine, object), '{"sha":"not a sha","files":3}');
    const gateway = countingTree();
    const cache = edgeCache(writes);
    expect((await cache.read(engine, object, TREE_CODEC, gateway.load)).layer).toBe('gateway');
    await writes.settle();
    expect(JSON.parse((await env.OBJECTS.get(await kvKey(engine, object))) ?? 'null')).toEqual(
      gateway.tree,
    );
  });

  it('reads through when the colo layer fails, rather than failing the page', async () => {
    const writes = background();
    const engine = publicEngine();
    const gateway = countingTree();
    const cache = edgeCache(writes, { colo: () => Promise.reject(new Error('cache broken')) });
    const answer = await cache.read(engine, { kind: 'tree', sha: SHA }, TREE_CODEC, gateway.load);
    expect(answer.layer).toBe('gateway');
    await writes.settle();
    expect(gateway.calls()).toBe(1);
  });

  it('skips KV for a value over its size bound', async () => {
    const writes = background();
    const engine = publicEngine();
    const object: EdgeObject = { kind: 'file', sha: SHA, path: 'big.bin' };
    const big: FileBlob = {
      path: 'big.bin',
      size: 2,
      binary: false,
      content: 'x'.repeat(1_100_000),
      truncated: false,
    };
    await edgeCache(writes).read(engine, object, FILE_CODEC, () => Promise.resolve(big));
    await writes.settle();
    expect(await env.OBJECTS.get(await kvKey(engine, object))).toBeNull();
  });

  it('refuses a codec for another kind of object', async () => {
    const cache = edgeCache(background());
    await expect(
      cache.read(
        publicEngine(),
        { kind: 'file', sha: SHA, path: 'a' },
        TREE_CODEC,
        countingTree().load,
      ),
    ).rejects.toThrow(TypeError);
  });
});
