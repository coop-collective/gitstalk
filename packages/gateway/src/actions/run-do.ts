/**
 * ActionsRunDO: one per workflow run (doc 25 §3.1). It owns the run's job DAG (`needs`, `if`,
 * matrix legs), starts each job on the executor when its needs are done and the repository has
 * capacity (the shared RunnerCapacity pool, at most `ACTIONS_CONCURRENT_JOBS` per repository)
 * and minutes left (the monthly budget, kept by ActionsRepoDO), mints the job's token, enforces
 * the timeout with alarms, cancels, and relays the executor's log lines to watchers' sockets
 * and into R2. It never stores a log line (D9).
 */
import { DurableObject } from 'cloudflare:workers';

import type {
  ActionsConclusion,
  ActionsExecutor,
  JobLogBatch,
  JobResult,
  LogFrame,
  LogLine,
  RunDetail,
  RunSummary,
  StepView,
} from '@gitstalk/shared-race/actions';
import {
  ActionsJobId,
  ActionsRunId,
  automationIdOf,
  isAutomationPath,
} from '@gitstalk/shared-race/actions';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';

import { RUNNER_POOL_NAME } from '../capacity/runner-capacity';
import { readConfig } from '../config';
import type { Logger } from '../log';
import { createLogger } from '../log';
import type { ActionsConfig } from './actions-config';
import { readActionsConfig } from './actions-config';
import type { ExpressionContexts } from './expressions';
import type { JobState, NeedResult } from './job-graph';
import { needResult, planJobs, readiness, runConclusion } from './job-graph';
import { jobSpecOf } from './job-spec';
import { JOB_TOKEN_GRACE_MS, mintJobToken, revokeJobTokens, tokenHash } from './job-tokens';
import type { LogLocation } from './log-chunks';
import { writeLogChunk } from './log-chunks';
import { maskTermsOf, maskText } from './mask';
import type { RerunSeed, RunRequest } from './run-request';
import type { JobPatch, JobRow, ModelCalls, RunRecord } from './run-store';
import { NO_MODEL_CALLS, RunStore, jobViewOf, summaryOf } from './run-store';
import type { EntryRepo, EntryStores } from './repo-entries';
import { entryStoresOf, jobSecretCatalog, jobVariables } from './repo-entries';
import { secretsForRun } from './secrets';
import { oidcJobEnv } from './oidc';
import { newReportToken } from './tickets';
import { readWorkflowFile } from './workflow-file';

/** How often a job waiting for capacity asks again. */
const CAPACITY_RETRY_MS = 5_000;
/** How often a running job's lease is renewed and its timeout checked. */
const RUNNING_TICK_MS = 60_000;

