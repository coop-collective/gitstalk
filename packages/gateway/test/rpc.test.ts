import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { CreatedRun } from './helpers';
import {
  ADMIN,
  arenaTask,
  call,
  createRun,
  json,
  pushBase,
  pushCommits,
  slotToken,
} from './helpers';

const BASE = '1'.repeat(40);
const NEXT = '2'.repeat(40);

/** The web app's service binding: the gateway's default entrypoint, over RPC. */
const gateway = exports.default;

/** A task whose acceptance test imports the money module. */
function moneyTask(id: string): Record<string, unknown> {
  return {
    ...arenaTask(id),
    acceptance_tests: { [`tests/${id}.test.ts`]: `import { money } from '../src/lib/money';\n` },
  };
}

/** A run whose repo holds two commits: the stalk at BASE, the sprout one commit ahead. */
async function runWithRepo(config: Record<string, unknown> = {}): Promise<CreatedRun> {
  const run = await createRun({ tasks: [moneyTask('t001'), arenaTask('t002')], ...config });
  const base = {
    'README.md': '# shop\n',
    'src/lib/money.ts': 'export const money = (cents: number) => `$${cents / 100}`;\n',
    'src/cart/index.ts': "import { money } from '../lib/money';\nexport const total = 0;\n",
  };
  const next = {
    ...base,
    'src/lib/money.ts': 'export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;\n',
  };
  const pushed = await pushCommits(
    run,
    { 'refs/heads/stalk': BASE, 'refs/heads/sprout': NEXT },
    {
      [BASE]: { message: 'base', files: base },
      [NEXT]: { parents: [BASE], message: 'money with cents', files: next },
    },
  );
  expect(pushed.status).toBe(200);
  return run;
}

describe('RPC for the web app: runs', () => {
  it('lists runs, newest first, with their phase and task counts', async () => {
    const first = await createRun();
    const second = await createRun({ policy: 'beanstalk-v2' });

    const runs = await gateway.listRuns(200);

    const listed = runs.filter((item) => item.run === first.run || item.run === second.run);
    expect(listed.map((item) => item.run)).toEqual([second.run, first.run]);
    expect(listed[0]).toMatchObject({
      policy: 'beanstalk-v2',
      phase: 'created',
      agents: 2,
      tasks: { total: 2, pending: 2, green: 0 },
    });
  });

  it('serves the typed run view and the event log, and refuses bad run ids', async () => {
    const run = await createRun({ policy: 'beanstalk-v2' });
    await pushBase(run, BASE);
    await call('POST', `/v1/runs/${run.run}/start`, { token: ADMIN });

    const view = await gateway.runView(run.run);
    const events = await gateway.runEvents(run.run, 0, 10);
    const bad = await gateway.runView('NOT A RUN');
    const missing = await gateway.runView('zzzzzzzzzz');

    expect(view).toMatchObject({
      ok: true,
      value: {
        run: run.run,
        repo: run.repo.name,
        phase: 'running',
        policy_state: { kind: 'beanstalk-v2' },
      },
    });
    if (!events.ok) throw new Error('no events');
    expect(JSON.parse(events.value.events[0] ?? '{}')).toMatchObject({
      seq: 1,
      type: 'race.setup',
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_request', status: 400 } });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found', status: 404 } });
  });

  it('answers cards by RPC with an actor, and mints view tokens for the live socket', async () => {
    const run = await createRun({ policy: 'beanstalk-v2' });
    await pushBase(run, BASE);
    await call('POST', `/v1/runs/${run.run}/start`, { token: ADMIN });

    const decided = await gateway.decide(run.run, 'D001', 't001', 'human:coop@example.test');
    const anonymous = await gateway.decide(run.run, 'D001', 't001', ' human: ');
    const token = await gateway.viewToken(run.run);

    expect(decided).toMatchObject({ ok: false, error: { code: 'unknown_card', status: 404 } });
    expect(anonymous).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    if (!token.ok) throw new Error('no view token');
    expect(token.value.live_path).toBe(`/v1/runs/${run.run}/live`);
    const viewed = await call('GET', `/v1/runs/${run.run}?key=${token.value.token}`);
    expect(viewed.status).toBe(200);
  });

  it('verifies view tokens for the MCP server, and refuses forged and slot tokens', async () => {
    const run = await createRun();
    const token = await gateway.viewToken(run.run);
    if (!token.ok) throw new Error('no view token');

    const verified = await gateway.verifyViewToken(token.value.token);
    const forged = await gateway.verifyViewToken(`${token.value.token.slice(0, -2)}xx`);
    const slot = await gateway.verifyViewToken(slotToken(run, 'a1'));

    expect(verified).toEqual({
      ok: true,
      value: { run: run.run, sub: 'web', expires_at: token.value.expires_at },
    });
    expect(forged).toMatchObject({ ok: false, error: { code: 'unauthorized', status: 401 } });
    expect(slot).toMatchObject({ ok: false, error: { code: 'forbidden', status: 403 } });
  });
});

