/**
 * ActionsRepoDO: one per repository (doc 25 §3.1). When the stalk moves (the repo-events
 * consumer calls `stalkMoved`), it re-reads `.github/workflows/` at the new head, rewrites the
 * D1 index, refreshes the schedules (alarms) and starts the runs `push` asks for. It also
 * starts `workflow_dispatch` and `schedule` runs, numbers runs per workflow, and keeps the
 * month's Actions minutes against the repository's budget (D9).
 *
 * Stalk moves are queued in its storage first, so a failure (Artifacts down) is retried by the
 * alarm and a redelivered event starts nothing twice.
 */
import { DurableObject } from 'cloudflare:workers';

import type {
  ActionsEvent,
  RunSummary,
  WorkflowSummary,
  WorkflowTrigger,
} from '@gitstalk/shared-race/actions';
import { ACTIONS_EVENTS, ActionsRunId, isAutomationPath } from '@gitstalk/shared-race/actions';
import { RepoEvent } from '@gitstalk/shared-race/repo-events';
import type { RpcResult } from '@gitstalk/shared-race/rpc';
import { z } from 'zod';

import type { RepoExplorer } from '../adapters/repo-explorer';
import { repoExplorer } from '../adapters/repo-explorer';
import { readConfig } from '../config';
import type { Logger } from '../log';
import { createLogger } from '../log';
import { d1Registry } from '../repos/registry';
import type { ActionsConfig } from './actions-config';
import { readActionsConfig } from './actions-config';
import type { Occurrence } from './automation-triggers';
import { automationFires, occurrenceOf, occurrencePayload } from './automation-triggers';
import { MIN_SCHEDULE_INTERVAL_MS, nextFireMs, parseCron } from '@gitstalk/shared-race/cron';
import type { RepoFacts } from './event-payload';
import { dispatchPayload, pushPayload, schedulePayload } from './event-payload';
import type { RunRequest } from './run-request';
import type { RunOrigin } from './secrets';
import { checkDispatchInputs, pushFires } from './triggers';
import type { IndexedWorkflow } from './workflow-index';
import { indexedSource, listIndexed, readWorkflows, writeIndex } from './workflow-index';

/** A stalk move that could not be processed is tried again after this. */
const RETRY_MS = 30_000;

/** The stalk moved (from `stalk.promoted`). */
export type StalkMoved = {
  readonly repoId: string;
  readonly sha: string;
  readonly seq: number;
  readonly beans: readonly string[];
};

export type DispatchRequest = {
  readonly repoId: string;
  readonly workflowPath: string;
  readonly inputs: Readonly<Record<string, string | number | boolean>>;
  readonly actor: string;
};

/** Repository events for automations (doc 25 §7.2), from the repo-events consumer. */
export type RepoEventsForAutomations = {
  readonly repoId: string;
  readonly events: readonly RepoEvent[];
};

/** A trigger an automation will run for, once its current run ends (§7.7: one at a time). */
const AutomationStart = z.object({
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
  actor: z.string(),
  origin: z.enum(['dispatch', 'schedule', 'event']),
});
type AutomationStart = Omit<z.infer<typeof AutomationStart>, 'event'> & {
  readonly event: ActionsEvent;
};

/** A stored run's event payload, as a re-run reads it back. */
const Payload = z.record(z.string(), z.unknown());

const PendingRow = z.object({ seq: z.number(), sha: z.string(), beans_json: z.string() });
const EventRow = z.object({ seq: z.number(), event_json: z.string() });
const AutomationRunRow = z.object({
  path: z.string(),
  run_id: z.string().nullable(),
  waiting_json: z.string().nullable(),
});
const ScheduleRow = z.object({
  path: z.string(),
  cron: z.string(),
  next_ms: z.number(),
  last_ms: z.number().nullable(),
});

