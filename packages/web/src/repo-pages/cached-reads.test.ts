import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RunId, Sha } from '@gitstalk/shared-race/ids';

import { commitTags, fileAtCommit, sharedReadsFor, treeAtCommit } from './cached-reads';

/**
 * The Workers runtime and vinext's cache exist only inside the built Worker; under plain vitest
 * they are stood in for: the GATEWAY binding answers any RPC method through `answer`, and the
 * cache calls are recorded (a `"use cache"` function then runs on every call).
 */
const platform = vi.hoisted(() => {
  const calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
  const cache: { life: unknown[]; tags: string[][] } = { life: [], tags: [] };
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
  return { calls, cache, answers, gateway };
});

vi.mock('cloudflare:workers', () => ({ env: { GATEWAY: platform.gateway } }));
vi.mock('next/cache', () => ({
  cacheLife: (profile: unknown) => platform.cache.life.push(profile),
  cacheTag: (...tags: string[]) => platform.cache.tags.push(tags),
}));

const ENGINE = RunId.parse('enginepublic');
const SHA = Sha.parse('c'.repeat(40));

beforeEach(() => {
  platform.calls.length = 0;
  platform.cache.life = [];
  platform.cache.tags = [];
  platform.answers.file = () => ({
    ok: true,
    value: { path: 'a.ts', size: 1, binary: false, content: 'a', truncated: false, commit: SHA },
  });
});

describe('which repositories share reads', () => {
  it('shares nothing for a private or an internal repository', () => {
    expect(sharedReadsFor({ visibility: 'private' }, ENGINE)).toBeNull();
    expect(sharedReadsFor({ visibility: 'internal' }, ENGINE)).toBeNull();
  });

  it('shares a public repository’s reads', () => {
    expect(sharedReadsFor({ visibility: 'public' }, ENGINE)).not.toBeNull();
  });
});

describe('reads at a commit', () => {
  it('keys a tree by the engine and the commit, kept for the longest life', async () => {
    const tree = await treeAtCommit(ENGINE, SHA);
    expect(tree).toEqual({ ref: SHA, sha: SHA, files: [{ path: 'a.ts', size: 0 }] });
    expect(platform.calls).toEqual([{ method: 'repoTree', args: [ENGINE, SHA, '', true] }]);
    expect(platform.cache.life).toEqual(['max']);
    expect(platform.cache.tags).toEqual([[`engine:${ENGINE}`, `commit:${ENGINE}:${SHA}`]]);
    expect(commitTags(ENGINE, SHA)).toEqual([`engine:${ENGINE}`, `commit:${ENGINE}:${SHA}`]);
  });

  it('answers a file the commit does not have as null, which may be kept', async () => {
    platform.answers.file = () => ({
      ok: false,
      error: { code: 'not_found', status: 404, message: 'missing' },
    });
    expect(await fileAtCommit(ENGINE, SHA, 'nope.ts')).toBeNull();
    expect(platform.calls).toEqual([{ method: 'repoFile', args: [ENGINE, SHA, 'nope.ts'] }]);
  });

  it('throws on a failed read, so the cache never keeps it', async () => {
    platform.answers.file = () => ({
      ok: false,
      error: { code: 'unavailable', status: 503, message: 'busy' },
    });
    await expect(fileAtCommit(ENGINE, SHA, 'a.ts')).rejects.toThrow(/busy/);
  });

  it('goes through the shared reads of a public repository', async () => {
    const shared = sharedReadsFor({ visibility: 'public' }, ENGINE);
    expect(await shared?.file(SHA, 'a.ts')).toMatchObject({ path: 'a.ts', content: 'a' });
    expect(platform.cache.tags).toEqual([[`engine:${ENGINE}`, `commit:${ENGINE}:${SHA}`]]);
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
