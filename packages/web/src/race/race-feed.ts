/**
 * The event feed: each race event as one plain sentence with a tone. Routine events
 * (invocations, footprints) stay out; landings, reds, promotions and decisions are major.
 */
import type { TaskId } from '@gitstalk/shared-race/ids';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import { plural } from './race-format';

export type FeedTone = 'good' | 'bad' | 'warn' | 'human' | 'neutral';

export type FeedLine = {
  readonly seq: number;
  readonly t: number;
  readonly tone: FeedTone;
  readonly text: string;
  readonly bean: TaskId | null;
  /** Worth announcing to a screen reader as it happens. */
  readonly major: boolean;
};

type Draft = Omit<FeedLine, 'seq' | 't'>;

/** The newest `limit` lines, newest first. */
export function recentFeed(events: readonly RaceEvent[], limit: number): readonly FeedLine[] {
  const lines: FeedLine[] = [];
  for (let index = events.length - 1; index >= 0 && lines.length < limit; index -= 1) {
    const event = events[index];
    const described = event === undefined ? undefined : feedLine(event);
    if (described !== undefined) lines.push(described);
  }
  return lines;
}

export function feedLine(event: RaceEvent): FeedLine | undefined {
  const draft = describe(event);
  return draft === undefined ? undefined : { seq: event.seq, t: event.t, ...draft };
}

function line(tone: FeedTone, text: string, bean: TaskId | null): Draft {
  return { tone, text, bean, major: false };
}

/** A line worth announcing as it happens. */
function majorLine(tone: FeedTone, text: string, bean: TaskId | null): Draft {
  return { tone, text, bean, major: true };
}

