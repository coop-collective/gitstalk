/**
 * A bean's journey in plain sentences (`docs/claude-opus/14` §4.4): each step of its
 * timeline, said the way a reader asks about it, with the step's facts kept.
 */
import type { BeanStep, BeanStepKind } from '../race/race-state';

/** How a journey step is drawn: its mark on the timeline. */
export type JourneyTone =
  | 'plan'
  | 'agent'
  | 'good'
  | 'bad'
  | 'rework'
  | 'land'
  | 'stalk'
  | 'decide'
  /** Held for a person's approval: violet, never the red of a failure. */
  | 'held'
  /** A person approved it. */
  | 'approved';

export type JourneyStep = {
  readonly t: number;
  readonly tone: JourneyTone;
  readonly text: string;
};

export function journeyOf(steps: readonly BeanStep[]): readonly JourneyStep[] {
  return steps.map((step) => ({ t: step.t, tone: toneOf(step.kind), text: sentenceOf(step) }));
}

function sentenceOf(step: BeanStep): string {
  const { detail } = step;
  switch (step.kind) {
    case 'started':
      return `Picked up ${detail}`;
    case 'committed':
      return `Committed ${detail.replace(/^(initial|rework|fixer): /, '')} (${detail.split(':')[0] ?? 'change'})`;
    case 'check-green':
      return 'Pre-land check passed on the merged tree';
    case 'check-red':
      return `Pre-land check red${detail === '' ? '' : `: ${detail}`}`;
    case 'held':
      return `Held for approval: ${detail}; nothing in it needs fixing`;
    case 'approved':
      return `Approved by a person; checking ${detail.replace(/^at /, '')} again`;
    case 'recheck':
      return `The sprout moved under it, so it was checked again (${detail})`;
    case 'optimistic':
      return `Landed without a re-check: ${detail}`;
    case 'conflict':
      return `Conflicted with the sprout in ${shortPaths(detail)}`;
    case 'rework':
      return `Sent back to its author: ${detail}`;
    case 'enqueued':
      return `Joined the merge queue (${detail})`;
    case 'batched':
      return `Tested in batch ${detail}`;
    case 'ejected':
      return `Ejected from the queue: ${detail}`;
    case 'decision':
      return `Decision ${detail}`;
    case 'landed':
      return `Landed ${detail}`;
    case 'green':
      return `Validated: on the stalk (${detail})`;
    case 'reverted':
      return `Reverted (${detail})`;
    case 'dropped':
      return `Fell off: ${detail.replace('--max-rework', 'the maximum')}`;
    case 'parked':
      return `Parked: ${detail.replace(/^needs a person: /, 'needs a person, ')}`;
    case 'tests-first':
      return `Tests written first (${detail})`;
    case 'reconcile':
      return `The test author compared specs: ${detail}`;
    case 'rescue':
      return `Rescued: re-executed on the sprout head (${detail})`;
    case 'requeued':
      return `Taken off a red sprout by a reset, to be checked and landed again (${detail})`;
    case 'culprits':
      return `Searched for what breaks its tests: ${detail}`;
    case 'synced':
      return `Caught up with the sprout: ${detail}`;
    case 'window':
      return `Waited for room on the sprout (${detail})`;
    default:
      return assertNever(step.kind);
  }
}

function toneOf(kind: BeanStepKind): JourneyTone {
  switch (kind) {
    case 'started':
    case 'committed':
      return 'agent';
    case 'check-green':
      return 'good';
    case 'check-red':
    case 'conflict':
    case 'ejected':
    case 'reverted':
    case 'dropped':
      return 'bad';
    case 'rework':
      return 'rework';
    case 'held':
      return 'held';
    case 'approved':
      return 'approved';
    case 'landed':
      return 'land';
    case 'green':
      return 'stalk';
    case 'decision':
    case 'reconcile':
    case 'parked':
      return 'decide';
    case 'rescue':
    case 'culprits':
    case 'requeued':
      return 'rework';
    case 'tests-first':
    case 'synced':
    case 'window':
    case 'recheck':
    case 'optimistic':
    case 'enqueued':
    case 'batched':
      return 'plan';
    default:
      return assertNever(kind);
  }
}

function shortPaths(detail: string): string {
  return detail
    .split(', ')
    .map((path) => path.split('/').at(-1) ?? path)
    .join(', ');
}

function assertNever(value: never): never {
  throw new Error(`unexpected step ${String(value)}`);
}
