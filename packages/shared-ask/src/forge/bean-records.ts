/**
 * The explorer's view of beans, decisions and tests, derived from a race state. The
 * recorded source uses these directly; the shapes are the gateway RPC's.
 */
import type { TaskId } from '@gitstalk/shared-race/ids';

import type { RaceEvent } from '../race/race-events';
import type { Bean, RaceState } from '../race/race-state';
import type { BeanRecord, BeanStatus, DecisionRecord, TestRecord, TestRun } from './forge-source';

/** What the source knows about a task besides its events. */
export type TaskInfo = {
  readonly title: string;
  readonly intent: string;
  readonly tests: readonly string[];
};

/** Test runs listed per test, newest last. */
const TEST_HISTORY_LIMIT = 16;

function beanStatus(bean: Bean): BeanStatus {
  switch (bean.phase) {
    case 'pending':
      return 'pending';
    case 'landed':
      return 'landed';
    case 'green':
      return 'green';
    case 'dropped':
      return bean.steps.some((step) => step.kind === 'reverted') ? 'reverted' : 'dropped';
    case 'parked':
      return 'parked';
    case 'working':
    case 'checking':
    case 'queued':
    case 'testing':
    case 'rework':
    case 'held':
    case 'deciding':
      return 'in-flight';
    default:
      return assertNever(bean.phase);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected bean phase: ${String(value)}`);
}

export function beanRecord(
  bean: Bean,
  task: TaskInfo | undefined,
  ownFiles: readonly string[] | undefined,
): BeanRecord {
  return {
    id: bean.id,
    title: task?.title ?? bean.id,
    intent: task?.intent ?? '',
    status: beanStatus(bean),
    phase: bean.phase,
    agent: bean.agent,
    files: ownFiles ?? bean.files,
    startedAt: bean.startedAt,
    landedAt: bean.landedAt,
    landedIdx: bean.landedIdx,
    greenAt: bean.greenAt,
    reworks: bean.reworks,
    card: bean.card,
    costUsd: bean.costUsd,
  };
}

/** Beans that touch any of `paths` (all beans for an empty list), most recent activity first. */
export function beansTouching(
  records: readonly BeanRecord[],
  paths: readonly string[],
): readonly BeanRecord[] {
  const wanted = new Set(paths);
  const touching =
    paths.length === 0
      ? records
      : records.filter((record) => record.files.some((file) => wanted.has(file)));
  return touching.toSorted((a, b) => lastActivity(b) - lastActivity(a));
}

function lastActivity(record: BeanRecord): number {
  return record.greenAt ?? record.landedAt ?? record.startedAt ?? -1;
}

export function decisionRecords(
  state: RaceState,
  records: ReadonlyMap<TaskId, BeanRecord>,
  paths: readonly string[] | undefined,
): readonly DecisionRecord[] {
  const cards = state.cards.map((card) => {
    const beans = [card.task, ...card.against];
    const files = [...new Set(beans.flatMap((id) => records.get(id)?.files ?? []))];
    return { ...card, files };
  });
  if (paths === undefined || paths.length === 0) return cards;
  return cards.filter((card) => card.files.some((file) => paths.includes(file)));
}

/**
 * A test's record: what it covers, who owns it, and its runs on the line (validations,
 * batches, bisection probes, the final check) plus the pre-land checks it failed.
 */
export function testRecord(input: {
  readonly path: string;
  readonly covers: readonly string[];
  readonly owner: TaskId | null;
  readonly existsFrom: number;
  readonly events: readonly RaceEvent[];
}): TestRecord {
  const history = input.events
    .flatMap((event) => testRun(event, input.path, input.existsFrom))
    .slice(-TEST_HISTORY_LIMIT);
  const lineRuns = history.filter((run) => run.kind !== 'preland');
  const latest = lineRuns.at(-1);
  return {
    path: input.path,
    covers: input.covers,
    owner: input.owner,
    state: stateOf(latest),
    history,
  };
}

function stateOf(run: TestRun | undefined): TestRecord['state'] {
  if (run === undefined) return 'unknown';
  return run.green ? 'pass' : 'fail';
}

function testRun(event: RaceEvent, path: string, existsFrom: number): readonly TestRun[] {
  if (event.t < existsFrom) return [];
  if (event.type === 'ci.end') {
    if (event.green === null || event.cancelled === true) return [];
    const failing = event.failing_files ?? [];
    const subject =
      event.trunk_idx === undefined ? (event.batch ?? event.ci) : `#${event.trunk_idx}`;
    return [{ t: event.t, green: !failing.includes(path), kind: event.purpose, subject }];
  }
  if (event.type === 'preland.check' && !event.green) {
    const failed = event.failing_tests.some(
      (name) => name.startsWith(`${path} >`) || name === path,
    );
    return failed ? [{ t: event.t, green: false, kind: 'preland', subject: event.task }] : [];
  }
  return [];
}
