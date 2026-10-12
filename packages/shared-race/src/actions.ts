/**
 * GitHub Actions on Gitstalk: the shared contract between the three lanes
 * (`docs/claude-opus/25-actions-and-automations.md`).
 *
 * - **Control plane** (the gateway): workflow discovery from the stalk, triggers, one
 *   `ActionsRunDO` per run owning the job DAG, limits, secrets, job tokens and the log relay.
 *   It serves `ActionsRpc` on the gateway Worker's named entrypoint `Actions` (bind with
 *   `{ "service": "beanstalk-gateway", "entrypoint": "Actions" }`), and `ActionsJobSink` on the
 *   named entrypoint `ActionsJobs` for the executor.
 * - **Executor** (lane 2): implements `ActionsExecutor` (`startJob`, `cancelJob`) on its own
 *   Worker's entrypoint, runs one container per job (D6), streams log batches and the result
 *   back through `ActionsJobSink` with the job's `report.token`.
 * - **UI** (lane 3): calls `ActionsRpc` through the service binding as the signed-in person.
 *
 * Every RPC returns `RpcResult`: expected failures are `{ ok: false, error }` with the HTTP
 * status the same failure would get (`not_found` 404, `forbidden` 403, `invalid_request` 400,
 * `invalid_state` 409, `over_limit` 429, `not_configured` 503).
 *
 * Access (`mayUseEngine`): `read` lists workflows, runs and logs; the `actions` action
 * (maintain) dispatches, cancels and manages secrets. Secret values are write-only: no method
 * returns one, except `actionsJobSecrets` to the executor, for the running job that names them.
 *
 * Limits (D9, beta defaults; vars on the gateway so self-hosters can change them): 100 Actions
 * minutes per repository per month, a 60-minute job timeout, 4 concurrent jobs per repository.
 * Logs are never stored in Durable Objects: the run DO relays live lines to watchers and writes
 * gzip chunks to R2 (`beanstalk-actions-logs`, 30-day lifecycle).
 */
import { z } from 'zod';

import { configPaths } from './config-dir';
import type { Viewer } from './repos';
import type { RpcResult } from './rpc';

// Identifiers ---------------------------------------------------------------------------------

/** A workflow run: a UUID, the `ActionsRunDO` name. */
export const ActionsRunId = z.uuid().brand<'ActionsRunId'>();
export type ActionsRunId = z.infer<typeof ActionsRunId>;

/** One job of a run (one matrix leg is one job): a UUID, unique across runs. */
export const ActionsJobId = z.uuid().brand<'ActionsJobId'>();
export type ActionsJobId = z.infer<typeof ActionsJobId>;

/**
 * A workflow file's path in the repository: `.github/workflows/<name>.yml` (or `.yaml`), or an
 * automation's, `.gitstalk/automations/<name>.yml` (`.yaml`, or `.md` with front matter), or the
 * same under `.beanstalk/automations/` from before the rename.
 */
export const WorkflowPath = z
  .string()
  .regex(
    /^(?:\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml|\.(?:gitstalk|beanstalk)\/automations\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\.(?:ya?ml|md))$/,
  )
  .brand<'WorkflowPath'>();
export type WorkflowPath = z.infer<typeof WorkflowPath>;

/**
 * A repository or org variable the product reads, by its name without the prefix (`DEPS_CACHE`):
 * `GITSTALK_<name>`, else `BEANSTALK_<name>` as repositories set it before the rename
 * (2026-10-10). `.gitstalk`'s rule: the current name wins when both are set.
 */
export function productVariable(
  vars: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return vars[`GITSTALK_${name}`] ?? vars[`BEANSTALK_${name}`];
}

/** Where new automations go (doc 25 §7): agent jobs defined by files on the stalk. */
export const AUTOMATIONS_DIR = '.gitstalk/automations';

/** Every directory automations are read from, in lookup order (`config-dir.ts`). */
export const AUTOMATIONS_DIRS: readonly string[] = configPaths('automations');

