/**
 * The ActionsRunDO's SQLite: the run (one row) and its jobs. No log line is ever stored here
 * (D9): lines go to watchers and to R2. Rows are validated when read.
 */
import type {
  ActionsConclusion,
  ActionsStatus,
  JobStepSpec,
  JobView,
  RunSummary,
  StepView,
} from '@gitstalk/shared-race/actions';
import {
  ACTIONS_CONCLUSIONS,
  ACTIONS_EVENTS,
  ACTIONS_STATUSES,
  ActionsJobId,
  ActionsRunId,
  StepViewSchema,
  WorkflowPath,
} from '@gitstalk/shared-race/actions';
import { z } from 'zod';

import type { PlannedJob } from './job-graph';
import type { RunRequest } from './run-request';

/** The run as stored: its request and where it stands. */
export type RunRecord = {
  readonly request: RunRequest;
  readonly workflowName: string;
  readonly status: ActionsStatus;
  readonly conclusion: ActionsConclusion | null;
  readonly reason: string | null;
  readonly startedMs: number | null;
  readonly completedMs: number | null;
  readonly cancelRequested: boolean;
  /** `vars.*` as the run started: org variables that reach the repository, then its own. */
  readonly vars: Readonly<Record<string, string>>;
  /** An automation's model calls so far (doc 25 §7.5). */
  readonly modelUsage: ModelCalls;
};

/** Model calls counted by the proxy. */
export type ModelCalls = {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
};

export const NO_MODEL_CALLS: ModelCalls = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** A job as stored: its plan and its state. */
export type JobRow = PlannedJob & {
  readonly status: ActionsStatus;
  readonly conclusion: ActionsConclusion | null;
  readonly reason: string | null;
  readonly stepStates: readonly StepView[];
  readonly outputValues: Readonly<Record<string, string>>;
  readonly startedMs: number | null;
  readonly completedMs: number | null;
  readonly minutes: number;
  /** SHA-256 of the report token's secret while the job runs. */
  readonly reportHash: string | null;
  /** When it first waited for capacity (it keeps its place). */
  readonly waitingSinceMs: number | null;
  readonly lastSeq: number;
};

export type JobPatch = Partial<
  Pick<
    JobRow,
    | 'status'
    | 'conclusion'
    | 'reason'
    | 'stepStates'
    | 'outputValues'
    | 'startedMs'
    | 'completedMs'
    | 'minutes'
    | 'reportHash'
    | 'waitingSinceMs'
    | 'lastSeq'
  >
>;

const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const StepSpec = z.object({
  number: z.number(),
  id: z.string().nullable(),
  name: z.string(),
  uses: z.string().nullable(),
  run: z.string().nullable(),
});
const JobSql = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  matrix_json: z.string(),
  needs_json: z.string(),
  condition: z.string(),
  image: z.string().nullable(),
  timeout_min: z.number(),
  steps_spec_json: z.string(),
  outputs_spec_json: z.string(),
  secret_names_json: z.string(),
  contents_write: z.number(),
  id_token_write: z.number(),
  status: z.enum(ACTIONS_STATUSES),
  conclusion: z.enum(ACTIONS_CONCLUSIONS).nullable(),
  reason: z.string().nullable(),
  steps_json: z.string(),
  outputs_json: z.string(),
  started_ms: z.number().nullable(),
  completed_ms: z.number().nullable(),
  minutes: z.number(),
  report_hash: z.string().nullable(),
  waiting_since_ms: z.number().nullable(),
  last_seq: z.number(),
});

const COLUMNS: { readonly [K in keyof JobPatch]-?: string } = {
  status: 'status',
  conclusion: 'conclusion',
  reason: 'reason',
  stepStates: 'steps_json',
  outputValues: 'outputs_json',
  startedMs: 'started_ms',
  completedMs: 'completed_ms',
  minutes: 'minutes',
  reportHash: 'report_hash',
  waitingSinceMs: 'waiting_since_ms',
  lastSeq: 'last_seq',
};

