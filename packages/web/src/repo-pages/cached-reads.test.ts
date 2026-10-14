import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RunId, Sha } from '@gitstalk/shared-race/ids';

import { sharedReadsFor } from './cached-reads';

/**
 * The Workers runtime exists only inside the built Worker; under plain vitest it is stood in
 * for: the GATEWAY binding answers any RPC method through `answer`, KV is a map and there is no
 * Cache API (the colo layer reads as absent). The edge cache's own layers are tested on
 * Miniflare (src/edge/object-cache.workers.test.ts).
 */
const platform = vi.hoisted(() => {
  const calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
  const answers: { file: () => unknown } = { file: () => ({ ok: true, value: {} }) };
  const answer = (method: string, args: readonly unknown[]): Promise<unknown> => {
    calls.push({ method, args });
    if (method === 'repoFile') return Promise.resolve(answers.file());
    if (method === 'repoTree')
      return Promise.resolve({
        ok: true,
        value: { commit: args[1], truncated: false, entries: [{ path: 'a.ts', type: 'blob' }] },
      });
    if (method === 'runEvents')
      return Promise.resolve({ ok: true, value: { events: [], next_after: args[1], done: false } });
    return Promise.resolve({ ok: false, error: { code: 'x', status: 501, message: 'unused' } });
  };
  const gateway = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (...args: unknown[]) =>
          answer(String(method), args),
    },
  );
  const stored = new Map<string, string>();
  const kv = {
    get: (key: string) => Promise.resolve(stored.get(key) ?? null),
    put: (key: string, value: string) => {
      stored.set(key, value);
      return Promise.resolve();
    },
  };
  const pending: Promise<unknown>[] = [];
  return { calls, answers, gateway, kv, stored, pending };
});

vi.mock('cloudflare:workers', () => ({
  env: { GATEWAY: platform.gateway, OBJECTS: platform.kv, WEB_URL: 'https://gitstalk.test' },
  waitUntil: (promise: Promise<unknown>) => platform.pending.push(promise),
}));

const SHA = Sha.parse('c'.repeat(40));
let engines = 0;
/** A fresh engine per test: the isolate layer is module state, shared across tests. */
const freshEngine = () => RunId.parse(`enginepublic${(engines += 1)}`);

beforeEach(() => {
  platform.calls.length = 0;
  platform.stored.clear();
  platform.answers.file = () => ({
    ok: true,
    value: { path: 'a.ts', size: 1, binary: false, content: 'a', truncated: false, commit: SHA },
  });
});

describe('which repositories share reads', () => {
  it('shares nothing for a private or an internal repository', () => {
    expect(sharedReadsFor({ visibility: 'private' }, freshEngine())).toBeNull();
    expect(sharedReadsFor({ visibility: 'internal' }, freshEngine())).toBeNull();
  });

  it('shares a public repository’s reads', () => {
    expect(sharedReadsFor({ visibility: 'public' }, freshEngine())).not.toBeNull();
  });
});

describe('reads at a commit', () => {
  it('reads a tree from the gateway once, then from this isolate on a later request', async () => {
    const engine = freshEngine();
    // Two requests: each builds its shared reads from the record, as `repositoryTab` does.
    const first = await sharedReadsFor({ visibility: 'public' }, engine)?.tree(SHA);
    const second = await sharedReadsFor({ visibility: 'public' }, engine)?.tree(SHA);
    expect(first).toEqual({ ref: SHA, sha: SHA, files: [{ path: 'a.ts', size: 0 }] });
    expect(second).toEqual(first);
    expect(platform.calls).toEqual([{ method: 'repoTree', args: [engine, SHA, '', true] }]);
    await Promise.all(platform.pending);
    expect([...platform.stored.keys()]).toEqual([`v1:${engine}:tree:${SHA}`]);
  });

  it('answers a file the commit does not have as null, and does not keep it', async () => {
    platform.answers.file = () => ({
      ok: false,
      error: { code: 'not_found', status: 404, message: 'missing' },
    });
    const shared = sharedReadsFor({ visibility: 'public' }, freshEngine());
    expect(await shared?.file(SHA, 'nope.ts')).toBeNull();
    expect(await shared?.file(SHA, 'nope.ts')).toBeNull();
    expect(platform.calls.map((call) => call.method)).toEqual(['repoFile', 'repoFile']);
    await Promise.all(platform.pending);
    expect(platform.stored.size).toBe(0);
  });

  it('throws on a failed read, so no layer keeps it', async () => {
    platform.answers.file = () => ({
      ok: false,
      error: { code: 'unavailable', status: 503, message: 'busy' },
    });
    const shared = sharedReadsFor({ visibility: 'public' }, freshEngine());
    await expect(shared?.file(SHA, 'a.ts')).rejects.toThrow(/busy/);
    await Promise.all(platform.pending);
    expect(platform.stored.size).toBe(0);
  });

  it('keeps a file a public repository has, by commit and path', async () => {
    const shared = sharedReadsFor({ visibility: 'public' }, freshEngine());
    expect(await shared?.file(SHA, 'a.ts')).toMatchObject({ path: 'a.ts', content: 'a' });
    expect(await shared?.file(SHA, 'a.ts')).toMatchObject({ path: 'a.ts', content: 'a' });
    expect(platform.calls).toHaveLength(1);
  });
});

function setupEvent(seq: number) {
  return { seq, t: seq, ts: '2026-10-11T00:00:00Z', type: 'race.setup' as const, policy: 'v2' };
}

describe('a public repository’s event log', () => {
  it('is held across requests: a later request reads only from its newest event', async () => {
    const engine = RunId.parse('enginelog');
    const afters: number[] = [];
    const readTail = (after: number) => {
      afters.push(after);
      const events = [setupEvent(1), setupEvent(2)].filter((candidate) => candidate.seq > after);
      return Promise.resolve({ events, last: 2 });
    };
    // Two requests: each builds its shared reads from the record, as `repositoryTab` does.
    await sharedReadsFor({ visibility: 'public' }, engine)?.events(readTail);
    await sharedReadsFor({ visibility: 'public' }, engine)?.events(readTail);
    expect(afters).toEqual([0, 1]);
  });
});