export class ActionsRunDO extends DurableObject<Env> {
  readonly #store: RunStore;
  readonly #config: ActionsConfig;
  readonly #log: Logger;
  readonly #entries: EntryStores;
  /** Mask terms per job, in memory only (rebuilt after an eviction). */
  readonly #masks = new Map<string, readonly string[]>();
  #isAdvancing = false;
  #shouldAdvanceAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new RunStore(ctx.storage.sql);
    this.#config = readActionsConfig(env);
    this.#log = createLogger(readConfig(env).logLevel, { component: 'actions-run' });
    this.#entries = entryStoresOf(env);
  }

  /** Plans and starts the run. Idempotent: a second call returns the run as it is. */
  async start(request: RunRequest): Promise<RunSummary> {
    const existing = this.#store.run();
    if (existing !== null) return summaryOf(existing, this.#store.jobs());
    const workflow = await readWorkflowFile(request.workflow.path, request.workflow.source, {
      maxMatrixLegs: this.#config.maxMatrixLegs,
      maxTimeoutMinutes: this.#config.jobTimeoutMinutes,
    });
    const [problem] = workflow.problems;
    const refusal =
      request.refused ?? (problem === undefined ? null : `invalid workflow: ${problem.message}`);
    const vars = await jobVariables(this.#entries, entryRepoOf(request));
    const base: RunRecord = {
      request,
      vars,
      workflowName: workflow.name,
      status: 'queued',
      conclusion: null,
      reason: null,
      startedMs: null,
      completedMs: null,
      cancelRequested: false,
      modelUsage: NO_MODEL_CALLS,
    };
    if (refusal === null) {
      this.#store.insertJobs(
        planJobs(workflow, {
          contexts: contextsOf(base, this.#config.serverUrl),
          maxTimeoutMinutes: this.#config.jobTimeoutMinutes,
          newId: () => crypto.randomUUID(),
        }),
      );
      this.#store.saveRun(base);
    } else {
      const now = Date.now();
      this.#store.saveRun({
        ...base,
        status: 'completed',
        conclusion: 'startup_failure',
        reason: refusal,
        completedMs: now,
      });
    }
    await this.#writeIndex();
    if (refusal === null) await this.#kick();
    return this.#summary();
  }

  /** The beans the stalk move behind this run carried (push runs); empty otherwise. */
  async beans(): Promise<readonly string[]> {
    return this.#store.run()?.request.beans ?? [];
  }

  /** What started the run, for a re-run of it (`ActionsRepoDO.rerun`). */
  async rerunSeed(): Promise<RerunSeed | null> {
    const request = this.#store.run()?.request;
    if (request === undefined) return null;
    const { workflow, event, sha, inputs, origin, beans } = request;
    return {
      repoId: request.repo.id,
      workflow,
      event,
      sha,
      inputs,
      origin,
      ...(beans === undefined ? {} : { beans }),
      payloadJson: JSON.stringify(request.eventPayload),
    };
  }

  async summary(): Promise<RunSummary | null> {
    return this.#store.run() === null ? null : this.#summary();
  }

  async detail(): Promise<RunDetail | null> {
    const record = this.#store.run();
    if (record === null) return null;
    const jobs = this.#store.jobs();
    const automation = record.request.automation;
    return {
      ...summaryOf(record, jobs),
      jobs: jobs.map(jobViewOf),
      inputs: record.request.inputs,
      ...(automation?.model === null || automation === undefined
        ? {}
        : {
            modelUsage: {
              ...record.modelUsage,
              model: automation.model,
              limitUsd: automation.maxCostUsd,
            },
          }),
    };
  }

  // The model proxy's side (doc 25 §7.5) ---------------------------------------------------

  /** The model a running automation job may call, and what it may still spend; else why not. */
  async modelAllowance(
    jobId: string,
  ): Promise<RpcResult<{ readonly model: string; readonly remainingUsd: number }>> {
    const record = this.#store.run();
    const job = this.#store.job(jobId);
    const automation = record?.request.automation;
    if (record === null || job === null || automation === undefined || automation.model === null)
      return refused('forbidden', 403, 'this job does not run an agent');
    if (job.status !== 'in_progress')
      return refused('invalid_state', 409, 'the job is not running');
    const remainingUsd = automation.maxCostUsd - record.modelUsage.costUsd;
    if (remainingUsd <= 0)
      return refused(
        'over_limit',
        429,
        `this run's model spend reached its max-cost-usd of $${automation.maxCostUsd}`,
      );
    return { ok: true, value: { model: automation.model, remainingUsd } };
  }

  /** Adds one model call to the run's count; returns the run's totals. */
  async chargeModel(calls: ModelCalls): Promise<ModelCalls> {
    const record = this.#requireRun();
    const total: ModelCalls = {
      calls: record.modelUsage.calls + calls.calls,
      inputTokens: record.modelUsage.inputTokens + calls.inputTokens,
      outputTokens: record.modelUsage.outputTokens + calls.outputTokens,
      costUsd: record.modelUsage.costUsd + calls.costUsd,
    };
    this.#store.saveRun({ ...record, modelUsage: total });
    return total;
  }

  /** Whether the job has completed (null: no such job). */
  async jobCompleted(jobId: string): Promise<boolean | null> {
    const job = this.#store.job(jobId);
    return job === null ? null : job.status === 'completed';
  }

  /** Cancels the run: queued jobs end cancelled, running ones are stopped. */
  async cancel(): Promise<RunSummary | null> {
    const record = this.#store.run();
    if (record === null) return null;
    if (record.status === 'completed') return this.#summary();
    this.#store.saveRun({ ...record, cancelRequested: true });
    for (const job of this.#store.jobs()) {
      if (job.status === 'completed') continue;
      // oxlint-disable-next-line no-await-in-loop -- each stop releases its lease before the next
      await (job.status === 'in_progress'
        ? this.#stop(job, 'cancelled', 'cancelled by a person')
        : this.#finish(job, { conclusion: 'cancelled', reason: 'cancelled by a person' }));
    }
    await this.#kick();
    return this.#summary();
  }

  // The executor's side (through ActionsJobs, with the report token) ----------------------

  async jobSecrets(jobId: string, secret: string): Promise<RpcResult<Record<string, string>>> {
    const job = await this.#reporting(jobId, secret);
    if (!job.ok) return job;
    if (job.value.status !== 'in_progress')
      return refused('invalid_state', 409, 'the job is not running');
    return { ok: true, value: await this.#jobSecretValues(job.value) };
  }

  async jobLogs(
    jobId: string,
    secret: string,
    batch: JobLogBatch,
  ): Promise<RpcResult<{ readonly cancelRequested: boolean }>> {
    const verified = await this.#reporting(jobId, secret);
    if (!verified.ok) return verified;
    const job = verified.value;
    if (job.status === 'completed') return { ok: true, value: { cancelRequested: true } };
    if (batch.seq <= job.lastSeq) return { ok: true, value: { cancelRequested: false } };
    const terms = await this.#maskTerms(job);
    const lines = batch.lines.map((line): LogLine => ({
      ...line,
      text: maskText(line.text, terms),
    }));
    await writeLogChunk(this.env.ACTIONS_LOGS, this.#location(job.id), { seq: batch.seq, lines });
    const steps = mergeSteps(job.stepStates, batch.steps);
    this.#store.updateJob(job.id, { lastSeq: batch.seq, stepStates: steps });
    const id = ActionsJobId.parse(job.id);
    if (lines.length > 0)
      this.#broadcast(job.id, { kind: 'lines', jobId: id, seq: batch.seq, lines });
    if (batch.steps.length > 0) this.#broadcast(job.id, { kind: 'steps', jobId: id, steps });
    return { ok: true, value: { cancelRequested: this.#requireRun().cancelRequested } };
  }

  async jobFinished(
    jobId: string,
    secret: string,
    result: JobResult,
  ): Promise<RpcResult<{ readonly accepted: true }>> {
    const verified = await this.#reporting(jobId, secret);
    if (!verified.ok) return verified;
    const job = verified.value;
    if (job.status !== 'in_progress') return { ok: true, value: { accepted: true } };
    const terms = await this.#maskTerms(job);
    // An output that carries a secret is dropped, as GitHub does.
    const outputs = Object.fromEntries(
      Object.entries(result.outputs).filter(([, value]) => maskText(value, terms) === value),
    );
    await this.#finish(job, {
      conclusion: result.conclusion,
      reason: result.error,
      outputs,
      steps: result.steps.length > 0 ? result.steps : job.stepStates,
      minutes: result.minutesBilled,
    });
    await this.#kick();
    return { ok: true, value: { accepted: true } };
  }

  // Watchers --------------------------------------------------------------------------------

  /** A watcher's WebSocket for one job (the route checked the ticket). */
  override async fetch(request: Request): Promise<Response> {
    const jobId = new URL(request.url).pathname.split('/').at(-2) ?? '';
    const job = this.#store.job(jobId);
    if (job === null)
      return Response.json(
        { error: { code: 'not_found', message: 'no such job' } },
        { status: 404 },
      );
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return Response.json(
        { error: { code: 'invalid_request', message: 'expected a WebSocket upgrade' } },
        { status: 426 },
      );
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [job.id]);
    const id = ActionsJobId.parse(job.id);
    server.send(
      JSON.stringify({ kind: 'steps', jobId: id, steps: jobViewOf(job).steps } satisfies LogFrame),
    );
    server.send(
      JSON.stringify({
        kind: 'job',
        jobId: id,
        status: job.status,
        conclusion: job.conclusion,
      } satisfies LogFrame),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(): Promise<void> {
    // Watchers only listen.
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    socket.close(code === 1005 ? 1000 : code, 'closed');
  }

  override async alarm(): Promise<void> {
    await this.#kick();
  }

  // The DAG ---------------------------------------------------------------------------------

  /** Runs `#advance` once at a time; a call that arrives meanwhile makes it go round again. */
  async #kick(): Promise<void> {
    if (this.#isAdvancing) {
      this.#shouldAdvanceAgain = true;
      return;
    }
    this.#isAdvancing = true;
    try {
      do {
        this.#shouldAdvanceAgain = false;
        // oxlint-disable-next-line no-await-in-loop -- one pass at a time, by design
        await this.#advance();
      } while (this.#shouldAdvanceAgain);
    } finally {
      this.#isAdvancing = false;
    }
  }

  async #advance(): Promise<void> {
    const record = this.#store.run();
    if (record === null || record.status === 'completed') return;
    const nowMs = Date.now();
    for (const job of this.#store
      .jobs()
      .filter((candidate) => candidate.status === 'in_progress')) {
      const deadline = (job.startedMs ?? nowMs) + job.timeoutMinutes * 60_000;
      const work =
        nowMs >= deadline
          ? this.#stop(job, 'timed_out', `the job ran past its ${job.timeoutMinutes}-minute limit`)
          : this.#lease(job, nowMs);
      // oxlint-disable-next-line no-await-in-loop -- leases and stops go one job at a time
      await work;
    }
    await this.#decideQueued(record);
    await this.#rollUp();
    await this.#scheduleAlarm(Date.now());
  }

  async #decideQueued(record: RunRecord): Promise<void> {
    const budget: { minutesLeft: number | null } = { minutesLeft: null };
    // Skipping a job can unblock others, so passes repeat until nothing changes.
    for (let pass = 0; pass < 50; pass += 1) {
      let changed = false;
      for (const job of this.#store.jobs()) {
        if (job.status !== 'queued' && job.status !== 'waiting') continue;
        // oxlint-disable-next-line no-await-in-loop -- decisions depend on the previous ones
        changed = (await this.#decide(job, record, budget)) || changed;
      }
      if (!changed) return;
    }
  }

  /** Decides one queued job; true when its state changed to done or running. */
  async #decide(
    job: JobRow,
    record: RunRecord,
    budget: { minutesLeft: number | null },
  ): Promise<boolean> {
    const states = this.#store.jobs().map(stateOf);
    const ready = readiness(job, states, {
      contexts: contextsOf(record, this.#config.serverUrl),
      cancelled: record.cancelRequested,
    });
    switch (ready.kind) {
      case 'blocked':
        return false;
      case 'skip':
        await this.#finish(job, { conclusion: 'skipped', reason: null });
        return true;
      case 'error':
        await this.#finish(job, { conclusion: 'failure', reason: ready.reason });
        return true;
      case 'start':
        return this.#tryStart(job, { states, budget });
      default:
        return ready;
    }
  }

  async #tryStart(
    job: JobRow,
    input: {
      readonly states: readonly JobState[];
      readonly budget: { minutesLeft: number | null };
    },
  ): Promise<boolean> {
    if (job.image === null) {
      await this.#finish(job, {
        conclusion: 'startup_failure',
        reason: 'runs-on names no runner here (ubuntu-latest, ubuntu-24.04 and ubuntu-22.04 run)',
      });
      return true;
    }
    const record = this.#requireRun();
    input.budget.minutesLeft ??= await this.env.ACTIONS_REPOS.getByName(
      record.request.repo.id,
    ).minutesLeft();
    if (input.budget.minutesLeft <= 0) {
      await this.#finish(job, {
        conclusion: 'startup_failure',
        reason: `this repository's ${this.#config.monthlyMinutes} Actions minutes for the month are spent`,
      });
      return true;
    }
    const nowMs = Date.now();
    const waitingSince = job.waitingSinceMs ?? nowMs;
    const lease = await this.#capacity().acquire({
      engine: capacityOwner(record),
      job: job.id,
      cap: this.#config.concurrentJobs,
      base: 0,
      waitingSinceMs: waitingSince,
    });
    const current = this.#store.job(job.id);
    if (
      lease.kind === 'wait' ||
      current === null ||
      (current.status !== 'queued' && current.status !== 'waiting')
    ) {
      if (lease.kind === 'granted') await this.#release(job.id);
      else this.#store.updateJob(job.id, { status: 'waiting', waitingSinceMs: waitingSince });
      return false;
    }
    await this.#launch(current, input.states);
    return true;
  }

  /** Mints the job's tokens, marks it running, and hands it to the executor. */
  async #launch(job: JobRow, states: readonly JobState[]): Promise<void> {
    const record = this.#requireRun();
    const { request } = record;
    const nowMs = Date.now();
    const runId = ActionsRunId.parse(request.runId);
    const jobId = ActionsJobId.parse(job.id);
    const report = newReportToken(runId, jobId);
    const catalog = await jobSecretCatalog(this.#entries, entryRepoOf(request));
    const secretNames = secretsForRun(request.origin, job.secretNames, catalog.stored);
    const jobToken = await mintJobToken(this.env.FORGE, {
      repoId: request.repo.id,
      engineId: request.repo.engineId,
      runId,
      jobId,
      canPush: job.contentsWrite && request.origin.kind !== 'preland',
      expiresMs: nowMs + job.timeoutMinutes * 60_000 + JOB_TOKEN_GRACE_MS,
      automationId: isAutomationPath(request.workflow.path)
        ? automationIdOf(request.workflow.path)
        : null,
    });
    this.#masks.set(job.id, [...(await this.#maskTerms(job)), jobToken]);
    this.#store.updateJob(job.id, {
      status: 'in_progress',
      startedMs: nowMs,
      reportHash: await tokenHash(report.secret),
      waitingSinceMs: null,
    });
    if (record.startedMs === null)
      this.#store.saveRun({ ...record, status: 'in_progress', startedMs: nowMs });
    await this.#writeIndex();
    this.#broadcast(job.id, { kind: 'job', jobId, status: 'in_progress', conclusion: null });
    const spec = jobSpecOf({
      run: this.#requireRun(),
      job,
      ids: { runId, jobId },
      needs: needsOf(job, states),
      secretNames,
      vars: record.vars,
      tokens: { job: jobToken, report: report.token },
      serverUrl: this.#config.serverUrl,
      modelUrl: `${this.#config.publicUrl}/v1/automations/model`,
      oidcEnv: await oidcJobEnv({
        env: this.env,
        publicUrl: this.#config.publicUrl,
        run: this.#requireRun(),
        job,
        nowMs,
      }),
    });
    const started = await this.#executor()
      .startJob(spec)
      .catch((error: unknown) => failure(error));
    if (started.ok) return;
    this.#log.warn('executor refused a job', { runId, jobId, error: started.error.message });
    const after = this.#store.job(job.id);
    if (after?.status === 'in_progress')
      await this.#finish(after, {
        conclusion: 'infrastructure_failure',
        reason: `the executor did not start the job: ${started.error.message}`,
      });
  }

  /** Stops a running job (cancel or timeout): the executor is told, the job ends now. */
  async #stop(job: JobRow, conclusion: 'cancelled' | 'timed_out', reason: string): Promise<void> {
    const stopped = await this.#executor()
      .cancelJob(ActionsJobId.parse(job.id), conclusion)
      .catch((error: unknown) => failure(error));
    if (!stopped.ok)
      this.#log.warn('executor did not stop a job', {
        jobId: job.id,
        error: stopped.error.message,
      });
    await this.#finish(job, { conclusion, reason });
  }

  /** Ends a job: state, lease, token, minutes, watchers. */
  async #finish(
    job: JobRow,
    end: {
      readonly conclusion: ActionsConclusion;
      readonly reason: string | null;
      readonly outputs?: Readonly<Record<string, string>>;
      readonly steps?: readonly StepView[];
      readonly minutes?: number;
    },
  ): Promise<void> {
    const nowMs = Date.now();
    const patch: JobPatch = {
      status: 'completed',
      conclusion: end.conclusion,
      reason: end.reason,
      completedMs: nowMs,
      waitingSinceMs: null,
      ...(end.outputs === undefined ? {} : { outputValues: end.outputs }),
      ...(end.steps === undefined ? {} : { stepStates: end.steps }),
      ...(end.minutes === undefined ? {} : { minutes: end.minutes }),
    };
    this.#store.updateJob(job.id, patch);
    this.#masks.delete(job.id);
    const record = this.#requireRun();
    const work: Promise<unknown>[] = [];
    if (job.status === 'in_progress' || job.status === 'waiting') work.push(this.#release(job.id));
    if (job.status === 'in_progress') work.push(revokeJobTokens(this.env.FORGE, job.id, nowMs));
    if (end.minutes !== undefined && end.minutes > 0)
      work.push(this.env.ACTIONS_REPOS.getByName(record.request.repo.id).addMinutes(end.minutes));
    await Promise.all(work);
    this.#broadcast(job.id, {
      kind: 'job',
      jobId: ActionsJobId.parse(job.id),
      status: 'completed',
      conclusion: end.conclusion,
    });
  }

  async #rollUp(): Promise<void> {
    const record = this.#requireRun();
    if (record.status === 'completed') return;
    const jobs = this.#store.jobs();
    const conclusion = runConclusion(jobs.map(stateOf), record.cancelRequested);
    if (conclusion === null) return;
    const failed = jobs.find((job) => job.conclusion === conclusion && job.reason !== null);
    this.#store.saveRun({
      ...record,
      status: 'completed',
      conclusion,
      reason: record.cancelRequested ? 'cancelled' : (failed?.reason ?? null),
      completedMs: Date.now(),
    });
    await this.#writeIndex();
    // Watchers have their job's final frame; their sockets close with the run.
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'run completed');
    await this.#tellAutomationEnded(record);
  }

  /** An automation runs one at a time: its repository starts the next waiting trigger. */
  async #tellAutomationEnded(record: RunRecord): Promise<void> {
    const { request } = record;
    if (!isAutomationPath(request.workflow.path)) return;
    await this.env.ACTIONS_REPOS.getByName(request.repo.id)
      .automationEnded({ path: request.workflow.path, runId: request.runId })
      .catch((error: unknown) => {
        // The repository also frees an automation whose recorded run has completed.
        this.#log.warn('automation end not told', { runId: request.runId, error });
      });
  }

  async #scheduleAlarm(nowMs: number): Promise<void> {
    const record = this.#requireRun();
    if (record.status === 'completed') {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const jobs = this.#store.jobs();
    const times: number[] = [];
    if (jobs.some((job) => job.status === 'waiting')) times.push(nowMs + CAPACITY_RETRY_MS);
    for (const job of jobs.filter((candidate) => candidate.status === 'in_progress'))
      times.push(
        Math.min((job.startedMs ?? nowMs) + job.timeoutMinutes * 60_000, nowMs + RUNNING_TICK_MS),
      );
    // A run with nothing running or waiting still checks in, in case a call was lost.
    await this.ctx.storage.setAlarm(
      times.length === 0 ? nowMs + RUNNING_TICK_MS : Math.min(...times),
    );
  }

  // Helpers ---------------------------------------------------------------------------------

  async #reporting(jobId: string, secret: string): Promise<RpcResult<JobRow>> {
    const job = this.#store.job(jobId);
    if (job?.reportHash === null || job === null || job.reportHash !== (await tokenHash(secret)))
      return refused('unauthorized', 401, 'unknown job or report token');
    return { ok: true, value: job };
  }

  async #maskTerms(job: JobRow): Promise<readonly string[]> {
    const known = this.#masks.get(job.id);
    if (known !== undefined) return known;
    const terms = maskTermsOf(Object.values(await this.#jobSecretValues(job)));
    this.#masks.set(job.id, terms);
    return terms;
  }

  /** The values of the secrets `job` may read: repository and org ones, filtered by D4. */
  async #jobSecretValues(job: JobRow): Promise<Record<string, string>> {
    const { request } = this.#requireRun();
    const catalog = await jobSecretCatalog(this.#entries, entryRepoOf(request));
    return catalog.reveal(secretsForRun(request.origin, job.secretNames, catalog.stored));
  }

  async #lease(job: JobRow, nowMs: number): Promise<void> {
    await this.#capacity().acquire({
      engine: capacityOwner(this.#requireRun()),
      job: job.id,
      cap: this.#config.concurrentJobs,
      base: 0,
      waitingSinceMs: nowMs,
    });
  }

  async #release(jobId: string): Promise<void> {
    await this.#capacity().release({ engine: capacityOwner(this.#requireRun()), job: jobId });
  }

  #capacity() {
    return this.env.RUNNER_CAPACITY.getByName(RUNNER_POOL_NAME);
  }

  #executor(): ActionsExecutor {
    if (this.#config.executorMode === 'service') {
      const binding: unknown = Reflect.get(this.env, 'ACTIONS_EXECUTOR');
      if (!isExecutor(binding))
        throw new Error(
          'ACTIONS_EXECUTOR_MODE is service but there is no ACTIONS_EXECUTOR binding',
        );
      return binding;
    }
    const stub = this.ctx.exports.StubActionsExecutor;
    return {
      startJob: async (spec) => stub.startJob(spec),
      cancelJob: async (jobId, reason) => stub.cancelJob(jobId, reason),
      forgetRepository: async (repoId) => stub.forgetRepository(repoId),
    };
  }

  #broadcast(jobId: string, frame: LogFrame): void {
    const text = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets(jobId)) {
      try {
        socket.send(text);
      } catch {
        // A socket that closed meanwhile has nobody to tell.
      }
    }
  }

  #location(jobId: string): LogLocation {
    const { request } = this.#requireRun();
    return { ownerId: request.repo.ownerId, repoId: request.repo.id, runId: request.runId, jobId };
  }

  #requireRun(): RunRecord {
    const record = this.#store.run();
    if (record === null) throw new Error('the run has not started');
    return record;
  }

  #summary(): RunSummary {
    return summaryOf(this.#requireRun(), this.#store.jobs());
  }

  async #writeIndex(): Promise<void> {
    const summary = this.#summary();
    const { request } = this.#requireRun();
    await this.env.FORGE.prepare(
      `INSERT INTO actions_runs (id, repo_id, number, workflow_path, workflow_name, event, ref, sha,
         status, conclusion, reason, actor, created_at, created_ms, started_at, completed_at, minutes_billed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, conclusion = excluded.conclusion,
         reason = excluded.reason, started_at = excluded.started_at,
         completed_at = excluded.completed_at, minutes_billed = excluded.minutes_billed`,
    )
      .bind(
        summary.id,
        summary.repoId,
        summary.number,
        summary.workflowPath,
        summary.workflowName,
        summary.event,
        summary.ref,
        summary.sha,
        summary.status,
        summary.conclusion,
        summary.reason,
        summary.actor,
        summary.createdAt,
        request.createdMs,
        summary.startedAt,
        summary.completedAt,
        summary.minutesBilled,
      )
      .run();
  }
}