export class ActionsRepoDO extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #config: ActionsConfig;
  readonly #log: Logger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#config = readActionsConfig(env);
    this.#log = createLogger(readConfig(env).logLevel, { component: 'actions-repo' });
    migrate(this.#sql);
  }

  /** Queues a stalk move; the alarm indexes and triggers it. Idempotent per sequence number. */
  async stalkMoved(move: StalkMoved): Promise<void> {
    this.#remember('repo_id', move.repoId);
    this.#sql.exec(
      'INSERT OR IGNORE INTO pending (seq, sha, beans_json) VALUES (?, ?, ?)',
      move.seq,
      move.sha,
      JSON.stringify(move.beans),
    );
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Queues repository events; the alarm starts the automations they trigger. Idempotent per seq. */
  async repoEvents(input: RepoEventsForAutomations): Promise<void> {
    this.#remember('repo_id', input.repoId);
    for (const event of input.events)
      this.#sql.exec(
        'INSERT OR IGNORE INTO pending_events (seq, event_json) VALUES (?, ?)',
        event.seq,
        JSON.stringify(event),
      );
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** An automation's run ended: the trigger that waited for it (the latest one) starts now. */
  async automationEnded(input: { readonly path: string; readonly runId: string }): Promise<void> {
    const row = this.#automationRow(input.path);
    if (row?.run_id !== input.runId) return;
    this.#sql.exec('UPDATE automation_runs SET run_id = NULL WHERE path = ?', input.path);
    if (row.waiting_json === null) return;
    this.#sql.exec('UPDATE automation_runs SET waiting_json = NULL WHERE path = ?', input.path);
    const parsed = AutomationStart.parse(JSON.parse(row.waiting_json));
    await this.#startAutomation(input.path, { ...parsed, event: actionsEventOf(parsed.event) });
  }

  /** Starts a `workflow_dispatch` run on the stalk's copy of the workflow. */
  async dispatch(request: DispatchRequest): Promise<RpcResult<RunSummary>> {
    this.#remember('repo_id', request.repoId);
    const facts = await this.#facts(request.repoId);
    if (facts === null) return invalid('not_found', 404, 'repository not found');
    const summary = (await listIndexed(this.env.FORGE, request.repoId)).find(
      (workflow) => workflow.path === request.workflowPath,
    );
    const indexed = await indexedSource(this.env.FORGE, request.repoId, request.workflowPath);
    if (summary === undefined || indexed === null)
      return invalid('not_found', 404, `no workflow ${request.workflowPath} on the stalk`);
    if (summary.state !== 'active')
      return invalid('invalid_state', 409, `${request.workflowPath} is not valid`);
    const trigger = summary.triggers.find((candidate) => candidate.kind === 'workflow_dispatch');
    if (trigger?.kind !== 'workflow_dispatch')
      return invalid(
        'invalid_request',
        400,
        `${request.workflowPath} has no workflow_dispatch trigger`,
      );
    const inputs = checkDispatchInputs(trigger.inputs, request.inputs);
    if (!inputs.ok) return invalid('invalid_request', 400, inputs.error);
    if ((await this.minutesLeft()) <= 0)
      return invalid(
        'over_limit',
        429,
        `this repository's ${this.#config.monthlyMinutes} Actions minutes for the month are used`,
      );
    if (isAutomationPath(request.workflowPath)) return this.#dispatchAutomation(request, facts);
    const run = await this.#createRun({
      facts,
      workflow: { path: request.workflowPath, source: indexed.source },
      event: 'workflow_dispatch',
      payload: dispatchPayload({
        repo: facts,
        publicUrl: this.#config.serverUrl,
        workflowPath: request.workflowPath,
        inputs: inputs.inputs,
        actor: request.actor,
      }),
      sha: indexed.sha,
      actor: request.actor,
      inputs: inputs.inputs,
      origin: { kind: 'dispatch' },
    });
    return { ok: true, value: run };
  }

  /**
   * Runs a finished run again as a new run: the same workflow file (as it was then), commit,
   * event, payload and inputs, by `actor`. Automations re-run through their own trigger (one at
   * a time), so they are refused here.
   */
  async rerun(request: {
    readonly repoId: string;
    readonly runId: string;
    readonly actor: string;
  }): Promise<RpcResult<RunSummary>> {
    this.#remember('repo_id', request.repoId);
    const previous = await this.env.ACTIONS_RUNS.getByName(request.runId).rerunSeed();
    const facts = await this.#facts(request.repoId);
    if (previous === null || facts === null || previous.repoId !== request.repoId)
      return invalid('not_found', 404, `run ${request.runId} not found`);
    if (isAutomationPath(previous.workflow.path))
      return invalid(
        'invalid_request',
        400,
        'an automation re-runs by running it again (automation_run), one run at a time',
      );
    if ((await this.minutesLeft()) <= 0)
      return invalid(
        'over_limit',
        429,
        `this repository's ${this.#config.monthlyMinutes} Actions minutes for the month are used`,
      );
    const run = await this.#createRun({
      facts,
      workflow: previous.workflow,
      event: previous.event,
      payload: Payload.parse(JSON.parse(previous.payloadJson)),
      sha: previous.sha,
      actor: request.actor,
      inputs: previous.inputs,
      origin: previous.origin,
      beans: previous.beans,
    });
    return { ok: true, value: run };
  }

  /**
   * The repository was deleted: no more workflow or automation schedules, queued stalk moves
   * and events, or alarms (a schedule's alarm would otherwise wake the object at every tick to
   * find no repository, doc 25 §7.11). The workflow and automation index rows go with the
   * registry's (`actions_workflows`). Idempotent.
   */
  async forget(): Promise<void> {
    const tables = [
      'pending',
      'pending_events',
      'handled',
      'schedules',
      'numbers',
      'automation_runs',
    ];
    for (const table of tables) this.#sql.exec(`DELETE FROM ${table}`);
    await this.ctx.storage.deleteAlarm();
  }

  /** Minutes the repository may still use this month (negative when over). */
  async minutesLeft(): Promise<number> {
    return this.#config.monthlyMinutes - this.#usedMinutes();
  }

  /** The month's automation model spend against the repository's cap (doc 25 §7.5). */
  async automationSpend(): Promise<{ readonly spentUsd: number; readonly limitUsd: number }> {
    const row = this.#sql
      .exec<{ usd: number }>('SELECT usd FROM model_spend WHERE month = ?', monthOf(Date.now()))
      .toArray()[0];
    return { spentUsd: row?.usd ?? 0, limitUsd: this.#config.automationsMonthlyUsd };
  }

  async addAutomationSpend(usd: number): Promise<void> {
    this.#sql.exec(
      `INSERT INTO model_spend (month, usd) VALUES (?, ?)
       ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd`,
      monthOf(Date.now()),
      usd,
    );
  }

  async addMinutes(minutes: number): Promise<void> {
    this.#sql.exec(
      `INSERT INTO usage (month, minutes) VALUES (?, ?)
       ON CONFLICT(month) DO UPDATE SET minutes = minutes + excluded.minutes`,
      monthOf(Date.now()),
      minutes,
    );
  }

  /** The month's usage, for Settings and operators. */
  async usage(): Promise<{
    readonly month: string;
    readonly minutes: number;
    readonly limit: number;
  }> {
    return {
      month: monthOf(Date.now()),
      minutes: this.#usedMinutes(),
      limit: this.#config.monthlyMinutes,
    };
  }

  override async alarm(): Promise<void> {
    const stalkFailed = await this.#drainPending();
    const failed = stalkFailed || (await this.#drainEvents());
    await this.#fireSchedules(Date.now());
    const next = this.#sql
      .exec<{ next: number | null }>('SELECT MIN(next_ms) AS next FROM schedules')
      .one().next;
    const times = [...(next === null ? [] : [next]), ...(failed ? [Date.now() + RETRY_MS] : [])];
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
  }

  // Stalk moves -----------------------------------------------------------------------------

  /** Processes queued stalk moves in order; true when one failed (it stays queued). */
  async #drainPending(): Promise<boolean> {
    const rows = this.#sql.exec('SELECT seq, sha, beans_json FROM pending ORDER BY seq').toArray();
    for (const raw of rows) {
      const row = PendingRow.parse(raw);
      try {
        // oxlint-disable-next-line no-await-in-loop -- stalk moves are handled in order
        await this.#onStalk(row.sha, z.array(z.string()).parse(JSON.parse(row.beans_json)));
        this.#sql.exec('DELETE FROM pending WHERE seq = ?', row.seq);
      } catch (error: unknown) {
        this.#log.error('stalk move not indexed; retrying', { sha: row.sha, error });
        return true;
      }
    }
    return false;
  }

  async #onStalk(sha: string, beans: readonly string[]): Promise<void> {
    const repoId = this.#recall('repo_id');
    if (
      repoId === null ||
      this.#sql.exec('SELECT 1 FROM handled WHERE sha = ?', sha).toArray().length > 0
    )
      return;
    const record = await d1Registry(this.env.FORGE).byId(repoId);
    if (record === null) return;
    const facts = factsOf(record);
    const explorer = repoExplorer(this.env.REPOS, record.artifacts_repo);
    const workflows = await readWorkflows(explorer, sha, {
      maxMatrixLegs: this.#config.maxMatrixLegs,
      maxTimeoutMinutes: this.#config.jobTimeoutMinutes,
    });
    await writeIndex(this.env.FORGE, repoId, workflows);
    this.#syncSchedules(workflows, Date.now());
    const before = this.#recall('stalk_sha');
    const changedPaths = before === null ? null : await changedBetween(explorer, before, sha);
    const actor = await this.#pusher(repoId, beans);
    const firing = workflows.filter(
      (workflow) =>
        workflow.summary.state === 'active' &&
        workflow.file.triggers.some((trigger) =>
          isPushFiring(trigger, { defaultBranch: facts.defaultBranch, changedPaths }),
        ),
    );
    for (const workflow of firing) {
      // oxlint-disable-next-line no-await-in-loop -- run numbers are given in order
      await this.#createRun({
        facts,
        workflow: { path: workflow.summary.path, source: workflow.source },
        event: 'push',
        payload: pushPayload({
          repo: facts,
          publicUrl: this.#config.serverUrl,
          before,
          after: sha,
          actor,
          beans,
        }),
        sha,
        actor,
        inputs: {},
        origin: { kind: 'stalk' },
        beans,
      });
    }
    this.#remember('stalk_sha', sha);
    this.#sql.exec('INSERT OR IGNORE INTO handled (sha) VALUES (?)', sha);
    this.#log.info('stalk indexed', {
      repoId,
      sha,
      workflows: workflows.length,
      runs: firing.length,
    });
  }

  /** Who moved the stalk: the author of the newest bean it carries, as the index knows it. */
  async #pusher(repoId: string, beans: readonly string[]): Promise<string> {
    const bean = beans.at(-1);
    if (bean === undefined) return 'gitstalk';
    const row = await this.env.FORGE.prepare(
      'SELECT actor FROM beans WHERE repo_id = ? AND bean = ?',
    )
      .bind(repoId, bean)
      .first<{ actor: string | null }>();
    return row?.actor ?? 'gitstalk';
  }

  // Schedules -------------------------------------------------------------------------------

  #syncSchedules(workflows: readonly IndexedWorkflow[], nowMs: number): void {
    const wanted = workflows.flatMap((workflow) =>
      workflow.summary.state !== 'active'
        ? []
        : workflow.file.triggers.flatMap((trigger) =>
            trigger.kind === 'schedule'
              ? trigger.crons
                  .filter((cron) => parseCron(cron) !== null)
                  .map((cron) => ({ path: workflow.summary.path, cron }))
              : [],
          ),
    );
    const existing = this.#schedules();
    for (const old of existing)
      if (!wanted.some((schedule) => schedule.path === old.path && schedule.cron === old.cron))
        this.#sql.exec('DELETE FROM schedules WHERE path = ? AND cron = ?', old.path, old.cron);
    for (const schedule of wanted) {
      if (existing.some((old) => old.path === schedule.path && old.cron === schedule.cron))
        continue;
      const next = nextAllowed(schedule.cron, nowMs, null);
      if (next !== null)
        this.#sql.exec(
          'INSERT INTO schedules (path, cron, next_ms, last_ms) VALUES (?, ?, ?, NULL)',
          schedule.path,
          schedule.cron,
          next,
        );
    }
  }

  async #fireSchedules(nowMs: number): Promise<void> {
    const due = this.#schedules().filter((schedule) => schedule.next_ms <= nowMs);
    const repoId = this.#recall('repo_id');
    if (due.length === 0 || repoId === null) return;
    const facts = await this.#facts(repoId);
    for (const schedule of due) {
      const next = nextAllowed(schedule.cron, nowMs, nowMs);
      this.#sql.exec(
        'UPDATE schedules SET next_ms = ?, last_ms = ? WHERE path = ? AND cron = ?',
        next ?? Number.MAX_SAFE_INTEGER,
        nowMs,
        schedule.path,
        schedule.cron,
      );
      if (facts === null) continue;
      if (isAutomationPath(schedule.path)) {
        // oxlint-disable-next-line no-await-in-loop -- one schedule at a time
        await this.#startAutomation(schedule.path, {
          event: 'schedule',
          payload: schedulePayload({
            repo: facts,
            publicUrl: this.#config.serverUrl,
            cron: schedule.cron,
          }),
          actor: 'schedule',
          origin: 'schedule',
        });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one schedule at a time
      const indexed = await indexedSource(this.env.FORGE, repoId, schedule.path);
      if (indexed === null) continue;
      // oxlint-disable-next-line no-await-in-loop -- run numbers are given in order
      await this.#createRun({
        facts,
        workflow: { path: schedule.path, source: indexed.source },
        event: 'schedule',
        payload: schedulePayload({
          repo: facts,
          publicUrl: this.#config.serverUrl,
          cron: schedule.cron,
        }),
        sha: indexed.sha,
        actor: 'schedule',
        inputs: {},
        origin: { kind: 'schedule' },
      });
    }
  }

  #schedules(): z.infer<typeof ScheduleRow>[] {
    return this.#sql
      .exec('SELECT path, cron, next_ms, last_ms FROM schedules')
      .toArray()
      .map((row) => ScheduleRow.parse(row));
  }

  // Automations (doc 25 §7) ----------------------------------------------------------------

  /** A manual run of an automation: refused while one runs (an automation runs one at a time). */
  async #dispatchAutomation(
    request: DispatchRequest,
    facts: RepoFacts,
  ): Promise<RpcResult<RunSummary>> {
    if (await this.#isAutomationBusy(request.workflowPath))
      return invalid(
        'invalid_state',
        409,
        `${request.workflowPath} is running; an automation runs one at a time`,
      );
    const started = await this.#startAutomation(request.workflowPath, {
      event: 'workflow_dispatch',
      payload: dispatchPayload({
        repo: facts,
        publicUrl: this.#config.serverUrl,
        workflowPath: request.workflowPath,
        inputs: {},
        actor: request.actor,
      }),
      actor: request.actor,
      origin: 'dispatch',
    });
    return started === null
      ? invalid('invalid_state', 409, `${request.workflowPath} could not start`)
      : { ok: true, value: started };
  }

  /**
   * A test run of a draft automation (the builder's "Test run", doc 25 §7.13): the draft's
   * compiled job runs once by hand on the stalk head, as a manual run of its path, without the
   * file being saved. The caller checked the maintain role and compiled the draft (without a
   * memory save step, so a test never writes the automation's memory). One at a time per path,
   * like any run of the automation.
   */
  async testAutomation(request: {
    readonly repoId: string;
    readonly path: string;
    readonly source: string;
    readonly sha: string;
    readonly actor: string;
    readonly automation: NonNullable<RunRequest['automation']>;
  }): Promise<RpcResult<RunSummary>> {
    this.#remember('repo_id', request.repoId);
    const facts = await this.#facts(request.repoId);
    if (facts === null) return invalid('not_found', 404, 'repository not found');
    if ((await this.minutesLeft()) <= 0)
      return invalid(
        'over_limit',
        429,
        `this repository's ${this.#config.monthlyMinutes} Actions minutes for the month are used`,
      );
    if (await this.#isAutomationBusy(request.path))
      return invalid(
        'invalid_state',
        409,
        `${request.path} is running; an automation runs one at a time`,
      );
    const run = await this.#createRun({
      automation: request.automation,
      facts,
      workflow: { path: request.path, source: request.source },
      event: 'workflow_dispatch',
      payload: dispatchPayload({
        repo: facts,
        publicUrl: this.#config.serverUrl,
        workflowPath: request.path,
        inputs: {},
        actor: request.actor,
      }),
      sha: request.sha,
      actor: request.actor,
      inputs: {},
      origin: { kind: 'dispatch' },
    });
    this.#sql.exec(
      `INSERT INTO automation_runs (path, run_id, waiting_json) VALUES (?, ?, NULL)
       ON CONFLICT(path) DO UPDATE SET run_id = excluded.run_id`,
      request.path,
      run.status === 'completed' ? null : run.id,
    );
    return { ok: true, value: run };
  }

  /** Starts the automations queued repository events trigger, in order; true when it failed. */
  async #drainEvents(): Promise<boolean> {
    const rows = this.#sql
      .exec('SELECT seq, event_json FROM pending_events ORDER BY seq')
      .toArray()
      .map((raw) => EventRow.parse(raw));
    const repoId = this.#recall('repo_id');
    if (rows.length === 0 || repoId === null) return false;
    try {
      const [automations, facts] = await Promise.all([
        listIndexed(this.env.FORGE, repoId).then((all) =>
          all.filter(
            (workflow) => workflow.automation !== undefined && workflow.state === 'active',
          ),
        ),
        this.#facts(repoId),
      ]);
      for (const row of rows) {
        const event = RepoEvent.safeParse(JSON.parse(row.event_json));
        if (event.success && facts !== null && automations.length > 0)
          // oxlint-disable-next-line no-await-in-loop -- events start automations in order
          await this.#onEvent(repoId, facts, { automations, event: event.data });
        this.#sql.exec('DELETE FROM pending_events WHERE seq = ?', row.seq);
      }
      return false;
    } catch (error: unknown) {
      this.#log.error('repository events not applied to automations; retrying', { error });
      return true;
    }
  }

  async #onEvent(
    repoId: string,
    facts: RepoFacts,
    input: { readonly automations: readonly WorkflowSummary[]; readonly event: RepoEvent },
  ): Promise<void> {
    const occurrence = await this.#withActor(repoId, occurrenceOf(input.event));
    for (const automation of input.automations) {
      const info = automation.automation;
      if (info === undefined || !automationFires(automation.triggers, occurrence, info.actor))
        continue;
      // oxlint-disable-next-line no-await-in-loop -- run numbers are given in order
      await this.#startAutomation(automation.path, {
        event: occurrence.event,
        payload: occurrencePayload({ repo: facts, publicUrl: this.#config.serverUrl, occurrence }),
        actor: occurrence.actor ?? 'gitstalk',
        origin: 'event',
      });
    }
  }

  /** The event's actor, from the bean index when the event itself does not name one. */
  async #withActor(repoId: string, occurrence: Occurrence): Promise<Occurrence> {
    if (occurrence.actor !== null || occurrence.bean === null) return occurrence;
    const row = await this.env.FORGE.prepare(
      'SELECT actor FROM beans WHERE repo_id = ? AND bean = ?',
    )
      .bind(repoId, occurrence.bean)
      .first<{ actor: string | null }>();
    return { ...occurrence, actor: row?.actor ?? null };
  }

  /**
   * Starts an automation's run on the stalk's copy, or, while one is running, keeps this
   * trigger as the one to run next (a later trigger replaces it: events coalesce). Returns the
   * run, or null when it waits.
   */
  async #startAutomation(path: string, start: AutomationStart): Promise<RunSummary | null> {
    const repoId = this.#recall('repo_id');
    if (repoId === null) return null;
    if (await this.#isAutomationBusy(path)) {
      this.#sql.exec(
        `INSERT INTO automation_runs (path, run_id, waiting_json) VALUES (?, NULL, ?)
         ON CONFLICT(path) DO UPDATE SET waiting_json = excluded.waiting_json`,
        path,
        JSON.stringify(start),
      );
      this.#log.info('automation trigger waits for the running one', { path, event: start.event });
      return null;
    }
    const [facts, indexed, summaries] = await Promise.all([
      this.#facts(repoId),
      indexedSource(this.env.FORGE, repoId, path),
      listIndexed(this.env.FORGE, repoId),
    ]);
    const info = summaries.find((summary) => summary.path === path)?.automation;
    if (facts === null || indexed === null || info === undefined) return null;
    const run = await this.#createRun({
      automation: { model: info.model, maxCostUsd: info.maxCostUsd },
      facts,
      workflow: { path, source: indexed.source },
      event: start.event,
      payload: start.payload,
      sha: indexed.sha,
      actor: start.actor,
      inputs: {},
      origin: { kind: start.origin },
    });
    this.#sql.exec(
      `INSERT INTO automation_runs (path, run_id, waiting_json) VALUES (?, ?, NULL)
       ON CONFLICT(path) DO UPDATE SET run_id = excluded.run_id`,
      path,
      run.status === 'completed' ? null : run.id,
    );
    return run;
  }

  /** Whether the automation has a run that has not completed (checked against the run index). */
  async #isAutomationBusy(path: string): Promise<boolean> {
    const runId = this.#automationRow(path)?.run_id ?? null;
    if (runId === null) return false;
    const row = await this.env.FORGE.prepare('SELECT status FROM actions_runs WHERE id = ?')
      .bind(runId)
      .first<{ status: string }>();
    if (row !== null && row.status !== 'completed') return true;
    this.#sql.exec('UPDATE automation_runs SET run_id = NULL WHERE path = ?', path);
    return false;
  }

  #automationRow(path: string): z.infer<typeof AutomationRunRow> | null {
    const raw = this.#sql
      .exec('SELECT path, run_id, waiting_json FROM automation_runs WHERE path = ?', path)
      .toArray()[0];
    return raw === undefined ? null : AutomationRunRow.parse(raw);
  }

  // Runs ------------------------------------------------------------------------------------

  async #createRun(input: {
    readonly facts: RepoFacts;
    readonly workflow: { readonly path: string; readonly source: string };
    readonly event: ActionsEvent;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly sha: string;
    readonly actor: string;
    readonly inputs: Readonly<Record<string, string>>;
    readonly origin: RunOrigin;
    readonly automation?: RunRequest['automation'];
    readonly beans?: readonly string[] | undefined;
  }): Promise<RunSummary> {
    const number = this.#nextNumber(input.workflow.path);
    const left = await this.minutesLeft();
    const request: RunRequest = {
      runId: ActionsRunId.parse(crypto.randomUUID()),
      number,
      repo: input.facts,
      workflow: input.workflow,
      event: input.event,
      eventPayload: input.payload,
      sha: input.sha,
      actor: input.actor,
      inputs: input.inputs,
      origin: input.origin,
      ...(input.automation === undefined ? {} : { automation: input.automation }),
      ...(input.beans === undefined ? {} : { beans: input.beans }),
      refused:
        left > 0
          ? null
          : `this repository's ${this.#config.monthlyMinutes} Actions minutes for the month are spent`,
      createdMs: Date.now(),
    };
    return this.env.ACTIONS_RUNS.getByName(request.runId).start(request);
  }

  #nextNumber(path: string): number {
    return this.#sql
      .exec<{ n: number }>(
        `INSERT INTO numbers (path, n) VALUES (?, 1)
         ON CONFLICT(path) DO UPDATE SET n = n + 1 RETURNING n`,
        path,
      )
      .one().n;
  }

  #usedMinutes(): number {
    const row = this.#sql
      .exec<{ minutes: number }>('SELECT minutes FROM usage WHERE month = ?', monthOf(Date.now()))
      .toArray()[0];
    return row?.minutes ?? 0;
  }

  async #facts(repoId: string): Promise<RepoFacts | null> {
    const record = await d1Registry(this.env.FORGE).byId(repoId);
    return record === null ? null : factsOf(record);
  }

  #remember(key: string, value: string): void {
    this.#sql.exec(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  #recall(key: string): string | null {
    const row = this.#sql
      .exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)
      .toArray()[0];
    return row?.value ?? null;
  }
}

