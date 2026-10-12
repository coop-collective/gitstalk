/**
 * How Actions answers look to an agent (`AgentActionsRpc`): compact snake_case views of runs,
 * jobs and workflows, a workflow found by path, file name or name, and a job's log cut to its
 * last lines. Pure functions; the RPC (./agent-actions-rpc.ts) reads the data.
 */
import type {
  AgentJob,
  AgentRun,
  AgentRunSummary,
  AgentWorkflow,
} from '@gitstalk/shared-race/agent-actions';
import type {
  JobView,
  LogLine,
  RunDetail,
  RunSummary,
  WorkflowSummary,
  WorkflowTrigger,
} from '@gitstalk/shared-race/actions';
import { automationIdOf, isAutomationPath } from '@gitstalk/shared-race/actions';

/** Conclusions an agent has to act on. */
const FAILED: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'startup_failure',
  'infrastructure_failure',
]);

export function kindOf(path: string): 'workflow' | 'automation' {
  return isAutomationPath(path) ? 'automation' : 'workflow';
}

export function isFailed(conclusion: string | null): boolean {
  return conclusion !== null && FAILED.has(conclusion);
}

export function runSummaryView(run: RunSummary): AgentRunSummary {
  return {
    id: run.id,
    number: run.number,
    workflow: run.workflowPath,
    workflow_name: run.workflowName,
    kind: kindOf(run.workflowPath),
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    reason: run.reason,
    ref: run.ref,
    sha: run.sha,
    actor: run.actor,
    created_at: run.createdAt,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    duration_s: durationS(run.startedAt, run.completedAt),
  };
}

export function runView(detail: RunDetail, beans: readonly string[]): AgentRun {
  return {
    ...runSummaryView(detail),
    beans,
    inputs: detail.inputs,
    jobs: detail.jobs.map(jobView),
  };
}

function jobView(job: JobView): AgentJob {
  const failed = job.steps.find((step) => isFailed(step.conclusion));
  return {
    id: job.id,
    key: job.key,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    reason: job.reason,
    needs: job.needs,
    duration_s: durationS(job.startedAt, job.completedAt),
    steps: job.steps.map((step) => ({
      number: step.number,
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      duration_s: durationS(step.startedAt, step.completedAt),
    })),
    failed_step: failed?.name ?? null,
  };
}

export function workflowView(workflow: WorkflowSummary): AgentWorkflow {
  const dispatch = workflow.triggers.find((trigger) => trigger.kind === 'workflow_dispatch');
  return {
    path: workflow.path,
    name: workflow.name,
    kind: kindOf(workflow.path),
    state: workflow.state,
    triggers: workflow.triggers.map(triggerText),
    dispatch_inputs: dispatch?.kind === 'workflow_dispatch' ? dispatch.inputs : null,
    unsupported_events: workflow.unsupportedEvents,
    problems: workflow.problems.map((problem) =>
      problem.line === null ? problem.message : `line ${problem.line}: ${problem.message}`,
    ),
    jobs: workflow.jobs.map((job) => job.key),
    sha: workflow.sha,
  };
}

/** `push (main)`, `workflow_dispatch`, `schedule (0 6 * * *)`, `bean_landed`. */
export function triggerText(trigger: WorkflowTrigger): string {
  switch (trigger.kind) {
    case 'push':
      return trigger.branches.length === 0 ? 'push' : `push (${trigger.branches.join(', ')})`;
    case 'workflow_dispatch':
      return 'workflow_dispatch';
    case 'schedule':
      return `schedule (${trigger.crons.join('; ')})`;
    case 'beanstalk':
      return trigger.event;
    default:
      return assertNever(trigger);
  }
}

/** A workflow by path, file name (with or without extension) or `name:`, case-insensitively. */
export function findWorkflow<W extends { readonly path: string; readonly name: string }>(
  workflows: readonly W[],
  ref: string,
): W | undefined {
  const wanted = ref.trim().toLowerCase();
  const exact = workflows.find((workflow) => workflow.path.toLowerCase() === wanted);
  if (exact !== undefined) return exact;
  return workflows.find((workflow) => {
    const file = workflow.path.split('/').at(-1)?.toLowerCase() ?? '';
    return (
      file === wanted ||
      automationIdOf(workflow.path) === wanted ||
      workflow.name.toLowerCase() === wanted
    );
  });
}

/** A job by id, key or display name; by default the first failed job, else the last one. */
export function pickJob(jobs: readonly JobView[], ref: string | undefined): JobView | undefined {
  if (ref === undefined)
    return jobs.find((job) => isFailed(job.conclusion)) ?? jobs.findLast(hasStarted) ?? jobs.at(-1);
  const wanted = ref.toLowerCase();
  return jobs.find(
    (job) =>
      job.id === ref || job.key.toLowerCase() === wanted || job.name.toLowerCase() === wanted,
  );
}

/**
 * Keeps the newest `tail` lines that match `grep` while a log streams past (so a long log never
 * sits in memory), and counts them all.
 */
export class LogTail {
  readonly #tail: number;
  readonly #needle: string | null;
  readonly #steps: ReadonlyMap<number, string>;
  #kept: string[] = [];
  #total = 0;
  #matched = 0;

  constructor(input: {
    readonly tail: number;
    readonly grep: string | undefined;
    readonly steps: ReadonlyMap<number, string>;
  }) {
    this.#tail = input.tail;
    this.#needle = input.grep === undefined ? null : input.grep.toLowerCase();
    this.#steps = input.steps;
  }

  add(lines: readonly LogLine[]): void {
    for (const line of lines) {
      this.#total += 1;
      const text = this.#format(line);
      if (this.#needle !== null && !text.toLowerCase().includes(this.#needle)) continue;
      this.#matched += 1;
      this.#kept.push(text);
      if (this.#kept.length > this.#tail * 2) this.#kept = this.#kept.slice(-this.#tail);
    }
  }

  /** The kept lines, newest last, cut from the front to `maxBytes`. */
  result(maxBytes: number): {
    readonly total: number;
    readonly matched: number;
    readonly shown: number;
    readonly truncated: boolean;
    readonly text: string;
  } {
    const kept = this.#kept.slice(-this.#tail);
    const shown: string[] = [];
    let bytes = 0;
    for (const line of kept.toReversed()) {
      const size = new TextEncoder().encode(line).length + 1;
      if (bytes + size > maxBytes) break;
      shown.push(line);
      bytes += size;
    }
    return {
      total: this.#total,
      matched: this.#matched,
      shown: shown.length,
      truncated: shown.length < this.#matched,
      text: shown.toReversed().join('\n'),
    };
  }

  #format(line: LogLine): string {
    const step = line.step === null ? null : (this.#steps.get(line.step) ?? `step ${line.step}`);
    return step === null ? line.text : `[${step}] ${line.text}`;
  }
}

/** A job's step names by number, for log lines. */
export function stepNames(job: JobView): ReadonlyMap<number, string> {
  return new Map(job.steps.map((step) => [step.number, step.name]));
}

function hasStarted(job: JobView): boolean {
  return job.startedAt !== null;
}

function durationS(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
}

function assertNever(value: never): never {
  throw new Error(`unexpected trigger: ${JSON.stringify(value)}`);
}
