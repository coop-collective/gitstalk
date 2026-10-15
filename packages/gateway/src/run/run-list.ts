/**
 * The run list (forge D1 `runs`): one row per run, which its RunDO upserts in the background
 * when its phase or task counts change, read by the web app (`listRuns`) and by the kill
 * switch (the runs to stop). Rows are validated when read back. It replaced the RunIndex
 * Durable Object (owner, 2026-10-15): a global list is a table, not one object.
 */
import { z } from 'zod';

import { RunId } from '@gitstalk/shared-race/ids';
import type { RunListCursor, RunListItem } from '@gitstalk/shared-race/rpc';
import { PolicyName, RunPreset } from '@gitstalk/shared-race/run-config';

/** Runs one `listRuns` page holds at most. */
export const MAX_LISTED_RUNS = 200;
/** Rows one D1 batch writes during the backfill. */
const BATCH_ROWS = 100;

const Count = z.number().int().min(0);

/** A stored row's body, as RunIndex validated it. */
export const StoredRunListItem = z.object({
  run: z.string(),
  policy: PolicyName,
  preset: RunPreset.nullable().default(null),
  phase: z.enum(['created', 'running', 'finishing', 'done']),
  aborted: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  agents: Count,
  tasks: z.object({
    total: Count,
    pending: Count,
    running: Count,
    queued: Count,
    testing: Count,
    rework: Count,
    landed: Count,
    green: Count,
    dropped: Count,
    // Rows written before parking have none.
    parked: Count.default(0),
  }),
  spent_usd: z.number(),
});

/** One page of the list: at most `limit` rows, older than `before` when given. */
export type RunListPage = { readonly limit: number; readonly before?: RunListCursor | undefined };

/** Records a run's row; a write older than the stored row (by `updated_at`) changes nothing. */
export async function recordRun(db: D1Database, item: RunListItem): Promise<void> {
  await upsertStatement(db, item).run();
}

/** Records many rows (the backfill), newest values winning, in batches. */
export async function recordRuns(db: D1Database, items: readonly RunListItem[]): Promise<void> {
  for (let start = 0; start < items.length; start += BATCH_ROWS) {
    const batch = items.slice(start, start + BATCH_ROWS).map((item) => upsertStatement(db, item));
    // oxlint-disable-next-line no-await-in-loop -- one D1 batch at a time bounds each request
    if (batch.length > 0) await db.batch(batch);
  }
}

/** The newest runs first, by when they began; rows that no longer validate are skipped. */
export async function listRunPage(db: D1Database, page: RunListPage): Promise<RunListItem[]> {
  const limit = Math.max(1, Math.min(MAX_LISTED_RUNS, Math.trunc(page.limit)));
  const before = page.before ?? null;
  const query =
    before === null
      ? db.prepare('SELECT body FROM runs ORDER BY created_at DESC, run DESC LIMIT ?').bind(limit)
      : db
          .prepare(
            `SELECT body FROM runs WHERE (created_at, run) < (?, ?)
             ORDER BY created_at DESC, run DESC LIMIT ?`,
          )
          .bind(before.created_at, before.run, limit);
  const { results } = await query.all<{ body: string }>();
  return results.flatMap((row) => parsedItem(row.body));
}

/** Runs not yet finishing (created or running): the ones the kill switch stops. */
export async function openRuns(db: D1Database): Promise<RunId[]> {
  const { results } = await db
    .prepare(`SELECT run FROM runs WHERE json_extract(body, '$.phase') IN ('created', 'running')`)
    .all<{ run: string }>();
  return results.flatMap((row) => {
    const run = RunId.safeParse(row.run);
    return run.success ? [run.data] : [];
  });
}

/** A stored body as a list item, or nothing when it no longer validates. */
export function parsedItem(body: string): RunListItem[] {
  try {
    const parsed = StoredRunListItem.safeParse(JSON.parse(body));
    return parsed.success ? [parsed.data] : [];
  } catch {
    // Not JSON: skipped like a row that fails validation.
    return [];
  }
}

function upsertStatement(db: D1Database, item: RunListItem): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO runs (run, created_at, updated_at, body) VALUES (?, ?, ?, ?)
       ON CONFLICT(run) DO UPDATE SET updated_at = excluded.updated_at, body = excluded.body
       WHERE excluded.updated_at >= runs.updated_at`,
    )
    .bind(item.run, item.created_at, item.updated_at, JSON.stringify(item));
}
