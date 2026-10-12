/**
 * `actions_wait_for_run`: one MCP call that holds until a run ends, so an agent never
 * sleep-polls. It waits for one run (`run`), for the runs a bean's landing starts (`bean`: the
 * bean reaches the stalk, which is a push to main, then its push runs end), or for a
 * workflow's newest run. Bounded by `seconds` (at most `MAX_RUN_WAIT_SECONDS`). A finished run
 * comes back with each failed job's failing step and the last lines of its log.
 *
 * The bean part holds on the engine's watch (as `bean_wait`); runs have no watch yet, so the
 * gateway reads their rows every one to five seconds while the agent's single call waits.
 */
import type { AgentRunWaited, AgentWaitedRun } from '@gitstalk/shared-race/agent-actions';
import { AgentWaitRunInput } from '@gitstalk/shared-race/agent-actions';
import type { RunSummary } from '@gitstalk/shared-race/actions';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import type { ActionsTarget } from './actions-target';
import { failure } from './agent-access';
import { waitForBean } from './agent-repos-rpc';
import { LogTail, isFailed, runView, stepNames } from './agent-run-views';
import { beansOf, readLog, runDetail, workflowPath } from './agent-runs';

/** After a bean reaches the stalk, how long its push runs may take to appear. */
const APPEAR_GRACE_MS = 60_000;
const FIRST_POLL_MS = 1000;
const MAX_POLL_MS = 5000;
/** The log lines a failure carries, and their bytes. */
const FAILURE_TAIL = 30;
const FAILURE_BYTES = 4000;
const MAX_FAILURES = 3;

export async function waitForRuns(
  target: ActionsTarget,
  raw: unknown,
): Promise<RpcResult<AgentRunWaited>> {
  const input = AgentWaitRunInput.safeParse(raw);
  if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid wait');
  const startMs = Date.now();
  const clock = { startMs, deadlineMs: startMs + input.data.seconds * 1000 };
  const { run, bean, workflow } = input.data;
  if ([run, bean].filter((given) => given !== undefined).length > 1)
    return invalid('give run or bean, not both');
  if (run !== undefined) {
    const found = await runDetail(target, run);
    return found.ok ? settle(target, { clock, runs: [found.value], bean: null }) : found;
  }
  if (bean !== undefined) return waitForLanding(target, { clock, bean });
  const path = workflow === undefined ? undefined : await workflowPath(target, workflow);
  if (path !== undefined && !path.ok) return path;
  const newest = await poll(clock, () => newestRun(target, path?.value));
  return settle(target, { clock, runs: newest === null ? [] : [newest], bean: null });
}

type Clock = { readonly startMs: number; readonly deadlineMs: number };

/** The bean to the stalk, then the push runs its stalk move started. */
async function waitForLanding(
  target: ActionsTarget,
  input: { readonly clock: Clock; readonly bean: string },
): Promise<RpcResult<AgentRunWaited>> {
  const { clock } = input;
  const left = Math.max(1, Math.ceil((clock.deadlineMs - Date.now()) / 1000));
  const waited = await waitForBean(target.opened, input.bean, { until: 'stalk', seconds: left });
  if (!waited.ok) return waited;
  const bean = { bean: input.bean, phase: waited.value.phase };
  if (bean.phase !== 'green')
    return ok(answer(target, { clock, bean, runs: [], outcome: 'bean_not_on_stalk' }));
  const appear = { ...clock, deadlineMs: Math.min(clock.deadlineMs, Date.now() + APPEAR_GRACE_MS) };
  const runs = await poll(appear, async () => {
    const found = await runsCarrying(target, input.bean);
    return found.length > 0 ? found : null;
  });
  return settle(target, { clock, runs: runs ?? [], bean });
}

