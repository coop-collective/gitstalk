/**
 * A bean the approval rules hold, as the engine logs it (`preland.check.held`, then the rework
 * that waits on it), with what follows in each story the journey tells: a person's approval
 * re-submits the same head and its check runs again; or a new push is judged and held again.
 * Test support only.
 */
import type { RevisionApproval } from '@gitstalk/shared-race/bean-approval';
import { parseRaceEvents } from '@gitstalk/shared-ask/race/race-events';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';

import type { PushedBean } from '../pushed-beans';

export const BEAN = 'login';
export const FIRST = 'a8c8ab782a7c7281f05cb47a8b1722610ccb60d4';
export const SECOND = 'b19d0f6c2e8a4b7d9c1e3f5a7b9d1c3e5f7a9b1d';
const MERGED = 'c'.repeat(40);
const LANDED = 'd'.repeat(40);
const START = Date.parse('2026-10-14T12:00:00.000Z');

export const HOLD = { classes: ['auth', 'tests-only'], class: 'auth', by: 'policy' } as const;

export const APPROVAL: RevisionApproval = {
  revision: FIRST,
  by: 'dana',
  at: '2026-10-14T12:02:00.000Z',
  note: 'Read the session change.',
  client: 'web',
};

/** Pushed, then held for approval: the engine's rework waits on a person. */
export function heldEvents(): readonly RaceEvent[] {
  return parsed([
    ['task.start', 0, { task: BEAN, agent: 'a0', base: MERGED }],
    ['task.commit', 1, commit(FIRST)],
    ['preland.check', 3, heldCheck()],
    ['rework.start', 3, { task: BEAN, reason: 'preland-red', attempt: 1, culprits: [] }],
    ['invocation.start', 3, rework()],
  ]);
}

/** Held, approved by a person, checked again on the same head, landed and validated. */
export function approvedEvents(): readonly RaceEvent[] {
  return [
    ...heldEvents(),
    ...parsed(
      [
        ['task.commit', 130, commit(FIRST)],
        ['preland.check', 133, greenCheck()],
        ['land', 134, { task: BEAN, sha: LANDED, target: 'sprout', files: [] }],
        ['green.promote', 140, { sha: LANDED, tasks: [BEAN] }],
      ],
      6,
    ),
  ];
}

/** Held, then a new push (a new revision) before anyone approved: judged and held again. */
export function heldAgainEvents(): readonly RaceEvent[] {
  return [
    ...heldEvents(),
    ...parsed(
      [
        ['task.commit', 60, commit(SECOND)],
        ['preland.check', 62, heldCheck()],
        ['rework.start', 62, { task: BEAN, reason: 'preland-red', attempt: 2, culprits: [] }],
      ],
      6,
    ),
  ];
}

/** The bean as the gateway lists it, its pushes counting the approval's re-submission. */
export function pushedLogin(change: Partial<PushedBean>): PushedBean {
  return {
    bean: BEAN,
    title: 'Sessions expire after a day',
    task: null,
    actor: 'erin',
    head: FIRST,
    pushes: 1,
    phase: 'red',
    reason: "held for a person's approval (class auth, decided by policy)",
    landed_sha: null,
    verdict: [],
    hold: null,
    approvals: [],
    ...change,
  };
}

type Row = readonly [type: string, t: number, fields: Record<string, unknown>];

function parsed(rows: readonly Row[], firstSeq = 1): readonly RaceEvent[] {
  return parseRaceEvents(
    rows.map(([type, t, fields], index) => ({
      seq: firstSeq + index,
      t,
      ts: new Date(START + t * 1000).toISOString(),
      type,
      ...fields,
    })),
  ).events;
}

function commit(sha: string): Record<string, unknown> {
  return { task: BEAN, sha, kind: 'rework', new_commit: true, files: ['src/auth/session.ts'] };
}

function heldCheck(): Record<string, unknown> {
  return {
    task: BEAN,
    sha: MERGED,
    green: false,
    failing_tests: ['.gitstalk/policy.yml > awaits approval by a person'],
    check_seconds: 0.4,
    held: HOLD,
  };
}

function greenCheck(): Record<string, unknown> {
  return { task: BEAN, sha: MERGED, green: true, failing_tests: [], check_seconds: 4.2 };
}

function rework(): Record<string, unknown> {
  return {
    inv: 'inv0002-rework',
    kind: 'rework',
    task: BEAN,
    agent: 'a0',
    adapter: 'push',
    model: null,
    attempt: 1,
  };
}
