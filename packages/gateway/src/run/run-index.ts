/**
 * RunIndex, deprecated (owner, 2026-10-15): the run list, the kill switch and the hourly sweep
 * moved to the forge D1 (`run-list.ts`, `gateway-flags.ts`) and a cron trigger
 * (`spend-guards.ts`). Nothing writes here any more. The class stays one release, read only,
 * so the backfill (`run-index-backfill.ts`) can copy its rows and its halt into D1; the next
 * release deletes it (an `exports` tombstone, `state: "deleted"`: the `deleted_classes`
 * migration; docs/claude-opus/31, "Retiring RunIndex").
 */
import { DurableObject } from 'cloudflare:workers';

import type { RunListItem } from '@gitstalk/shared-race/rpc';

import { Halt } from './gateway-flags';
import { parsedItem } from './run-list';

/** The index's one instance. */
export const RUN_INDEX_NAME = 'runs';
/** Rows one `dump` page returns at most. */
export const MAX_DUMPED_ROWS = 500;
const HALT_KEY = 'halt';

/** One page of the index, in run order. */
export type RunIndexDump = {
  readonly rows: readonly RunListItem[];
  /** The page's last run, to pass as `after` for the next page; null on the last page. */
  readonly next: string | null;
  /** Rows on this page that no longer validated (not copied). */
  readonly invalid: number;
};

export class RunIndex extends DurableObject<Env> {
  /** Rows after run `after` (null: from the start), in run order, validated. */
  async dump(after: string | null, limit: number = MAX_DUMPED_ROWS): Promise<RunIndexDump> {
    if (!this.#hasRuns()) return { rows: [], next: null, invalid: 0 };
    const bounded = Math.max(1, Math.min(MAX_DUMPED_ROWS, Math.trunc(limit)));
    const page = this.ctx.storage.sql
      .exec<{ run: string; body: string }>(
        'SELECT run, body FROM runs WHERE run > ? ORDER BY run LIMIT ?',
        after ?? '',
        bounded,
      )
      .toArray();
    const rows = page.flatMap((row) => parsedItem(row.body));
    const last = page.at(-1);
    return {
      rows,
      next: page.length === bounded && last !== undefined ? last.run : null,
      invalid: page.length - rows.length,
    };
  }

  /** The kill switch as RunIndex last held it: null when runs could be created. */
  async halted(): Promise<Halt | null> {
    const parsed = Halt.safeParse(this.ctx.storage.kv.get(HALT_KEY));
    return parsed.success ? parsed.data : null;
  }

  /** A sweep alarm set before the move: the cron trigger sweeps now, so it lapses. */
  override async alarm(): Promise<void> {}

  /** Whether the old `runs` table exists; reading never creates it. */
  #hasRuns(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'`,
        )
        .toArray().length > 0
    );
  }
}
