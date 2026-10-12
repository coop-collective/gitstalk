/**
 * Workflows and runs for an MCP session (`AgentActionsRpc`): list, read, a job's log tail,
 * dispatch, re-run and cancel. Reads go through the person's Actions RPC (read role), changes
 * through it too (maintain role); the session's scope was checked when the target was opened.
 */
import type {
  AgentJobLog,
  AgentRun,
  AgentRunPage,
  AgentRunSummary,
  AgentWorkflows,
} from '@gitstalk/shared-race/agent-actions';
import {
  AgentDispatchInput,
  AgentJobLogInput,
  AgentRunFilter,
  DEFAULT_LOG_BYTES,
  DEFAULT_LOG_TAIL,
} from '@gitstalk/shared-race/agent-actions';
import type { RunDetail, RunFilter, WorkflowSummary } from '@gitstalk/shared-race/actions';
import { ActionsRunId } from '@gitstalk/shared-race/actions';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { handleOf } from '../actions/actions-audit';
import { namesStalk } from '../actions/triggers';
import type { ActionsTarget } from './actions-target';
import { mayManageActions } from './actions-target';
import { failure } from './agent-access';
import {
  LogTail,
  findWorkflow,
  pickJob,
  runSummaryView,
  runView,
  stepNames,
  workflowView,
} from './agent-run-views';

/** Log pages (of 50 chunks) one answer reads at most. */
const MAX_LOG_PAGES = 40;
/** Push runs searched for a bean's landing. */
const BEAN_SEARCH_RUNS = 30;

export async function listWorkflows(target: ActionsTarget): Promise<RpcResult<AgentWorkflows>> {
  const listed = await target.actions.listWorkflows(target.viewer, target.record.id);
  if (!listed.ok) return listed;
  return ok({
    repo: target.repo,
    default_branch: target.record.default_branch,
    workflows: listed.value.map(workflowView),
  });
}