/** SQL `LIKE` patterns matching an automation's workflow path, one per directory. */
export const AUTOMATION_PATH_PATTERNS: readonly string[] = AUTOMATIONS_DIRS.map(
  (dir) => `${dir}/%`,
);

/** Whether a workflow path is an automation's (not a GitHub workflow's). */
export function isAutomationPath(path: string): boolean {
  return AUTOMATIONS_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

/**
 * The automation paths that count when both directories hold files: one with the same id under
 * `.gitstalk/automations/` hides its `.beanstalk/automations/` namesake. Others keep their order.
 */
export function preferredAutomationPaths(paths: readonly string[]): readonly string[] {
  const current = new Set(
    paths.filter((path) => path.startsWith(`${AUTOMATIONS_DIR}/`)).map(automationIdOf),
  );
  return paths.filter(
    (path) =>
      !isAutomationPath(path) ||
      path.startsWith(`${AUTOMATIONS_DIR}/`) ||
      !current.has(automationIdOf(path)),
  );
}

/** An automation's id: its file name without the extension (`fix-red` for `fix-red.yml`). */
export function automationIdOf(path: string): string {
  const file = path.split('/').at(-1) ?? path;
  return file.replace(/\.(?:ya?ml|md)$/, '').toLowerCase();
}

/** A secret's name, as GitHub allows them: letters, digits, `_`; no `GITHUB_` prefix. */
export const SecretName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)
  .refine((name) => !name.toUpperCase().startsWith('GITHUB_'), 'names may not start with GITHUB_')
  .transform((name) => name.toUpperCase())
  .brand<'SecretName'>();
export type SecretName = z.infer<typeof SecretName>;

// States ------------------------------------------------------------------------------------

/** GitHub's `status`: where a run, job or step is. */
export const ACTIONS_STATUSES = ['queued', 'waiting', 'in_progress', 'completed'] as const;
export type ActionsStatus = (typeof ACTIONS_STATUSES)[number];

/**
 * GitHub's `conclusion`, set once `status` is `completed`. `infrastructure_failure` is a lost
 * container or executor (never shown as red, `18` §7.1); `startup_failure` is a run that could
 * not start (an invalid workflow, the monthly minutes spent: `reason` says which).
 */
export const ACTIONS_CONCLUSIONS = [
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'infrastructure_failure',
  'startup_failure',
] as const;
export type ActionsConclusion = (typeof ACTIONS_CONCLUSIONS)[number];

/**
 * Gitstalk events an automation's `on:` may name (doc 25 §7.2), each the repository event of
 * the same moment (`bean_red` is `bean.rework`: a red pre-land check or a conflict).
 */
export const GITSTALK_EVENTS = [
  'bean_opened',
  'bean_landed',
  'bean_red',
  'bean_parked',
  'bean_dropped',
  'bean_reverted',
  'stalk_moved',
  'stalk_reset',
  'validation_red',
  'decision_opened',
  'decision_decided',
] as const;
export type GitstalkEvent = (typeof GITSTALK_EVENTS)[number];

/** The events that start a run: GitHub's three, and the Gitstalk events (automations only). */
export const ACTIONS_EVENTS = [
  'push',
  'workflow_dispatch',
  'schedule',
  ...GITSTALK_EVENTS,
] as const;
export type ActionsEvent = (typeof ACTIONS_EVENTS)[number];

// Workflows ---------------------------------------------------------------------------------

/** One way a workflow starts, as the index read it from the file. */
export type WorkflowTrigger =
  | {
      readonly kind: 'push';
      /** Branch filters as written (`main` means the stalk); empty: every push to the stalk. */
      readonly branches: readonly string[];
      readonly branchesIgnore: readonly string[];
      readonly paths: readonly string[];
      readonly pathsIgnore: readonly string[];
    }
  | { readonly kind: 'workflow_dispatch'; readonly inputs: readonly DispatchInputSpec[] }
  | { readonly kind: 'schedule'; readonly crons: readonly string[] }
  | {
      /** A Gitstalk event (automations only), with optional glob filters. */
      readonly kind: 'beanstalk';
      readonly event: GitstalkEvent;
      /** Bean names it fires for; empty: any. */
      readonly beans: readonly string[];
      /** Handles of the bean's pusher it fires for; empty: any. */
      readonly authors: readonly string[];
    };

