/**
 * An append-only cache of public repositories' engine event logs, kept in this isolate's
 * memory across requests. A request reads only the events after the newest one held, plus that
 * newest one again as an anchor: when the anchor is gone or changed (the log was reset, or
 * the engine answered a different log), the whole log is read again. Bounded by engines and by
 * total events; the least recently read engine goes first.
 *
 * Only a public repository's engine can be named here (`PublicEngine`), and only from a record
 * the viewer's access check returned: a private or internal repository always reads fresh.
 */
import type { RunId } from '@gitstalk/shared-race/ids';

import type { EventsTail } from '@gitstalk/shared-ask/ask/plan-context';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RepositoryRecord } from '../repositories/registry-client';

/**
 * What of a repository's record decides whether its reads are shared, and under which epoch:
 * its visibility, and `updated_at`, which the registry moves on every change to the record
 * (visibility, name, owner, archive, settings).
 */
export type CacheScope = Pick<RepositoryRecord, 'visibility' | 'updated_at'>;

/** A public repository's engine: the only key the shared caches accept. */
export class PublicEngine {
  readonly engine: RunId;
  /**
   * The record's cache epoch (docs/claude-opus/35-caching.md §4.6): part of every edge object
   * key, so any change to the record (a visibility flip, a transfer, a takedown edit by an
   * operator) leaves every copy cached before it unreachable in every layer.
   */
  readonly epoch: string;

  private constructor(engine: RunId, epoch: string) {
    this.engine = engine;
    this.epoch = epoch;
  }

  /**
   * The engine of a record the viewer's access check returned, when every viewer may read
   * it; null for a private or internal repository, which is never cached.
   */
  static of(record: CacheScope, engine: RunId): PublicEngine | null {
    return record.visibility === 'public' ? new PublicEngine(engine, epochOf(record)) : null;
  }
}

/** `updated_at` as a key segment: its letters and digits (`20261014T120000000Z`). */
function epochOf(record: CacheScope): string {
  const compact = record.updated_at.replace(/[^0-9A-Za-z]/g, '');
  return compact === '' ? '0' : compact;
}

export type EventCacheLimits = {
  readonly maxEngines: number;
  /** Events held across all engines; a log longer than this is not cached. */
  readonly maxEvents: number;
};

/** Reads an engine's events after a sequence number (`eventsAfter` bound to a source). */
export type ReadTail = (after: number) => Promise<EventsTail>;

export type EventCache = {
  /** The engine's whole log: the held start plus what was appended since. */
  events(engine: PublicEngine, readTail: ReadTail): Promise<readonly RaceEvent[]>;
  /** What is held now (tests and logs). */
  held(): { readonly engines: number; readonly events: number };
};

export function createEventCache(limits: EventCacheLimits): EventCache {
  const logs = lruLogs(limits);
  return {
    held: logs.held,
    events: async ({ engine }, readTail) => {
      const held = logs.get(engine);
      const anchor = held?.at(-1);
      if (held === undefined || anchor === undefined)
        return logs.put(engine, (await readTail(0)).events);
      const appended = continuation(anchor, (await readTail(anchor.seq - 1)).events);
      if (appended === null) return logs.put(engine, (await readTail(0)).events);
      return appended.length === 0 ? held : logs.put(engine, [...held, ...appended]);
    },
  };
}

/**
 * The events after the anchor, when the page starts with the anchor itself, unchanged, and
 * runs forward; null when the log no longer continues the held one.
 */
function continuation(anchor: RaceEvent, page: readonly RaceEvent[]): readonly RaceEvent[] | null {
  const [first, ...rest] = page;
  if (first === undefined || !sameEvent(first, anchor)) return null;
  const forward = rest.every((event, index) => event.seq > (rest[index - 1] ?? anchor).seq);
  return forward ? rest : null;
}

function sameEvent(left: RaceEvent, right: RaceEvent): boolean {
  return left.seq === right.seq && left.type === right.type && left.ts === right.ts;
}

/** Logs by engine, least recently read first (a `Map` keeps insertion order). */
function lruLogs(limits: EventCacheLimits) {
  const logs = new Map<RunId, readonly RaceEvent[]>();
  let total = 0;
  const drop = (engine: RunId) => {
    total -= logs.get(engine)?.length ?? 0;
    logs.delete(engine);
  };
  return {
    held: () => ({ engines: logs.size, events: total }),
    get: (engine: RunId): readonly RaceEvent[] | undefined => {
      const events = logs.get(engine);
      if (events === undefined) return undefined;
      logs.delete(engine);
      logs.set(engine, events);
      return events;
    },
    /** Holds a log as the most recent (unless it alone is over the bound) and returns it. */
    put: (engine: RunId, events: readonly RaceEvent[]): readonly RaceEvent[] => {
      drop(engine);
      if (events.length > limits.maxEvents) return events;
      logs.set(engine, events);
      total += events.length;
      for (const oldest of logs.keys()) {
        if (logs.size <= limits.maxEngines && total <= limits.maxEvents) break;
        drop(oldest);
      }
      return events;
    },
  };
}