describe('RPC for the web app: the repo explorer', () => {
  it('lists a directory, reads a file and searches at a ref', async () => {
    const run = await runWithRepo();

    const root = await gateway.repoTree(run.run, 'sprout');
    const lib = await gateway.repoTree(run.run, 'sprout', 'src/lib');
    const whole = await gateway.repoTree(run.run, 'sprout', '', true);
    const file = await gateway.repoFile(run.run, 'stalk', 'src/lib/money.ts');
    const grep = await gateway.repoGrep(run.run, 'sprout', 'toFixed|money\\(', ['src'], true);

    expect(root).toMatchObject({ ok: true, value: { commit: NEXT, truncated: false } });
    if (!root.ok || !lib.ok || !whole.ok || !file.ok || !grep.ok)
      throw new Error('explorer failed');
    expect(whole.value.entries.map((entry) => entry.path)).toEqual([
      'README.md',
      'src',
      'src/cart',
      'src/cart/index.ts',
      'src/lib',
      'src/lib/money.ts',
    ]);
    expect(whole.value.truncated).toBe(false);
    expect(root.value.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ['src', 'tree'],
      ['README.md', 'blob'],
    ]);
    expect(lib.value.entries.map((entry) => entry.path)).toEqual(['src/lib/money.ts']);
    expect(file.value).toMatchObject({ commit: BASE, binary: false, truncated: false });
    expect(file.value.content).toContain('cents / 100');
    expect(grep.value.matches).toEqual([
      expect.objectContaining({ path: 'src/lib/money.ts', line: 1 }),
    ]);
    expect(grep.value.files_scanned).toBe(2);
  });

  it('diffs two refs and finds the commits that touched a path', async () => {
    const run = await runWithRepo();

    const diff = await gateway.repoDiff(run.run, 'stalk', 'sprout');
    const log = await gateway.repoLog(run.run, 'sprout', ['src/lib/money.ts'], 10);
    const untouched = await gateway.repoLog(run.run, 'sprout', ['src/cart'], 10);

    if (!diff.ok || !log.ok || !untouched.ok) throw new Error('explorer failed');
    expect(diff.value.files).toEqual([
      { path: 'src/lib/money.ts', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect(diff.value.patch).toContain('diff --git a/src/lib/money.ts b/src/lib/money.ts');
    expect(log.value.commits.map((commit) => commit.sha)).toEqual([NEXT, BASE]);
    expect(untouched.value.commits.map((commit) => commit.sha)).toEqual([BASE]);
  });

  it('counts the read index’s hits and misses in the run view: a repeated read is all hits', async () => {
    const run = await runWithRepo();
    const cacheNow = async () => {
      const view = await gateway.runView(run.run);
      if (!view.ok || view.value.cache === undefined) throw new Error('no cache counts');
      return view.value.cache;
    };

    const before = await cacheNow();
    await gateway.repoFile(run.run, NEXT, 'src/lib/money.ts');
    const first = await cacheNow();
    await gateway.repoFile(run.run, NEXT, 'src/lib/money.ts');
    const second = await cacheNow();

    expect(first.objects.misses).toBeGreaterThan(before.objects.misses);
    expect(second.objects.misses).toBe(first.objects.misses);
    expect(second.objects.hits - first.objects.hits).toBeGreaterThanOrEqual(4);
    expect(second.objects.hit_rate).toBeGreaterThan(first.objects.hit_rate ?? 0);
  });

  it('refuses refs and paths outside the run repo', async () => {
    const run = await runWithRepo();

    const badRef = await gateway.repoTree(run.run, 'refs/heads/main');
    const badPath = await gateway.repoFile(run.run, 'sprout', '../etc/passwd');
    const missing = await gateway.repoFile(run.run, 'sprout', 'src/nowhere.ts');

    expect(badRef).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(badPath).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found', status: 404 } });
  });

  it('finds the acceptance tests whose import closure covers a path', async () => {
    const run = await runWithRepo({ policy: 'beanstalk-v2' });

    const covering = await gateway.testsFor(run.run, ['src/lib/money.ts']);
    const none = await gateway.testsFor(run.run, ['src/cart']);

    expect(covering).toMatchObject({
      ok: true,
      value: [
        {
          test: 'tests/t001.test.ts',
          task: 't001',
          covers: ['src/lib/money.ts'],
          closure_size: 2,
          amended: false,
        },
      ],
    });
    expect(none).toMatchObject({ ok: true, value: [] });
  });
});

describe('RPC for the web app: beans and decisions', () => {
  it('lists the beans that touched a path and tells one bean’s story', async () => {
    const run = await createRun({ policy: 'beanstalk-v2', agents: 1 });
    await pushBase(run, BASE);
    await call('POST', `/v1/runs/${run.run}/start`, { token: ADMIN });
    const token = slotToken(run, 'a0');
    const next = await json<{
      invocation: { inv: string; workspace: { bean_url: string; branch: string } };
    }>(await call('POST', `/v1/runs/${run.run}/agents/a0/next`, { token }));
    const { inv } = next.invocation;
    await call('POST', `/v1/runs/${run.run}/invocations/${inv}/result`, {
      token,
      body: {
        ok: true,
        cost_usd: 0.02,
        cost_source: 'reported',
        session_id: 's1',
        head_sha: '3'.repeat(40),
        new_commit: true,
        files: ['src/t001.ts'],
      },
    });

    const beans = await gateway.beansByPath(run.run, ['src/t001.ts']);
    const detail = await gateway.beanDetail(run.run, 't001');
    const unknown = await gateway.beanDetail(run.run, 't999');
    const decisions = await gateway.decisions(run.run);

    expect(beans).toMatchObject({
      ok: true,
      value: [
        {
          bean: 't001',
          branch: 'beans/t001',
          title: 'Task t001',
          agent: 'a0',
          intent: 'Implement t001.',
        },
      ],
    });
    if (!detail.ok) throw new Error('no detail');
    expect(detail.value).toMatchObject({
      bean: 't001',
      intent: 'Implement t001.',
      files: ['src/t001.ts', 'tests/t001.test.ts'],
      acceptance: [{ path: 'tests/t001.test.ts', amended: false }],
    });
    expect(detail.value.invocations).toEqual([
      expect.objectContaining({ inv, kind: 'initial', agent: 'a0', ok: true, cost_usd: 0.02 }),
    ]);
    expect(unknown).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(decisions).toEqual({ ok: true, value: [] });
  });
});
