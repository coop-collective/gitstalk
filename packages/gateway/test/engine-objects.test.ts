import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { CacheKindsView, RpcResult } from '@gitstalk/shared-race/rpc';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import { insertUser } from '@gitstalk/shared-identity/users';

import { pushRefsBody } from './helpers';

/**
 * The repository's derived data reads git objects through its engine (`RunDO.readObjects`,
 * docs/claude-opus/35-caching.md §12), on Miniflare with the fake Artifacts: the engine's
 * read index serves what the engine already read, a miss is fetched once and kept, bad
 * requests are refused, and derivation still answers when the engine cannot.
 */
const gateway = exports.default;

const C0 = 'd0'.repeat(20);
const C1 = 'd1'.repeat(20);
const TEXT = 'export const rate = 0.2;\n';
const HISTORY = {
  [C0]: { message: 'start', files: { 'src/rate.ts': TEXT } },
  [C1]: {
    parents: [C0],
    message: 'Raise the rate\n\nTask: rate\nPolicy: beanstalk\n',
    files: { 'src/rate.ts': TEXT.replace('0.2', '0.25') },
  },
};

describe('derived data reading objects through the engine', () => {
  it('hits the engine’s index for objects the engine has read', async () => {
    const record = await repository('objects-hit');
    await gateway.repoFile(record.engine_id, C1, 'src/rate.ts');
    await gateway.repoFile(record.engine_id, C0, 'src/rate.ts');
    const before = await derivedCounts(record);

    value(await gateway.whyLines(record.engine_id, { path: 'src/rate.ts' }));
    const after = await derivedCounts(record);

    // Derivation read both commits, their trees and both sides of the file, all held.
    expect(after.objects.hits - before.objects.hits).toBeGreaterThanOrEqual(6);
    expect(after.objects.misses).toBe(before.objects.misses);
    expect(after.commit.hits).toBeGreaterThanOrEqual(2);
    expect(after.blob.hits).toBeGreaterThanOrEqual(2);
  });

  it('fetches a missing object once, keeps it and serves it from the index after', async () => {
    const record = await repository('objects-miss');
    const engine = env.RUNS.getByName(record.engine_id);
    const request = { repo: record.artifacts_repo, reads: [{ kind: 'commit', id: C1 }] };

    const first = await engine.readObjects(request);
    const second = await engine.readObjects(request);
    const counts = await derivedCounts(record);

    expect(first).toMatchObject({ ok: true, value: [{ kind: 'commit', commit: { hash: C1 } }] });
    expect(second).toEqual(first);
    expect(counts.commit).toEqual({ hits: 1, misses: 1, hit_rate: 0.5 });
  });

  it('answers a missing object as null', async () => {
    const record = await repository('objects-absent');
    const absent = 'ee'.repeat(20);

    const answer = await env.RUNS.getByName(record.engine_id).readObjects({
      repo: record.artifacts_repo,
      reads: [{ kind: 'tree', id: absent }],
    });

    expect(answer).toEqual({ ok: true, value: [{ kind: 'tree', id: absent, entries: null }] });
  });

  it('refuses ids that are not object ids, other kinds and another repository', async () => {
    const record = await repository('objects-refused');
    const engine = env.RUNS.getByName(record.engine_id);
    const repo = record.artifacts_repo;

    const badId = await engine.readObjects({ repo, reads: [{ kind: 'blob', id: '../HEAD' }] });
    const upper = await engine.readObjects({
      repo,
      reads: [{ kind: 'blob', id: C1.toUpperCase() }],
    });
    const ref = await engine.readObjects({ repo, reads: [{ kind: 'ref', id: 'sprout' }] });
    const none = await engine.readObjects({ repo, reads: [] });
    const other = await engine.readObjects({
      repo: 'repo-someone-else',
      reads: [{ kind: 'commit', id: C1 }],
    });

    for (const refused of [badId, upper, ref, none])
      expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_request', status: 400 } });
    expect(other).toMatchObject({ ok: false, error: { code: 'not_found', status: 404 } });
  });

  it('derives from Artifacts directly when the engine cannot answer', async () => {
    const record = await repository('objects-fallback');

    // An engine id with no engine behind it: every object read is refused.
    const why = await env.DERIVED.getByName('objects-fallback-derived').whyLines({
      repo: record.artifacts_repo,
      engine: 'no-such-engine',
      path: 'src/rate.ts',
    });

    expect(value(why).ranges).toEqual([{ start: 1, end: 1, commit: C1 }]);
  });
});

/** A registered repository whose sprout holds `HISTORY`. */
async function repository(name: string): Promise<RepositoryRecord> {
  const id = `u_${name.replace(/-/g, '_')}`;
  await insertUser(env, { id, handle: name, email: null }, Date.now()).run();
  const record = value(
    await gateway.createRepository(
      { id, handle: name },
      { name, visibility: 'private', start: { kind: 'empty' } },
    ),
  );
  const repo = await env.REPOS.get(record.artifacts_repo);
  const { plaintext } = await repo.createToken('write', 600);
  const info = await repo.info();
  const response = await fetch(`${info.remote}/git-receive-pack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plaintext}` },
    body: `${pushRefsBody([{ ref: 'refs/heads/sprout', newSha: C1 }])}${JSON.stringify({ commits: HISTORY })}`,
  });
  expect(response.ok).toBe(true);
  return record;
}

/** The engine's counts of derivation's reads (`cache.derived` in its view). */
async function derivedCounts(record: RepositoryRecord): Promise<CacheKindsView> {
  const view = value(await gateway.runView(record.engine_id));
  if (view.cache?.derived === undefined) throw new Error('no derived counts');
  return view.cache.derived;
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
