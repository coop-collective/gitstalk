import { describe, expect, it } from 'vitest';

import { changesOf } from './changes';
import type { JourneyInput } from './journey';
import { journeyOf, wallClock } from './journey';
import {
  APPROVAL,
  BEAN,
  FIRST,
  SECOND,
  approvedEvents,
  heldAgainEvents,
  heldEvents,
  pushedLogin,
} from './testing/held-bean';
import { GREETER_EVENTS, GREETER_PUSHED } from './testing/greeter';

function journey(events: JourneyInput['events'], approvals: JourneyInput['approvals'] = []) {
  return journeyOf({ id: BEAN, events, clock: wallClock(events), actor: 'erin', approvals });
}

describe('a held bean’s journey', () => {
  it('reads as held for approval, with the classes and who decided, never as red or sent back', () => {
    const steps = journey(heldEvents());
    expect(steps.map((step) => step.tone)).toEqual(['push', 'held']);
    expect(steps[1]).toMatchObject({
      text: 'Held for approval: class auth, decided by the policy. Nothing in it needs fixing',
      lines: ['classes: auth, tests-only'],
    });
    expect(steps.map((step) => step.text).join('\n')).not.toMatch(/red|Sent back|failing/u);
  });

  it('names who approved, when and their note, then checks the same head again', () => {
    const steps = journey(approvedEvents(), [APPROVAL]);
    expect(steps.map((step) => [step.tone, step.text])).toEqual([
      ['push', `Push 1 from @erin: ${FIRST.slice(0, 7)}`],
      ['held', 'Held for approval: class auth, decided by the policy. Nothing in it needs fixing'],
      ['approved', 'Approved by @dana on the web'],
      ['wait', `Checking ${FIRST.slice(0, 7)} again`],
      ['good', 'Pre-land check green on the merged tree (4.2 s)'],
      ['land', 'Landed on the sprout as ddddddd'],
      ['stalk', 'Validated: on the stalk at ddddddd'],
    ]);
    expect(steps[2]).toMatchObject({
      at: Date.parse(APPROVAL.at),
      lines: ['Read the session change.'],
    });
  });

  it('says a person approved it when the approval record is not there', () => {
    const steps = journey(approvedEvents());
    expect(steps[2]).toMatchObject({ tone: 'approved', text: 'Approved by a person', lines: [] });
  });

  it('shows a push while held as a new revision, held again', () => {
    const steps = journey(heldAgainEvents());
    expect(steps.map((step) => [step.tone, step.text])).toEqual([
      ['push', `Push 1 from @erin: ${FIRST.slice(0, 7)}`],
      ['held', 'Held for approval: class auth, decided by the policy. Nothing in it needs fixing'],
      ['push', `Push 2 from @erin: ${SECOND.slice(0, 7)}: a new revision, judged again`],
      [
        'held',
        'Held for approval again: class auth, decided by the policy. Nothing in it needs fixing',
      ],
    ]);
  });

  it('keeps an ordinary red as red, sent back to its author', () => {
    const shout = changesOf(GREETER_EVENTS, GREETER_PUSHED).find(
      (change) => change.bean === 'shout',
    );
    expect(shout?.journey.map((step) => [step.tone, step.text])).toEqual([
      ['push', 'Push 1 from @coop: a8c8ab7'],
      ['bad', 'Pre-land check red: 1 failing test (1.5 s)'],
      ['rework', 'Sent back to @coop to fix and push again'],
    ]);
  });
});

describe('a held bean in the Changes model', () => {
  it('is held, with no failing tests and no rework, even when the gateway sends no hold', () => {
    const [login] = changesOf(heldEvents(), [pushedLogin({})]);
    expect(login).toMatchObject({ state: 'held', group: 'open', failing: [], collided: [] });
  });

  it('counts the approval’s re-submission as no push', () => {
    const [login] = changesOf(approvedEvents(), [
      pushedLogin({ pushes: 2, phase: 'green', approvals: [APPROVAL] }),
    ]);
    expect(login).toMatchObject({ state: 'validated', pushes: 1, failing: [] });
  });

  it('counts a new revision while held as a push', () => {
    const [login] = changesOf(heldAgainEvents(), [pushedLogin({ pushes: 2, head: SECOND })]);
    expect(login).toMatchObject({ state: 'held', pushes: 2 });
  });
});
