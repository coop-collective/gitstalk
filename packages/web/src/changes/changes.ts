/**
 * The Changes tab's model: every bean of a repository with who brought it (a person, or an
 * agent session when nobody pushed it), what it is for, where it stands, and its journey
 * (pushes, checks, verdicts with failing tests and the beans it collided with, landing,
 * validation, decisions), read from the engine's event log and the pushed beans. Pure and
 * client-safe: it imports types only from the zod-validated modules, so the Changes tab's
 * client components derive their rows with it without carrying a schema library.
 */
import type { BeanHold } from '@gitstalk/shared-race/bean-approval';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { Bean, BeanPhase } from '@gitstalk/shared-ask/race/race-state';
import { reduceRace } from '@gitstalk/shared-ask/race/reduce-race';

import type { PushedBean } from './pushed-beans';

/** Who brought a bean: the person who pushed it, or the engine's session slot. */
export type Author =
  | { readonly kind: 'person'; readonly handle: string }
  | { readonly kind: 'session'; readonly slot: string };

export type ChangeState =
  | 'checking'
  | 'held'
  | 'red'
  | 'conflict'
  | 'waiting'
  | 'landed'
  | 'validated'
  | 'parked'
  | 'fell-off';

/** The three lists of the tab. */
export type ChangeGroup = 'open' | 'landed' | 'parked';

/** What the tab shows: a list, or the open beans held for a person's approval. */
export type ChangeFilter = ChangeGroup | 'held';

export type JourneyTone = 'push' | 'good' | 'bad' | 'rework' | 'land' | 'stalk' | 'decide' | 'wait';

export type JourneyEntry = {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly tone: JourneyTone;
  readonly text: string;
  /** Failing tests or conflicted files, one per line. */
  readonly lines: readonly string[];
  /** Beans it collided with, linked. */
  readonly beans: readonly string[];
};

export type Change = {
  readonly bean: string;
  readonly title: string;
  readonly author: Author | null;
  readonly state: ChangeState;
  readonly group: ChangeGroup;
  /** The engine's last word on it ("validated; on the stalk at 941e146"). */
  readonly reason: string;
  readonly pushes: number;
  readonly head: string | null;
  readonly landedSha: string | null;
  /** The latest red check's failing tests (empty once it is green). */
  readonly failing: readonly string[];
  /** Landed beans its latest red was traced to. */
  readonly collided: readonly string[];
  readonly startedAt: number | null;
  readonly updatedAt: number | null;
  readonly journey: readonly JourneyEntry[];
  /** The approval rules' hold: held for a person, or approved for its head; null otherwise. */
  readonly hold: BeanHold | null;
};

export const GROUP_OF: Readonly<Record<ChangeState, ChangeGroup>> = {
  checking: 'open',
  held: 'open',
  red: 'open',
  conflict: 'open',
  waiting: 'open',
  landed: 'landed',
  validated: 'landed',
  parked: 'parked',
  'fell-off': 'parked',
};

const PUSHED_STATE: Readonly<Record<PushedBean['phase'], ChangeState>> = {
  checking: 'checking',
  red: 'red',
  conflict: 'conflict',
  waiting: 'waiting',
  landed: 'landed',
  green: 'validated',
  parked: 'parked',
  dropped: 'fell-off',
};

