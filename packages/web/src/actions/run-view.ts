/**
 * Words and shapes the Actions pages share: one state per run, job or step (GitHub's status
 * plus conclusion folded together), durations, who and what started a run, the job graph's
 * columns, and which job a run page opens on.
 */
import type { ActionsClient } from './actions-client';
import type {
  Conclusion,
  Job,
  LogLine,
  RunActor,
  RunDetail,
  RunEvent,
  RunStatus,
  RunSummary,
  Workflow,
  WorkflowTrigger,
} from './actions-contract';
import { isAutomationPath } from '@gitstalk/shared-race/actions';

export type RunState =
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'skipped'
  | 'infra_lost'
  | 'startup_failure';

export function stateOf(item: {
  readonly status: RunStatus;
  readonly conclusion: Conclusion | null;
}): RunState {
  if (item.status === 'queued') return 'queued';
  if (item.status === 'in_progress') return 'running';
  return item.conclusion ?? 'success';
}

export const STATE_WORDS: Readonly<Record<RunState, string>> = {
  queued: 'queued',
  running: 'running',
  success: 'succeeded',
  failure: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timed out',
  skipped: 'skipped',
  infra_lost: 'runner lost',
  startup_failure: 'could not start',
};

/** Whether a run or job can still change. */
export function isLive(state: RunState): boolean {
  return state === 'queued' || state === 'running';
}

/** Milliseconds from start to end (or to now while it runs); null before it starts. */
export function elapsedMs(
  item: { readonly startedAt: string | null; readonly completedAt: string | null },
  nowMs: number,
): number | null {
  if (item.startedAt === null) return null;
  const end = item.completedAt === null ? nowMs : Date.parse(item.completedAt);
  return Math.max(0, end - Date.parse(item.startedAt));
}

/** `41s`, `1m 52s`, `1h 3m`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const EVENT_WORDS: Readonly<Record<RunEvent, string>> = {
  push: 'stalk moved',
  workflow_dispatch: 'run by hand',
  schedule: 'schedule',
  bean_opened: 'bean pushed',
  bean_landed: 'bean landed',
  bean_red: 'bean red',
  bean_parked: 'bean parked',
  bean_dropped: 'bean dropped',
  bean_reverted: 'bean reverted',
  stalk_moved: 'stalk moved',
  stalk_reset: 'stalk reset',
  validation_red: 'validation red',
  decision_opened: 'decision opened',
  decision_decided: 'decision answered',
};

/** Which segment of the Automations tab a workflow or run belongs to, by its file's folder. */
export function sectionOf(workflowPath: string): 'actions' | 'automations' {
  return isAutomationPath(workflowPath) ? 'automations' : 'actions';
}

export function eventWord(event: RunEvent): string {
  return EVENT_WORDS[event];
}

export function actorLabel(actor: RunActor): string {
  switch (actor.kind) {
    case 'person':
      return `@${actor.handle}`;
    case 'session':
      return actor.name;
    case 'schedule':
      return 'on schedule';
    default:
      return assertNever(actor);
  }
}

/** One trigger in a person's words: `push to main (the stalk)`, `daily at 03:00 UTC`. */
export function triggerLabel(trigger: WorkflowTrigger): string {
  switch (trigger.event) {
    case 'push':
      return trigger.branches.length === 0
        ? 'stalk moves'
        : `push to ${trigger.branches.join(', ')} (the stalk)`;
    case 'workflow_dispatch':
      return 'run by hand';
    case 'schedule':
      return trigger.crons.map(cronWords).join(', ');
    case 'beanstalk':
      return [
        EVENT_WORDS[trigger.name],
        trigger.beans.length === 0 ? null : `beans ${trigger.beans.join(', ')}`,
        trigger.authors.length === 0 ? null : `by ${trigger.authors.join(', ')}`,
      ]
        .filter((part) => part !== null)
        .join(' · ');
    case 'other':
      return trigger.name;
    default:
      return assertNever(trigger);
  }
}

