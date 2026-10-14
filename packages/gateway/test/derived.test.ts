import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { RepoEvent } from '@gitstalk/shared-race/repo-events';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { createLogger } from '../src/log';
import type { DerivedFeed } from '../src/repo-events/consumer';
import { consumeRepoEvents } from '../src/repo-events/consumer';
import { d1Registry } from '../src/repos/registry';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import { insertUser } from '@gitstalk/shared-identity/users';

import { pushRefsBody } from './helpers';

/**
 * Derived history end to end on Miniflare: a registered repository's sprout in the fake
 * Artifacts, the gateway's `whyLines` and `pathHistory` RPC, and the real `RepoDerivedDO`
 * deriving lazily on read and eagerly from the repo-events feed.
 */
const gateway = exports.default;

const C0 = 'c0'.repeat(20);
const C1 = 'c1'.repeat(20);
const C2 = 'c2'.repeat(20);
const C3 = 'c3'.repeat(20);

const BASE =
  'import { rate } from "./rate";\nconst TAX = 0.2;\nexport function tax(x) {\n  return x * TAX;\n}\n';
const TAXED = BASE.replace('0.2', '0.25');
const ROUNDED = `${TAXED}export const round = (x) => Math.round(x);\n`;
const REVERTED = `${BASE}export const round = (x) => Math.round(x);\n`;

type Commit = { parents?: string[]; message: string; files: Record<string, string> };

/** Pushes commits straight to the repository's Artifacts remote and moves the sprout. */
async function pushSprout(artifactsRepo: string, head: string, commits: Record<string, Commit>) {
  const repo = await env.REPOS.get(artifactsRepo);
  const { plaintext } = await repo.createToken('write', 600);
  const info = await repo.info();
  const response = await fetch(`${info.remote}/git-receive-pack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plaintext}` },
    body: `${pushRefsBody([{ ref: 'refs/heads/sprout', newSha: head }])}${JSON.stringify({ commits })}`,
  });
  expect(response.ok).toBe(true);
}

