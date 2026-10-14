/**
 * `AgentReposRpc` (`@gitstalk/shared-race/agent-repos`): what the MCP repository tools ask
 * the gateway. Every call opens the repository through `agent-access.ts` (the git rule), then
 * reads or writes the engine's own state: pushed beans, reservations, claims, the backlog file.
 */
import { z } from 'zod';

import type {
  AgentAutomations,
  AgentBean,
  AgentPrincipal,
  AgentReposRpc,
  Backlog,
  BacklogTask,
  BeanOpened,
  BeanWaited,
  CollidedBean,
  TaskClaimed,
} from '@gitstalk/shared-race/agent-repos';
import {
  BacklogTaskId,
  BeanName,
  BeanOpenInput,
  BeanWaitUntil,
  MAX_BEAN_WAIT_SECONDS,
} from '@gitstalk/shared-race/agent-repos';
import { BeanCommitInput } from '@gitstalk/shared-race/bean-commit';
import type { BeanCommitResult } from '@gitstalk/shared-race/bean-commit';
import { AUTOMATION_PATH_PATTERNS, isAutomationPath } from '@gitstalk/shared-race/actions';
import { TaskId } from '@gitstalk/shared-race/ids';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { listIndexed } from '../actions/workflow-index';
import type { Deps } from '../deps';
import { GatewayError } from '../errors';
import type { PushBean } from '../push/push-bean';
import { withoutRemotePrefix } from '../push/push-messages';
import { pushedBeanStatus } from '../rpc/repo-engine-rpc';
import type { Opened } from './agent-access';
import { failure, openRepository, personRepositories } from './agent-access';
import type { Reservation, TaskStanding } from './agent-store';
import type { BacklogEntry } from './backlog';
import { BACKLOG_FILES, parseBacklog } from './backlog';

/** Collided-with beans described in full; more are named only in the verdict. */
const MAX_COLLIDED = 4;
const JOURNEY_LINES = 30;
const IN_FLIGHT_FIRST = ['checking', 'waiting', 'red', 'conflict'];
/** Phases a check is still running in; `landed` is still moving when waiting for the stalk. */
const CHECKING: ReadonlySet<string> = new Set(['checking', 'waiting']);

export function agentReposRpc(deps: Deps): Required<AgentReposRpc> {
  return {
    agentRepositories: (principal) => guarded(() => personRepositories(deps, principal)),
    agentRepository: (principal, repo) =>
      guarded(async () =>
        mapped(await openRepository(deps, { principal, repo, need: READ }), (opened) => {
          return opened.repository;
        }),
      ),
    agentPushedBeans: (principal, repo) =>
      within(deps, { principal, repo, need: READ }, async ({ engine }) => {
        const beans = (await engine.pushedBeans()).map(pushedBeanStatus);
        return ok(beans.toSorted((a, b) => inFlightRank(a.phase) - inFlightRank(b.phase)));
      }),
    agentBean: (principal, repo, bean) =>
      within(deps, { principal, repo, need: READ }, (opened) => describeBean(opened, bean)),
    agentWaitBean: (principal, repo, bean, wait) =>
      within(deps, { principal, repo, need: READ }, (opened) => waitForBean(opened, bean, wait)),
    agentOpenBean: (principal, repo, input) =>
      within(deps, { principal, repo, need: OPEN_BEAN }, (opened) =>
        openBean(opened, principal, input),
      ),
    agentBacklog: (principal, repo) =>
      within(deps, { principal, repo, need: READ }, (opened) => readBacklog(opened)),
    agentClaimTask: (principal, repo, task) =>
      within(deps, { principal, repo, need: CLAIM_TASK }, (opened) =>
        claim(opened, principal, task),
      ),
    agentReleaseTask: (principal, repo, task) =>
      within(deps, { principal, repo, need: RELEASE_TASK }, (opened) =>
        release(opened, principal, task),
      ),
    agentAutomations: (principal, repo) =>
      within(deps, { principal, repo, need: READ }, (opened) => automationsOf(deps, opened)),
    agentCommitBean: (principal, repo, input) =>
      within(deps, { principal, repo, need: COMMIT_BEAN }, (opened) =>
        commitBean(opened, principal, input),
      ),
  };
}

/** Runs `automation_get` lists. */
const AUTOMATION_RUNS = 20;

