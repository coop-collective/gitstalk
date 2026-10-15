/**
 * The one-time copy of the deprecated RunIndex into the forge D1: its run rows into `runs`,
 * and its kill switch into `gateway_flags`. Idempotent, so the admin route may run it any
 * number of times and the cron runs it once by itself:
 * - rows: each is upserted only when newer than the D1 row (`updated_at`), so a RunDO's own
 *   write since the deploy always wins over RunIndex's older copy;
 * - halt: copied only on the first backfill and only when D1 has no halt, so a later
 *   `DELETE /v1/admin/halt` is never undone by running the backfill again;
 * - the `run_index_backfill` flag records when it ran and what it copied.
 */
import { z } from 'zod';

import type { Logger } from '../log';
import { readFlag, writeFlag } from './gateway-flags';
import type { RunIndex } from './run-index';
import { recordRuns } from './run-list';

export type BackfillDeps = {
  readonly db: D1Database;
  readonly index: () => DurableObjectStub<RunIndex>;
  readonly now: () => number;
  readonly log: Logger;
};

/** What a backfill copied (the flag's value). */
export const BackfillReport = z.object({
  rows: z.number().int().min(0),
  invalid: z.number().int().min(0),
  halt_copied: z.boolean(),
  at: z.string(),
});
export type BackfillReport = z.infer<typeof BackfillReport>;

/** Copies RunIndex into D1 (see the module comment); safe to repeat. */
export async function backfillRunIndex(deps: BackfillDeps): Promise<BackfillReport> {
  const firstTime = (await previousBackfill(deps.db)) === null;
  const { rows, invalid } = await copyRows(deps);
  const haltCopied = firstTime && (await copyHalt(deps));
  const report: BackfillReport = {
    rows,
    invalid,
    halt_copied: haltCopied,
    at: new Date(deps.now()).toISOString(),
  };
  await writeFlag(deps.db, { name: 'run_index_backfill', value: report, atMs: deps.now() });
  deps.log.info('run index backfilled', report);
  return report;
}

/** The last backfill's report, or null when none has run. */
export async function previousBackfill(db: D1Database): Promise<BackfillReport | null> {
  return readFlag(db, 'run_index_backfill', BackfillReport);
}

async function copyRows(deps: BackfillDeps): Promise<{ rows: number; invalid: number }> {
  const index = deps.index();
  let after: string | null = null;
  let rows = 0;
  let invalid = 0;
  do {
    // oxlint-disable-next-line no-await-in-loop -- pages are read in order, each after the last
    const page = await index.dump(after);
    // oxlint-disable-next-line no-await-in-loop -- one page in memory at a time
    await recordRuns(deps.db, page.rows);
    rows += page.rows.length;
    invalid += page.invalid;
    after = page.next;
  } while (after !== null);
  return { rows, invalid };
}

async function copyHalt(deps: BackfillDeps): Promise<boolean> {
  const halt = await deps.index().halted();
  if (halt === null) return false;
  await writeFlag(deps.db, { name: 'halt', value: halt, atMs: deps.now() }, 'keep-existing');
  return true;
}
