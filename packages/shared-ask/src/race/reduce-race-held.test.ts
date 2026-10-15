import { describe, expect, it } from 'vitest';

import { beanRecord } from '../forge/bean-records';
import { journeyOf } from '../home/journey';
import type { RaceEvent } from './race-events';
import { parseRaceEvents } from './race-events';
import { reduceRace } from './reduce-race';

const BASE = '26eecce0d764943d0c89a6139e3491055e9ff00c';
const FIRST = 'b8da0156785efc5e20d5ec34f9db8fce173beed6';
const SECOND = '822e661f90b8cd852d625acae8cc3ce36520d6cd';
const HOLD = { classes: ['auth'], class: 'auth', by: 'clef' };

/** A pushed bean the approval rules hold, as a repository engine logs it, then `after`. */
function heldBean(after: readonly Record<string, unknown>[]): readonly RaceEvent[] {
  const raw = [
    { type: 'task.start', task: 'login', agent: 'a0', base: BASE },
    commit(FIRST),
    check({ green: false, failing_tests: ['.gitstalk/policy.yml > awaits'], held: HOLD }),
    { type: 'rework.start', task: 'login', reason: 'preland-red', attempt: 1, culprits: [] },
    { type: 'invocation.start', inv: 'i2', kind: 'rework', task: 'login', agent: 'a0', attempt: 1 },
    ...after,
  ];
  const ts = '2026-10-14T12:00:00.000+00:00';
  return parseRaceEvents(
    raw.map((event, index) => Object.assign({ seq: index + 1, t: index, ts }, event)),
  ).events;
}

function commit(sha: string): Record<string, unknown> {
  return { type: 'task.commit', task: 'login', sha, kind: 'rework', new_commit: true, files: [] };
}

function check(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'preland.check', task: 'login', sha: BASE, check_seconds: 1, ...fields };
}

describe('a bean the approval rules hold', () => {
  it('is held, not sent back: no rework round and no red check counted', () => {
    const bean = reduceRace(heldBean([])).beans['login'];
    expect(bean).toMatchObject({ phase: 'held', reworks: 0, redChecks: 0, checks: 1 });
    expect(bean?.steps.map((step) => step.kind)).toEqual(['started', 'committed', 'held']);
    expect(journeyOf(bean?.steps ?? []).at(-1)).toEqual({
      t: 2,
      tone: 'held',
      text: 'Held for approval: class auth, decided by clef; nothing in it needs fixing',
    });
  });

  it('reads the same head committed again as the approval, then checks it again', () => {
    const state = reduceRace(heldBean([commit(FIRST), check({ green: true })]));
    const bean = state.beans['login'];
    expect(bean?.steps.map((step) => step.kind)).toEqual([
      'started',
      'committed',
      'held',
      'approved',
      'check-green',
    ]);
    expect(journeyOf(bean?.steps ?? [])[3]).toMatchObject({
      tone: 'approved',
      text: 'Approved by a person; checking b8da015 again',
    });
    expect(bean === undefined ? null : beanRecord(bean, undefined, undefined).status).toBe(
      'in-flight',
    );
  });

  it('reads a new head while held as a new push, and a second hold as held again', () => {
    const bean = reduceRace(
      heldBean([commit(SECOND), check({ green: false, failing_tests: ['x'], held: HOLD })]),
    ).beans['login'];
    expect(bean?.steps.map((step) => step.kind)).toEqual([
      'started',
      'committed',
      'held',
      'committed',
      'held',
    ]);
    expect(bean).toMatchObject({ phase: 'held', reworks: 0 });
  });

  it('leaves an ordinary red a red, sent back to its author', () => {
    const raw = heldBean([commit(SECOND), check({ green: false, failing_tests: ['x'] })]);
    const red = [
      ...raw,
      ...parseRaceEvents([
        {
          seq: 99,
          t: 9,
          ts: '2026-10-14T12:00:00.000+00:00',
          type: 'rework.start',
          task: 'login',
          reason: 'preland-red',
          attempt: 2,
        },
      ]).events,
    ];
    const bean = reduceRace(red).beans['login'];
    expect(bean).toMatchObject({ phase: 'rework', reworks: 1, redChecks: 1 });
    expect(bean?.steps.slice(-2).map((step) => step.kind)).toEqual(['check-red', 'rework']);
  });
});