/** The common cron shapes in words; anything else stays cron. */
export function cronWords(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  const [minute, hour, day, month, weekday] = parts;
  if (parts.length !== 5 || !isFixed(minute)) return `cron ${cron}`;
  const at = (h: string) => `${h.padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`;
  if (hour === '*' && day === '*' && month === '*' && weekday === '*')
    return `hourly at :${String(minute).padStart(2, '0')}`;
  if (isFixed(hour) && day === '*' && month === '*' && weekday === '*')
    return `daily at ${at(String(hour))}`;
  return `cron ${cron}`;
}

function isFixed(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/.test(value);
}

/** The dispatch trigger, when the workflow can be run by hand. */
export function dispatchOf(workflow: Workflow) {
  const found = workflow.triggers.find((trigger) => trigger.event === 'workflow_dispatch');
  return found?.event === 'workflow_dispatch' ? found : null;
}

/** Each job's column in the graph: one more than the deepest job it needs. */
export function jobColumns(jobs: readonly Job[]): readonly (readonly Job[])[] {
  const depth = new Map<string, number>();
  const depthOf = (job: Job, seen: ReadonlySet<string>): number => {
    const known = depth.get(job.id);
    if (known !== undefined) return known;
    const needs = job.needs.flatMap((id) => {
      const need = jobs.find((candidate) => candidate.id === id);
      return need === undefined || seen.has(id) ? [] : [need];
    });
    const value =
      needs.length === 0
        ? 0
        : 1 + Math.max(...needs.map((need) => depthOf(need, new Set([...seen, job.id]))));
    depth.set(job.id, value);
    return value;
  };
  const columns: Job[][] = [];
  for (const job of jobs) {
    const column = depthOf(job, new Set([job.id]));
    while (columns.length <= column) columns.push([]);
    columns[column]?.push(job);
  }
  return columns;
}

/** The job a run page opens: the first failed, else the one running, else the last. */
export function focusJob(jobs: readonly Job[]): Job | null {
  return (
    jobs.find((job) => stateOf(job) === 'failure') ??
    jobs.find((job) => stateOf(job) === 'running') ??
    jobs.findLast((job) => stateOf(job) !== 'skipped' && stateOf(job) !== 'queued') ??
    jobs[0] ??
    null
  );
}

/** A run's one-line title: the commit's for a push (when known), else the workflow's and how it began. */
export function runTitle(run: RunSummary): string {
  return run.event === 'push' && run.title !== ''
    ? run.title
    : `${run.workflowName} · ${eventWord(run.event)}`;
}

/** What a maintainer just asked for, shown before the control plane has answered. */
export type RunIntent = 'cancel' | 'rerun';

/** The run as it will read once the request lands: cancelled, or (re-run) queued again. */
export function optimisticRun(run: RunDetail, intent: RunIntent): RunDetail {
  switch (intent) {
    case 'cancel':
      return { ...run, status: 'completed', conclusion: 'cancelled' };
    case 'rerun':
      return { ...run, status: 'queued', conclusion: null };
    default:
      return assertNever(intent);
  }
}

/**
 * Whether JSON from the run route is a run. The route's answer was checked by the schema on
 * the server; this keeps the client bundle free of it and rejects an error body.
 */
export function isRunDetail(value: unknown): value is RunDetail {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'status') === 'string' &&
    Array.isArray(Reflect.get(value, 'jobs'))
  );
}

/**
 * The job's log as the page starts it. A running job's log is not read here: its stream
 * (`JobLog`) replays from line 1, so reading it first only delayed the page. A finished job's
 * stored log is the page's to read, since nothing streams it. Null when it cannot be read.
 */
export async function initialLog(
  actions: ActionsClient,
  runId: string,
  job: Job,
): Promise<readonly LogLine[] | null> {
  if (isLive(stateOf(job))) return [];
  const log = await actions.log(runId, job.id, 0);
  return log.ok ? log.value.lines : null;
}

export function assertNever(value: never): never {
  throw new Error(`unexpected value ${JSON.stringify(value)}`);
}
