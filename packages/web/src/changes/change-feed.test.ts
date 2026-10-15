import { describe, expect, it } from 'vitest';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import { parseRaceEvents } from '@gitstalk/shared-ask/race/race-events';
import { appendBySeq } from '../query/append-by-seq';
import {
  beanDiffPath,
  changeFeedPaths,
  changesBeanDiff,
  eventsAfter,
  hasStandingLanding,
  isEventsAnswer,
  isPushedAnswer,
  isRepoDiff,
  movesPushedBeans,
  parseEventBatch,
} from './change-feed';
import { changesOf, inGroup } from './changes';
import { GREETER_EVENTS, GREETER_PUSHED } from './testing/greeter';

const ofType = (type: string) => GREETER_EVENTS.filter((event) => event.type === type);
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('the Changes tab’s client data', () => {
  it('names the routes and the feed of a repository', () => {
    expect(changeFeedPaths('/coop/greeter')).toEqual({
      events: '/api/repos/coop/greeter/events',
      pushed: '/api/repos/coop/greeter/pushed',
      live: '/api/repos/coop/greeter/live',
    });
    expect(beanDiffPath('greeter01', 'add truncate')).toBe(
      '/api/runs/greeter01/beans/add%20truncate/diff',
    );
  });

  it('accepts the routes’ answers as they arrive over the wire', () => {
    expect(isEventsAnswer(roundTrip({ events: GREETER_EVENTS }))).toBe(true);
    expect(isPushedAnswer(roundTrip({ pushed: GREETER_PUSHED }))).toBe(true);
    expect(isRepoDiff({ files: [] })).toBe(true);
  });

  it('rejects answers of another shape', () => {
    expect(isEventsAnswer({ events: [{ type: 'land' }] })).toBe(false);
    expect(isEventsAnswer(GREETER_EVENTS)).toBe(false);
    expect(isPushedAnswer({ pushed: [{ bean: 'x' }] })).toBe(false);
    expect(isPushedAnswer(null)).toBe(false);
    expect(isRepoDiff({ error: { message: 'no' } })).toBe(false);
  });

  it('reads a feed batch, and nothing from a message that is not one', () => {
    expect(parseEventBatch(roundTrip(GREETER_EVENTS.slice(0, 2)))).toHaveLength(2);
    expect(parseEventBatch({ reason: 'the run is done' })).toBeNull();
    expect(parseEventBatch(null)).toBeNull();
  });

  it('marks the pushed beans stale on a push or a landing, not on agent chatter', () => {
    expect(movesPushedBeans(ofType('task.commit'))).toBe(true);
    expect(movesPushedBeans(ofType('land'))).toBe(true);
    expect(movesPushedBeans(ofType('preland.check'))).toBe(true);
    expect(movesPushedBeans(ofType('invocation.start'))).toBe(false);
    expect(movesPushedBeans([])).toBe(false);
  });

  it('marks a bean’s diff stale on its own push or landing only', () => {
    const landing = ofType('land');
    const landed = landing[0]?.type === 'land' ? (landing[0].task ?? '') : '';
    expect(landed).not.toBe('');
    expect(changesBeanDiff(landing, landed)).toBe(true);
    expect(changesBeanDiff(landing, 'someone-else')).toBe(false);
    expect(changesBeanDiff(ofType('preland.check'), landed)).toBe(false);
  });

  it('cuts the events after a seq', () => {
    const third = GREETER_EVENTS[2]?.seq ?? 0;
    expect(eventsAfter(GREETER_EVENTS, third)).toEqual(GREETER_EVENTS.slice(3));
    expect(eventsAfter(GREETER_EVENTS, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(eventsAfter(GREETER_EVENTS, -1)).toEqual(GREETER_EVENTS);
  });

  it('derives the same rows from a snapshot grown by feed batches as from the whole log', () => {
    const cut = Math.floor(GREETER_EVENTS.length / 2);
    const snapshot = GREETER_EVENTS.slice(0, cut);
    const grown = [GREETER_EVENTS.slice(cut, cut + 3), GREETER_EVENTS.slice(cut + 3)].reduce<
      readonly RaceEvent[]
    >((held, batch) => appendBySeq(held, batch).events, snapshot);
    expect(changesOf(grown, GREETER_PUSHED)).toEqual(changesOf(GREETER_EVENTS, GREETER_PUSHED));
    expect(inGroup(changesOf(snapshot, []), 'landed').length).toBeLessThanOrEqual(
      inGroup(changesOf(grown, []), 'landed').length,
    );
  });
});

describe('whether a bean’s landing stands', () => {
  let seq = 0;
  const parsed = (...raw: Record<string, unknown>[]): readonly RaceEvent[] => {
    const result = parseRaceEvents(
      raw.map((fields) => {
        seq += 1;
        return { seq, t: seq, ts: '2026-10-14T00:00:00Z', ...fields };
      }),
    );
    expect(result.events).toHaveLength(raw.length);
    return result.events;
  };
  const SHA = 'a'.repeat(40);
  const land = { type: 'land', task: 'fix', sha: SHA, target: 'trunk', files: ['a.ts'] };
  const requeued = { type: 'bean.requeued', task: 'fix', ticket: 'T1', trunk_idx: 2 };
  const reset = {
    type: 'sprout.reset',
    ticket: 'T1',
    green_idx: 0,
    trunk_idx: 1,
    sha: SHA,
    requeued: ['fix'],
  };
  const demote = { type: 'green.demote', sha: SHA, failing: [], tasks: ['fix'] };

  it('stands once the bean lands', () => {
    expect(hasStandingLanding(parsed(land), 'fix')).toBe(true);
    expect(hasStandingLanding(parsed(land), 'other')).toBe(false);
  });

  it.each([
    ['a requeue', requeued],
    ['a red reset of the sprout', reset],
    ['a demotion of the stalk', demote],
  ])('falls after %s, until the bean lands again', (_name, takeOff) => {
    expect(hasStandingLanding(parsed(land, takeOff), 'fix')).toBe(false);
    expect(hasStandingLanding(parsed(land, takeOff, land), 'fix')).toBe(true);
  });
});