const PATCH_FIELDS: readonly (keyof JobPatch)[] = [
  'status',
  'conclusion',
  'reason',
  'stepStates',
  'outputValues',
  'startedMs',
  'completedMs',
  'minutes',
  'reportHash',
  'waitingSinceMs',
  'lastSeq',
];

const RunRecordSchema = z.object({
  request: z.object({
    runId: ActionsRunId,
    number: z.number(),
    repo: z.object({
      id: z.string(),
      ownerId: z.string(),
      ownerHandle: z.string(),
      name: z.string(),
      engineId: z.string(),
      defaultBranch: z.string(),
      visibility: z.enum(['public', 'private', 'internal']),
    }),
    workflow: z.object({ path: z.string(), source: z.string() }),
    event: z.enum(ACTIONS_EVENTS),
    eventPayload: z.record(z.string(), z.unknown()),
    sha: z.string(),
    actor: z.string(),
    inputs: z.record(z.string(), z.string()),
    origin: z.union([
      z.object({ kind: z.enum(['stalk', 'dispatch', 'schedule', 'event']) }),
      z.object({
        kind: z.literal('preland'),
        pushedBy: z.enum(['maintainer', 'collaborator', 'agent-session', 'deploy-token']),
      }),
    ]),
    automation: z.object({ model: z.string().nullable(), maxCostUsd: z.number() }).optional(),
    // Runs stored before beans were kept have none.
    beans: z.array(z.string()).optional(),
    refused: z.string().nullable(),
    createdMs: z.number(),
  }),
  workflowName: z.string(),
  status: z.enum(ACTIONS_STATUSES),
  conclusion: z.enum(ACTIONS_CONCLUSIONS).nullable(),
  reason: z.string().nullable(),
  startedMs: z.number().nullable(),
  completedMs: z.number().nullable(),
  cancelRequested: z.boolean(),
  // Runs stored before variables existed have none.
  vars: z.record(z.string(), z.string()).default({}),
  modelUsage: z
    .object({
      calls: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number(),
    })
    .default(NO_MODEL_CALLS),
});

export class RunStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS run (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)',
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, ord INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
      matrix_json TEXT NOT NULL, needs_json TEXT NOT NULL, condition TEXT NOT NULL, image TEXT,
      timeout_min INTEGER NOT NULL, steps_spec_json TEXT NOT NULL, outputs_spec_json TEXT NOT NULL,
      secret_names_json TEXT NOT NULL, contents_write INTEGER NOT NULL,
      id_token_write INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      conclusion TEXT, reason TEXT, steps_json TEXT NOT NULL DEFAULT '[]',
      outputs_json TEXT NOT NULL DEFAULT '{}', started_ms INTEGER, completed_ms INTEGER,
      minutes INTEGER NOT NULL DEFAULT 0, report_hash TEXT, waiting_since_ms INTEGER,
      last_seq INTEGER NOT NULL DEFAULT 0)`);
  }

  run(): RunRecord | null {
    const row = this.#sql.exec<{ json: string }>('SELECT json FROM run WHERE id = 1').toArray()[0];
    return row === undefined ? null : RunRecordSchema.parse(JSON.parse(row.json));
  }

  saveRun(record: RunRecord): void {
    this.#sql.exec(
      'INSERT INTO run (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      JSON.stringify(record),
    );
  }

  insertJobs(jobs: readonly PlannedJob[]): void {
    for (const [ord, job] of jobs.entries()) {
      this.#sql.exec(
        `INSERT INTO jobs (id, ord, key, name, matrix_json, needs_json, condition, image, timeout_min,
           steps_spec_json, outputs_spec_json, secret_names_json, contents_write, id_token_write, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
        job.id,
        ord,
        job.key,
        job.name,
        JSON.stringify(job.matrix),
        JSON.stringify(job.needs),
        job.condition,
        job.image,
        job.timeoutMinutes,
        JSON.stringify(job.steps),
        JSON.stringify(job.outputs),
        JSON.stringify(job.secretNames),
        job.contentsWrite ? 1 : 0,
        job.idTokenWrite ? 1 : 0,
      );
    }
  }

  jobs(): JobRow[] {
    return this.#sql
      .exec('SELECT * FROM jobs ORDER BY ord')
      .toArray()
      .map((raw) => jobOf(JobSql.parse(raw)));
  }

  job(id: string): JobRow | null {
    const raw = this.#sql.exec('SELECT * FROM jobs WHERE id = ?', id).toArray()[0];
    return raw === undefined ? null : jobOf(JobSql.parse(raw));
  }

  updateJob(id: string, patch: JobPatch): void {
    const entries = PATCH_FIELDS.flatMap((field) =>
      patch[field] === undefined ? [] : [[COLUMNS[field], columnValue(patch[field])] as const],
    );
    if (entries.length === 0) return;
    this.#sql.exec(
      `UPDATE jobs SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`,
      ...entries.map(([, value]) => value),
      id,
    );
  }
}

