import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { feedItems } from '../src/repos/engine-feed';
import { ADMIN, call, json, pkt, sha } from './helpers';

/** The web app's service binding: the gateway's default entrypoint, over RPC. */
const gateway = exports.default;
const ZERO = '0'.repeat(40);

async function openRepo(repo: string): Promise<{ engineId: string; path: string; token: string }> {
  const opened = await json<{ engineId: string; git_path: string }>(
    await call('POST', '/v1/repos', {
      token: ADMIN,
      body: {
        repoName: repo,
        artifactsRepo: `repo-${repo}`,
        owner: { id: 'u1', handle: 'acme' },
        // The fake runner decides this test's reds (no checks file is involved).
        settings: { engine: { checks_source: 'suite' } },
        create_artifacts_repo: true,
      },
    }),
  );
  const minted = await call('POST', `/v1/repos/${opened.engineId}/git-token`, {
    token: ADMIN,
    body: { user: { id: 'u1', handle: 'coop' } },
  });
  const { token } = await json<{ token: string }>(minted);
  return { engineId: opened.engineId, path: opened.git_path, token };
}

/** `git push -o wait` of one commit to `bean/<name>`; resolves once the verdict is printed. */
async function pushBean(repo: { path: string; token: string }, name: string, message: string) {
  const caps = 'report-status side-band-64k push-options agent=git/2.47.0';
  const head = await sha(`${name}-1`);
  const commits = { [head]: { message, parents: [], files: {} } };
  const body = `${pkt(`${ZERO} ${head} refs/heads/bean/${name}\0${caps}\n`)}0000${pkt('wait\n')}0000PACK${JSON.stringify({ commits })}`;
  const response = await call('POST', `${repo.path}/git-receive-pack`, {
    body,
    headers: {
      'user-agent': 'git/2.47.0',
      authorization: `Basic ${btoa(`x:${repo.token}`)}`,
      'content-type': 'application/x-git-receive-pack-request',
    },
  });
  await response.arrayBuffer();
}

describe('engineFeeds', () => {
  it('lists landings, validations and reds newest first, with who pushed each bean', async () => {
    const repo = await openRepo('feed');
    await pushBean(repo, 'add-total', 'Add a total helper');
    await pushBean(repo, 'red-total', 'Total with tax');
    const answer = await gateway.engineFeeds([repo.engineId, 'not-an-engine'], 20);
    if (!answer.ok) throw new Error(answer.error.message);
    const [feed, missing] = answer.value;
    expect(missing).toEqual({ engine_id: 'not-an-engine', tasks: {}, items: [] });
    const lines = feed?.items.map((item) => `${item.kind} ${item.bean ?? ''}`) ?? [];
    expect(lines).toContain('landed add-total');
    expect(lines).toContain('red red-total');
    expect(lines.indexOf('red red-total')).toBeLessThan(lines.indexOf('landed add-total'));
    const landed = feed?.items.find((item) => item.kind === 'landed');
    expect(landed).toMatchObject({ actor: 'coop', title: 'Add a total helper' });
    expect(Date.parse(landed?.at ?? '')).not.toBeNaN();
    expect(feed?.tasks.landed ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('refuses more engines than one call may name', async () => {
    const answer = await gateway.engineFeeds(
      Array.from({ length: 51 }, (_, i) => `r${i}`),
      5,
    );
    expect(answer.ok).toBe(false);
  });
});

describe('feedItems', () => {
  const ts = '2026-10-07T13:39:47.232+00:00';
  const pushed = new Map([['a', { title: 'Add a', actor: 'dana' }]]);

  it('turns a validation of several beans into one line per bean', () => {
    const items = feedItems(
      [{ seq: 4, t: 1, ts, type: 'green.promote', sha: 'f'.repeat(40), tasks: ['a', 'b'] }],
      pushed,
    );
    expect(items).toEqual([
      {
        seq: 4,
        at: '2026-10-07T13:39:47.232Z',
        kind: 'validated',
        bean: 'a',
        detail: 'fffffff',
        title: 'Add a',
        actor: 'dana',
      },
      {
        seq: 4,
        at: '2026-10-07T13:39:47.232Z',
        kind: 'validated',
        bean: 'b',
        detail: 'fffffff',
        title: null,
        actor: null,
      },
    ]);
  });

  it('skips green checks, inherited reds and events it does not follow', () => {
    const items = feedItems(
      [
        { seq: 1, ts, type: 'preland.check', task: 'a', green: true },
        { seq: 2, ts, type: 'preland.check', task: 'a', green: false, inherited: true },
        { seq: 3, ts, type: 'ci.start', ci: 'c1' },
        'not an event',
      ],
      pushed,
    );
    expect(items).toEqual([]);
  });

  it('names a decision by its card and both sides', () => {
    const [item] = feedItems(
      [{ seq: 9, ts, type: 'decision.request', card: 'D1', task: 'a', against: ['b'] }],
      pushed,
    );
    expect(item).toMatchObject({ kind: 'decision', bean: 'a', detail: 'D1: a or b' });
  });
});