function migrate(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec(
    'CREATE TABLE IF NOT EXISTS pending (seq INTEGER PRIMARY KEY, sha TEXT NOT NULL, beans_json TEXT NOT NULL)',
  );
  sql.exec('CREATE TABLE IF NOT EXISTS handled (sha TEXT PRIMARY KEY)');
  sql.exec(`CREATE TABLE IF NOT EXISTS schedules (path TEXT NOT NULL, cron TEXT NOT NULL,
    next_ms INTEGER NOT NULL, last_ms INTEGER, PRIMARY KEY (path, cron))`);
  sql.exec('CREATE TABLE IF NOT EXISTS numbers (path TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, minutes INTEGER NOT NULL)');
  sql.exec(
    'CREATE TABLE IF NOT EXISTS pending_events (seq INTEGER PRIMARY KEY, event_json TEXT NOT NULL)',
  );
  sql.exec(`CREATE TABLE IF NOT EXISTS automation_runs (path TEXT PRIMARY KEY, run_id TEXT,
    waiting_json TEXT)`);
  sql.exec('CREATE TABLE IF NOT EXISTS model_spend (month TEXT PRIMARY KEY, usd REAL NOT NULL)');
}

/** A stored trigger's event name, checked. */
function actionsEventOf(name: string): ActionsEvent {
  const event = ACTIONS_EVENTS.find((known) => known === name);
  if (event === undefined) throw new Error(`not an Actions event: ${name}`);
  return event;
}

