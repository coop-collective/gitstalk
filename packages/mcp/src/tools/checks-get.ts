/**
 * `bean_status` with `checks: true`: a bean's pre-land checks as structured failures, not log dumps. Each failure
 * names its test file and test, says whether the red was inherited from the sprout (not this
 * bean's fault: no rework is spent) and whether the test is protected (an acceptance test a
 * bean owns: fix the code, never the test).
 */
import type { TaskId } from '@gitstalk/shared-race/ids';

import { testPathOf } from '@gitstalk/shared-ask/ask/file-set';
import type { RaceEvent, RaceEventOf } from '@gitstalk/shared-ask/race/race-events';
import type { RaceState } from '@gitstalk/shared-ask/race/race-state';

import type { ToolContext } from './tool-context';
import { seconds } from './tool-context';

const CHECKS_SHOWN = 5;
const FAILURES_SHOWN = 20;

export type CheckFailure = {
  readonly file: string;
  readonly test: string;
  /** The sprout was already red on this test: not this bean's fault. */
  readonly inherited: boolean;
  /** An acceptance test a bean owns; never edit it to make the check pass. */
  readonly protected: boolean;
  readonly owner: TaskId | null;
};

export type ChecksAnswer = {
  readonly bean: TaskId;
  readonly checks: { readonly total: number; readonly red: number; readonly inherited: number };
  readonly latest: {
    readonly at_s: number;
    readonly green: boolean;
    readonly inherited: boolean;
  } | null;
  /** The latest check's failures; empty when it was green. */
  readonly failures: readonly CheckFailure[];
  readonly history: readonly {
    readonly at_s: number;
    readonly green: boolean;
    readonly failing: number;
  }[];
  /** Line validations that blamed this bean (repair tickets, queue batches). */
  readonly blamed_by: readonly { readonly handle: string; readonly failing: readonly string[] }[];
  readonly summary: string;
};

/** The bean's checks, or undefined when the run has no such bean. */
export async function checksGet(ctx: ToolContext, bean: TaskId): Promise<ChecksAnswer | undefined> {
  const { events, state } = await ctx.snapshot();
  if (state.beans[bean] === undefined) return undefined;
  const checks = events.filter((event): event is RaceEventOf<'preland.check'> =>
    isCheckOf(event, bean),
  );
  const latest = checks.at(-1);
  const failures = latest === undefined || latest.green ? [] : failuresOf(latest, state);
  const answer = {
    bean,
    checks: {
      total: checks.length,
      red: checks.filter((check) => !check.green).length,
      inherited: checks.filter((check) => check.inherited === true).length,
    },
    latest:
      latest === undefined
        ? null
        : {
            at_s: seconds(latest.t) ?? 0,
            green: latest.green,
            inherited: latest.inherited === true,
          },
    failures: failures.slice(0, FAILURES_SHOWN),
    history: checks.slice(-CHECKS_SHOWN).map((check) => ({
      at_s: seconds(check.t) ?? 0,
      green: check.green,
      failing: check.failing_tests.length,
    })),
    blamed_by: blamedBy(state, bean),
  };
  return { ...answer, summary: summarize(answer) };
}

function isCheckOf(event: RaceEvent, bean: TaskId): boolean {
  return event.type === 'preland.check' && event.task === bean;
}

function failuresOf(check: RaceEventOf<'preland.check'>, state: RaceState): CheckFailure[] {
  return check.failing_tests.map((test) => {
    const file = testPathOf(test);
    const owner = ownerOf(state, file);
    return {
      file,
      test: test.slice(file.length).replace(/^ > /, '') || test,
      inherited: check.inherited === true,
      protected: owner !== null,
      owner,
    };
  });
}

/** The bean whose change added the test file, if any. */
function ownerOf(state: RaceState, file: string): TaskId | null {
  return state.order.find((id) => state.beans[id]?.files.includes(file) === true) ?? null;
}

function blamedBy(state: RaceState, bean: TaskId): ChecksAnswer['blamed_by'] {
  const tickets = state.tickets
    .filter((ticket) => ticket.culprit === bean)
    .map((ticket) => ({ handle: `ticket:${ticket.ticket}`, failing: ticket.failing }));
  const batches = state.batches
    .filter((batch) => batch.culprit === bean)
    .map((batch) => ({ handle: `batch:${batch.batch}`, failing: batch.failing }));
  return [...tickets, ...batches];
}

function summarize(answer: Omit<ChecksAnswer, 'summary'>): string {
  if (answer.latest === null) return `${answer.bean} has not been checked yet.`;
  if (answer.latest.green)
    return `${answer.bean}: latest check green (${answer.checks.red} red before).`;
  if (answer.latest.inherited)
    return `${answer.bean}: latest check red, inherited from the sprout; not this bean's fault, no rework spent.`;
  const own = answer.failures.length;
  if (own === 0)
    return `${answer.bean}: latest check red without named tests (a build error or a timeout).`;
  return `${answer.bean}: latest check red, ${own} failing test${own === 1 ? '' : 's'}. Fix the code; protected tests are not to be edited.`;
}
