/**
 * The private object cache on Miniflare, behind the real access check (`lookupRepository`, the
 * one the pages and the Changes routes run), with the real `OBJECTS` KV namespace and the real
 * Cache API watched: who gets a private repository's cached objects, when the cache answers,
 * how a record change makes old entries unreachable, and that nothing private ever reaches
 * `caches.default` or the named Cache API cache.
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunId, Sha } from '@gitstalk/shared-race/ids';

import type { RepoTree } from '@gitstalk/shared-ask/repo/repo-types';
import { lookupRepository } from '../repositories/flows';
import type { RegistryClient } from '../repositories/registry-client';
import { registryClient } from '../repositories/registry-client';
import type { EdgeObject } from './cache-keys';
import { privateKvKey } from './cache-keys';
import type { PrivateKv } from './private-object-cache';
import { PRIVATE_KV_TTL_SECONDS, createPrivateObjectCache } from './private-object-cache';
import { PrivateEngine, ReadGrant } from './read-grant';
import { TREE_CODEC } from './stored-objects';

const OWNER = { id: 'u_coop', handle: 'coop', email: 'coop@example.test' };
const MEMBER = { id: 'u_ada', handle: 'ada', email: 'ada@example.test' };
const STRANGER = { id: 'u_eve', handle: 'eve', email: 'eve@example.test' };
type Viewer = typeof OWNER | null;

const SHA = Sha.parse('e'.repeat(40));
const TREE_OBJECT: EdgeObject = { kind: 'tree', sha: SHA };

let repositories = 0;

/** A registry method this fake does not answer. */
const unused = async () => ({
  ok: false as const,
  error: { code: 'unavailable', status: 503, message: 'not in this fake' },
});

/** One repository in a fake registry whose `getRepository` answers as the gateway's does. */
function repository(visibility: 'public' | 'private' | 'internal' = 'private') {
  repositories += 1;
  const state = {
    name: `vault${repositories}`,
    engine: RunId.parse(`privcache${repositories}`),
    visibility,
    updatedAt: '2026-10-14T12:00:00.000Z',
    members: new Set([OWNER.id, MEMBER.id]),
  };
  const registry: RegistryClient = registryClient({
    createRepository: unused,
    listRepositories: unused,
    updateRepository: unused,
    deleteRepository: unused,
    repositoryActivity: unused,
    repositoryFiles: unused,
    getRepository: async (handle: string, name: string, viewer: string | null) => {
      const readable =
        state.visibility === 'public' || (viewer !== null && state.members.has(viewer));
      if (handle !== OWNER.handle || name !== state.name || !readable)
        return { ok: false, error: { code: 'not_found', status: 404, message: 'not found' } };
      return { ok: true, value: recordOf(state, viewer) };
    },
  });
  return { state, registry };
}

function recordOf(
  state: ReturnType<typeof repository>['state'],
  viewer: string | null,
): Record<string, unknown> {
  return {
    id: `repo-${state.name}`,
    owner: { id: OWNER.id, handle: OWNER.handle },
    name: state.name,
    description: '',
    visibility: state.visibility,
    origin: { kind: 'empty' },
    artifacts_repo: `art-${state.name}`,
    engine_id: state.engine,
    default_branch: 'stalk',
    created_at: '2026-10-07T00:00:00.000Z',
    updated_at: state.updatedAt,
    viewer_role: roleOf(state, viewer),
  };
}

function roleOf(state: ReturnType<typeof repository>['state'], viewer: string | null) {
  if (viewer === OWNER.id) return 'owner';
  return viewer !== null && state.members.has(viewer) ? 'read' : null;
}

/** The real KV namespace, watched: every key read. */
function watchedKv() {
  const reads: string[] = [];
  const binding: PrivateKv = {
    get: (key) => {
      reads.push(key);
      return env.OBJECTS.get(key, 'text');
    },
    put: (key, value, options) => env.OBJECTS.put(key, value, options),
  };
  return { reads, binding };
}