/** The run as lists show it. */
export function summaryOf(record: RunRecord, jobs: readonly JobRow[]): RunSummary {
  const { request } = record;
  return {
    id: ActionsRunId.parse(request.runId),
    repoId: request.repo.id,
    number: request.number,
    workflowPath: WorkflowPath.parse(request.workflow.path),
    workflowName: record.workflowName,
    event: request.event,
    ref: 'refs/heads/main',
    sha: request.sha,
    status: record.status,
    conclusion: record.conclusion,
    reason: record.reason,
    actor: request.actor,
    createdAt: iso(request.createdMs),
    startedAt: isoOrNull(record.startedMs),
    completedAt: isoOrNull(record.completedMs),
    minutesBilled: jobs.reduce((sum, job) => sum + job.minutes, 0),
  };
}

export function jobViewOf(job: JobRow): JobView {
  return {
    id: ActionsJobId.parse(job.id),
    key: job.key,
    name: job.name,
    matrix: job.matrix,
    needs: job.needs,
    status: job.status,
    conclusion: job.conclusion,
    reason: job.reason,
    steps: job.stepStates.length > 0 ? job.stepStates : plannedSteps(job.steps),
    outputs: job.outputValues,
    startedAt: isoOrNull(job.startedMs),
    completedAt: isoOrNull(job.completedMs),
    minutesBilled: job.minutes,
  };
}

function plannedSteps(steps: readonly JobStepSpec[]): StepView[] {
  return steps.map((step) => ({
    number: step.number,
    name: step.name,
    status: 'queued',
    conclusion: null,
    startedAt: null,
    completedAt: null,
  }));
}

function jobOf(row: z.infer<typeof JobSql>): JobRow {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    matrix: z.record(z.string(), Scalar).nullable().parse(JSON.parse(row.matrix_json)),
    needs: z.array(z.string()).parse(JSON.parse(row.needs_json)),
    condition: row.condition,
    image: row.image,
    timeoutMinutes: row.timeout_min,
    steps: z.array(StepSpec).parse(JSON.parse(row.steps_spec_json)),
    outputs: z.record(z.string(), z.string()).parse(JSON.parse(row.outputs_spec_json)),
    secretNames: z.array(z.string()).parse(JSON.parse(row.secret_names_json)),
    contentsWrite: row.contents_write === 1,
    idTokenWrite: row.id_token_write === 1,
    status: row.status,
    conclusion: row.conclusion,
    reason: row.reason,
    stepStates: z.array(StepViewSchema).parse(JSON.parse(row.steps_json)),
    outputValues: z.record(z.string(), z.string()).parse(JSON.parse(row.outputs_json)),
    startedMs: row.started_ms,
    completedMs: row.completed_ms,
    minutes: row.minutes,
    reportHash: row.report_hash,
    waitingSinceMs: row.waiting_since_ms,
    lastSeq: row.last_seq,
  };
}

function columnValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return JSON.stringify(value);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}