async function automationsOf(deps: Deps, opened: Opened): Promise<RpcResult<AgentAutomations>> {
  const record = await deps.registry.byEngine(opened.engineId);
  if (record === null) return failure('not_found', 404, `${opened.repository.repo} has no index`);
  const [workflows, runs] = await Promise.all([
    listIndexed(deps.forge, record.id),
    deps.forge
      .prepare(
        `SELECT id, workflow_path, number, event, status, conclusion, created_at FROM actions_runs
         WHERE repo_id = ? AND (workflow_path LIKE ? OR workflow_path LIKE ?) ORDER BY created_ms DESC LIMIT ?`,
      )
      .bind(record.id, ...AUTOMATION_PATH_PATTERNS, AUTOMATION_RUNS)
      .all<{
        id: string;
        workflow_path: string;
        number: number;
        event: string;
        status: string;
        conclusion: string | null;
        created_at: string;
      }>(),
  ]);
  return ok({
    repo: opened.repository.repo,
    automations: workflows
      .filter((workflow) => isAutomationPath(workflow.path))
      .map((workflow) => ({
        path: workflow.path,
        name: workflow.name,
        state: workflow.state,
        problems: workflow.problems.map((problem) =>
          problem.line === null ? problem.message : `line ${problem.line}: ${problem.message}`,
        ),
        triggers: workflow.triggers.map((trigger) =>
          trigger.kind === 'beanstalk' ? trigger.event : trigger.kind,
        ),
        harness: workflow.automation?.harness ?? null,
        model: workflow.automation?.model ?? null,
        acts_as: workflow.automation?.actor ?? null,
        memory_ref: workflow.automation?.memoryRef ?? null,
      })),
    runs: runs.results.map((run) => ({
      id: run.id,
      automation: run.workflow_path,
      number: run.number,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      created_at: run.created_at,
    })),
  });
}

const READ = { kind: 'read' } as const;
const OPEN_BEAN = { kind: 'act', scopes: ['write'], what: 'Opening a bean' } as const;
const COMMIT_BEAN = { kind: 'act', scopes: ['write'], what: 'Committing to a bean' } as const;
const RELEASE_TASK = {
  kind: 'act',
  scopes: ['write'],
  what: 'Releasing a task',
} as const;
const CLAIM_TASK = {
  kind: 'act',
  scopes: ['write'],
  what: 'Claiming a task',
} as const;

async function describeBean(opened: Opened, raw: string): Promise<RpcResult<AgentBean>> {
  const name = BeanName.safeParse(raw);
  if (!name.success) return failure('invalid_request', 400, `"${raw}" is not a bean name`);
  const { pushed, reservation } = await opened.engine.agentBean(name.data);
  const { repo } = opened.repository;
  if (pushed === null && reservation === null)
    return failure('not_found', 404, `${repo} has no bean ${name.data}`);
  const status = pushed === null ? null : { ...pushedBeanStatus(pushed), intent: pushed.intent };
  return ok({
    repo,
    phase: pushed?.phase ?? 'open',
    reservation: reservation === null ? null : reservationView(reservation),
    pushed: status,
    rework:
      pushed === null || pushed.rework === null ? null : await reworkOf(opened, pushed.rework),
    journey: pushed === null ? [] : journeyOf(pushed),
  });
}

/** The lines every push printed, with the latest verdict's in place, oldest first. */
function journeyOf(bean: PushBean): AgentBean['journey'] {
  const { verdict } = bean;
  const lines = bean.notes.flatMap((note) => {
    const line = { push: note.push, text: note.text };
    if (verdict === null || note.n !== verdict.after) return [line];
    return [line, ...verdict.lines.map((text) => ({ push: verdict.push, text }))];
  });
  const hasVerdictPlace = verdict !== null && bean.notes.some((note) => note.n === verdict.after);
  const all =
    verdict === null || hasVerdictPlace
      ? lines
      : [...lines, ...verdict.lines.map((text) => ({ push: verdict.push, text }))];
  return all
    .slice(-JOURNEY_LINES)
    .map((line) => ({ push: line.push, text: withoutRemotePrefix(line.text) }));
}

/**
 * `bean_wait`: holds on the engine until the bean changes (its save wakes the watch, as it wakes
 * `git push -o wait`), then reads it again, until it settles or the time is up.
 */
export async function waitForBean(
  opened: Opened,
  bean: string,
  wait: { readonly until: unknown; readonly seconds: unknown },
): Promise<RpcResult<BeanWaited>> {
  const until = BeanWaitUntil.safeParse(wait.until);
  const seconds =
    typeof wait.seconds === 'number' && Number.isFinite(wait.seconds) ? wait.seconds : 0;
  if (!until.success || seconds < 1 || seconds > MAX_BEAN_WAIT_SECONDS)
    return failure(
      'invalid_request',
      400,
      `wait until verdict or stalk, 1 to ${MAX_BEAN_WAIT_SECONDS} s`,
    );
  const startMs = Date.now();
  const watch = { actor: '', beans: [bean] };
  for (;;) {
    // The key before the read: a change after it wakes the watch below.
    // oxlint-disable-next-line no-await-in-loop -- each round follows the last change
    const seen = await opened.engine.watchBeans({ ...watch, known: null, maxMs: 0 });
    // oxlint-disable-next-line no-await-in-loop -- read after the key
    const described = await describeBean(opened, bean);
    if (!described.ok) return described;
    const waitedMs = Date.now() - startMs;
    const isSettled = !isMoving(described.value.phase, until.data);
    if (isSettled || waitedMs >= seconds * 1000) {
      const waited_s = Math.round(waitedMs / 1000);
      return ok({ ...described.value, waited_s, timed_out: !isSettled });
    }
    // oxlint-disable-next-line no-await-in-loop -- until the bean changes or the time is up
    await opened.engine.watchBeans({ ...watch, known: seen.key, maxMs: seconds * 1000 - waitedMs });
  }
}