/** The expression contexts a run's jobs see: `github`, `inputs`, `vars`. */
export function contextsOf(
  record: Pick<RunRecord, 'request' | 'vars'>,
  publicUrl: string,
): ExpressionContexts {
  const { request } = record;
  const fullName = `${request.repo.ownerHandle}/${request.repo.name}`;
  return {
    github: {
      event_name: request.event,
      ref: 'refs/heads/main',
      ref_name: 'main',
      sha: request.sha,
      actor: request.actor,
      repository: fullName,
      repository_owner: request.repo.ownerHandle,
      run_id: request.runId,
      run_number: request.number,
      server_url: publicUrl,
      workflow: request.workflow.path,
      event: JSON.parse(JSON.stringify(request.eventPayload)),
    },
    inputs: request.inputs,
    vars: { ...record.vars },
  };
}

/** The run's repository as secret and variable resolution sees it. */
function entryRepoOf(request: RunRequest): EntryRepo {
  const { repo } = request;
  return {
    id: repo.id,
    visibility: repo.visibility,
    owner: { id: repo.ownerId, handle: repo.ownerHandle },
  };
}

/** The repository's owner key in the RunnerCapacity pool: its Actions jobs, apart from its checks. */
function capacityOwner(record: RunRecord): string {
  return `actions:${record.request.repo.id}`;
}

