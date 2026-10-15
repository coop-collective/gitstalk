import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { RunId } from '@gitstalk/shared-race/ids';

import { REPO_MAX_AGE_MS } from '../src/run/spend-guards';

import type { CreatedRun } from './helpers';
import {
  ADMIN,
  arenaTask,
  call,
  createRun,
  driveSlot,
  fireCron,
  json,
  listedRun,
  pushBase,
} from './helpers';

const BASE = 'f'.repeat(40);

type RepoStatus = { status: string; deleted?: string[]; failed?: unknown[] };
type Summary = {
  aborted: string | null;
  infra: {
    worker_requests: number;
    do_requests: number;
    artifacts_ops: number;
    runner_calls: number;
    container_busy_seconds: number;
    container_up_seconds: number;
    usd: { total: number; artifacts: number; containers: number };
  };
  repos: RepoStatus;
};

async function summary(run: CreatedRun): Promise<Summary> {
  return json<Summary>(await call('GET', `/v1/runs/${run.run}/summary`, { token: ADMIN }));
}

/** The summary once the run's own reap (a background task after `done`) has finished. */
async function summaryAfterReap(run: CreatedRun): Promise<Summary> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each read lets the background reap progress
    const current = await summary(run);
    if (current.repos.status !== 'reaping') return current;
  }
  throw new Error(`run ${run.run} never finished reaping`);
}

async function repoNames(run: CreatedRun): Promise<string[]> {
  const response = await call('POST', `/v1/runs/${run.run}/reap`, { token: ADMIN, body: {} });
  return (await json<{ repos: string[] }>(response)).repos;
}

async function raceToDone(config: Record<string, unknown>): Promise<CreatedRun> {
  const run = await createRun({ policy: 'beanstalk-v2', agents: 1, ...config });
  await pushBase(run, BASE);
  await call('POST', `/v1/runs/${run.run}/start`, { token: ADMIN });
  await driveSlot(run, 'a0');
  return run;
}

describe('a finished race', () => {
  it('deletes its repos after the final check and reports what it cost', async () => {
    const run = await raceToDone({ preset: 'demo' });

    const done = await summaryAfterReap(run);

    expect(done.repos).toEqual({ status: 'reaped', deleted: [run.repo.name], failed: [] });
    expect(await repoNames(run)).toEqual([]);
    expect(done.infra.worker_requests).toBeGreaterThan(0);
    expect(done.infra.artifacts_ops).toBeGreaterThan(0);
    expect(done.infra.runner_calls).toBeGreaterThan(0);
    expect(done.infra.container_up_seconds).toBeGreaterThanOrEqual(120);
    expect(done.infra.usd.total).toBeGreaterThan(0);
  });

  it('keeps its repos when asked, until a sweep finds it old enough', async () => {
    const beforeCreation = Date.now();
    const run = await raceToDone({ keep_repo: true });

    expect((await summary(run)).repos).toEqual({ status: 'kept' });
    const young = await env.RUNS.getByName(run.run).sweep(RunId.parse(run.run), beforeCreation);
    const old = await env.RUNS.getByName(run.run).sweep(RunId.parse(run.run), Date.now() + 1000);

    expect(young).toEqual({ ok: true, value: null });
    expect(old).toMatchObject({ ok: true, value: { deleted: [run.repo.name] } });
    expect((await summary(run)).repos).toMatchObject({ status: 'reaped' });
  });
});

