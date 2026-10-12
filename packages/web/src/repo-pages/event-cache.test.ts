import { describe, expect, it } from 'vitest';

import { RunId } from '@gitstalk/shared-race/ids';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import { parseRaceEvents } from '@gitstalk/shared-ask/race/race-events';
import type { EventCacheLimits } from './event-cache';
import { createEventCache, PublicEngine } from './event-cache';

const ROOMY: EventCacheLimits = { maxEngines: 8, maxEvents: 1000 };

function setupEvent(seq: number, stamp = 'a'): RaceEvent {
  const [event] = parseRaceEvents([
    { seq, t: seq, ts: `2026-10-11T00:00:00.${stamp}Z`, type: 'race.setup', policy: 'v2' },
  ]).events;
  if (event === undefined) throw new Error('the fixture event does not parse');
  return event;
}

function eventsUpTo(count: number, stamp = 'a'): RaceEvent[] {
  return Array.from({ length: count }, (_, index) => setupEvent(index + 1, stamp));
}

function publicEngine(id: string): PublicEngine {
  const engine = PublicEngine.of({ visibility: 'public' }, RunId.parse(id));
  if (engine === null) throw new Error('a public record names a public engine');
  return engine;
}

/** An engine's log the test edits, recording each `after` the cache asks for. */
function engineLog(initial: readonly RaceEvent[]) {
  const state = { events: [...initial], afters: [] as number[] };
  const readTail = (after: number) => {
    state.afters.push(after);
    const events = state.events.filter((event) => event.seq > after);
    return Promise.resolve({ events, last: events.at(-1)?.seq ?? after });
  };
  return { state, readTail };
}

const seqs = (events: readonly RaceEvent[]) => events.map((event) => event.seq);

describe('the append-only event cache', () => {
  it('reads the whole log once, then only the anchor and what follows it', async () => {
    const cache = createEventCache(ROOMY);
    const engine = publicEngine('engineaaa');
    const log = engineLog(eventsUpTo(3));
    expect(seqs(await cache.events(engine, log.readTail))).toEqual([1, 2, 3]);
    log.state.events.push(setupEvent(4), setupEvent(5));
    expect(seqs(await cache.events(engine, log.readTail))).toEqual([1, 2, 3, 4, 5]);
    expect(log.state.afters).toEqual([0, 2]);
  });

  it('answers the held log itself when nothing was appended', async () => {
    const cache = createEventCache(ROOMY);
    const engine = publicEngine('engineaaa');
    const log = engineLog(eventsUpTo(3));
    const first = await cache.events(engine, log.readTail);
    expect(await cache.events(engine, log.readTail)).toBe(first);
  });

  it('reads the whole log again when the sequence went backwards (the log was reset)', async () => {
    const cache = createEventCache(ROOMY);
    const engine = publicEngine('engineaaa');
    const log = engineLog(eventsUpTo(5));
    await cache.events(engine, log.readTail);
    log.state.events = eventsUpTo(2, 'b');
    expect(await cache.events(engine, log.readTail)).toEqual(eventsUpTo(2, 'b'));
    expect(log.state.afters).toEqual([0, 4, 0]);
  });

  it('reads the whole log again when the anchor changed under the same sequence number', async () => {
    const cache = createEventCache(ROOMY);
    const engine = publicEngine('engineaaa');
    const log = engineLog(eventsUpTo(3));
    await cache.events(engine, log.readTail);
    log.state.events = eventsUpTo(4, 'b');
    expect(await cache.events(engine, log.readTail)).toEqual(eventsUpTo(4, 'b'));
    expect(log.state.afters).toEqual([0, 2, 0]);
  });

  it('reads the whole log again across a gap where the anchor should be', async () => {
    const cache = createEventCache(ROOMY);
    const engine = publicEngine('engineaaa');
    const log = engineLog(eventsUpTo(3));
    await cache.events(engine, log.readTail);
    log.state.events = [...eventsUpTo(2), setupEvent(7), setupEvent(8)];
    expect(seqs(await cache.events(engine, log.readTail))).toEqual([1, 2, 7, 8]);
    expect(log.state.afters).toEqual([0, 2, 0]);
  });

  it('reads the whole log again when a tail runs backwards after the anchor', async () => {
    const cache = createEventCache(ROOMY);
    const engine = publicEngine('engineaaa');
    const held = eventsUpTo(3);
    let calls = 0;
    const readTail = (after: number) => {
      calls += 1;
      const events = calls === 2 ? [setupEvent(3), setupEvent(2)] : held;
      return Promise.resolve({ events: after === 0 ? held : events, last: 3 });
    };
    await cache.events(engine, readTail);
    expect(seqs(await cache.events(engine, readTail))).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });

  it('keeps each engine’s log apart', async () => {
    const cache = createEventCache(ROOMY);
    const first = engineLog(eventsUpTo(2));
    const second = engineLog(eventsUpTo(4));
    expect(seqs(await cache.events(publicEngine('engineaaa'), first.readTail))).toEqual([1, 2]);
    expect(seqs(await cache.events(publicEngine('enginebbb'), second.readTail))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(cache.held()).toEqual({ engines: 2, events: 6 });
  });
});

describe('the event cache’s bounds', () => {
  it('drops the least recently read engine beyond the engine bound', async () => {
    const cache = createEventCache({ maxEngines: 2, maxEvents: 1000 });
    const logs = ['enginea1', 'engineb1', 'enginec1'].map((id) => ({
      engine: publicEngine(id),
      log: engineLog(eventsUpTo(2)),
    }));
    const [a, b, c] = logs;
    if (a === undefined || b === undefined || c === undefined) throw new Error('three engines');
    await cache.events(a.engine, a.log.readTail);
    await cache.events(b.engine, b.log.readTail);
    await cache.events(a.engine, a.log.readTail);
    await cache.events(c.engine, c.log.readTail);
    expect(cache.held()).toEqual({ engines: 2, events: 4 });
    // c pushed b out (a was read more recently); reading a again keeps it, so b pushes c out.
    await cache.events(a.engine, a.log.readTail);
    await cache.events(b.engine, b.log.readTail);
    await cache.events(c.engine, c.log.readTail);
    expect(a.log.state.afters).toEqual([0, 1, 1]);
    expect(b.log.state.afters).toEqual([0, 0]);
    expect(c.log.state.afters).toEqual([0, 0]);
  });

  it('drops old engines to stay under the event bound, and never holds a log over it', async () => {
    const cache = createEventCache({ maxEngines: 8, maxEvents: 10 });
    await cache.events(publicEngine('enginea1'), engineLog(eventsUpTo(6)).readTail);
    await cache.events(publicEngine('engineb1'), engineLog(eventsUpTo(5)).readTail);
    expect(cache.held()).toEqual({ engines: 1, events: 5 });
    const huge = engineLog(eventsUpTo(11));
    expect(await cache.events(publicEngine('enginec1'), huge.readTail)).toHaveLength(11);
    await cache.events(publicEngine('enginec1'), huge.readTail);
    expect(huge.state.afters).toEqual([0, 0]);
    expect(cache.held()).toEqual({ engines: 1, events: 5 });
  });
});

describe('which engines may be cached', () => {
  it('names only a public repository’s engine', () => {
    const engine = RunId.parse('engineaaa');
    expect(PublicEngine.of({ visibility: 'public' }, engine)?.engine).toBe(engine);
    expect(PublicEngine.of({ visibility: 'private' }, engine)).toBeNull();
    expect(PublicEngine.of({ visibility: 'internal' }, engine)).toBeNull();
  });
});