/**
 * A request for the repository's tree, as a page makes it: the access check first, then (only
 * with its grant) the private cache, then the gateway.
 */
function harness(repo: ReturnType<typeof repository>) {
  const pending: Promise<unknown>[] = [];
  const kv = watchedKv();
  const cache = createPrivateObjectCache({
    kv: () => kv.binding,
    waitUntil: (promise) => pending.push(promise),
  });
  let gatewayReads = 0;
  const tree: RepoTree = { ref: SHA, sha: SHA, files: [{ path: 'secret.ts', size: 9 }] };
  const load = () => {
    gatewayReads += 1;
    return Promise.resolve(tree);
  };
  const request = async (viewer: Viewer) => {
    const found = await lookupRepository(OWNER.handle, repo.state.name, viewer, repo.registry);
    if (found.kind === 'not-found') return { status: 404 } as const;
    const owned = PrivateEngine.of(found.grant, repo.state.engine);
    if (owned === null) return { status: 200, layer: 'public' } as const;
    const answer = await cache.read(owned, TREE_OBJECT, TREE_CODEC, load);
    await Promise.all(pending.splice(0));
    return { status: 200, layer: answer.layer, value: answer.value } as const;
  };
  return { request, kv, cache, gatewayReads: () => gatewayReads, tree };
}

