/**
 * The RunDO's storage. The append-only event log is a SQLite table (read back by range for
 * `GET /events`); the run's metadata, configuration, repos and the engine state snapshot
 * are values in the object's synchronous KV store, written in the same step as the events.
 */
import type { RunId } from '@gitstalk/shared-race/ids';
import type { RunConfig } from '@gitstalk/shared-race/run-config';

import type { EmittedEvent } from '../engine/model';
import type { EngineState } from '../engine/state';
import type { InfraMeter } from './infra-meter';
import { restoredMeter } from './infra-meter';
import type { RunRepos } from './run-jobs';
import type { ReapReport } from './run-reap';

export type RunMeta = {
  readonly run: RunId;
  readonly createdAtMs: number;
};

/** Everything a RunDO keeps about its run. */
export type StoredRun = {
  readonly meta: RunMeta;
  readonly config: RunConfig;
  readonly repos: RunRepos;
  readonly state: EngineState;
};

/**
 * Fields a run stored before the spend guards (and streaming diffs) existed lacks; they read
 * as their defaults.
 */
const SPEND_GUARD_DEFAULTS = {
  preset: null,
  max_usd: null,
  keep_repo: false,
  stream_diffs: false,
  continuous: false,
  test_skipper: false,
} as const satisfies Pick<
  RunConfig,
  'preset' | 'max_usd' | 'keep_repo' | 'stream_diffs' | 'continuous' | 'test_skipper'
>;
type StoredConfig = Omit<RunConfig, keyof typeof SPEND_GUARD_DEFAULTS> &
  Partial<Pick<RunConfig, keyof typeof SPEND_GUARD_DEFAULTS>>;

/** The last time the run's repos were deleted, and what that did. */
export type ReapRecord = ReapReport & { readonly atMs: number };

const KEYS = {
  meta: 'meta',
  config: 'config',
  repos: 'repos',
  state: 'state',
  meter: 'infra-meter',
  reaped: 'reaped',
} as const;

/**
 * Creates the events table and its by-type index if they do not exist (idempotent; safe in
 * the constructor). The index serves `readEventsOfTypes` (the web app's bean views).
 */
export function migrate(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS events (
       seq INTEGER PRIMARY KEY,
       t REAL NOT NULL,
       type TEXT NOT NULL,
       body TEXT NOT NULL
     )`,
  );
  sql.exec('CREATE INDEX IF NOT EXISTS events_by_type ON events (type, seq)');
}

/** Whether this object ever held a run (a probe or sweep of an unknown run finds none). */
export function hasRun(storage: DurableObjectStorage): boolean {
  return storage.kv.get<RunMeta>(KEYS.meta) !== undefined;
}

export function loadRun(storage: DurableObjectStorage): StoredRun | null {
  const meta = storage.kv.get<RunMeta>(KEYS.meta);
  const config = storage.kv.get<StoredConfig>(KEYS.config);
  const repos = storage.kv.get<RunRepos>(KEYS.repos);
  const state = storage.kv.get<EngineState>(KEYS.state);
  if (meta === undefined || config === undefined || repos === undefined || state === undefined)
    return null;
  return { meta, config: { ...SPEND_GUARD_DEFAULTS, ...config }, repos, state };
}

export function saveNewRun(storage: DurableObjectStorage, run: StoredRun): void {
  storage.kv.put(KEYS.meta, run.meta);
  storage.kv.put(KEYS.config, run.config);
  storage.kv.put(KEYS.repos, run.repos);
  storage.kv.put(KEYS.state, run.state);
}

/** A continuous engine's configuration after a pushed bean joined its tasks. */
export function saveConfig(storage: DurableObjectStorage, config: RunConfig): void {
  storage.kv.put(KEYS.config, config);
}

/**
 * Persists a step: the new state, its events and the infra meter, atomically (no await in
 * between). The state goes first: when it is too large to store, nothing of the step is.
 */
export function saveStep(
  storage: DurableObjectStorage,
  step: { state: EngineState; events: readonly EmittedEvent[]; meter: InfraMeter },
): void {
  storage.kv.put(KEYS.state, step.state);
  storage.kv.put(KEYS.meter, step.meter);
  for (const event of step.events) {
    storage.sql.exec(
      'INSERT INTO events (seq, t, type, body) VALUES (?, ?, ?, ?)',
      event.seq,
      event.t,
      event.type,
      JSON.stringify(event),
    );
  }
}

export function loadMeter(storage: DurableObjectStorage, nowMs: number): InfraMeter | null {
  const stored = storage.kv.get<Partial<InfraMeter>>(KEYS.meter);
  return stored === undefined ? null : restoredMeter(stored, nowMs);
}

export function saveMeter(storage: DurableObjectStorage, meter: InfraMeter): void {
  storage.kv.put(KEYS.meter, meter);
}

export function loadReapRecord(storage: DurableObjectStorage): ReapRecord | null {
  return storage.kv.get<ReapRecord>(KEYS.reaped) ?? null;
}

export function saveReapRecord(storage: DurableObjectStorage, record: ReapRecord): void {
  storage.kv.put(KEYS.reaped, record);
}

/** Every event of the given types, in order (the web app's bean and decision views). */
export function readEventsOfTypes(sql: SqlStorage, types: readonly string[]): string[] {
  if (types.length === 0) return [];
  const marks = types.map(() => '?').join(', ');
  return sql
    .exec<{ body: string }>(
      `SELECT body FROM events WHERE type IN (${marks}) ORDER BY seq`,
      ...types,
    )
    .toArray()
    .map((row) => row.body);
}

/** Events of the given types after `after`, in order, at most `limit` (`events_by_type`). */
export function readEventsOfTypesAfter(
  sql: SqlStorage,
  input: { readonly types: readonly string[]; readonly after: number; readonly limit: number },
): { seq: number; body: string }[] {
  if (input.types.length === 0) return [];
  const marks = input.types.map(() => '?').join(', ');
  return sql
    .exec<{ seq: number; body: string }>(
      `SELECT seq, body FROM events WHERE type IN (${marks}) AND seq > ? ORDER BY seq LIMIT ?`,
      ...input.types,
      input.after,
      input.limit,
    )
    .toArray();
}

/** Event bodies (JSON text) after `after`, in order, at most `limit`. */
export function readEvents(
  sql: SqlStorage,
  after: number,
  limit: number,
): { seq: number; body: string }[] {
  return sql
    .exec<{ seq: number; body: string }>(
      'SELECT seq, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
      after,
      limit,
    )
    .toArray();
}

/**
 * Drops the read index's cached git objects (`repo/object-cache.ts`): once the run's repos
 * are deleted they can never be read again.
 */
export function clearObjectCache(sql: SqlStorage): void {
  sql.exec('DELETE FROM git_objects');
}
