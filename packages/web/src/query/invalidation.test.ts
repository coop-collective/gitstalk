import { describe, expect, it } from 'vitest';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import { parseRaceEvents } from '@gitstalk/shared-ask/race/race-events';

import { headMoves, staleKeysFor } from './invalidation';
import { qk } from './keys';

const keys = qk.repo('u1', 'acme', 'web');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

let seq = 0;
/** Parsed with the real schema, so each fixture is a valid event. */
function events(...raw: Record<string, unknown>[]): readonly RaceEvent[] {
  const parsed = parseRaceEvents(
    raw.map((fields) => {
      seq += 1;
      return { seq, t: seq, ts: '2026-10-14T00:00:00Z', ...fields };
    }),
  );
  expect(parsed.events).toHaveLength(raw.length);
  return parsed.events;
}

const land = (task: string | null, sha: string, target = 'trunk') => ({
  type: 'land',
  task,
  sha,
  target,
  files: ['a.ts'],
});
const commit = (task: string, sha: string) => ({
  type: 'task.commit',
  task,
  sha,
  kind: 'push',
  new_commit: true,
  files: ['a.ts'],
});
const promote = (sha: string) => ({ type: 'green.promote', sha, tasks: [] });
const ciEnd = (sha: string) => ({
  type: 'ci.end',
  ci: 'c1',
  sha,
  purpose: 'final',
  green: true,
  slot: 0,
});
const raceSetup = { type: 'race.setup', policy: 'v2' };

describe('what fresh events make stale', () => {
  it('invalidates the pushed beans when a bean moves', () => {
    expect(staleKeysFor(events(commit('fix', SHA_A)), keys).invalidate).toEqual([keys.pushed()]);
  });

  it('invalidates nothing for events that move no bean', () => {
    expect(staleKeysFor(events(raceSetup), keys)).toEqual({ invalidate: [], refresh: 'none' });
  });

  it('invalidates the diff of a bean on screen when it is pushed or lands', () => {
    const watch = { beans: ['fix', 'other'] };
    expect(staleKeysFor(events(commit('fix', SHA_A)), keys, watch).invalidate).toEqual([
      keys.pushed(),
      keys.bean('fix'),
    ]);
    expect(staleKeysFor(events(land('other', SHA_B)), keys, watch).invalidate).toContainEqual(
      keys.bean('other'),
    );
  });

  it('refreshes at once when a line the page shows moved past its rendered head', () => {
    const heads = { stalk: null, sprout: SHA_A };
    expect(staleKeysFor(events(land('fix', SHA_B)), keys, { heads }).refresh).toBe('now');
  });

  it('does not refresh when the head is the one the page rendered', () => {
    const heads = { stalk: null, sprout: SHA_B };
    expect(staleKeysFor(events(land('fix', SHA_B)), keys, { heads }).refresh).toBe('none');
  });

  it('does not refresh for a line the page does not show', () => {
    const heads = { stalk: SHA_A, sprout: null };
    expect(staleKeysFor(events(land('fix', SHA_B)), keys, { heads }).refresh).toBe('none');
    expect(staleKeysFor(events(promote(SHA_C)), keys, { heads }).refresh).toBe('now');
  });

  it('refreshes History, debounced, for validation activity that moves no head', () => {
    const heads = { stalk: SHA_A, sprout: SHA_B };
    expect(staleKeysFor(events(ciEnd(SHA_B)), keys, { heads, activity: true }).refresh).toBe(
      'debounced',
    );
    expect(staleKeysFor(events(ciEnd(SHA_B)), keys, { heads }).refresh).toBe('none');
  });

  it('prefers refreshing now when a batch both moves a head and carries activity', () => {
    const watch = { heads: { stalk: SHA_A, sprout: null }, activity: true };
    expect(staleKeysFor(events(ciEnd(SHA_C), promote(SHA_C)), keys, watch).refresh).toBe('now');
  });
});

describe('head moves', () => {
  it('names each line’s newest head in a batch', () => {
    const batch = events(land('a', SHA_A), land('b', SHA_B), promote(SHA_A));
    expect(headMoves(batch)).toEqual([
      { line: 'sprout', sha: SHA_B },
      { line: 'stalk', sha: SHA_A },
    ]);
  });

  it('reads a landing straight onto the stalk (queue mode) as a stalk move', () => {
    expect(headMoves(events(land('a', SHA_A, 'main')))).toEqual([{ line: 'stalk', sha: SHA_A }]);
  });

  it('ignores a landing on any other target', () => {
    expect(headMoves(events(land('a', SHA_A, 'bean/a')))).toEqual([]);
  });

  it('reads a red reset of the sprout as a sprout move', () => {
    const reset = {
      type: 'sprout.reset',
      ticket: 't1',
      green_idx: 1,
      trunk_idx: 2,
      sha: SHA_C,
      requeued: [],
    };
    expect(headMoves(events(reset))).toEqual([{ line: 'sprout', sha: SHA_C }]);
  });
});
