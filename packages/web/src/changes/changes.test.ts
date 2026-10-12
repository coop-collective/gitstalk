import { describe, expect, it } from 'vitest';

import { parseRaceEvents } from '@gitstalk/shared-ask/race/race-events';
import {
  authorText,
  changesOf,
  groupCounts,
  inGroup,
  isSettledState,
  latestActivityMs,
  shownGroup,
  stateText,
} from './changes';
import { GREETER_EVENTS, GREETER_PUSHED } from './testing/greeter';

describe('the Changes tab of a real repository', () => {
  const changes = changesOf(GREETER_EVENTS, GREETER_PUSHED);

  it('sorts beans into open, landed and parked, newest activity first', () => {
    expect(groupCounts(changes)).toEqual({ open: 1, landed: 2, parked: 0 });
    expect(inGroup(changes, 'landed').map((change) => change.bean)).toEqual([
      'slugify',
      'add-truncate',
    ]);
  });

  it('names the person who pushed each bean, never the engine slot', () => {
    expect(changes.map((change) => authorText(change.author))).toEqual(['@coop', '@coop', '@coop']);
  });

  it('keeps the red bean open with the test that failed on the merged tree', () => {
    const [red] = inGroup(changes, 'open');
    expect(red).toMatchObject({
      bean: 'shout',
      state: 'red',
      title: 'Shout greetings in capitals',
      failing: ['test/shout.test.ts > shout adds an exclamation mark'],
      collided: [],
    });
    expect(red?.journey.map((entry) => entry.tone)).toEqual(['push', 'bad', 'rework']);
    expect(red?.journey[1]?.lines).toEqual(['test/shout.test.ts > shout adds an exclamation mark']);
    expect(red?.journey[2]?.text).toBe('Sent back to @coop to fix and push again');
  });

  it('tells a landed bean’s journey from push to the stalk, with wall-clock times', () => {
    const truncate = changes.find((change) => change.bean === 'add-truncate');
    expect(truncate?.journey.map((entry) => entry.text)).toEqual([
      'Push 1 from @coop: b99e3e0',
      'Pre-land check green on the merged tree (4.9 s)',
      'Landed on the sprout as 941e146',
      'Validated: on the stalk at 941e146',
    ]);
    expect(new Date(truncate?.journey[0]?.at ?? 0).toISOString()).toBe('2026-10-07T13:40:35.349Z');
    expect(truncate).toMatchObject({ state: 'validated', group: 'landed', failing: [] });
  });

  it('names a race bean by its session slot when nobody pushed it, and blames its culprit', () => {
    const ts = '2026-10-07T10:00:00.000+00:00';
    const { events } = parseRaceEvents([
      { seq: 1, t: 0, ts, type: 'task.start', task: 't001', agent: 'a3', base: 'a'.repeat(40) },
      {
        seq: 2,
        t: 5,
        ts,
        type: 'preland.check',
        task: 't001',
        green: false,
        failing_tests: ['x'],
        check_seconds: 2,
      },
      {
        seq: 3,
        t: 5,
        ts,
        type: 'rework.start',
        task: 't001',
        reason: 'preland-red',
        attempt: 1,
        culprits: ['t000'],
      },
    ]);
    const [change] = changesOf(events, [], { t001: 'Coupons cap' });
    expect(change).toMatchObject({ title: 'Coupons cap', state: 'red', collided: ['t000'] });
    expect(authorText(change?.author ?? null)).toBe('session a3');
    expect(change?.journey.at(-1)).toMatchObject({ tone: 'rework', beans: ['t000'] });
  });
});

describe('how the Changes tab shows its lists', () => {
  const changes = changesOf(GREETER_EVENTS, GREETER_PUSHED);

  it('shows the group asked for, else open beans when there are any, else landed ones', () => {
    expect(shownGroup('parked', changes)).toBe('parked');
    expect(shownGroup(null, changes)).toBe('open');
    expect(shownGroup('everything', inGroup(changes, 'landed'))).toBe('landed');
  });

  it('reads each state as a person would say it', () => {
    expect(changes.map((change) => stateText(change.state)).toSorted()).toEqual([
      'on the stalk',
      'on the stalk',
      'red',
    ]);
    expect(stateText('fell-off')).toBe('fell off');
  });

  it('settles a bean once it is validated, parked or fell off', () => {
    expect([
      isSettledState('validated'),
      isSettledState('parked'),
      isSettledState('fell-off'),
    ]).toEqual([true, true, true]);
    expect([isSettledState('checking'), isSettledState('red'), isSettledState('landed')]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('measures "ago" from the newest activity when it is later than the render', () => {
    const newest = Math.max(...changes.map((change) => change.updatedAt ?? 0));
    expect(latestActivityMs(changes, 0)).toBe(newest);
    expect(latestActivityMs(changes, newest + 1000)).toBe(newest + 1000);
    expect(latestActivityMs([], 5)).toBe(5);
  });
});