/** What an automation file says beyond its triggers (doc 25 §7.1). */
export type AutomationInfo = {
  /** The file name without its extension: names the memory ref, the bot and its beans. */
  readonly id: string;
  /**
   * `agent`: Gitstalk's agent loop on a Workers AI model through the model proxy (§7.5);
   * `shell`: a script with the same workspace, memory and bean push, and no model.
   */
  readonly harness: 'agent' | 'shell';
  /** The Workers AI model (`@cf/…`) for `agent`; null for `shell`. */
  readonly model: string | null;
  /** The prompt (or, for `shell`, the script), as written. */
  readonly prompt: string;
  readonly permissions: { readonly beans: 'read' | 'write' };
  /** Secret names the run may read (D4 still filters them per trigger). */
  readonly secrets: readonly string[];
  readonly timeoutMinutes: number;
  readonly maxTurns: number;
  /** The run stops its model calls once they cost this much (USD). */
  readonly maxCostUsd: number;
  /** `refs/automations/<id>/memory`, or null when `memory: false`. */
  readonly memoryRef: string | null;
  /** Who it acts as: `<id>[automation]`. */
  readonly actor: string;
};

/** A `workflow_dispatch` input as declared. */
export type DispatchInputSpec = {
  readonly name: string;
  readonly description: string | null;
  readonly type: 'string' | 'boolean' | 'number' | 'choice' | 'environment';
  readonly required: boolean;
  readonly default: string | null;
  /** For `choice`. */
  readonly options: readonly string[];
};

/** What the compatibility report says about one feature of a file (`25` §1.1). */
export type CompatibilityNote = {
  readonly feature: string;
  readonly verdict: 'runs' | 'runs-differently' | 'never-runs' | 'after-mvp';
  readonly detail: string;
};

/** A problem in a workflow file (a parse or schema error); the workflow cannot run. */
export type WorkflowProblem = {
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
};

/** A workflow as indexed from the stalk (`listWorkflows`). */
export type WorkflowSummary = {
  readonly path: WorkflowPath;
  /** `name:` from the file, or the path's file name. */
  readonly name: string;
  readonly state: 'active' | 'invalid';
  readonly triggers: readonly WorkflowTrigger[];
  /** Events in `on:` that Gitstalk does not start runs for yet (`pull_request` …). */
  readonly unsupportedEvents: readonly string[];
  readonly jobs: readonly {
    readonly key: string;
    readonly name: string;
    readonly needs: readonly string[];
  }[];
  readonly problems: readonly WorkflowProblem[];
  readonly compatibility: readonly CompatibilityNote[];
  /** Set for an automation (`.gitstalk/automations/`); absent for a GitHub workflow. */
  readonly automation?: AutomationInfo | undefined;
  /** The stalk commit the index read the file at. */
  readonly sha: string;
  readonly indexedAt: string;
};

// Runs --------------------------------------------------------------------------------------

/** A run as lists show it. Times are ISO 8601. */
export type RunSummary = {
  readonly id: ActionsRunId;
  readonly repoId: string;
  /** Per repository and workflow, from 1, like GitHub's `run_number`. */
  readonly number: number;
  readonly workflowPath: WorkflowPath;
  readonly workflowName: string;
  readonly event: ActionsEvent;
  /** `refs/heads/<default branch>`: the stalk under its base branch's name (D3). */
  readonly ref: string;
  /** The commit the run checks out (the stalk head it was triggered on). */
  readonly sha: string;
  readonly status: ActionsStatus;
  readonly conclusion: ActionsConclusion | null;
  /** Why it ended the way it did, when the conclusion alone does not say. */
  readonly reason: string | null;
  /** Who started it: a handle, `schedule`, or the pusher of the stalk move. */
  readonly actor: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly minutesBilled: number;
};

