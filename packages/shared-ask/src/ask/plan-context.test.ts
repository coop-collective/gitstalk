import { describe, expect, it } from 'vitest';

import { RunId } from '@gitstalk/shared-race/ids';

import type { EventsPage, ForgeSource } from '../forge/forge-source';
import type { RaceEvent } from '../race/race-events';
import { parseRaceEvents } from '../race/race-events';
import { eventsAfter } from './plan-context';

const run = RunId.parse('k3x9q2m7ab');
const PAGE = 5000;

function setupEvent(seq: number): RaceEvent {
  const [event] = parseRaceEvents([
    {
      seq,
      t: seq,
      ts: `2026-10-11T00:00:${String(seq % 60).padStart(2, '0')}Z`,
      type: 'race.setup',
      policy: 'v2',
    },
  ]).events;
  if (event === undefined) throw new Error('the fixture event does not parse');
  return event;
}

/** A live log of `count` events (never `done`), recording each `after` it is asked for. */
function liveLog(count: number) {
  const afters: number[] = [];
  const events = Array.from({ length: count }, (_, index) => setupEvent(index + 1));
  const source: Pick<ForgeSource, 'runEvents'> = {
    runEvents: (_run, after, limit): Promise<EventsPage> => {
      afters.push(after);
      const page = events.filter((event) => event.seq > after).slice(0, limit);
      return Promise.resolve({ events: page, nextAfter: page.at(-1)?.seq ?? after, done: false });
    },
  };
  return { source, afters };
}

describe('reading a log after a cursor', () => {
  it('reads a short live tail in one call, without a trailing empty page', async () => {
    const log = liveLog(40);
    const tail = await eventsAfter(log.source, run, 30);
    expect(tail.events.map((event) => event.seq)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    expect(tail.last).toBe(40);
    expect(log.afters).toEqual([30]);
  });

  it('follows full pages until one ends inside its span', async () => {
    const log = liveLog(PAGE * 2 + 3);
    const tail = await eventsAfter(log.source, run, 0);
    expect(tail.events).toHaveLength(PAGE * 2 + 3);
    expect(log.afters).toEqual([0, PAGE, PAGE * 2]);
  });

  it('answers an empty tail at the end of the log with the cursor unchanged', async () => {
    const log = liveLog(5);
    expect(await eventsAfter(log.source, run, 5)).toEqual({ events: [], last: 5 });
  });
});
