import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { RunListItem } from '@gitstalk/shared-race/rpc';

import { recordRun } from '../src/run/run-list';
import { createRun, listedRun } from './helpers';

/** The web app's service binding: the gateway's default entrypoint, over RPC. */
const gateway = exports.default;

/** A list row, as a RunDO would write it. */
function listItem(run: string, createdAt: string, updatedAt = createdAt): RunListItem {
  return {
    run,
    policy: 'queue',
    preset: null,
    phase: 'running',
    aborted: null,
    created_at: createdAt,
    updated_at: updatedAt,
    agents: 2,
    tasks: {
      total: 1,
      pending: 1,
      running: 0,
      queued: 0,
      testing: 0,
      rework: 0,
      landed: 0,
      green: 0,
      dropped: 0,
      parked: 0,
    },
    spent_usd: 0,
  };
}

describe('the run list', () => {
  it('holds the row each RunDO writes, and the web app lists it', async () => {
    const run = await createRun();

    const row = await listedRun(run.run);
    const listed = await gateway.listRuns(50);

    expect(row).toMatchObject({ run: run.run, policy: 'queue', phase: 'created', agents: 2 });
    expect(listed.map((item) => item.run)).toContain(run.run);
  });

  it('pages the newest runs first, by when they began', async () => {
    // Far in the future, so these five come before every run the other tests create.
    const rows = [
      listItem('page1', '2999-01-05T00:00:00.000Z'),
      listItem('page2', '2999-01-04T00:00:00.000Z'),
      listItem('page3b', '2999-01-03T00:00:00.000Z'),
      listItem('page3a', '2999-01-03T00:00:00.000Z'),
      listItem('page4', '2999-01-01T00:00:00.000Z'),
    ];
    await Promise.all(rows.map((row) => recordRun(env.FORGE, row)));

    const first = await gateway.listRuns(2);
    const second = await gateway.listRuns(2, first.at(-1));
    const third = await gateway.listRuns(1, second.at(-1));

    expect(first.map((item) => item.run)).toEqual(['page1', 'page2']);
    expect(second.map((item) => item.run)).toEqual(['page3b', 'page3a']);
    expect(third.map((item) => item.run)).toEqual(['page4']);
  });

  it('keeps the newer row when a late write arrives', async () => {
    await recordRun(
      env.FORGE,
      listItem('late1', '2001-01-01T00:00:00.000Z', '2001-01-02T00:00:00.000Z'),
    );
    await recordRun(env.FORGE, {
      ...listItem('late1', '2001-01-01T00:00:00.000Z', '2001-01-01T12:00:00.000Z'),
      phase: 'created',
    });

    const listed = await gateway.listRuns(1, { created_at: '2001-01-02T00:00:00.000Z', run: '' });

    expect(listed).toEqual([
      listItem('late1', '2001-01-01T00:00:00.000Z', '2001-01-02T00:00:00.000Z'),
    ]);
  });

  it('skips a row that no longer validates', async () => {
    await env.FORGE.prepare(
      'INSERT INTO runs (run, created_at, updated_at, body) VALUES (?, ?, ?, ?)',
    )
      .bind('broken1', '2002-01-01T00:00:00.000Z', '2002-01-01T00:00:00.000Z', '{"run":"broken1"}')
      .run();

    const listed = await gateway.listRuns(1, { created_at: '2002-01-02T00:00:00.000Z', run: '' });

    expect(listed).toEqual([]);
  });
});