function describe(event: RaceEvent): Draft | undefined {
  switch (event.type) {
    case 'race.start':
      return majorLine(
        'neutral',
        `The race starts: ${event.agents} agents, ${plural(event.tasks.length, 'bean')}.`,
        null,
      );
    case 'task.start':
      return majorLine('neutral', `${event.agent} picks up ${event.task}.`, event.task);
    case 'task.commit':
      return line(
        'neutral',
        `${event.task} committed (${plural(event.files.length, 'file')}).`,
        event.task,
      );
    case 'preland.check':
      return event.green
        ? line(
            'good',
            `${event.task} passed its pre-land check on the exact merged tree.`,
            event.task,
          )
        : line(
            'bad',
            `${event.task} pre-land check red: ${plural(event.failing_tests.length, 'failing test')}.`,
            event.task,
          );
    case 'preland.recheck':
      return line(
        'warn',
        `${event.task} re-checks: the sprout moved under a shared file.`,
        event.task,
      );
    case 'preland.optimistic':
      return line(
        'neutral',
        `${event.task} lands without a re-check (${event.landed_meanwhile} landed meanwhile, no shared file).`,
        event.task,
      );
    case 'merge.conflict':
      return line(
        'bad',
        `${event.task ?? 'A repair'} conflicts in ${event.files.join(', ')}.`,
        event.task,
      );
    case 'rework.start':
      return describeRework(event);
    case 'land':
      return describeLanding(event);
    case 'green.promote':
      return line(
        'good',
        `The stalk advances${event.trunk_idx === undefined ? '' : ` to #${event.trunk_idx}`}: ${event.tasks.join(', ')}.`,
        event.tasks[0] ?? null,
      );
    case 'green.demote':
      return describeDemotion(event);
    case 'ci.end':
      return describeCi(event);
    case 'ticket.open':
      return majorLine('bad', `Repair ${event.ticket}: sprout #${event.red_idx} is red.`, null);
    case 'ticket.culprit':
      return majorLine(
        'bad',
        `${event.ticket} blames ${event.task ?? 'a repair'} (#${event.trunk_idx}).`,
        event.task,
      );
    case 'revert':
      return line(
        'warn',
        `${event.task ?? 'A commit'} is reverted from the sprout (revert-first).`,
        event.task,
      );
    case 'sprout.reset':
      return majorLine(
        'warn',
        `${event.ticket}: the sprout is reset to the stalk (#${event.green_idx}); ` +
          `${event.requeued.length} beans go back through their checks.`,
        null,
      );
    case 'revert.conflict':
      return majorLine(
        'warn',
        `Reverting ${event.task ?? 'the culprit'} conflicted; it stays and the line moves on.`,
        event.task,
      );
    case 'decision.request':
      return line(
        'human',
        event.trigger === 'start'
          ? `Start card ${event.card}: ${event.task} would undo ${event.against.join(', ')}. A person decides before it starts.`
          : `Decision ${event.card}: ${event.task} and ${event.against.join(', ')} disagree. A person decides.`,
        event.task,
      );
    case 'decision.reconcile':
      return line(
        event.outcome === 'reconciled' ? 'good' : 'human',
        event.outcome === 'reconciled'
          ? `The test author reconciles ${event.task}'s tests with ${event.against}.`
          : `The test author finds ${event.task} contradicts ${(event.parties ?? [event.against]).join(', ')}.`,
        event.task,
      );
    case 'rescue.start':
      return majorLine(
        'warn',
        `${event.task} is rescued: re-executed once on the sprout head (${event.why}).`,
        event.task,
      );
    case 'culprit.dynamic':
      return line(
        'warn',
        `${event.task}: leaving out ${plural(event.candidates.length, 'landed bean')} one at a time${event.confirmed.length > 0 ? ` blames ${event.confirmed.join(', ')}` : ' blames none alone'}.`,
        event.task,
      );
    case 'tests.first':
      return line('neutral', `${event.task}: tests written first (${event.status}).`, event.task);
    case 'sync.applied':
    case 'sync.midrun.applied':
      return line(
        'neutral',
        `${event.task} catches up: ${event.landed.join(', ')} merged in.`,
        event.task,
      );
    case 'window.resize':
      return line(
        event.reason === 'red' ? 'warn' : 'neutral',
        `The sprout window ${event.window > event.previous ? 'grows' : 'shrinks'} to ${event.window}.`,
        null,
      );
    case 'decision.made':
      return majorLine('human', decisionWords(event), event.winner);
    case 'spec.amended':
      return line(
        'human',
        `${event.card}: the test author ${amendmentWords(event.status)} ${event.task}'s tests${event.paths.length > 0 ? ` (${event.paths.join(', ')})` : ''}.`,
        event.task,
      );
    case 'flake.suspected':
      return line(
        'warn',
        `Sprout #${event.trunk_idx}: the red did not repeat; ${event.flaky.join(', ')} is flaky, no revert.`,
        null,
      );
    case 'task.drop':
      return majorLine('neutral', `${event.task} dropped: ${event.reason}.`, event.task);
    case 'task.parked':
      return majorLine('warn', `${event.task} is parked: ${event.reason}.`, event.task);
    case 'queue.enqueue':
      return majorLine(
        'neutral',
        `${event.task} joins the queue (depth ${event.depth}).`,
        event.task,
      );
    case 'queue.eject':
      return line('bad', `${event.task} is ejected from the queue (${event.reason}).`, event.task);
    case 'batch.start':
      return line(
        'neutral',
        `Batch ${event.batch} tests ${event.tasks.join(', ')}${event.speculative ? ', speculatively' : ''}.`,
        null,
      );
    case 'batch.red':
      return line('bad', `Batch ${event.batch} is red; bisecting ${event.tasks.join(', ')}.`, null);
    case 'batch.cancel':
      return majorLine(
        'warn',
        `Batch ${event.batch} is cancelled: it was built on a red batch.`,
        null,
      );
    case 'bisect.end':
      return line(
        'bad',
        `Bisection blames ${event.culprit}; ${event.landed.length > 0 ? `${event.landed.join(', ')} land` : 'nothing lands'}.`,
        event.culprit,
      );
    case 'race.setup':
    case 'footprint.predicted':
    case 'invocation.start':
    case 'invocation.end':
    case 'acceptance.restored':
    case 'ci.start':
    case 'queue.hold':
    case 'bisect.start':
    case 'ticket.close':
    case 'ticket.escalate':
    case 'ticket.stuck':
    case 'abort':
    case 'sync.noted':
    case 'sync.midrun.offered':
    case 'sync.midrun.noted':
    case 'window.wait':
    case 'bean.requeued':
      return undefined;
    case 'race.end':
      return majorLine(
        'neutral',
        event.aborted === null ? 'The race is over.' : `The race stopped: ${event.aborted}.`,
        null,
      );
    case 'final.check':
      return event.correct === true
        ? majorLine(
            'good',
            `Final check: the stalk is correct, ${event.tasks_accepted ?? '?'} of ${event.tasks_total ?? '?'} beans accepted.`,
            null,
          )
        : majorLine('bad', 'Final check: the stalk is not correct.', null);
    default:
      return assertNever(event);
  }
}

