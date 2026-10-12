/**
 * Agents running a repository's Actions through MCP (`docs/claude-opus/23-mcp-repository-tools.md`
 * §5): the gateway RPC behind the MCP Worker's `actions_*` and automation tools. Every call names
 * the repository as `owner/name`, like `AgentReposRpc`, and the gateway decides access the way the
 * web does (`mayUseEngine` through `repos/access.ts`): a role to read, maintain to run workflows
 * and manage secrets. On top of the role, the session's scopes cap what it may do: `read` for
 * reads, `write` to dispatch, re-run, cancel and start automations, `secrets` to change secrets
 * and variables. No answer ever carries a secret value.
 */
import { z } from 'zod';

import type {
  ActionsConclusion,
  ActionsEvent,
  ActionsStatus,
  DispatchInputSpec,
  GitstalkEvent,
} from './actions';
import { ACTIONS_EVENTS, ACTIONS_STATUSES } from './actions';
import type { AgentPrincipal } from './collaborators';
import type { RpcResult } from './rpc';

/** Longest an `actions_wait_for_run` holds (as `bean_wait`). */
export const MAX_RUN_WAIT_SECONDS = 1800;
/** Lines `actions_job_log` returns by default, and at most. */
export const DEFAULT_LOG_TAIL = 80;
export const MAX_LOG_TAIL = 2000;
/** Bytes of log text one answer carries by default, and at most. */
export const DEFAULT_LOG_BYTES = 12_000;
export const MAX_LOG_BYTES = 48_000;

/** A workflow by path (`.github/workflows/ci.yml`), file name (`ci.yml`) or `name:` (`CI`). */
const WorkflowRef = z.string().trim().min(1).max(200);
const RunRef = z.uuid();

/** Where a secret or variable lives: the repository, or the org that owns it. */
export const EntryLevel = z.enum(['repository', 'organization']);
export type EntryLevel = z.infer<typeof EntryLevel>;

export const AgentRunFilter = z.object({
  workflow: WorkflowRef.optional(),
  event: z.enum(ACTIONS_EVENTS).optional(),
  status: z.enum(ACTIONS_STATUSES).optional(),
  /** `main`, `stalk` or the base branch: every run is on the stalk today. */
  branch: z.string().trim().min(1).max(255).optional(),
  /** The commit the run checked out (a full or 7+ character sha). */
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
  /** Runs started by the stalk move that carried this bean. */
  bean: z.string().trim().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(100).optional(),
});
export type AgentRunFilter = z.input<typeof AgentRunFilter>;

export const AgentJobLogInput = z.object({
  run: RunRef,
  /** A job id, key or display name; default: the first failed job, else the last one. */
  job: z.string().trim().min(1).max(200).optional(),
  tail: z.number().int().min(1).max(MAX_LOG_TAIL).optional(),
  /** Only lines containing this text (case-insensitive), the newest `tail` of them. */
  grep: z.string().min(1).max(200).optional(),
  max_bytes: z.number().int().min(500).max(MAX_LOG_BYTES).optional(),
});
export type AgentJobLogInput = z.input<typeof AgentJobLogInput>;

export const AgentDispatchInput = z.object({
  workflow: WorkflowRef,
  /** The stalk under any of its names (`stalk`, `main`, the base branch); default `main`. */
  ref: z.string().trim().min(1).max(255).optional(),
  inputs: z
    .record(z.string().max(100), z.union([z.string().max(65_535), z.number(), z.boolean()]))
    .optional(),
});
export type AgentDispatchInput = z.input<typeof AgentDispatchInput>;

/** What to wait for: one run, the runs a bean's landing starts, or a workflow's newest run. */
export const AgentWaitRunInput = z.object({
  run: RunRef.optional(),
  bean: z.string().trim().min(1).max(64).optional(),
  workflow: WorkflowRef.optional(),
  seconds: z.number().int().min(1).max(MAX_RUN_WAIT_SECONDS),
});
export type AgentWaitRunInput = z.input<typeof AgentWaitRunInput>;

export const AgentPutSecretInput = z.object({
  name: z.string().trim().min(1).max(100),
  /** Write-only: stored encrypted, never returned, logged or shown again. */
  value: z
    .string()
    .min(1)
    .max(48 * 1024),
  level: EntryLevel.optional(),
});
export type AgentPutSecretInput = z.input<typeof AgentPutSecretInput>;

