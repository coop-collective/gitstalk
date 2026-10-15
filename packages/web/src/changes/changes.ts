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

import type { Clock, JourneyEntry } from './journey';
import { journeyOf, resubmissionsOf, wallClock } from './journey';
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

type ChangeInput = {
  readonly id: string;
  readonly bean: Bean | undefined;
  readonly push: PushedBean | undefined;
  readonly title: string | undefined;
  readonly events: readonly RaceEvent[];
  readonly clock: Clock;
};

function changeOf({ id, bean, push, title, events, clock }: ChangeInput): Change {
  const journey = journeyOf({
    id,
    events,
    clock,
    actor: push?.actor ?? null,
    approvals: push?.approvals ?? [],
  });
  const hold = push?.hold ?? null;
  const enginePhase = bean?.phase ?? 'pending';
  const state = push === undefined ? stateOfPhase(enginePhase) : pushedStateOf(push, enginePhase);
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
    pushes:
      push === undefined
        ? journey.filter((entry) => entry.tone === 'push').length
        : push.pushes - resubmissionsOf({ id, events }),
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

/**
 * A pushed bean's state: `held` while it is open and waits for a person's approval, by its hold
 * or, when the gateway sends none, by the engine's phase (its latest check was a hold).
 */
function pushedStateOf(push: PushedBean, enginePhase: BeanPhase): ChangeState {
  const state = PUSHED_STATE[push.phase];
  const isHeld =
    push.hold === null ? enginePhase === 'held' && state === 'red' : push.hold.state === 'held';
  return isHeld && GROUP_OF[state] === 'open' ? 'held' : state;
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
    case 'held':
      return 'held';
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

/**
 * The latest red check's failing tests, and the beans the rework after it blamed. A hold of the
 * approval rules is not a red: nothing in it failed.
 */
function latestRed(
  id: string,
  events: readonly RaceEvent[],
): { readonly failing: readonly string[]; readonly culprits: readonly string[] } {
  let failing: readonly string[] = [];
  let culprits: readonly string[] = [];
  let isHeld = false;
  for (const event of events) {
    if (event.type === 'preland.check' && event.task === id) isHeld = event.held !== undefined;
    if (event.type === 'preland.check' && event.task === id && !event.green && !isHeld) {
      failing = event.failing_tests;
      culprits = [];
    }
    if (event.type === 'rework.start' && event.task === id && !isHeld) {
      if ((event.failing ?? []).length > 0) failing = event.failing ?? [];
      culprits = event.culprits ?? [];
    }
  }
  return { failing, culprits };
}

function assertNever(value: never): never {
  throw new Error(`unexpected bean phase or state ${String(value)}`);
}