describe('the hourly sweep', () => {
  it('deletes orphaned race repos and leaves a young run’s repos', async () => {
    const orphan = `s${crypto.randomUUID().replaceAll('-', '').slice(0, 11)}`;
    await env.ARTIFACTS.create(`race-${orphan}`);
    const young = await createRun({ keep_repo: true });

    const response = await call('POST', '/v1/admin/sweep', { token: ADMIN, body: {} });
    const report = await json<{ deleted: string[]; skipped: string[] }>(response);

    expect(report.deleted).toContain(orphan);
    expect(report.skipped).toContain(young.run);
    expect(await repoNames(young)).toEqual([young.repo.name]);
  });

  it('never deletes a person’s repository, however old', async () => {
    const name = `keep${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const opened = await call('POST', '/v1/repos', {
      token: ADMIN,
      body: {
        repoName: name,
        artifactsRepo: `repo-${name}`,
        owner: { id: 'u-sweep', handle: 'sweeper' },
        create_artifacts_repo: true,
      },
    });
    const { engineId } = await json<{ engineId: string }>(opened);
    // Even a race-shaped name in the repositories' namespace is out of the sweep's reach.
    const lookalike = `race-s${crypto.randomUUID().replaceAll('-', '').slice(0, 11)}`;
    await env.REPOS.create(lookalike);

    const response = await call('POST', '/v1/admin/sweep', {
      token: ADMIN,
      body: { older_than_hours: 0 },
    });
    const report = await json<{ deleted: string[] }>(response);
    const direct = await env.RUNS.getByName(engineId).sweep(RunId.parse(engineId), Date.now());
    const kept = (await env.REPOS.list()).repos.map((repo) => repo.name);

    expect(opened.status).toBe(201);
    expect(report.deleted).not.toContain(engineId);
    expect(direct).toMatchObject({ ok: false, error: { status: 409 } });
    expect(kept).toEqual(expect.arrayContaining([`repo-${name}`, lookalike]));
    expect((await env.ARTIFACTS.list()).repos.map((repo) => repo.name)).not.toContain(
      `repo-${name}`,
    );
  });
});

describe('the hourly cron trigger', () => {
  it('sweeps old runs and orphaned repos and leaves fresh ones', async () => {
    const orphan = `s${crypto.randomUUID().replaceAll('-', '').slice(0, 11)}`;
    await env.ARTIFACTS.create(`race-${orphan}`);
    const old = await createRun({ keep_repo: true });
    const fresh = await createRun({ keep_repo: true });
    const [oldRow, freshRow] = await Promise.all([listedRun(old.run), listedRun(fresh.run)]);
    const freshStartedMs = Date.parse(freshRow.created_at);

    // The trigger fires one day after the fresh run began: it is just young enough to stay.
    await fireCron(freshStartedMs + REPO_MAX_AGE_MS);
    const remaining = (await env.ARTIFACTS.list()).repos.map((repo) => repo.name);

    expect(Date.parse(oldRow.created_at)).toBeLessThan(freshStartedMs);
    expect(remaining).not.toContain(`race-${orphan}`);
    expect(remaining).not.toContain(old.repo.name);
    expect(remaining).toContain(fresh.repo.name);
    expect(await repoNames(fresh)).toEqual([fresh.repo.name]);
  });
});

describe('the spend cap', () => {
  it('aborts a run whose agent and infrastructure spend reach max_usd', async () => {
    const run = await createRun({ policy: 'beanstalk-v2', agents: 1, max_usd: 0.0001 });
    await pushBase(run, BASE);

    await call('POST', `/v1/runs/${run.run}/start`, { token: ADMIN });
    await driveSlot(run, 'a0');

    expect((await summaryAfterReap(run)).aborted).toMatch(
      /^budget \(max_usd\): \$0\.00 of \$0\.00/,
    );
  });
});

describe('the kill switch', () => {
  it('stops runs in flight and refuses new ones until it is turned off', async () => {
    const waiting = await createRun();
    await listedRun(waiting.run);

    const halted = await call('POST', '/v1/admin/halt', { token: ADMIN, body: { reason: 'bill' } });
    const refused = await call('POST', '/v1/runs', {
      token: ADMIN,
      body: { policy: 'queue', tasks: [arenaTask('t001')] },
    });
    const stopped = await summary(waiting);
    await call('DELETE', '/v1/admin/halt', { token: ADMIN });
    const after = await createRun();

    const report = await json<{ halt: { reason: string; stopped: string[] } }>(halted);
    expect(report.halt.reason).toBe('bill');
    expect(report.halt.stopped).toContain(waiting.run);
    expect(refused.status).toBe(503);
    expect(stopped.aborted).toBe('halted: bill');
    expect(after.run).toMatch(/^[a-z0-9]+$/);
  });
});