/** Every bean, newest activity first. */
export function changesOf(
  events: readonly RaceEvent[],
  pushed: readonly PushedBean[],
  titles: Readonly<Record<string, string>> = {},
): readonly Change[] {
  const clock = wallClock(events);
  const state = reduceRace(events);
  const byBean = new Map(pushed.map((bean) => [bean.bean, bean]));
  const ids = new Set([...pushed.map((bean) => bean.bean), ...Object.keys(state.beans)]);
  const changes = [...ids].map((id) =>
    changeOf({ id, bean: state.beans[id], push: byBean.get(id), title: titles[id], events, clock }),
  );
  return changes.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** `?show=` as a filter; without one, open when anything is, else landed. */
export function shownGroup(value: unknown, changes: readonly Change[]): ChangeFilter {
  if (value === 'open' || value === 'landed' || value === 'parked' || value === 'held')
    return value;
  return inGroup(changes, 'open').length > 0 ? 'open' : 'landed';
}

/** Whether nothing more will happen to a bean in this state (validated, parked, fell off). */
export function isSettledState(state: ChangeState): boolean {
  return state === 'validated' || state === 'parked' || state === 'fell-off';
}

/** The state as a person reads it. */
export function stateText(state: ChangeState): string {
  switch (state) {
    case 'checking':
      return 'in check';
    case 'held':
      return 'held for approval';
    case 'waiting':
      return 'waiting';
    case 'red':
      return 'red';
    case 'conflict':
      return 'conflict';
    case 'landed':
      return 'on the sprout';
    case 'validated':
      return 'on the stalk';
    case 'parked':
      return 'parked';
    case 'fell-off':
      return 'fell off';
    default:
      return assertNever(state);
  }
}

/**
 * The clock "5 minutes ago" is measured against: the page's render time, moved up to the
 * newest activity when live events arrive later (so a bean that just moved reads "just now").
 */
export function latestActivityMs(changes: readonly Change[], renderedAtMs: number): number {
  return changes.reduce((latest, change) => Math.max(latest, change.updatedAt ?? 0), renderedAtMs);
}

/** The changes a filter shows, in the tab's order. */
export function inGroup(changes: readonly Change[], filter: ChangeFilter): readonly Change[] {
  return filter === 'held'
    ? changes.filter((change) => change.state === 'held')
    : changes.filter((change) => change.group === filter);
}

/** How many beans each filter shows. */
export function groupCounts(changes: readonly Change[]): Readonly<Record<ChangeFilter, number>> {
  return {
    open: inGroup(changes, 'open').length,
    held: inGroup(changes, 'held').length,
    landed: inGroup(changes, 'landed').length,
    parked: inGroup(changes, 'parked').length,
  };
}

/** The author as the page names them: `@coop`, or `session a0`. */
export function authorText(author: Author | null): string {
  if (author === null) return 'nobody yet';
  return author.kind === 'person' ? `@${author.handle}` : `session ${author.slot}`;
}

/** Epoch milliseconds of race second `t` (the log's first event pins the clock). */
export type Clock = (t: number) => number;

export function wallClock(events: readonly RaceEvent[]): Clock {
  const first = events[0];
  const zero = first === undefined ? 0 : Date.parse(first.ts) - first.t * 1000;
  return (t) => Math.round((Number.isNaN(zero) ? 0 : zero) + t * 1000);
}

type ChangeInput = {
  readonly id: string;
  readonly bean: Bean | undefined;
  readonly push: PushedBean | undefined;
  readonly title: string | undefined;
  readonly events: readonly RaceEvent[];
  readonly clock: Clock;
};

function changeOf({ id, bean, push, title, events, clock }: ChangeInput): Change {
  const journey = journeyOf(id, events, clock, push?.actor ?? null);
  const hold = push?.hold ?? null;
  const state = push === undefined ? stateOfPhase(bean?.phase ?? 'pending') : pushedStateOf(push);
  const red = latestRed(id, events);
  const isRed =
    state === 'red' || state === 'conflict' || state === 'parked' || state === 'fell-off';
  return {
    bean: id,
    title: push?.title ?? title ?? id,
    author: authorOf(push, bean),
    state,
    group: GROUP_OF[state],
    reason: push?.reason ?? bean?.dropReason ?? '',
    pushes: push?.pushes ?? journey.filter((entry) => entry.tone === 'push').length,
    head: push?.head ?? bean?.head ?? null,
    landedSha: push?.landed_sha ?? bean?.landedSha ?? null,
    failing: isRed ? red.failing : [],
    collided: isRed ? red.culprits : [],
    startedAt: bean?.startedAt === null || bean === undefined ? null : clock(bean.startedAt),
    updatedAt: journey.at(-1)?.at ?? null,
    journey,
    hold,
  };
}

/** A pushed bean's state: `held` while it is open and waits for a person's approval. */
function pushedStateOf(push: PushedBean): ChangeState {
  const state = PUSHED_STATE[push.phase];
  return push.hold?.state === 'held' && GROUP_OF[state] === 'open' ? 'held' : state;
}

function authorOf(push: PushedBean | undefined, bean: Bean | undefined): Author | null {
  if (push !== undefined) return { kind: 'person', handle: push.actor };
  return bean?.agent === null || bean === undefined ? null : { kind: 'session', slot: bean.agent };
}

function stateOfPhase(phase: BeanPhase): ChangeState {
  switch (phase) {
    case 'landed':
      return 'landed';
    case 'green':
      return 'validated';
    case 'parked':
      return 'parked';
    case 'dropped':
      return 'fell-off';
    case 'rework':
      return 'red';
    case 'deciding':
    case 'pending':
      return 'waiting';
    case 'working':
    case 'checking':
    case 'queued':
    case 'testing':
      return 'checking';
    default:
      return assertNever(phase);
  }
}

/** The latest red check's failing tests, and the beans the rework after it blamed. */
function latestRed(
  id: string,
  events: readonly RaceEvent[],
): { readonly failing: readonly string[]; readonly culprits: readonly string[] } {
  let failing: readonly string[] = [];
  let culprits: readonly string[] = [];
  for (const event of events) {
    if (event.type === 'preland.check' && event.task === id && !event.green) {
      failing = event.failing_tests;
      culprits = [];
    }
    if (event.type === 'rework.start' && event.task === id) {
      if ((event.failing ?? []).length > 0) failing = event.failing ?? [];
      culprits = event.culprits ?? [];
    }
  }
  return { failing, culprits };
}

/** The bean's story, one entry per event that concerns it, oldest first. */
export function journeyOf(
  id: string,
  events: readonly RaceEvent[],
  clock: Clock,
  actor: string | null,
): readonly JourneyEntry[] {
  let pushes = 0;
  return events.flatMap((event): JourneyEntry[] => {
    const entry: Entry = (tone, text, extra = {}) => [
      { at: clock(event.t), tone, text, lines: [], beans: [], ...extra },
    ];
    if (event.type === 'task.commit' && event.task === id) {
      pushes += 1;
      const who = actor === null ? '' : ` from @${actor}`;
      return entry('push', `Push ${pushes}${who}: ${event.sha.slice(0, 7)}`);
    }
    return entryOf(id, event, entry, actor);
  });
}

/** What one event (other than a push) adds to bean `id`'s journey. */
function entryOf(id: string, event: RaceEvent, entry: Entry, actor: string | null): JourneyEntry[] {
  if (event.type === 'preland.check' && event.task === id) return checkEntry(event, entry);
  if (event.type === 'preland.recheck' && event.task === id)
    return entry('wait', 'The sprout moved under it, so it was checked again');
  if (event.type === 'merge.conflict' && event.task === id)
    return entry('bad', 'Conflicted with the sprout', { lines: event.files });
  if (event.type === 'rework.start' && event.task === id) return reworkEntry(event, entry, actor);
  if (event.type === 'land' && event.task === id)
    return entry('land', `Landed on the sprout as ${event.sha.slice(0, 7)}`);
  if (event.type === 'green.promote' && event.tasks.some((task) => task === id))
    return entry('stalk', `Validated: on the stalk at ${event.sha.slice(0, 7)}`);
  if (
    event.type === 'decision.request' &&
    [event.task, ...event.against].some((task) => task === id)
  )
    return entry('decide', `Decision ${event.card} asked: which spec stands`, {
      beans: [event.task, ...event.against].filter((bean) => bean !== id),
    });
  if (event.type === 'decision.made' && (event.winner === id || event.loser === id))
    return entry(
      'decide',
      `Decision ${event.card}: ${event.winner} kept over ${event.loser} (${event.oracle})`,
    );
  if (event.type === 'task.parked' && event.task === id)
    return entry('decide', `Parked: ${event.reason}`);
  if (event.type === 'task.drop' && event.task === id)
    return entry('bad', `Fell off: ${event.reason}`);
  return [];
}

type Entry = (tone: JourneyTone, text: string, extra?: Partial<JourneyEntry>) => JourneyEntry[];

function checkEntry(
  event: Extract<RaceEvent, { type: 'preland.check' }>,
  entry: Entry,
): JourneyEntry[] {
  const seconds = `${event.check_seconds.toFixed(1)} s`;
  if (event.green) return entry('good', `Pre-land check green on the merged tree (${seconds})`);
  if (event.inherited === true)
    return entry('wait', 'The sprout itself was red; it waited for the sprout to be repaired');
  const count = event.failing_tests.length;
  return entry(
    'bad',
    `Pre-land check red: ${count} failing ${count === 1 ? 'test' : 'tests'} (${seconds})`,
    {
      lines: event.failing_tests,
    },
  );
}

function reworkEntry(
  event: Extract<RaceEvent, { type: 'rework.start' }>,
  entry: Entry,
  actor: string | null,
): JourneyEntry[] {
  const to = actor === null ? 'its author' : `@${actor}`;
  const culprits = event.culprits ?? [];
  const text =
    culprits.length > 0
      ? `Sent back to ${to}: it collided with ${culprits.length === 1 ? 'a landed bean' : 'landed beans'}`
      : `Sent back to ${to} to fix and push again`;
  return entry('rework', text, { beans: culprits });
}

function assertNever(value: never): never {
  throw new Error(`unexpected bean phase or state ${String(value)}`);
}
