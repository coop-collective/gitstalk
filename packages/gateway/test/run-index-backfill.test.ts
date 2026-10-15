import { env, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { RunListItem } from '@gitstalk/shared-race/rpc';

import { ADMIN, call, fireCron, json } from './helpers';

/** The web app's service binding: the gateway's default entrypoint, over RPC. */
const gateway = exports.default;

/** A row as the deprecated RunIndex stored it (one ancient year per test, listed alone). */
function indexRow(run: string, createdAt: string, updatedAt: string): RunListItem {
  return {
    run,
    policy: 'beanstalk-v2',
    preset: 'demo',
    phase: 'done',
    aborted: null,
    created_at: createdAt,
    updated_at: updatedAt,
    agents: 3,
    tasks: {
      total: 4,
      pending: 0,
      running: 0,
      queued: 0,
      testing: 0,
      rework: 0,
      landed: 4,
      green: 4,
      dropped: 0,
      parked: 0,
    },
    spent_usd: 1.25,
  };
}

/** Writes rows (and the halt) into RunIndex's storage, the way it held them before the move. */
async function seedRunIndex(rows: readonly RunListItem[], halt?: { reason: string; at: string }) {
  await runInDurableObject(env.RUN_INDEX.getByName('runs'), (_, state) => {
    state.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS runs (run TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL)',
    );
    for (const row of rows)
      state.storage.sql.exec(
        `INSERT INTO runs (run, created_at, body) VALUES (?, ?, ?)
         ON CONFLICT(run) DO UPDATE SET body = excluded.body`,
        row.run,
        row.created_at,
        JSON.stringify(row),
      );
    if (halt !== undefined) state.storage.kv.put('halt', halt);
  });
}

/** The listed runs that began in `year`. */
async function listedIn(year: number): Promise<readonly RunListItem[]> {
  const page = await gateway.listRuns(200, { created_at: `${year + 1}-01-01`, run: '' });
  return page.filter((item) => item.created_at.startsWith(`${year}-`));
}

describe('the RunIndex backfill', () => {
  it('copies RunIndex’s rows and halt once, by the first cron run', async () => {
    const first = indexRow('bf1', '1990-01-01T00:00:00.000Z', '1990-01-02T00:00:00.000Z');
    await seedRunIndex([first], { reason: 'old halt', at: '1990-01-03T00:00:00.000Z' });

    await fireCron(Date.now());
    const halt = await call('GET', '/v1/admin/halt', { token: ADMIN });
    await call('DELETE', '/v1/admin/halt', { token: ADMIN });
    await seedRunIndex([indexRow('bf2', '1990-02-01T00:00:00.000Z', '1990-02-01T00:00:00.000Z')]);
    await fireCron(Date.now());
    const resumed = await call('GET', '/v1/admin/halt', { token: ADMIN });

    expect(await listedIn(1990)).toEqual([first]);
    expect(await json<{ halt: unknown }>(halt)).toEqual({
      halt: { reason: 'old halt', at: '1990-01-03T00:00:00.000Z' },
    });
    expect(await json<{ halt: unknown }>(resumed)).toEqual({ halt: null });
  });

  it('runs again from the admin route without undoing newer rows', async () => {
    const stale = indexRow('bf3', '1991-01-01T00:00:00.000Z', '1991-01-01T00:00:00.000Z');
    const newer = { ...stale, phase: 'running' as const, updated_at: '1991-06-01T00:00:00.000Z' };
    const copied = indexRow('bf4', '1991-02-01T00:00:00.000Z', '1991-02-01T00:00:00.000Z');
    await seedRunIndex([stale, copied]);
    await env.FORGE.prepare(
      'INSERT INTO runs (run, created_at, updated_at, body) VALUES (?, ?, ?, ?)',
    )
      .bind(newer.run, newer.created_at, newer.updated_at, JSON.stringify(newer))
      .run();

    const once = await call('POST', '/v1/admin/runs/backfill', { token: ADMIN });
    const twice = await call('POST', '/v1/admin/runs/backfill', { token: ADMIN });

    expect(once.status).toBe(200);
    expect(twice.status).toBe(200);
    expect(await listedIn(1991)).toEqual([copied, newer]);
  });

  it('is admin only', async () => {
    const response = await call('POST', '/v1/admin/runs/backfill', {});

    expect(response.status).toBe(401);
  });
});