/** A registered repository (the per-repository engine), owned by a new person. */
async function registered(name: string): Promise<RepositoryRecord> {
  const id = `u_${name.replace(/-/g, '_')}`;
  await insertUser(env, { id, handle: name, email: null }, Date.now()).run();
  const created = await gateway.createRepository(
    { id, handle: name },
    { name, visibility: 'private', start: { kind: 'empty' } },
  );
  return value(created);
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function at(seq: number): { seq: number; at: string } {
  return { seq, at: new Date(Date.UTC(2026, 9, 14, 12, 0, seq)).toISOString() };
}

const HISTORY: Record<string, Commit> = {
  [C0]: { message: 'start', files: { 'src/tax.ts': BASE, 'README.md': '# shop\n' } },
  [C1]: {
    parents: [C0],
    message: 'Raise the tax rate\n\nTask: tax-rate\nPolicy: beanstalk\n',
    files: { 'src/tax.ts': TAXED, 'README.md': '# shop\n' },
  },
  [C2]: {
    parents: [C1],
    message: 'Add rounding\n\nTask: rounding\nPolicy: beanstalk\n',
    files: { 'src/tax.ts': ROUNDED, 'README.md': '# shop\n' },
  },
};

describe('derived history: why_lines and path_history', () => {
  it('answers which bean last changed each line, and a revert gives the lines back', async () => {
    const record = await registered('derive-blame');
    const opened = { engineId: record.engine_id };
    const repo = record.artifacts_repo;
    await pushSprout(repo, C2, HISTORY);

    const why = value(await gateway.whyLines(opened.engineId, { path: 'src/tax.ts' }));
    expect(why.commit).toBe(C2);
    expect(why.lines).toBe(6);
    expect(why.ranges).toEqual([
      { start: 1, end: 1, commit: C0 },
      { start: 2, end: 2, commit: C1 },
      { start: 3, end: 5, commit: C0 },
      { start: 6, end: 6, commit: C2 },
    ]);
    expect(why.commits[C1]).toMatchObject({
      kind: 'landing',
      bean: 'tax-rate',
      title: 'Raise the tax rate',
    });
    expect(why.commits[C0]).toMatchObject({ kind: 'base', bean: null });
    expect(why.beans['tax-rate']).toMatchObject({ title: 'Raise the tax rate', reverted: false });

    // Line 2 only.
    const line = value(
      await gateway.whyLines(opened.engineId, { path: 'src/tax.ts', start: 2, end: 2 }),
    );
    expect(line.ranges).toEqual([{ start: 2, end: 2, commit: C1 }]);

    // The engine reverts the tax-rate landing.
    await pushSprout(repo, C3, {
      ...HISTORY,
      [C3]: {
        parents: [C2],
        message: `Revert Raise the tax rate\n\nReverts: ${C1}\nTicket: k1\n`,
        files: { 'src/tax.ts': REVERTED, 'README.md': '# shop\n' },
      },
    });
    const after = value(await gateway.whyLines(opened.engineId, { path: 'src/tax.ts' }));
    expect(after.ranges).toEqual([
      { start: 1, end: 5, commit: C0 },
      { start: 6, end: 6, commit: C2 },
    ]);
    // The state at an older commit is still answered.
    const before = value(
      await gateway.whyLines(opened.engineId, { path: 'src/tax.ts', ref: C1, start: 2, end: 2 }),
    );
    expect(before.ranges).toEqual([{ start: 2, end: 2, commit: C1 }]);

    const history = value(await gateway.pathHistory(opened.engineId, { path: 'src/tax.ts' }));
    expect(
      history.entries.map((entry) => [entry.sha, entry.kind, entry.bean, entry.change]),
    ).toEqual([
      [C3, 'revert', 'tax-rate', 'modified'],
      [C2, 'landing', 'rounding', 'modified'],
      [C1, 'landing', 'tax-rate', 'modified'],
    ]);
    expect(history.beans['tax-rate']?.reverted).toBe(true);

    // A file never changed since derivation began belongs to the base; a missing one is not found.
    const readme = value(await gateway.whyLines(opened.engineId, { path: 'README.md' }));
    expect(readme.ranges).toEqual([{ start: 1, end: 1, commit: C0 }]);
    const missing = await gateway.whyLines(opened.engineId, { path: 'nope.ts' });
    expect(missing.ok ? null : missing.error.code).toBe('not_found');
  });

  it('records titles, decision cards and the stalk from the events it is fed', async () => {
    const record = await registered('derive-feed');
    const opened = { engineId: record.engine_id };
    const repo = record.artifacts_repo;
    await pushSprout(repo, C2, HISTORY);
    const events: RepoEvent[] = [
      {
        ...at(1),
        kind: 'bean.opened',
        bean: 'tax-rate',
        title: 'Tax at 25 percent',
        actor: 'coop',
      },
      {
        ...at(2),
        kind: 'bean.landed',
        bean: 'tax-rate',
        sha: C1,
        trunk_idx: 1,
        files: 1,
        actor: 'coop',
      },
      {
        ...at(3),
        kind: 'decision.asked',
        card: 'card-7',
        bean: 'rounding',
        against: ['tax-rate'],
        reason: null,
      },
      { ...at(4), kind: 'stalk.promoted', sha: C1, trunk_idx: 1, beans: ['tax-rate'] },
      {
        ...at(5),
        kind: 'bean.landed',
        bean: 'rounding',
        sha: C2,
        trunk_idx: 2,
        files: 1,
        actor: null,
      },
    ];
    const fed: DerivedFeed[] = [];
    const batch = createMessageBatch('gitstalk-repo-events', [
      {
        id: 'm1',
        timestamp: new Date(),
        attempts: 1,
        body: { v: 1, engine: opened.engineId, events },
      },
    ]);
    await consumeRepoEvents(batch, {
      db: env.FORGE,
      registry: d1Registry(env.FORGE),
      log: createLogger('error'),
      derived: (feed) => fed.push(feed),
    });
    await getQueueResult(batch, createExecutionContext());
    expect(fed).toEqual([{ engine: opened.engineId, repo, events }]);
    await env.DERIVED.getByName(opened.engineId).observe({ repo, events });

    const why = value(await gateway.whyLines(opened.engineId, { path: 'src/tax.ts' }));
    expect(why.beans['tax-rate']).toEqual({
      bean: 'tax-rate',
      title: 'Tax at 25 percent',
      actor: 'coop',
      decisions: ['card-7'],
      reverted: false,
    });
    expect(why.commits[C1]?.on_stalk).toBe(true);
    expect(why.commits[C2]?.on_stalk).toBe(false);
  });

  it('refuses refs it does not derive and engines that drive no repository', async () => {
    const record = await registered('derive-refs');
    const opened = { engineId: record.engine_id };
    const bean = await gateway.whyLines(opened.engineId, { path: 'a.ts', ref: 'bean/x' });
    expect(bean.ok ? null : bean.error.code).toBe('invalid_request');
    const unknown = await gateway.pathHistory('nosuchengine1', { path: 'a.ts' });
    expect(unknown.ok ? null : unknown.error.code).toBe('not_found');
  });
});