/** A job as the DAG sees it: its reported outputs, not the expressions that make them. */
function stateOf(job: JobRow): JobState {
  return {
    key: job.key,
    status: job.status,
    conclusion: job.conclusion,
    outputs: job.outputValues,
  };
}

function needsOf(job: JobRow, states: readonly JobState[]): Record<string, NeedResult> {
  const needs: Record<string, NeedResult> = {};
  for (const key of job.needs) {
    const result = needResult(states, key);
    if (result !== null) needs[key] = result;
  }
  return needs;
}

/** Steps as the executor reports them, folded into what the job already had, by number. */
function mergeSteps(known: readonly StepView[], updates: readonly StepView[]): StepView[] {
  const byNumber = new Map(known.map((step) => [step.number, step]));
  for (const step of updates) byNumber.set(step.number, step);
  return [...byNumber.values()].toSorted((a, b) => a.number - b.number);
}

function isExecutor(value: unknown): value is ActionsExecutor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'startJob') === 'function' &&
    typeof Reflect.get(value, 'cancelJob') === 'function'
  );
}

function refused<T>(code: string, status: number, message: string): RpcResult<T> {
  const error: RpcError = { code, status, message };
  return { ok: false, error };
}

function failure(error: unknown): { readonly ok: false; readonly error: RpcError } {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'upstream_failed', status: 502, message } };
}
