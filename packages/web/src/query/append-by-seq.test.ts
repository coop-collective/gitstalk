import { describe, expect, it } from 'vitest';

import { appendBySeq, lastSeq } from './append-by-seq';

type Event = { readonly seq: number; readonly text: string };

const events = (...seqs: number[]): Event[] => seqs.map((seq) => ({ seq, text: `e${seq}` }));
const seqsOf = (list: readonly Event[]) => list.map((event) => event.seq);

describe('appendBySeq', () => {
  it('appends a batch that continues the held events', () => {
    const outcome = appendBySeq(events(1, 2), events(3, 4));
    expect(outcome.kind).toBe('appended');
    expect(seqsOf(outcome.events)).toEqual([1, 2, 3, 4]);
  });

  it('returns the same array when the batch holds nothing new', () => {
    const held = events(1, 2, 3);
    const outcome = appendBySeq(held, events(2, 3));
    expect(outcome.kind).toBe('unchanged');
    expect(outcome.events).toBe(held);
  });

  it('drops repeats, keeping the held copy and the first copy within a batch', () => {
    const held = [{ seq: 1, text: 'held' }];
    const outcome = appendBySeq(held, [
      { seq: 1, text: 'again' },
      { seq: 2, text: 'first' },
      { seq: 2, text: 'second' },
    ]);
    expect(outcome.events).toEqual([
      { seq: 1, text: 'held' },
      { seq: 2, text: 'first' },
    ]);
  });

  it('keeps seq order when a batch arrives out of order or fills a hole', () => {
    const outcome = appendBySeq(events(1, 2, 4), events(5, 3));
    expect(seqsOf(outcome.events)).toEqual([1, 2, 3, 4, 5]);
    expect(outcome.kind).toBe('appended');
  });

  it('reports a gap when seqs between the held events and the batch are missing', () => {
    const outcome = appendBySeq(events(1, 2), events(5, 6));
    expect(outcome.kind).toBe('gap');
    expect(seqsOf(outcome.events)).toEqual([1, 2, 5, 6]);
  });

  it('reports a gap inside a batch', () => {
    expect(appendBySeq(events(1), events(2, 4)).kind).toBe('gap');
  });

  it('does not report a hole the held events already had', () => {
    expect(appendBySeq(events(1, 5), events(6)).kind).toBe('appended');
  });

  it('starts from an empty list without a gap', () => {
    const outcome = appendBySeq([], events(40, 41));
    expect(outcome.kind).toBe('appended');
    expect(seqsOf(outcome.events)).toEqual([40, 41]);
  });

  it('does not mutate its inputs', () => {
    const held = events(1, 3);
    const batch = events(4, 2);
    appendBySeq(held, batch);
    expect(seqsOf(held)).toEqual([1, 3]);
    expect(seqsOf(batch)).toEqual([4, 2]);
  });
});

describe('lastSeq', () => {
  it('is the last seq held, or the fallback for an empty list', () => {
    expect(lastSeq(events(3, 7))).toBe(7);
    expect(lastSeq([])).toBe(0);
    expect(lastSeq([], 12)).toBe(12);
  });
});
