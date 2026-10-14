/**
 * The Actions pages' own model (`docs/claude-opus/25` §5): what a workflow, run, job, log line
 * and secret look like to the web. The gateway's contract (`ActionsRpc` in
 * `@gitstalk/shared-race/actions`) is translated into it by `gateway-actions.ts`; the fixture
 * fake (`fake/`) speaks it directly through `ActionsViewRpc`. Every answer is validated against
 * these schemas, so a difference shows up as one failed parse, never as a wrong page.
 */
import { z } from 'zod';

import { GITSTALK_EVENTS } from '@gitstalk/shared-race/actions';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

/** GitHub's run and job vocabulary, kept so workflows and people read the same words. */
export const RunStatus = z.enum(['queued', 'in_progress', 'completed']);
export type RunStatus = z.infer<typeof RunStatus>;

/** `infra_lost`: the container went away, never shown as red (`25` §6.3); `startup_failure`: the run could not start. */
export const Conclusion = z.enum([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
  'infra_lost',
  'startup_failure',
]);
export type Conclusion = z.infer<typeof Conclusion>;

/** GitHub's three, and the Gitstalk events automations run on (`25` §7.2). */
export const RunEvent = z.enum(['push', 'workflow_dispatch', 'schedule', ...GITSTALK_EVENTS]);
export type RunEvent = z.infer<typeof RunEvent>;

export const DispatchInput = z.object({
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(['string', 'boolean', 'choice', 'number', 'environment']),
  required: z.boolean(),
  default: z.string().nullable(),
  options: z.array(z.string()),
});
export type DispatchInput = z.infer<typeof DispatchInput>;

/** One `on:` entry, as the compatibility report reads it (`25` §1.1). */
export const WorkflowTrigger = z.discriminatedUnion('event', [
  z.object({ event: z.literal('push'), branches: z.array(z.string()) }),
  z.object({ event: z.literal('workflow_dispatch'), inputs: z.array(DispatchInput) }),
  z.object({ event: z.literal('schedule'), crons: z.array(z.string()) }),
  z.object({
    event: z.literal('beanstalk'),
    name: z.enum(GITSTALK_EVENTS),
    beans: z.array(z.string()),
    authors: z.array(z.string()),
    /** Changed-file globs (landings and reverts); empty: any files. */
    paths: z.array(z.string()).default([]),
  }),
  z.object({
    event: z.literal('other'),
    name: z.string(),
    support: z.enum(['later', 'never']),
    reason: z.string(),
  }),
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTrigger>;

export const CompatibilityNote = z.object({
  level: z.enum(['differs', 'never']),
  text: z.string(),
});
export type CompatibilityNote = z.infer<typeof CompatibilityNote>;

export const RunActor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), handle: z.string() }),
  z.object({ kind: z.literal('session'), name: z.string() }),
  z.object({ kind: z.literal('schedule') }),
]);
export type RunActor = z.infer<typeof RunActor>;