/** The repository as runs see it. */
export function factsOf(record: {
  readonly id: string;
  readonly owner: { readonly id: string; readonly handle: string };
  readonly name: string;
  readonly engine_id: string;
  readonly default_branch: string;
  readonly visibility: 'public' | 'private' | 'internal';
}): RepoFacts {
  return {
    id: record.id,
    ownerId: record.owner.id,
    ownerHandle: record.owner.handle,
    name: record.name,
    engineId: record.engine_id,
    defaultBranch: record.default_branch,
    visibility: record.visibility,
  };
}

function isPushFiring(
  trigger: WorkflowTrigger,
  move: { readonly defaultBranch: string; readonly changedPaths: readonly string[] | null },
): boolean {
  return trigger.kind === 'push' && pushFires(trigger, move);
}

/** Paths changed between two stalk heads; null when unknown (too many, or unreadable). */
async function changedBetween(
  explorer: RepoExplorer,
  before: string,
  after: string,
): Promise<string[] | null> {
  try {
    const diff = await explorer.diff(before, after, null);
    return diff.truncated ? null : diff.files.map((file) => file.path);
  } catch {
    return null;
  }
}

/** The next time a cron fires, at least 5 minutes after the last time it fired. */
function nextAllowed(cron: string, nowMs: number, lastMs: number | null): number | null {
  const schedule = parseCron(cron);
  if (schedule === null) return null;
  const earliest =
    lastMs === null ? nowMs : Math.max(nowMs, lastMs + MIN_SCHEDULE_INTERVAL_MS - 60_000);
  return nextFireMs(schedule, earliest);
}

function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function invalid<T>(code: string, status: number, message: string): RpcResult<T> {
  return { ok: false, error: { code, status, message } };
}