/** The Cache API, watched: any call during a test fails it. */
const cacheApiCalls: string[] = [];
beforeEach(() => {
  cacheApiCalls.length = 0;
  vi.spyOn(caches, 'open').mockImplementation((name: string) => {
    cacheApiCalls.push(`open ${name}`);
    return Promise.reject(new Error('private data must not reach the Cache API'));
  });
  for (const method of ['match', 'put', 'delete'] as const)
    vi.spyOn(defaultCache(), method).mockImplementation(() => {
      cacheApiCalls.push(`default.${method}`);
      return Promise.reject(new Error('private data must not reach caches.default'));
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(cacheApiCalls).toEqual([]);
});

describe('the Cache API watch', () => {
  it('catches a call, so the other tests prove there was none', async () => {
    await expect(caches.open('anything')).rejects.toThrow(/Cache API/);
    await expect(defaultCache().match('https://gitstalk.test/x')).rejects.toThrow(/default/);
    expect(cacheApiCalls).toEqual(['open anything', 'default.match']);
    cacheApiCalls.length = 0;
  });
});

describe('who gets a private repository’s cached objects', () => {
  it('a member: the gateway on the first read, KV on the second', async () => {
    const repo = repository();
    const { request, gatewayReads, tree, kv } = harness(repo);
    expect(await request(MEMBER)).toEqual({ status: 200, layer: 'gateway', value: tree });
    expect(await request(MEMBER)).toEqual({ status: 200, layer: 'kv', value: tree });
    expect(gatewayReads()).toBe(1);
    const key = await privateKvKey(privateEngineOf(repo), TREE_OBJECT);
    expect(kv.reads).toEqual([key, key]);
  });

  it('an internal repository’s member, the same way', async () => {
    const repo = repository('internal');
    const { request, gatewayReads } = harness(repo);
    await request(OWNER);
    expect((await request(OWNER)).layer).toBe('kv');
    expect(gatewayReads()).toBe(1);
  });

  it.each([
    ['signed out', null],
    ['a non-member', STRANGER],
  ])('never %s: a 404 before any cache read', async (_who, viewer) => {
    const repo = repository();
    const { request, kv } = harness(repo);
    await request(OWNER);
    const readsBefore = kv.reads.length;
    expect(await request(viewer)).toEqual({ status: 404 });
    expect(kv.reads).toHaveLength(readsBefore);
  });

  it('never a member whose access was revoked', async () => {
    const repo = repository();
    const { request, kv } = harness(repo);
    await request(MEMBER);
    repo.state.members.delete(MEMBER.id);
    const readsBefore = kv.reads.length;
    expect(await request(MEMBER)).toEqual({ status: 404 });
    expect(kv.reads).toHaveLength(readsBefore);
  });

  it('never a reader of a repository made private who is not a member', async () => {
    const repo = repository('public');
    const { request, kv } = harness(repo);
    expect(await request(STRANGER)).toEqual({ status: 200, layer: 'public' });
    repo.state.visibility = 'private';
    repo.state.updatedAt = '2026-10-15T08:00:00.000Z';
    await request(OWNER);
    const readsBefore = kv.reads.length;
    expect(await request(STRANGER)).toEqual({ status: 404 });
    expect(await request(null)).toEqual({ status: 404 });
    expect(kv.reads).toHaveLength(readsBefore);
  });
});

describe('the cache epoch', () => {
  it.each([
    ['a settings save', (state: ReturnType<typeof repository>['state']) => state],
    [
      'a visibility flip and back',
      (state: ReturnType<typeof repository>['state']) => {
        state.visibility = 'internal';
        return state;
      },
    ],
  ])('moves on %s, so the old entry is unreachable', async (_change, change) => {
    const repo = repository();
    const { request, gatewayReads } = harness(repo);
    await request(OWNER);
    expect((await request(OWNER)).layer).toBe('kv');
    const oldKey = await privateKvKey(privateEngineOf(repo), TREE_OBJECT);
    change(repo.state).updatedAt = '2026-10-15T09:30:00.000Z';
    expect((await request(OWNER)).layer).toBe('gateway');
    expect(gatewayReads()).toBe(2);
    expect(await privateKvKey(privateEngineOf(repo), TREE_OBJECT)).not.toBe(oldKey);
  });

  it('stores entries for a week, under the private namespace', async () => {
    const repo = repository();
    const puts: { key: string; ttl: number | undefined }[] = [];
    const pending: Promise<unknown>[] = [];
    const cache = createPrivateObjectCache({
      kv: () => ({
        get: () => Promise.resolve(null),
        put: (key, _value, options) => {
          puts.push({ key, ttl: options?.expirationTtl });
          return Promise.resolve();
        },
      }),
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    const owned = privateEngineOf(repo);
    const empty: RepoTree = { ref: SHA, sha: SHA, files: [] };
    await cache.read(owned, TREE_OBJECT, TREE_CODEC, () => Promise.resolve(empty));
    await Promise.all(pending);
    expect(puts).toEqual([
      { key: await privateKvKey(owned, TREE_OBJECT), ttl: PRIVATE_KV_TTL_SECONDS },
    ]);
    expect(puts[0]?.key.startsWith(`v1:priv:${repo.state.engine}:`)).toBe(true);
    expect(PRIVATE_KV_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe('keys', () => {
  it('never collide across repositories: one repository’s entry is not another’s', async () => {
    const first = repository();
    const second = repository();
    const one = harness(first);
    const two = harness(second);
    await one.request(OWNER);
    expect((await two.request(OWNER)).layer).toBe('gateway');
    expect(await privateKvKey(privateEngineOf(first), TREE_OBJECT)).not.toBe(
      await privateKvKey(privateEngineOf(second), TREE_OBJECT),
    );
  });
});

/** workerd's `caches.default` (the DOM typings this package uses do not declare it). */
function defaultCache(): Cache {
  const cache: unknown = Reflect.get(caches, 'default');
  if (!(cache instanceof Cache)) throw new Error('no caches.default in this runtime');
  return cache;
}

/** The private engine the repository's owner would be granted now (for its keys). */
function privateEngineOf(repo: ReturnType<typeof repository>): PrivateEngine {
  const scope = { visibility: repo.state.visibility, updated_at: repo.state.updatedAt };
  const owned = PrivateEngine.of(ReadGrant.afterAccessCheck(scope), repo.state.engine);
  if (owned === null) throw new Error('a private repository has a private engine');
  return owned;
}
