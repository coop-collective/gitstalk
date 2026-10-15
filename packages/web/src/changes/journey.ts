/**
 * A bean's journey on its page: one entry per event that concerns it (pushes, checks, verdicts
 * with failing tests and the beans it collided with, landing, validation, decisions), oldest
 * first. A hold of the approval rules (`preland.check.held`) reads as held for a person, never
 * as a red sent back to its author; a person's approval of the held revision, and the check it
 * starts again, read as such (`docs/claude-opus/32-approval-rules.md` §5). Pure and
 * client-safe: it imports types only.
 */
import type { RevisionApproval } from '@gitstalk/shared-race/bean-approval';
import type { CheckHold, RaceEvent } from '@gitstalk/shared-ask/race/race-events';

export type JourneyTone =
  | 'push'
  | 'good'
  | 'bad'
  | 'rework'
  | 'land'
  | 'stalk'
  | 'decide'
  | 'wait'
  /** Held for a person's approval: violet, the held panel's mark. */
  | 'held'
  /** A person approved the held revision. */
  | 'approved';

export type JourneyEntry = {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly tone: JourneyTone;
  readonly text: string;
  /** Failing tests, conflicted files, a hold's classes or an approval's note, one per line. */
  readonly lines: readonly string[];
  /** Beans it collided with, linked. */
  readonly beans: readonly string[];
};

/** Epoch milliseconds of race second `t` (the log's first event pins the clock). */
export type Clock = (t: number) => number;

export type JourneyInput = {
  readonly id: string;
  readonly events: readonly RaceEvent[];
  readonly clock: Clock;
  /** Who pushed it (null: an engine session's bean). */
  readonly actor: string | null;
  /** The approvals people gave its revisions (`PushedBean.approvals`). */
  readonly approvals: readonly RevisionApproval[];
};

export function wallClock(events: readonly RaceEvent[]): Clock {
  const first = events[0];
  const zero = first === undefined ? 0 : Date.parse(first.ts) - first.t * 1000;
  return (t) => Math.round((Number.isNaN(zero) ? 0 : zero) + t * 1000);
}

/** The bean's story, one entry per event that concerns it, oldest first. */
export function journeyOf(input: JourneyInput): readonly JourneyEntry[] {
  const entries: JourneyEntry[] = [];
  let walk: Walk = { pushes: 0, head: null, hold: 'none' };
  for (const event of input.events) {
    entries.push(...entriesOf(input, walk, event));
    walk = advance(walk, input.id, event);
  }
  return entries;
}

/** How many of the bean's commits were an approval's re-submission rather than a push. */
export function resubmissionsOf(input: Pick<JourneyInput, 'id' | 'events'>): number {
  let walk: Walk = { pushes: 0, head: null, hold: 'none' };
  let count = 0;
  for (const event of input.events) {
    if (event.type === 'task.commit' && event.task === input.id)
      count += isApprovalResubmission(walk, event.sha) ? 1 : 0;
    walk = advance(walk, input.id, event);
  }
  return count;
}

/**
 * Where the walk through the log stands before an event: pushes so far, the bean's head, and
 * whether its latest check was a hold (`held`), or a hold came before (`was-held`: the next
 * one is "again").
 */
type Walk = {
  readonly pushes: number;
  readonly head: string | null;
  readonly hold: 'none' | 'held' | 'was-held';
};

type Entry = (tone: JourneyTone, text: string, extra?: Partial<JourneyEntry>) => JourneyEntry[];

function entriesOf(input: JourneyInput, walk: Walk, event: RaceEvent): JourneyEntry[] {
  const { id } = input;
  const entry: Entry = (tone, text, extra = {}) => [
    { at: input.clock(event.t), tone, text, lines: [], beans: [], ...extra },
  ];
  if (event.type === 'task.commit' && event.task === id)
    return commitEntries({ input, walk, sha: event.sha }, entry);
  if (event.type === 'preland.check' && event.task === id) return checkEntry(event, entry, walk);
  if (event.type === 'rework.start' && event.task === id)
    return walk.hold === 'held' ? [] : reworkEntry(event, entry, input.actor);
  return otherEntry(id, event, entry);
}