function isMoving(phase: string, until: BeanWaitUntil): boolean {
  return CHECKING.has(phase) || (until === 'stalk' && phase === 'landed');
}

async function reworkOf(
  opened: Opened,
  rework: NonNullable<PushBean['rework']>,
): Promise<NonNullable<AgentBean['rework']>> {
  const culprits = rework.culprits.slice(0, MAX_COLLIDED);
  const collided = await Promise.all(culprits.map((bean) => collidedBean(opened, bean)));
  return {
    failing_tests: rework.failing,
    conflicts: rework.conflicts,
    collided_with: collided,
  };
}

/** A landed bean's intent and what it changed (its branch's diff stat). */
async function collidedBean(opened: Opened, bean: string): Promise<CollidedBean> {
  const detail = await opened.engine.bean(bean);
  if (!detail.ok) return { bean, title: bean, intent: '', landed_sha: null, files: [] };
  const { value } = detail;
  const base = value.base_sha;
  const head = value.head_sha;
  const diff =
    base === null || head === null ? null : await opened.engine.repoDiff(base, head, null);
  const counted = diff?.ok === true ? diff.value.files : [];
  const files =
    counted.length > 0
      ? counted.map(({ path, additions, deletions }) => ({ path, additions, deletions }))
      : value.files.map((path) => ({ path, additions: null, deletions: null }));
  return {
    bean,
    title: value.title,
    intent: value.intent,
    landed_sha: value.landed_sha,
    files,
  };
}

async function openBean(
  opened: Opened,
  principal: AgentPrincipal,
  raw: unknown,
): Promise<RpcResult<BeanOpened>> {
  const input = BeanOpenInput.safeParse(raw);
  if (!input.success) {
    const [issue] = input.error.issues;
    const field = issue?.path[0] === 'bean' ? 'not a bean name' : `bad ${String(issue?.path[0])}`;
    return failure('invalid_request', 400, `${field}: ${issue?.message ?? 'invalid'}`);
  }
  const bean = TaskId.safeParse(input.data.bean);
  if (!bean.success)
    return failure('invalid_request', 400, `"${input.data.bean}" is not a bean name`);
  const task = input.data.task ?? null;
  if (task !== null) {
    const known = await backlogEntries(opened);
    if (known.entries.length > 0 && !known.entries.some((entry) => entry.id === task))
      return failure(
        'not_found',
        404,
        `the backlog of ${opened.repository.repo} has no task ${task}`,
      );
  }
  const reserved = await opened.engine.reserveBean({
    bean: bean.data,
    actor: principal.user.handle,
    intent: input.data.intent,
    task,
  });
  if (!reserved.ok) return failure('conflict', 409, reserved.reason);
  const sprout = await opened.engine.repoLog('sprout', null, 1);
  return ok({
    repo: opened.repository.repo,
    bean: bean.data,
    branch: `bean/${bean.data}`,
    intent: reserved.value.intent,
    task: reserved.value.task,
    sprout: sprout.ok ? (sprout.value.commits[0]?.sha ?? null) : null,
    expires_at: new Date(reserved.value.expiresMs).toISOString(),
  });
}

/**
 * `bean_commit` for a session (doc 33): the engine builds the commit on `bean/<name>` and
 * submits it. An agent session never vouches for protected paths, as for its git pushes.
 */
async function commitBean(
  opened: Opened,
  principal: AgentPrincipal,
  raw: unknown,
): Promise<RpcResult<BeanCommitResult>> {
  const input = BeanCommitInput.safeParse(raw);
  if (!input.success) return failure('invalid_request', 400, z.prettifyError(input.error));
  const handle = principal.user.handle;
  const role = opened.repository.role ?? 'no role';
  return opened.engine.repoBeanCommit({
    actor: handle,
    client: principal.label || 'MCP',
    protectedAccess: { allowed: false, who: `@${handle} (${role}, with an MCP session)` },
    input: input.data,
  });
}

