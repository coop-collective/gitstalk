/**
 * The gateway's hourly cron trigger (`triggers.crons` in wrangler.jsonc): the repo sweep of
 * the spend guards, for runs that began more than `REPO_MAX_AGE_MS` before the trigger's time.
 * Until the deprecated RunIndex has been copied into D1 once, it first runs that backfill, so
 * a deploy needs no manual step; a failed backfill is logged and does not stop the sweep.
 */
import { readConfig } from '../config';
import { createSpendGuards } from '../deps';
import type { Logger } from '../log';
import { createLogger } from '../log';
import { RUN_INDEX_NAME } from './run-index';
import { backfillRunIndex, previousBackfill } from './run-index-backfill';
import type { SweepReport } from './spend-guards';
import { REPO_MAX_AGE_MS } from './spend-guards';

export async function runScheduledSweep(env: Env, scheduledTimeMs: number): Promise<SweepReport> {
  const log = createLogger(readConfig(env).logLevel, { component: 'scheduled-sweep' });
  await backfillOnce(env, log);
  return createSpendGuards(env, log).sweep(scheduledTimeMs - REPO_MAX_AGE_MS);
}

async function backfillOnce(env: Env, log: Logger): Promise<void> {
  try {
    if ((await previousBackfill(env.FORGE)) !== null) return;
    await backfillRunIndex({
      db: env.FORGE,
      index: () => env.RUN_INDEX.getByName(RUN_INDEX_NAME),
      now: () => Date.now(),
      log,
    });
  } catch (error: unknown) {
    log.error('run index backfill failed', { error });
  }
}