/** The walk after the event. */
function advance(walk: Walk, id: string, event: RaceEvent): Walk {
  if (event.type === 'task.commit' && event.task === id)
    return {
      pushes: isApprovalResubmission(walk, event.sha) ? walk.pushes : walk.pushes + 1,
      head: event.sha,
      hold: walk.hold === 'held' ? 'was-held' : walk.hold,
    };
  if (event.type === 'preland.check' && event.task === id && event.held !== undefined)
    return { ...walk, hold: 'held' };
  return walk;
}

/**
 * A held bean's same head committed again is its approval's re-submission (the engine checks
 * the approved revision again), not a push.
 */
function isApprovalResubmission(walk: Walk, sha: string): boolean {
  return walk.hold === 'held' && walk.head === sha;
}

function commitEntries(
  commit: { readonly input: JourneyInput; readonly walk: Walk; readonly sha: string },
  entry: Entry,
): JourneyEntry[] {
  const { input, walk, sha } = commit;
  const short = sha.slice(0, 7);
  if (isApprovalResubmission(walk, sha))
    return [
      ...approvalEntry(input.approvals, sha, entry),
      ...entry('wait', `Checking ${short} again`),
    ];
  const who = input.actor === null ? '' : ` from @${input.actor}`;
  const revised = walk.hold === 'held' ? ': a new revision, judged again' : '';
  return entry('push', `Push ${walk.pushes + 1}${who}: ${short}${revised}`);
}

/** Who approved the revision, when and with what note; "a person" when the record is missing. */
function approvalEntry(
  approvals: readonly RevisionApproval[],
  sha: string,
  entry: Entry,
): JourneyEntry[] {
  const approval = approvals.findLast((given) => given.revision === sha);
  if (approval === undefined) return entry('approved', 'Approved by a person');
  const at = Date.parse(approval.at);
  const via = approval.client === 'web' ? 'on the web' : `through ${approval.client}`;
  return entry('approved', `Approved by @${approval.by} ${via}`, {
    ...(Number.isNaN(at) ? {} : { at }),
    lines: approval.note === null ? [] : [approval.note],
  });
}

function checkEntry(
  event: Extract<RaceEvent, { type: 'preland.check' }>,
  entry: Entry,
  walk: Walk,
): JourneyEntry[] {
  if (event.held !== undefined) return heldEntry(event.held, entry, walk.hold);
  const seconds = `${event.check_seconds.toFixed(1)} s`;
  if (event.green) return entry('good', `Pre-land check green on the merged tree (${seconds})`);
  if (event.inherited === true)
    return entry('wait', 'The sprout itself was red; it waited for the sprout to be repaired');
  const count = event.failing_tests.length;
  return entry(
    'bad',
    `Pre-land check red: ${count} failing ${count === 1 ? 'test' : 'tests'} (${seconds})`,
    { lines: event.failing_tests },
  );
}

function heldEntry(held: CheckHold, entry: Entry, hold: Walk['hold']): JourneyEntry[] {
  const again = hold === 'none' ? '' : ' again';
  const rule = held.class === null ? 'its classes' : `class ${held.class}`;
  return entry(
    'held',
    `Held for approval${again}: ${rule}, decided by ${DECIDERS[held.by]}. Nothing in it needs fixing`,
    { lines: held.classes.length === 0 ? [] : [`classes: ${held.classes.join(', ')}`] },
  );
}

const DECIDERS: Readonly<Record<CheckHold['by'], string>> = {
  policy: 'the policy',
  clef: 'Clef',
  rules: 'the triage rule',
};

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

/** What any other event adds to bean `id`'s journey. */
function otherEntry(id: string, event: RaceEvent, entry: Entry): JourneyEntry[] {
  if (event.type === 'preland.recheck' && event.task === id)
    return entry('wait', 'The sprout moved under it, so it was checked again');
  if (event.type === 'merge.conflict' && event.task === id)
    return entry('bad', 'Conflicted with the sprout', { lines: event.files });
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