function describeDemotion(event: Extract<RaceEvent, { type: 'green.demote' }>): Draft {
  const to = event.trunk_idx === undefined ? '' : ` to #${event.trunk_idx}`;
  const again = event.tasks.length === 0 ? '' : `: ${event.tasks.join(', ')} land again`;
  return line('bad', `A red audit takes the stalk back${to}${again}.`, event.tasks[0] ?? null);
}

function assertNever(value: never): never {
  throw new Error(`unexpected event ${JSON.stringify(value)}`);
}

function decisionWords(event: Extract<RaceEvent, { type: 'decision.made' }>): string {
  const by = event.oracle.startsWith('human:') ? ` by ${event.oracle.slice('human:'.length)}` : '';
  const what =
    event.outcome === 'adopt-in-place'
      ? `adopt ${event.winner} and amend ${event.loser}`
      : `keep ${event.winner}, ${loserFate(event.outcome)} ${event.loser}`;
  return `${event.card} decided${by}: ${what}.${event.text === undefined ? '' : ` "${event.text}"`}`;
}

function loserFate(outcome: string | undefined): string {
  return outcome === 'keep-landed' ? 're-execute' : 'decline';
}

function amendmentWords(status: string): string {
  if (status === 'amended') return 'amended';
  if (status === 'rejected') return 'could not amend';
  if (status === 'rolled-back') return 'rolled back the amendment of';
  return 'left unchanged';
}

function describeRework(event: Extract<RaceEvent, { type: 'rework.start' }>): Draft | undefined {
  if (event.task === null) return undefined;
  const culprits = event.culprits ?? [];
  const why = event.reason === 'conflict' ? 'a merge conflict' : 'red tests';
  const informed = culprits.length > 0 ? `, informed by ${culprits.join(', ')}` : '';
  return majorLine('warn', `${event.task} goes back to its author: ${why}${informed}.`, event.task);
}

function describeLanding(event: Extract<RaceEvent, { type: 'land' }>): Draft {
  if (event.target === 'main')
    return line('good', `${event.task ?? 'A batch'} lands on the stalk.`, event.task);
  const structural = event.resolved === 'structural' ? ', after a structural merge' : '';
  return majorLine(
    'good',
    `${event.task ?? 'A repair'} lands on the sprout as #${event.trunk_idx ?? '?'}${structural}.`,
    event.task,
  );
}

function describeCi(event: Extract<RaceEvent, { type: 'ci.end' }>): Draft | undefined {
  if (event.purpose !== 'validate' || event.green === null) return undefined;
  const subject = event.trunk_idx === undefined ? 'The sprout' : `Sprout #${event.trunk_idx}`;
  return event.green
    ? majorLine('good', `${subject} validates green.`, null)
    : line('bad', `${subject} validates red: ${(event.failing_files ?? []).join(', ')}.`, null);
}