export const RunSummary = z.object({
  id: z.string(),
  number: z.number().int(),
  attempt: z.number().int(),
  workflowId: z.string(),
  workflowName: z.string(),
  event: RunEvent,
  status: RunStatus,
  conclusion: Conclusion.nullable(),
  /** The line the run's commit is on: `stalk` for push and schedule runs. */
  branch: z.string(),
  sha: z.string(),
  title: z.string(),
  /** The bean whose landing moved the stalk to `sha`, when there is one. */
  bean: z.string().nullable(),
  actor: RunActor,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** Each job's minutes rounded up, summed (GitHub's billing rule). */
  billedMinutes: z.number(),
  /** Why it ended the way it did, when the conclusion alone does not say. */
  reason: z.string().nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** What an automation file says (`25` §7.1): its agent, permissions, memory and limits. */
export const AutomationFacts = z.object({
  id: z.string(),
  harness: z.enum(['agent', 'shell']),
  model: z.string().nullable(),
  prompt: z.string(),
  beansWrite: z.boolean(),
  secrets: z.array(z.string()),
  timeoutMinutes: z.number(),
  maxTurns: z.number(),
  maxCostUsd: z.number(),
  memoryRef: z.string().nullable(),
  actor: z.string(),
});
export type AutomationFacts = z.infer<typeof AutomationFacts>;

export const Workflow = z.object({
  /** The file's path, which is its identity. */
  id: z.string(),
  name: z.string(),
  path: z.string(),
  triggers: z.array(WorkflowTrigger),
  notes: z.array(CompatibilityNote),
  /** A file the parser refused: why, with line and column. */
  error: z.string().nullable(),
  lastRun: RunSummary.nullable(),
  /** Set for an automation (`.gitstalk/automations/`). */
  automation: AutomationFacts.nullable().default(null),
});
export type Workflow = z.infer<typeof Workflow>;

export const Step = z.object({
  number: z.number().int(),
  name: z.string(),
  status: RunStatus,
  conclusion: Conclusion.nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Step = z.infer<typeof Step>;

export const Job = z.object({
  id: z.string(),
  name: z.string(),
  /** Ids of the jobs this one waits for. */
  needs: z.array(z.string()),
  runsOn: z.string(),
  status: RunStatus,
  conclusion: Conclusion.nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  steps: z.array(Step),
  /** The job's outputs (an automation's: beans pushed, memory commits, spend). */
  outputs: z.record(z.string(), z.string()).default({}),
});
export type Job = z.infer<typeof Job>;

export const Annotation = z.object({
  level: z.enum(['error', 'warning', 'notice']),
  message: z.string(),
  jobId: z.string(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
});
export type Annotation = z.infer<typeof Annotation>;

export const RunDetail = RunSummary.extend({
  jobs: z.array(Job),
  annotations: z.array(Annotation),
  /** `GITHUB_STEP_SUMMARY` Markdown, all jobs joined; null when none wrote one. */
  summary: z.string().nullable(),
  inputs: z.record(z.string(), z.string()),
  workflowPath: z.string(),
  /** Whether `workflow_dispatch` is on this workflow (re-run dispatches it again). */
  canRerun: z.boolean(),
  /** An agent automation's model calls through the gateway's proxy. */
  modelUsage: z
    .object({
      model: z.string().nullable(),
      calls: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number(),
      limitUsd: z.number(),
    })
    .nullable()
    .default(null),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const RunPage = z.object({ runs: z.array(RunSummary), next: z.string().nullable() });
export type RunPage = z.infer<typeof RunPage>;

export const RunFilter = z.object({
  workflow: z.string().optional(),
  /** Only GitHub workflows' runs, or only automations'. */
  kind: z.enum(['workflow', 'automation']).optional(),
  status: z.enum(['success', 'failure', 'cancelled', 'in_progress', 'queued']).optional(),
  branch: z.string().optional(),
  /** The `next` of the previous page. */
  before: z.string().optional(),
  limit: z.number().int().min(1).max(100),
});
export type RunFilter = z.infer<typeof RunFilter>;

/** One masked log line; `n` counts from 1 within its job. */
export const LogLine = z.object({ n: z.number().int(), step: z.number().int(), text: z.string() });
export type LogLine = z.infer<typeof LogLine>;

export const LogPage = z.object({
  lines: z.array(LogLine),
  /** Whether the job has finished and every line is in. */
  complete: z.boolean(),
});
export type LogPage = z.infer<typeof LogPage>;

export const SecretSummary = z.object({
  name: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  /** Off by default: pre-land checks run code from beans not yet reviewed (`25` §3.4). */
  availableToPreland: z.boolean(),
});
export type SecretSummary = z.infer<typeof SecretSummary>;

export const ActionsUsage = z.object({
  month: z.string(),
  minutesUsed: z.number(),
  minutesIncluded: z.number(),
  jobTimeoutMinutes: z.number(),
});
export type ActionsUsage = z.infer<typeof ActionsUsage>;

export const SecretList = z.object({
  secrets: z.array(SecretSummary),
  usage: ActionsUsage.nullable(),
});
export type SecretList = z.infer<typeof SecretList>;

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;

export const PutSecretInput = z.strictObject({
  name: z
    .string()
    .trim()
    .transform((name) => name.toUpperCase())
    .pipe(
      z
        .string()
        .regex(SECRET_NAME, 'Letters, digits and _ only, not starting with a digit.')
        .refine((name) => !name.startsWith('GITHUB_'), 'Names starting GITHUB_ are reserved.'),
    ),
  /** Null keeps the stored value (only the pre-land toggle changes). */
  value: z
    .string()
    .min(1, 'Enter a value.')
    .max(48 * 1024)
    .nullable(),
  availableToPreland: z.boolean(),
});
export type PutSecretInput = z.infer<typeof PutSecretInput>;

export const DispatchRequest = z.strictObject({
  workflow: z.string().min(1),
  ref: z.string().min(1),
  inputs: z.record(z.string(), z.string()),
});
export type DispatchRequest = z.infer<typeof DispatchRequest>;

// Secrets and variables beyond the repository's own secrets (`25` §3.4) ---------------------

/** Where an entry a repository sees comes from: itself, or the org that owns it. */
export const EntrySource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repository') }),
  z.object({ kind: z.literal('organization'), orgHandle: z.string() }),
]);
export type EntrySource = z.infer<typeof EntrySource>;

/** Which of an org's repositories an org entry reaches. */
export const AccessPolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('private') }),
  z.object({ kind: z.literal('selected'), repoIds: z.array(z.string()) }),
]);
export type AccessPolicy = z.infer<typeof AccessPolicy>;