export type StepView = {
  readonly number: number;
  readonly name: string;
  readonly status: ActionsStatus;
  readonly conclusion: ActionsConclusion | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

/** One job of a run (one matrix leg). */
export type JobView = {
  readonly id: ActionsJobId;
  /** The job's key under `jobs:`. */
  readonly key: string;
  /** Display name: `name:` with the matrix values, as GitHub shows it (`test (20)`). */
  readonly name: string;
  readonly matrix: Readonly<Record<string, string | number | boolean>> | null;
  /** Keys of the jobs it waits for. */
  readonly needs: readonly string[];
  readonly status: ActionsStatus;
  readonly conclusion: ActionsConclusion | null;
  readonly reason: string | null;
  readonly steps: readonly StepView[];
  readonly outputs: Readonly<Record<string, string>>;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly minutesBilled: number;
};

/** An automation run's model calls through the proxy (doc 25 §7.5), as the gateway counted them. */
export type ModelUsage = {
  readonly model: string | null;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** The run's cap (`max-cost-usd`). */
  readonly limitUsd: number;
};

export type RunDetail = RunSummary & {
  readonly jobs: readonly JobView[];
  readonly inputs: Readonly<Record<string, string>>;
  /** Set for an automation's run with the `agent` harness. */
  readonly modelUsage?: ModelUsage | undefined;
};

export type RunFilter = {
  readonly workflowPath?: string;
  /** Only GitHub workflows' runs, or only automations'. */
  readonly kind?: 'workflow' | 'automation';
  readonly status?: ActionsStatus;
  readonly event?: ActionsEvent;
  /** The commit the run checked out: a full sha or a prefix of at least 7 characters. */
  readonly sha?: string;
  /** Newest first; at most 100 (default 25). */
  readonly limit?: number;
  /** The `next` cursor of the previous page. */
  readonly cursor?: string;
};

export type RunPage = { readonly runs: readonly RunSummary[]; readonly next: string | null };

/** `dispatchWorkflow`'s input. `ref` is the stalk under any of its names (`stalk`, `main`, the base branch). */
export type DispatchInput = {
  readonly workflowPath: string;
  readonly ref: string;
  readonly inputs: Readonly<Record<string, string | number | boolean>>;
};

// Logs --------------------------------------------------------------------------------------

/** One log line. `step` is the step's number, null for the job's own lines (set up, tear down). */
export type LogLine = { readonly step: number | null; readonly at: string; readonly text: string };

/** Where to watch a job's log live: a WebSocket URL and a short-lived token for it. */
export type LogStreamTicket = {
  /** `wss://…/v1/actions/runs/<run>/jobs/<job>/logs` (the token goes in `?token=`). */
  readonly url: string;
  readonly token: string;
  readonly expiresAt: string;
};

/**
 * A frame on the live log WebSocket (JSON text). Lines are relayed, not stored: a watcher
 * reads history with `logChunks` first, then follows the socket from the `seq` it saw.
 */
export type LogFrame =
  | {
      readonly kind: 'lines';
      readonly jobId: ActionsJobId;
      readonly seq: number;
      readonly lines: readonly LogLine[];
    }
  | { readonly kind: 'steps'; readonly jobId: ActionsJobId; readonly steps: readonly StepView[] }
  | {
      readonly kind: 'job';
      readonly jobId: ActionsJobId;
      readonly status: ActionsStatus;
      readonly conclusion: ActionsConclusion | null;
    };

/** A page of a job's stored log: R2 chunks in order (`seq` is the executor's batch number). */
export type LogChunkPage = {
  readonly chunks: readonly { readonly seq: number; readonly lines: readonly LogLine[] }[];
  /** Pass as `after` for the next page; null when the stored log ends here. */
  readonly next: number | null;
  /** The job has completed, so no more chunks will come. */
  readonly complete: boolean;
};

// Secrets -----------------------------------------------------------------------------------

/** A secret as Settings lists it: never its value. */
export type SecretSummary = {
  readonly name: SecretName;
  /** D4: also given to pre-land runs of beans pushed by agent sessions and deploy tokens. */
  readonly prelandAllowed: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
};

export type PutSecretInput = {
  readonly name: string;
  /** At most 48 KiB, as on GitHub. Write-only. */
  readonly value: string;
  readonly prelandAllowed: boolean;
};

// The control plane's RPC (entrypoint `Actions`) -------------------------------------------

/**
 * The Actions RPC, for the web app and the MCP Worker. `viewer` is the signed-in person's
 * user id (null: nobody); `repoId` is the registry's repository id.
 */
export type ActionsRpc = {
  listWorkflows(viewer: Viewer, repoId: string): Promise<RpcResult<readonly WorkflowSummary[]>>;
  /** Starts a `workflow_dispatch` run on the stalk head. Needs the maintain role. */
  dispatchWorkflow(
    viewer: Viewer,
    repoId: string,
    input: DispatchInput,
  ): Promise<RpcResult<RunSummary>>;
  listRuns(viewer: Viewer, repoId: string, filter: RunFilter): Promise<RpcResult<RunPage>>;
  getRun(viewer: Viewer, runId: string): Promise<RpcResult<RunDetail>>;
  /** Cancels a run's queued and running jobs. Needs the maintain role. */
  cancelRun(viewer: Viewer, runId: string): Promise<RpcResult<RunSummary>>;
  /** A ticket for the job's live log WebSocket (read role). */
  logStream(viewer: Viewer, runId: string, jobId: string): Promise<RpcResult<LogStreamTicket>>;
  /** The job's stored log from R2, after chunk `after` (0: from the start). */
  logChunks(
    viewer: Viewer,
    runId: string,
    jobId: string,
    after?: number,
  ): Promise<RpcResult<LogChunkPage>>;
  listSecrets(viewer: Viewer, repoId: string): Promise<RpcResult<readonly SecretSummary[]>>;
  putSecret(
    viewer: Viewer,
    repoId: string,
    input: PutSecretInput,
  ): Promise<RpcResult<SecretSummary>>;
  deleteSecret(
    viewer: Viewer,
    repoId: string,
    name: string,
  ): Promise<RpcResult<{ readonly deleted: boolean }>>;
};

// The executor contract (lane 2) ------------------------------------------------------------

/** A step as the workflow declares it, for display and for the stub executor. */
export type JobStepSpec = {
  readonly number: number;
  readonly id: string | null;
  readonly name: string;
  readonly uses: string | null;
  readonly run: string | null;
};

/**
 * Everything the executor needs to run one job (one container, D6). The workflow file is at
 * `workflowPath` in the checked-out commit; `jobName` is its key under `jobs:`, `matrix` the
 * leg's values. Secret values are not here: the executor asks `actionsJobSecrets` once, with
 * `report.token`, and must mask every value (and its base64 form) in the lines it sends.
 */
export type JobSpec = {
  readonly jobId: ActionsJobId;
  readonly repo: {
    readonly id: string;
    readonly owner: string;
    readonly name: string;
    /** `owner/name`, GitHub's `github.repository`. */
    readonly fullName: string;
  };
  readonly runId: ActionsRunId;
  readonly runNumber: number;
  readonly workflowPath: WorkflowPath;
  readonly workflowName: string;
  readonly jobName: string;
  readonly displayName: string;
  readonly matrix: Readonly<Record<string, string | number | boolean>> | null;
  readonly event: ActionsEvent;
  /** GitHub's event payload (a subset in GitHub's shape), for `github.event` and `-e event.json`. */
  readonly eventPayload: Readonly<Record<string, unknown>>;
  /** The `github` context's scalars. */
  readonly context: {
    readonly sha: string;
    readonly ref: string;
    readonly refName: string;
    readonly actor: string;
    readonly serverUrl: string;
    readonly apiUrl: string;
    readonly runAttempt: number;
  };
  /**
   * Git over HTTPS for `actions/checkout`: `url` is GitHub-shaped, `<context.serverUrl>/<owner>/
   * <repo>` (the gateway serves git there, so `act --github-instance <host>` and unmodified
   * checkout work; Basic `x-access-token:<token>` is accepted); `token` is
   * the job token (`bsj_…`, also `GITHUB_TOKEN`): this repository only, read, and push to
   * `bean/*` only when `permissions` allow `contents: write`; revoked when the job ends.
   */
  readonly checkout: { readonly url: string; readonly token: string; readonly sha: string };
  /** Outputs of the jobs this one `needs`, for `needs.<job>.outputs.<name>`. */
  readonly needs: Readonly<
    Record<
      string,
      { readonly result: ActionsConclusion; readonly outputs: Readonly<Record<string, string>> }
    >
  >;
  /** `workflow_dispatch` inputs, as strings. */
  readonly inputs: Readonly<Record<string, string>>;
  /**
   * Extra environment the control plane sets (`GITSTALK_LINE=stalk` and its `BEANSTALK_` twin, `CI=true`, and for an
   * `id-token: write` job `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN`); workflow `env:` is in the file.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Secrets this job may read (named by the workflow and allowed by D4). Values via `actionsJobSecrets`. */
  readonly secretNames: readonly SecretName[];
  /**
   * `vars.*`: the org's variables this repository may see, then the repository's own (which win
   * on a name clash). Plain configuration, not masked. Absent from gateways older than org
   * secrets and variables; treat absent as none.
   */
  readonly vars?: Readonly<Record<string, string>>;
  readonly steps: readonly JobStepSpec[];
  /** The job's `outputs:` expressions, which the executor evaluates at the end. */
  readonly outputs: Readonly<Record<string, string>>;
  /** At most the repository's limit (60 by default); the control plane cancels at this time. */
  readonly timeoutMinutes: number;
  /** `runs-on` resolved to an image label (`ubuntu-24.04`). */
  readonly image: string;
  /** How the executor reports back (`ActionsJobSink`): a bearer for this job only. */
  readonly report: { readonly token: string };
  /**
   * The dependency cache (docs/claude-opus/27): the ref scope the job reads, and whether it
   * may save. Only default-branch pushes save (`origin: stalk`); pre-land, dispatch and
   * schedule runs only read, so nothing they leave reaches a default-branch run. Absent from
   * older gateways: the executor then lets the job read only.
   */
  readonly depsCache?: { readonly scope: string; readonly canSave: boolean } | undefined;
  /**
   * The workflow text to run instead of reading `workflowPath` at the commit: an automation's
   * job, compiled by the control plane from its file (doc 25 §7.4). Absent for GitHub workflows.
   */
  readonly workflowSource?: string | undefined;
};

/** The executor accepted the job; it will report through the sink. */
export type JobHandle = {
  readonly jobId: ActionsJobId;
  /** The executor's own reference (a container id), for its logs. */
  readonly executorRef: string;
  readonly acceptedAt: string;
};

/** How a job ended, as the executor saw it. */
export type JobResult = {
  readonly conclusion: Extract<
    ActionsConclusion,
    'success' | 'failure' | 'cancelled' | 'timed_out' | 'infrastructure_failure'
  >;
  readonly outputs: Readonly<Record<string, string>>;
  readonly durationMs: number;
  /** Whole minutes, rounded up per job as GitHub bills them. */
  readonly minutesBilled: number;
  readonly steps: readonly StepView[];
  /** For a failure the steps do not explain (an infrastructure error). */
  readonly error: string | null;
};

/**
 * One batch of log lines (and step changes) from the executor. `seq` counts from 1 per job,
 * in order; a repeated `seq` is ignored. Send at most one batch a second, or when 64 KiB of
 * lines are waiting: each batch is one gzip chunk in R2.
 */
export type JobLogBatch = {
  readonly seq: number;
  readonly lines: readonly LogLine[];
  readonly steps: readonly StepView[];
};

/** Implemented by the executor Worker (lane 2); the run DO calls it through a service binding. */
export type ActionsExecutor = {
  startJob(spec: JobSpec): Promise<RpcResult<JobHandle>>;
  /** Stops a job (cancel or timeout); it then reports `cancelled` or `timed_out` through the sink. */
  cancelJob(
    jobId: ActionsJobId,
    reason: 'cancelled' | 'timed_out',
  ): Promise<RpcResult<{ readonly stopping: boolean }>>;
  /**
   * The repository was deleted: drop what the executor keeps for it (its dependency snapshots
   * in R2 and their index). Idempotent; `purged: false` means storage failed and the executor's
   * daily sweep retries.
   */
  forgetRepository(repoId: string): Promise<RpcResult<RepositoryForgotten>>;
};

/** What `forgetRepository` removed. */
export type RepositoryForgotten = {
  readonly purged: boolean;
  readonly objectsDeleted: number;
};

/**
 * Implemented by the gateway (entrypoint `ActionsJobs`) for the executor's daily sweep: whether
 * a repository still exists, so state left by a delete whose `forgetRepository` call failed is
 * found and removed.
 */
export type RepositoryDirectory = {
  repositoryExists(repoId: string): Promise<RpcResult<{ readonly exists: boolean }>>;
};

/** Implemented by the gateway (entrypoint `ActionsJobs`); the executor calls it with `report.token`. */
export type ActionsJobSink = {
  /** The values of the job's `secretNames`, while the job runs. Never log them. */
  actionsJobSecrets(reportToken: string): Promise<RpcResult<Readonly<Record<string, string>>>>;
  /** Live lines and step changes; `cancelRequested` tells the executor to stop the job. */
  actionsJobLogs(
    reportToken: string,
    batch: JobLogBatch,
  ): Promise<RpcResult<{ readonly cancelRequested: boolean }>>;
  /** The job ended. The job token is revoked and the next jobs start. */
  actionsJobFinished(
    reportToken: string,
    result: JobResult,
  ): Promise<RpcResult<{ readonly accepted: true }>>;
};

// Boundary schemas (the sink validates what the executor sends) ----------------------------

const Iso = z.string().min(1).max(40);
const Status = z.enum(ACTIONS_STATUSES);
const Conclusion = z.enum(ACTIONS_CONCLUSIONS);

export const StepViewSchema = z.object({
  number: z.number().int().min(0).max(1000),
  name: z.string().max(500),
  status: Status,
  conclusion: Conclusion.nullable(),
  startedAt: Iso.nullable(),
  completedAt: Iso.nullable(),
});

export const LogLineSchema = z.object({
  step: z.number().int().min(0).max(1000).nullable(),
  at: Iso,
  text: z.string().max(64 * 1024),
});

export const JobLogBatchSchema = z.object({
  seq: z.number().int().min(1),
  lines: z.array(LogLineSchema).max(5000),
  steps: z.array(StepViewSchema).max(1000),
});

export const JobResultSchema = z.object({
  conclusion: z.enum(['success', 'failure', 'cancelled', 'timed_out', 'infrastructure_failure']),
  outputs: z.record(z.string().max(100), z.string().max(1024 * 1024)),
  durationMs: z.number().int().min(0),
  minutesBilled: z.number().int().min(0),
  steps: z.array(StepViewSchema).max(1000),
  error: z.string().max(2000).nullable(),
});

export const PutSecretInputSchema = z.object({
  name: SecretName,
  value: z
    .string()
    .min(1)
    .max(48 * 1024),
  prelandAllowed: z.boolean(),
});

export const DispatchInputSchema = z.object({
  workflowPath: WorkflowPath,
  ref: z.string().min(1).max(255),
  inputs: z.record(z.string().max(100), z.union([z.string().max(65_535), z.number(), z.boolean()])),
});

export const RunFilterSchema = z.object({
  workflowPath: z.string().max(200).optional(),
  kind: z.enum(['workflow', 'automation']).optional(),
  status: Status.optional(),
  event: z.enum(ACTIONS_EVENTS).optional(),
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(100).optional(),
});