export async function listRuns(
  target: ActionsTarget,
  raw: unknown,
): Promise<RpcResult<AgentRunPage>> {
  const filter = AgentRunFilter.safeParse(raw);
  if (!filter.success) return invalid(filter.error.issues[0]?.message ?? 'invalid filter');
  const { workflow, branch, bean, event, status, sha, limit, cursor } = filter.data;
  if (branch !== undefined && !namesStalk(branch, target.record.default_branch))
    return ok({ repo: target.repo, runs: [], next: null });
  const path = workflow === undefined ? undefined : await workflowPath(target, workflow);
  if (path !== undefined && !path.ok) return path;
  const query: RunFilter = {
    ...(event === undefined ? {} : { event }),
    ...(status === undefined ? {} : { status }),
    ...(sha === undefined ? {} : { sha }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(path === undefined ? {} : { workflowPath: path.value }),
    ...(bean === undefined ? {} : { event: 'push', limit: BEAN_SEARCH_RUNS }),
  };
  const listed = await target.actions.listRuns(target.viewer, target.record.id, query);
  if (!listed.ok) return listed;
  const runs =
    bean === undefined ? listed.value.runs : await carrying(target, listed.value.runs, bean);
  return ok({
    repo: target.repo,
    runs: runs.map(runSummaryView),
    next: bean === undefined ? listed.value.next : null,
  });
}

export async function getRun(target: ActionsTarget, runId: string): Promise<RpcResult<AgentRun>> {
  const detail = await runDetail(target, runId);
  if (!detail.ok) return detail;
  return ok(runView(detail.value, await beansOf(target, detail.value.id)));
}

export async function jobLog(target: ActionsTarget, raw: unknown): Promise<RpcResult<AgentJobLog>> {
  const input = AgentJobLogInput.safeParse(raw);
  if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid log request');
  const detail = await runDetail(target, input.data.run);
  if (!detail.ok) return detail;
  const job = pickJob(detail.value.jobs, input.data.job);
  if (job === undefined)
    return failure('not_found', 404, `run ${input.data.run} has no job ${input.data.job ?? ''}`);
  const tail = new LogTail({
    tail: input.data.tail ?? DEFAULT_LOG_TAIL,
    grep: input.data.grep,
    steps: stepNames(job),
  });
  const read = await readLog(target, { run: detail.value.id, job: job.id }, tail);
  if (!read.ok) return read;
  const shown = tail.result(input.data.max_bytes ?? DEFAULT_LOG_BYTES);
  return ok({
    repo: target.repo,
    run: detail.value.id,
    job: { id: job.id, name: job.name, status: job.status, conclusion: job.conclusion },
    lines_total: shown.total,
    matched: input.data.grep === undefined ? null : shown.matched,
    lines_shown: shown.shown,
    truncated: shown.truncated || !read.value.whole,
    complete: read.value.complete,
    text: shown.text,
  });
}

export async function dispatch(
  target: ActionsTarget,
  raw: unknown,
): Promise<RpcResult<AgentRunSummary>> {
  const input = AgentDispatchInput.safeParse(raw);
  if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid dispatch');
  const path = await workflowPath(target, input.data.workflow);
  if (!path.ok) return path;
  const started = await target.actions.dispatchWorkflow(target.viewer, target.record.id, {
    workflowPath: path.value,
    ref: input.data.ref ?? 'main',
    inputs: input.data.inputs ?? {},
  });
  return started.ok ? ok(runSummaryView(started.value)) : started;
}

export async function rerun(
  target: ActionsTarget,
  runId: string,
): Promise<RpcResult<AgentRunSummary>> {
  const detail = await runDetail(target, runId);
  if (!detail.ok) return detail;
  if (detail.value.status !== 'completed')
    return failure(
      'invalid_state',
      409,
      `run ${runId} is still ${detail.value.status}; cancel it or wait`,
    );
  const allowed = await mayManageActions(target);
  if (!allowed.ok) return allowed;
  const started = await target.env.ACTIONS_REPOS.getByName(target.record.id).rerun({
    repoId: target.record.id,
    runId: detail.value.id,
    actor: await handleOf(target.env, target.viewer),
  });
  return started.ok ? ok(runSummaryView(started.value)) : started;
}

export async function cancel(
  target: ActionsTarget,
  runId: string,
): Promise<RpcResult<AgentRunSummary>> {
  const detail = await runDetail(target, runId);
  if (!detail.ok) return detail;
  const cancelled = await target.actions.cancelRun(target.viewer, detail.value.id);
  return cancelled.ok ? ok(runSummaryView(cancelled.value)) : cancelled;
}

/** A run of this repository (another repository's run is not found, whoever may see it). */
export async function runDetail(
  target: ActionsTarget,
  runId: string,
): Promise<RpcResult<RunDetail>> {
  const id = ActionsRunId.safeParse(runId);
  const missing = failure('not_found', 404, `${target.repo} has no run ${runId}`);
  if (!id.success) return missing;
  const detail = await target.actions.getRun(target.viewer, id.data);
  if (!detail.ok) return detail.error.status === 404 ? missing : detail;
  return detail.value.repoId === target.record.id ? detail : missing;
}

/** The beans the stalk move behind a push run carried. */
export async function beansOf(target: ActionsTarget, runId: string): Promise<readonly string[]> {
  return target.env.ACTIONS_RUNS.getByName(runId).beans();
}

/** The workflow's path from a path, file name or name; 404 naming the ones there are. */
export async function workflowPath(target: ActionsTarget, ref: string): Promise<RpcResult<string>> {
  const listed = await target.actions.listWorkflows(target.viewer, target.record.id);
  if (!listed.ok) return listed;
  const found = findWorkflow<WorkflowSummary>(listed.value, ref);
  if (found !== undefined) return ok(found.path);
  const known = listed.value.map((workflow) => workflow.path).join(', ');
  return failure(
    'not_found',
    404,
    `${target.repo} has no workflow ${ref} on the stalk${known === '' ? ' (none yet: land a .github/workflows/*.yml file)' : ` (it has ${known})`}`,
  );
}

async function carrying<R extends { readonly id: string }>(
  target: ActionsTarget,
  runs: readonly R[],
  bean: string,
): Promise<readonly R[]> {
  const wanted = bean.replace(/^beans?\//, '');
  const beans = await Promise.all(runs.map((run) => beansOf(target, run.id)));
  return runs.filter((_, index) => beans[index]?.includes(wanted) === true);
}

/** Streams the job's stored chunks through `tail`, at most `MAX_LOG_PAGES` pages. */
export async function readLog(
  target: ActionsTarget,
  where: { readonly run: string; readonly job: string },
  tail: LogTail,
): Promise<RpcResult<{ readonly complete: boolean; readonly whole: boolean }>> {
  let after = 0;
  for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts after the last one's end
    const read = await target.actions.logChunks(target.viewer, where.run, where.job, after);
    if (!read.ok) return read;
    for (const chunk of read.value.chunks) tail.add(chunk.lines);
    if (read.value.next === null) return ok({ complete: read.value.complete, whole: true });
    after = read.value.next;
  }
  return ok({ complete: false, whole: false });
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function invalid<T>(message: string): RpcResult<T> {
  return failure('invalid_request', 400, message);
}