export const InheritableSecret = SecretSummary.extend({
  source: EntrySource,
  /** An org secret hidden by the repository's own secret of the same name. */
  overridden: z.boolean(),
});
export type InheritableSecret = z.infer<typeof InheritableSecret>;

export const Variable = z.object({
  name: z.string(),
  value: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});
export type Variable = z.infer<typeof Variable>;

export const InheritableVariable = Variable.extend({
  source: EntrySource,
  overridden: z.boolean(),
});
export type InheritableVariable = z.infer<typeof InheritableVariable>;

/** Repository Settings → Secrets and variables: its own entries and the org's that reach it. */
export const RepoEntries = z.object({
  canManage: z.boolean(),
  orgHandle: z.string().nullable(),
  secrets: z.array(InheritableSecret),
  variables: z.array(InheritableVariable),
});
export type RepoEntries = z.infer<typeof RepoEntries>;

const EntryName = z
  .string()
  .trim()
  .transform((name) => name.toUpperCase())
  .pipe(
    z
      .string()
      .regex(SECRET_NAME, 'Letters, digits and _ only, not starting with a digit.')
      .refine((name) => !name.startsWith('GITHUB_'), 'Names starting GITHUB_ are reserved.'),
  );

export const PutVariableInput = z.strictObject({
  name: EntryName,
  value: z.string().max(48 * 1024, 'At most 48 KiB.'),
});
export type PutVariableInput = z.infer<typeof PutVariableInput>;

export const PutOrgSecretInput = z.strictObject({
  name: EntryName,
  /** Null keeps the stored value (only the access policy or the pre-land toggle change). */
  value: z
    .string()
    .min(1, 'Enter a value.')
    .max(48 * 1024)
    .nullable(),
  access: AccessPolicy,
  prelandAllowed: z.boolean(),
});
export type PutOrgSecretInput = z.infer<typeof PutOrgSecretInput>;

export const PutOrgVariableInput = PutVariableInput.extend({ access: AccessPolicy });
export type PutOrgVariableInput = z.infer<typeof PutOrgVariableInput>;

export const OrgSecret = z.object({
  name: z.string(),
  access: AccessPolicy,
  prelandAllowed: z.boolean(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});
export type OrgSecret = z.infer<typeof OrgSecret>;

export const OrgVariable = Variable.extend({ access: AccessPolicy });
export type OrgVariable = z.infer<typeof OrgVariable>;

export const OrgRepository = z.object({
  id: z.string(),
  name: z.string(),
  visibility: z.enum(['public', 'private', 'internal']),
});
export type OrgRepository = z.infer<typeof OrgRepository>;

/** Org Settings → Secrets and variables. */
export const OrgSettings = z.object({
  org: z.object({ id: z.string(), handle: z.string() }),
  canManage: z.boolean(),
  secrets: z.array(OrgSecret),
  variables: z.array(OrgVariable),
  repositories: z.array(OrgRepository),
  audit: z.array(
    z.object({ at: z.string(), actorHandle: z.string(), action: z.string(), detail: z.string() }),
  ),
});
export type OrgSettings = z.infer<typeof OrgSettings>;

/** The person asking; null for someone reading a public repository signed out. */
export type ActionsActor = { readonly id: string; readonly handle: string } | null;

/** The fixture fake's surface: the view model, scoped by repository on every call. */
export type ActionsViewRpc = {
  listWorkflows(actor: ActionsActor, repoId: string): Promise<RpcResult<unknown>>;
  dispatchWorkflow(
    actor: ActionsActor,
    repoId: string,
    request: DispatchRequest,
  ): Promise<RpcResult<unknown>>;
  listRuns(actor: ActionsActor, repoId: string, filter: RunFilter): Promise<RpcResult<unknown>>;
  getRun(actor: ActionsActor, repoId: string, runId: string): Promise<RpcResult<unknown>>;
  cancelRun(actor: ActionsActor, repoId: string, runId: string): Promise<RpcResult<unknown>>;
  /** Stored history (R2 segments, then the live tail): lines after `after`. */
  logChunks(
    actor: ActionsActor,
    repoId: string,
    where: { readonly runId: string; readonly jobId: string; readonly after: number },
  ): Promise<RpcResult<unknown>>;
  listSecrets(actor: ActionsActor, repoId: string): Promise<RpcResult<unknown>>;
  putSecret(
    actor: ActionsActor,
    repoId: string,
    input: PutSecretInput,
  ): Promise<RpcResult<unknown>>;
  deleteSecret(actor: ActionsActor, repoId: string, name: string): Promise<RpcResult<unknown>>;
};