/** Waits for every run to complete (or the clock), then describes them. */
async function settle(
  target: ActionsTarget,
  input: {
    readonly clock: Clock;
    readonly runs: readonly RunSummary[];
    readonly bean: AgentRunWaited['bean'];
  },
): Promise<RpcResult<AgentRunWaited>> {
  const { clock, bean } = input;
  if (input.runs.length === 0)
    return ok(answer(target, { clock, bean, runs: [], outcome: 'no_run' }));
  const ids = input.runs.map((run) => run.id);
  await poll(clock, async () => ((await allCompleted(target, ids)) ? true : null));
  const described = await Promise.all(ids.map((id) => waitedRun(target, id)));
  const runs = described.flatMap((run) => (run === null ? [] : [run]));
  const isDone = runs.every((run) => run.status === 'completed');
  return ok(answer(target, { clock, bean, runs, outcome: isDone ? 'completed' : 'running' }));
}

function answer(
  target: ActionsTarget,
  input: {
    readonly clock: Clock;
    readonly bean: AgentRunWaited['bean'];
    readonly runs: readonly AgentWaitedRun[];
    readonly outcome: AgentRunWaited['outcome'];
  },
): AgentRunWaited {
  return {
    repo: target.repo,
    outcome: input.outcome,
    waited_s: Math.round((Date.now() - input.clock.startMs) / 1000),
    bean: input.bean,
    runs: input.runs,
  };
}

/** A run as the wait ends it: with each failed job's failing step and its log's last lines. */
async function waitedRun(target: ActionsTarget, runId: string): Promise<AgentWaitedRun | null> {
  const detail = await runDetail(target, runId);
  if (!detail.ok) return null;
  const run = runView(detail.value, await beansOf(target, runId));
  const failedJobs = detail.value.jobs
    .filter((job) => isFailed(job.conclusion))
    .slice(0, MAX_FAILURES);
  const failures = await Promise.all(
    failedJobs.map(async (job) => {
      const tail = new LogTail({ tail: FAILURE_TAIL, grep: undefined, steps: stepNames(job) });
      await readLog(target, { run: runId, job: job.id }, tail);
      return {
        job: job.name,
        step: run.jobs.find((view) => view.id === job.id)?.failed_step ?? null,
        log_tail: tail.result(FAILURE_BYTES).text,
      };
    }),
  );
  return { ...run, failures };
}

async function newestRun(
  target: ActionsTarget,
  path: string | undefined,
): Promise<RunSummary | null> {
  const listed = await target.actions.listRuns(target.viewer, target.record.id, {
    ...(path === undefined ? {} : { workflowPath: path }),
    limit: 1,
  });
  return listed.ok ? (listed.value.runs[0] ?? null) : null;
}

async function runsCarrying(target: ActionsTarget, bean: string): Promise<readonly RunSummary[]> {
  const listed = await target.actions.listRuns(target.viewer, target.record.id, {
    event: 'push',
    limit: 20,
  });
  if (!listed.ok) return [];
  const wanted = bean.replace(/^beans?\//, '');
  const beans = await Promise.all(listed.value.runs.map((run) => beansOf(target, run.id)));
  return listed.value.runs.filter((_, index) => beans[index]?.includes(wanted) === true);
}

async function allCompleted(target: ActionsTarget, ids: readonly string[]): Promise<boolean> {
  const statuses = await Promise.all(
    ids.map(async (id) => {
      const summary = await target.env.ACTIONS_RUNS.getByName(id).summary();
      return summary?.status ?? 'completed';
    }),
  );
  return statuses.every((status) => status === 'completed');
}

/** Calls `check` until it answers non-null or the clock runs out (then null). */
async function poll<T>(clock: Clock, check: () => Promise<T | null>): Promise<T | null> {
  let interval = FIRST_POLL_MS;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each check follows the last
    const found = await check();
    const left = clock.deadlineMs - Date.now();
    if (found !== null || left <= 0) return found;
    // oxlint-disable-next-line no-await-in-loop -- the wait between checks is the point
    await scheduler.wait(Math.min(interval, left));
    interval = Math.min(MAX_POLL_MS, Math.round(interval * 1.5));
  }
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function invalid<T>(message: string): RpcResult<T> {
  return failure('invalid_request', 400, message);
}