export const AgentPutVariableInput = z.object({
  name: z.string().trim().min(1).max(100),
  value: z.string().max(48 * 1024),
  level: EntryLevel.optional(),
});
export type AgentPutVariableInput = z.input<typeof AgentPutVariableInput>;

export const AgentEntryRef = z.object({
  name: z.string().trim().min(1).max(100),
  level: EntryLevel.optional(),
});
export type AgentEntryRef = z.input<typeof AgentEntryRef>;

export type AgentWorkflow = {
  readonly path: string;
  readonly name: string;
  readonly kind: 'workflow' | 'automation';
  /** `invalid` files never run; their problems say why. */
  readonly state: 'active' | 'invalid';
  /** Readable triggers: `push (main)`, `workflow_dispatch`, `schedule (0 6 * * *)`, `bean_landed`. */
  readonly triggers: readonly string[];
  /** Inputs `actions_dispatch` takes; null when the file has no `workflow_dispatch`. */
  readonly dispatch_inputs: readonly DispatchInputSpec[] | null;
  /** Events in `on:` Gitstalk does not start runs for (`pull_request` …). */
  readonly unsupported_events: readonly string[];
  readonly problems: readonly string[];
  readonly jobs: readonly string[];
  /** The stalk commit the file was read at. */
  readonly sha: string;
};

export type AgentWorkflows = {
  readonly repo: string;
  readonly default_branch: string;
  readonly workflows: readonly AgentWorkflow[];
};

export type AgentRunSummary = {
  readonly id: string;
  readonly number: number;
  readonly workflow: string;
  readonly workflow_name: string;
  readonly kind: 'workflow' | 'automation';
  readonly event: ActionsEvent;
  readonly status: ActionsStatus;
  readonly conclusion: ActionsConclusion | null;
  readonly reason: string | null;
  readonly ref: string;
  readonly sha: string;
  readonly actor: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly duration_s: number | null;
};

export type AgentRunPage = {
  readonly repo: string;
  readonly runs: readonly AgentRunSummary[];
  readonly next: string | null;
};

export type AgentStep = {
  readonly number: number;
  readonly name: string;
  readonly status: ActionsStatus;
  readonly conclusion: ActionsConclusion | null;
  readonly duration_s: number | null;
};

export type AgentJob = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: ActionsStatus;
  readonly conclusion: ActionsConclusion | null;
  readonly reason: string | null;
  readonly needs: readonly string[];
  readonly duration_s: number | null;
  readonly steps: readonly AgentStep[];
  /** The first step that failed, by name; null when none did. */
  readonly failed_step: string | null;
};

export type AgentRun = AgentRunSummary & {
  /** The beans the stalk move carried (push runs); empty for other events. */
  readonly beans: readonly string[];
  readonly inputs: Readonly<Record<string, string>>;
  readonly jobs: readonly AgentJob[];
};

export type AgentJobLog = {
  readonly repo: string;
  readonly run: string;
  readonly job: {
    readonly id: string;
    readonly name: string;
    readonly status: ActionsStatus;
    readonly conclusion: ActionsConclusion | null;
  };
  readonly lines_total: number;
  /** Lines that matched `grep`; null without it. */
  readonly matched: number | null;
  readonly lines_shown: number;
  /** Older lines (or bytes) were left out to keep within `tail` and `max_bytes`. */
  readonly truncated: boolean;
  /** The job has ended, so the log will not grow. */
  readonly complete: boolean;
  /** `[step] text` lines, secrets already masked as `***`. */
  readonly text: string;
};

/** A run as `actions_wait_for_run` ends it: for failures, where and the log's last lines. */
export type AgentWaitedRun = AgentRun & {
  readonly failures: readonly {
    readonly job: string;
    readonly step: string | null;
    readonly log_tail: string;
  }[];
};

export type AgentRunWaited = {
  readonly repo: string;
  /**
   * `completed`: every run waited for ended; `running`: the time ran out first; `no_run`: no run
   * started (none matched, or the landing fired no workflow); `bean_not_on_stalk`: the bean has
   * not reached the stalk, so its landing started nothing yet.
   */
  readonly outcome: 'completed' | 'running' | 'no_run' | 'bean_not_on_stalk';
  readonly waited_s: number;
  readonly bean: { readonly bean: string; readonly phase: string } | null;
  readonly runs: readonly AgentWaitedRun[];
};

export type AgentSecret = {
  readonly name: string;
  readonly level: EntryLevel;
  /** The org it comes from, for an organization secret. */
  readonly org: string | null;
  readonly preland_allowed: boolean;
  readonly updated_at: string;
  readonly updated_by: string;
  /** An org secret hidden by the repository's own of the same name. */
  readonly overridden: boolean;
};

