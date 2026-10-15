/**
 * The gateway-wide spend guards, on the forge D1 and a cron trigger (they lived in the RunIndex
 * Durable Object until 2026-10-15):
 * - the kill switch (`halt`, a `gateway_flags` row): no new runs, and every run in flight is
 *   stopped when it is turned on. Runs in flight never poll it: turning it on stops them, and
 *   creating or starting a run reads it once, so there is no cache and no window;
 * - the hourly sweep (the cron trigger, `scheduled()`): deletes the Artifacts repos of any
 *   run that began more than a day ago, and of orphaned `race-*` repos, so nothing outlives a
 *   day even when a run's own reap failed or it kept its repo.
 */
import type { RunId } from '@gitstalk/shared-race/ids';

import type { ArtifactsPort } from '../adapters/artifacts';
import type { Logger } from '../log';
import type { RunDO } from './run-do';
import { Halt, clearFlag, readFlag, writeFlag } from './gateway-flags';
import { openRuns } from './run-list';
import { runOfRepo } from './run-names';

/** Repos of runs that began longer ago than this are deleted by the sweep. */
export const REPO_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** RunDOs a sweep or a halt calls at once. */
const RUN_CALL_CONCURRENCY = 4;

export type HaltReport = Halt & { readonly stopped: readonly string[] };

export type SweepReport = {
  readonly runs: number;
  readonly deleted: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly { readonly run: string; readonly error: string }[];
};

export type SpendGuardDeps = {
  readonly db: D1Database;
  readonly run: (run: RunId) => DurableObjectStub<RunDO>;
  /** The race repos' namespace (ARTIFACTS); people's repositories are never listed. */
  readonly raceRepos: ArtifactsPort;
  readonly now: () => number;
  readonly log: Logger;
};

export type SpendGuards = {
  /** The kill switch's state: null when runs may be created. */
  readonly halted: () => Promise<Halt | null>;
  /** Turns the kill switch on: refuses new runs and stops every run not yet done. */
  readonly halt: (reason: string) => Promise<HaltReport>;
  /** Turns the kill switch off. */
  readonly resume: () => Promise<void>;
  /** Deletes the repos of every run that began before `startedBeforeMs` (see `sweepRunRepos`). */
  readonly sweep: (startedBeforeMs: number) => Promise<SweepReport>;
};

export function spendGuards(deps: SpendGuardDeps): SpendGuards {
  return {
    halted: () => readFlag(deps.db, 'halt', Halt),
    halt: (reason) => haltRuns(deps, reason),
    resume: async () => {
      await clearFlag(deps.db, 'halt');
      deps.log.info('runs resumed');
    },
    sweep: (startedBeforeMs) => sweepRunRepos(deps, startedBeforeMs),
  };
}

async function haltRuns(deps: SpendGuardDeps, reason: string): Promise<HaltReport> {
  const halt: Halt = { reason, at: new Date(deps.now()).toISOString() };
  await writeFlag(deps.db, { name: 'halt', value: halt, atMs: deps.now() });
  const open = await openRuns(deps.db);
  const stopped = await inBatches(open, async (run) => {
    const result = await deps.run(run).stop(`halted: ${reason}`);
    return result.ok ? [run] : [];
  });
  deps.log.warn('runs halted', { reason, stopped: stopped.length });
  return { ...halt, stopped };
}

/**
 * Deletes the repos of every run that began before `startedBeforeMs` and is not racing,
 * and of `race-*` repos no run knows. Each run's own RunDO decides and deletes, from the
 * one listing of the namespace made here (each run gets only its own repo names).
 */
async function sweepRunRepos(deps: SpendGuardDeps, startedBeforeMs: number): Promise<SweepReport> {
  const repos = await deps.raceRepos.listRepos((name) => runOfRepo(name) !== null);
  const reposByRun = Map.groupBy(
    repos.flatMap((name) => {
      const run = runOfRepo(name);
      return run === null ? [] : [{ run, name }];
    }),
    (entry) => entry.run,
  );
  const runs = [...reposByRun.keys()];
  const outcomes = await inBatches(runs, async (run) => {
    const listed = (reposByRun.get(run) ?? []).map((entry) => entry.name);
    const result = await deps.run(run).sweep(run, startedBeforeMs, listed);
    return [{ run, result }];
  });
  const report: SweepReport = {
    runs: runs.length,
    deleted: outcomes.flatMap(({ run, result }) =>
      result.ok && result.value !== null && result.value.failed.length === 0 ? [run] : [],
    ),
    skipped: outcomes.flatMap(({ run, result }) =>
      result.ok && result.value === null ? [run] : [],
    ),
    failed: outcomes.flatMap(({ run, result }) => {
      if (!result.ok) return [{ run, error: result.error.message }];
      const failed = result.value?.failed ?? [];
      return failed.length > 0 ? [{ run, error: failed.map((f) => f.error).join('; ') }] : [];
    }),
  };
  deps.log.info('run repos swept', {
    runs: report.runs,
    deleted: report.deleted.length,
    skipped: report.skipped.length,
    failed: report.failed.length,
  });
  return report;
}

/** Maps `items` a few at a time (each call wakes a RunDO) and flattens the results. */
async function inBatches<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<readonly R[]>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += RUN_CALL_CONCURRENCY) {
    const batch = items.slice(start, start + RUN_CALL_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- batches bound the RunDOs woken at once
    const mapped = await Promise.all(batch.map(map));
    results.push(...mapped.flat());
  }
  return results;
}
