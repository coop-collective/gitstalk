/**
 * The Changes tab's client data: the JSON routes it reads (`events`, `pushed`), the guards
 * that accept their answers and the live feed's batches, and which new events make other
 * queries stale (the pushed beans, a bean's diff). Client-safe: no schema library.
 *
 * The guards check the envelope (an array of events with a numeric `seq`, of beans with a
 * name and a phase): the server already validated every event and bean with the full schemas
 * (`parseRaceEvents`, `PushedBean`) before sending them, on the JSON routes and on the feed.
 */
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RepoDiff } from '@gitstalk/shared-ask/repo/repo-types';

import type { PushedBean } from './pushed-beans';

/** `GET /api/repos/:owner/:repo/events[?after=<seq>]`. */
export type EventsAnswer = { readonly events: readonly RaceEvent[] };

/** `GET /api/repos/:owner/:repo/pushed`. */
export type PushedAnswer = { readonly pushed: readonly PushedBean[] };

/** Which repository's client data, for whom: the parts of its query keys and its paths. */
export type RepoScope = {
  /** The viewer's user id, or null when signed out. */
  readonly uid: string | null;
  /** The owner's handle and the repository's name, as the record names them now. */
  readonly owner: string;
  readonly repo: string;
  /** `/<owner>/<repo>`. */
  readonly base: string;
};

/** The JSON routes and the live feed of the repository at `base` (`/<owner>/<repo>`). */
export function changeFeedPaths(base: string) {
  return {
    events: `/api/repos${base}/events`,
    pushed: `/api/repos${base}/pushed`,
    live: `/api/repos${base}/live`,
  } as const;
}

/** A bean's own diff, through the engine's run route (access-checked the same way). */
export function beanDiffPath(engine: string, bean: string): string {
  return `/api/runs/${encodeURIComponent(engine)}/beans/${encodeURIComponent(bean)}/diff`;
}

export function isEventsAnswer(value: unknown): value is EventsAnswer {
  return isRecord(value) && isList(value['events'], isEventEnvelope);
}

export function isPushedAnswer(value: unknown): value is PushedAnswer {
  return isRecord(value) && isList(value['pushed'], isPushedEnvelope);
}

export function isRepoDiff(value: unknown): value is RepoDiff {
  return isRecord(value) && Array.isArray(value['files']);
}

/** One live-feed message's events, or null when it is not a batch (for `useLiveFeed`). */
export function parseEventBatch(data: unknown): readonly RaceEvent[] | null {
  return isList(data, isEventEnvelope) ? data : null;
}

/**
 * Events that move a pushed bean (a push, a check's verdict, a landing, validation, parking,
 * a decision, a revert): the gateway's pushed list changes with them.
 */
const PUSHED_KINDS: ReadonlySet<RaceEvent['type']> = new Set<RaceEvent['type']>([
  'task.start',
  'task.commit',
  'preland.check',
  'merge.conflict',
  'rework.start',
  'land',
  'green.promote',
  'task.parked',
  'task.drop',
  'decision.made',
  'revert',
  'bean.requeued',
  'sprout.reset',
]);

/** Whether any of `events` changes what the pushed beans say. */
export function movesPushedBeans(events: readonly RaceEvent[]): boolean {
  return events.some((event) => PUSHED_KINDS.has(event.type));
}

/** Whether any of `events` gives `bean` a new diff: a new push (its head) or its landing. */
export function changesBeanDiff(events: readonly RaceEvent[], bean: string): boolean {
  return events.some(
    (event) => (event.type === 'task.commit' || event.type === 'land') && event.task === bean,
  );
}

/** The events after seq `after` (the list is sorted by seq). */
export function eventsAfter(events: readonly RaceEvent[], after: number): readonly RaceEvent[] {
  const first = events.findIndex((event) => event.seq > after);
  return first === -1 ? [] : events.slice(first);
}

function isEventEnvelope(value: unknown): value is RaceEvent {
  return (
    isRecord(value) &&
    Number.isInteger(value['seq']) &&
    typeof value['t'] === 'number' &&
    typeof value['ts'] === 'string' &&
    typeof value['type'] === 'string'
  );
}

function isPushedEnvelope(value: unknown): value is PushedBean {
  return (
    isRecord(value) &&
    typeof value['bean'] === 'string' &&
    typeof value['phase'] === 'string' &&
    typeof value['actor'] === 'string' &&
    Array.isArray(value['verdict']) &&
    (value['hold'] === undefined || value['hold'] === null || isRecord(value['hold']))
  );
}

function isList<T>(value: unknown, isItem: (item: unknown) => item is T): value is readonly T[] {
  return Array.isArray(value) && value.every((item) => isItem(item));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