export type AgentVariable = Omit<AgentSecret, 'preland_allowed'> & { readonly value: string };

export type AgentActionsEntries = {
  readonly repo: string;
  /** Whether this person may change them (maintain or owner); the session also needs `secrets`. */
  readonly can_manage: boolean;
  readonly org: string | null;
  readonly secrets: readonly AgentSecret[];
  readonly variables: readonly AgentVariable[];
};

/** A saved entry: never a secret's value. */
export type AgentEntrySaved = {
  readonly repo: string;
  readonly name: string;
  readonly level: EntryLevel;
  readonly org: string | null;
  readonly updated_at: string;
  readonly updated_by: string;
};

export type AgentEntryDeleted = {
  readonly repo: string;
  readonly name: string;
  readonly level: EntryLevel;
  readonly deleted: boolean;
};

export type AgentAutomation = {
  readonly repo: string;
  readonly path: string;
  readonly name: string;
  readonly state: 'active' | 'invalid';
  readonly problems: readonly string[];
  readonly triggers: readonly string[];
  readonly events: readonly GitstalkEvent[];
  readonly harness: 'agent' | 'shell' | null;
  readonly model: string | null;
  readonly acts_as: string | null;
  readonly memory_ref: string | null;
  /** The file on the stalk, as written. */
  readonly file: string | null;
  readonly runs: readonly AgentRunSummary[];
};

export type AgentAutomationStarted = {
  readonly repo: string;
  readonly automation: string;
  readonly run: AgentRunSummary;
};

/** The gateway RPC behind the MCP Actions, secrets and automation tools. */
export type AgentActionsRpc = {
  agentWorkflows(principal: AgentPrincipal, repo: string): Promise<RpcResult<AgentWorkflows>>;
  agentRuns(
    principal: AgentPrincipal,
    repo: string,
    filter: AgentRunFilter,
  ): Promise<RpcResult<AgentRunPage>>;
  agentRun(principal: AgentPrincipal, repo: string, run: string): Promise<RpcResult<AgentRun>>;
  agentJobLog(
    principal: AgentPrincipal,
    repo: string,
    input: AgentJobLogInput,
  ): Promise<RpcResult<AgentJobLog>>;
  /** `workflow_dispatch` on the stalk; maintain role and `write` scope. */
  agentDispatch(
    principal: AgentPrincipal,
    repo: string,
    input: AgentDispatchInput,
  ): Promise<RpcResult<AgentRunSummary>>;
  /** The whole run again (same commit, event and inputs) as a new run; maintain and `write`. */
  agentRerun(
    principal: AgentPrincipal,
    repo: string,
    run: string,
  ): Promise<RpcResult<AgentRunSummary>>;
  agentCancel(
    principal: AgentPrincipal,
    repo: string,
    run: string,
  ): Promise<RpcResult<AgentRunSummary>>;
  /** Holds until the runs end or `seconds` pass. */
  agentWaitRun(
    principal: AgentPrincipal,
    repo: string,
    input: AgentWaitRunInput,
  ): Promise<RpcResult<AgentRunWaited>>;
  /** Secret names (never values) and variables, the repository's and its org's (any role). */
  agentActionsEntries(
    principal: AgentPrincipal,
    repo: string,
  ): Promise<RpcResult<AgentActionsEntries>>;
  agentPutSecret(
    principal: AgentPrincipal,
    repo: string,
    input: AgentPutSecretInput,
  ): Promise<RpcResult<AgentEntrySaved>>;
  agentDeleteSecret(
    principal: AgentPrincipal,
    repo: string,
    input: AgentEntryRef,
  ): Promise<RpcResult<AgentEntryDeleted>>;
  agentPutVariable(
    principal: AgentPrincipal,
    repo: string,
    input: AgentPutVariableInput,
  ): Promise<RpcResult<AgentEntrySaved>>;
  agentDeleteVariable(
    principal: AgentPrincipal,
    repo: string,
    input: AgentEntryRef,
  ): Promise<RpcResult<AgentEntryDeleted>>;
  agentAutomation(
    principal: AgentPrincipal,
    repo: string,
    automation: string,
  ): Promise<RpcResult<AgentAutomation>>;
  /** Runs an automation now; maintain role and `write` scope. */
  agentRunAutomation(
    principal: AgentPrincipal,
    repo: string,
    automation: string,
  ): Promise<RpcResult<AgentAutomationStarted>>;
};