async function readBacklog(opened: Opened): Promise<RpcResult<Backlog>> {
  const { file, entries } = await backlogEntries(opened);
  const standings = await opened.engine.taskStandings(entries.map((entry) => entry.id));
  return ok({
    repo: opened.repository.repo,
    file,
    tasks: entries.map((entry) => taskView(entry, standings[entry.id])),
  });
}

async function claim(
  opened: Opened,
  principal: AgentPrincipal,
  raw: string,
): Promise<RpcResult<TaskClaimed>> {
  const id = BacklogTaskId.safeParse(raw);
  if (!id.success) return failure('invalid_request', 400, `"${raw}" is not a task id`);
  const { repo } = opened.repository;
  const { file, entries } = await backlogEntries(opened);
  if (file === null)
    return failure('not_found', 404, `${repo} has no backlog (${BACKLOG_FILES.join(' or ')})`);
  const entry = entries.find((candidate) => candidate.id === id.data);
  if (entry === undefined) return failure('not_found', 404, `${file} has no task ${id.data}`);
  if (entry.isTicked) return failure('conflict', 409, `task ${id.data} is ticked done in ${file}`);
  const claimed = await opened.engine.claimTask({ task: id.data, actor: principal.user.handle });
  if (!claimed.ok) return failure('conflict', 409, claimed.reason);
  return ok({ repo, task: taskView(entry, claimed.value) });
}

async function release(
  opened: Opened,
  principal: AgentPrincipal,
  raw: string,
): Promise<RpcResult<TaskClaimed>> {
  const id = BacklogTaskId.safeParse(raw);
  if (!id.success) return failure('invalid_request', 400, `"${raw}" is not a task id`);
  const { file, entries } = await backlogEntries(opened);
  const entry = entries.find((candidate) => candidate.id === id.data);
  if (file === null || entry === undefined)
    return failure('not_found', 404, `${opened.repository.repo} has no task ${id.data}`);
  const released = await opened.engine.releaseTask({
    task: id.data,
    actor: principal.user.handle,
  });
  if (!released.ok) return failure('conflict', 409, released.reason);
  return ok({ repo: opened.repository.repo, task: taskView(entry, released.value) });
}

/** The backlog file on the sprout and its tasks; none when the repository has no backlog. */
async function backlogEntries(
  opened: Opened,
): Promise<{ readonly file: string | null; readonly entries: readonly BacklogEntry[] }> {
  for (const file of BACKLOG_FILES) {
    // oxlint-disable-next-line no-await-in-loop -- the first file found wins
    const read = await opened.engine.repoFile('sprout', file);
    if (read.ok && read.value.content !== null)
      return { file, entries: parseBacklog(read.value.content) };
    if (!read.ok && read.error.status !== 404)
      throw new GatewayError(read.error.message, read.error.code, read.error.status);
  }
  return { file: null, entries: [] };
}

function taskView(entry: BacklogEntry, standing: TaskStanding | undefined): BacklogTask {
  const base = { id: entry.id, title: entry.title, detail: entry.detail };
  if (entry.isTicked) return { ...base, state: 'done', by: null, bean: null, until: null };
  return {
    ...base,
    state: standing?.state ?? 'open',
    by: standing?.by ?? null,
    bean: standing?.bean ?? null,
    until:
      standing?.untilMs === null || standing === undefined
        ? null
        : new Date(standing.untilMs).toISOString(),
  };
}

function reservationView(reservation: Reservation): NonNullable<AgentBean['reservation']> {
  return {
    bean: reservation.bean,
    actor: reservation.actor,
    intent: reservation.intent,
    task: reservation.task,
    reserved_at: new Date(reservation.reservedMs).toISOString(),
    expires_at: new Date(reservation.expiresMs).toISOString(),
  };
}

/** Opens the repository for `need`, then runs `use` on it; gateway errors become values. */
function within<T>(
  deps: Deps,
  input: Parameters<typeof openRepository>[1],
  use: (opened: Opened) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  return guarded(async () => {
    const opened = await openRepository(deps, input);
    return opened.ok ? use(opened.value) : opened;
  });
}

async function guarded<T>(use: () => Promise<RpcResult<T>>): Promise<RpcResult<T>> {
  try {
    return await use();
  } catch (error: unknown) {
    if (error instanceof GatewayError) return failure(error.code, error.status, error.message);
    throw error;
  }
}

function mapped<T, U>(result: RpcResult<T>, map: (value: T) => U): RpcResult<U> {
  return result.ok ? ok(map(result.value)) : result;
}

function inFlightRank(phase: string): number {
  const rank = IN_FLIGHT_FIRST.indexOf(phase);
  return rank === -1 ? IN_FLIGHT_FIRST.length : rank;
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}
