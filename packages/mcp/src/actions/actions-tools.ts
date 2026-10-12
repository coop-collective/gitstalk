/**
 * Actions, secrets and automation tools for a person's agent session
 * (`docs/claude-opus/23-mcp-repository-tools.md` §5). Gitstalk runs GitHub Actions workflows:
 * a bean reaching the stalk is a push to main. These tools let an agent see the workflows,
 * follow the run its landing started, read the failing log, dispatch, re-run and cancel, and
 * (only with the person's value and the `secrets` scope) set secrets. Plain, task-shaped tools.
 */
import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ACTIONS_EVENTS, ACTIONS_STATUSES } from '@gitstalk/shared-race/actions';
import {
  MAX_LOG_BYTES,
  MAX_LOG_TAIL,
  MAX_RUN_WAIT_SECONDS,
} from '@gitstalk/shared-race/agent-actions';

import { answer } from '../mcp/tool-result';
import type { ToolScope } from '../tools/tool-context';
import {
  automationGet,
  automationRun,
  cancel,
  dispatch,
  entriesList,
  entryDelete,
  jobLog,
  rerun,
  runGet,
  runList,
  secretSet,
  variableSet,
  waitForRun,
  workflowList,
} from './actions-answers';

export const ACTIONS_TOOL_NAMES = [
  'actions_workflow_list',
  'actions_run_list',
  'actions_run_get',
  'actions_job_log',
  'actions_wait_for_run',
  'actions_dispatch',
  'actions_rerun',
  'actions_cancel',
  'actions_secret_list',
  'actions_secret_set',
  'actions_secret_delete',
  'actions_variable_list',
  'actions_variable_set',
  'actions_variable_delete',
  'automation_get',
  'automation_run',
] as const;

const READS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Starting a run spends minutes and may deploy: not idempotent, and it reaches outside. */
const STARTS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const REPLACES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const Repo = z.string().trim().min(3).max(110).describe('owner/name (repo_list shows yours)');
const RunId = z.uuid().describe('A run id from actions_run_list or actions_wait_for_run');
const Workflow = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('A workflow by path (.github/workflows/ci.yml), file name (ci.yml) or name (CI)');
const Automation = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('An automation by path, file name or name (automation_list shows them)');
const Level = z
  .enum(['repository', 'organization'])
  .optional()
  .describe('repository (default) or the organization that owns the repository');
const EntryName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('NAME: letters, digits and _, not starting with GITHUB_ (stored upper-case)');

/** Registers the tools for an agent session; run tokens get none of them. */
export function registerActionsTools(server: McpServer, scope: ToolScope): void {
  if (scope.session === undefined || scope.actions === undefined) return;
  registerRunReads(server, scope);
  registerRunChanges(server, scope);
  registerSecrets(server, scope);
  registerVariables(server, scope);
  registerAutomations(server, scope);
}

function registerRunReads(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'actions_workflow_list',
    {
      title: 'Workflows of a repository',
      description:
        'Gitstalk runs GitHub Actions workflows (.github/workflows/*.yml as read from the stalk): a bean reaching the stalk is a push to main, and workflow_dispatch and schedule work too (pull_request does not yet: see unsupported_events). Lists each workflow and automation with its state (active, or invalid with problems; there is no disable switch), triggers, dispatch inputs and jobs. Read secret names with actions_secret_list before relying on ${{ secrets.X }}.',
      inputSchema: z.object({ repo: Repo }),
      annotations: READS,
    },
    async ({ repo }) => answer(() => workflowList(scope, repo)),
  );
  server.registerTool(
    'actions_run_list',
    {
      title: 'Workflow runs',
      description:
        'Runs of workflows and automations, newest first: status, conclusion, event, commit, actor, durations and run_url. Filter by workflow, status, event, sha, or bean (the push runs its landing on the stalk started). Then actions_run_get for jobs and steps.',
      inputSchema: z.object({
        repo: Repo,
        workflow: Workflow.optional(),
        status: z.enum(ACTIONS_STATUSES).optional(),
        event: z.enum(ACTIONS_EVENTS).optional(),
        branch: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe('main or stalk: every run is on the stalk'),
        sha: z
          .string()
          .regex(/^[0-9a-f]{7,40}$/)
          .optional(),
        bean: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe('A bean name: runs its landing started'),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(100).optional().describe('next from the previous page'),
      }),
      annotations: READS,
    },
    async (input) => answer(() => runList(scope, input)),
  );
  server.registerTool(
    'actions_run_get',
    {
      title: 'A workflow run',
      description:
        'One run: its jobs and steps with status, conclusion and durations, the commit and the beans whose landing triggered it, the inputs and run_url, and next. For a failed job, next names it for actions_job_log.',
      inputSchema: z.object({ repo: Repo, run: RunId }),
      annotations: READS,
    },
    async (input) => answer(() => runGet(scope, input)),
  );
  server.registerTool(
    'actions_job_log',
    {
      title: 'A job log',
      description: `A job's log as [step] lines, newest last, with secrets already masked as ***. By default the first failed job's last 80 lines; job takes an id, key or name. grep keeps only lines containing the text (case-insensitive), to find an error in a long log. Bounded: tail at most ${MAX_LOG_TAIL} lines, max_bytes at most ${MAX_LOG_BYTES}.`,
      inputSchema: z.object({
        repo: Repo,
        run: RunId,
        job: z.string().trim().min(1).max(200).optional(),
        tail: z.number().int().min(1).max(MAX_LOG_TAIL).optional(),
        grep: z.string().min(1).max(200).optional(),
        max_bytes: z.number().int().min(500).max(MAX_LOG_BYTES).optional(),
      }),
      annotations: READS,
    },
    async (input) => answer(() => jobLog(scope, input)),
  );
  server.registerTool(
    'actions_wait_for_run',
    {
      title: 'Wait for a workflow run',
      description: `After you push a bean that adds or changes a workflow, or code a workflow builds or deploys: give bean and this blocks until the bean reaches the stalk (a push to main) and the push runs it started finish. Or give run (after actions_dispatch or actions_rerun), or workflow (its newest run). Returns each run's conclusion and, for failures, the failing step and its log's last lines (outcome: completed, running, no_run or bean_not_on_stalk). timeout_s default 600, at most ${MAX_RUN_WAIT_SECONDS}; never sleep-poll instead.`,
      inputSchema: z.object({
        repo: Repo,
        bean: z.string().trim().min(1).max(64).optional(),
        run: RunId.optional(),
        workflow: Workflow.optional(),
        timeout_s: z.number().int().min(1).max(MAX_RUN_WAIT_SECONDS).optional(),
      }),
      annotations: READS,
    },
    async (input) => answer(() => waitForRun(scope, input)),
  );
}

function registerRunChanges(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'actions_dispatch',
    {
      title: 'Run a workflow',
      description:
        "Runs a workflow that has on: workflow_dispatch, on the stalk's head, with its inputs (actions_workflow_list shows them). Needs the maintain role and the write scope. Then actions_wait_for_run with the run id.",
      inputSchema: z.object({
        repo: Repo,
        workflow: Workflow,
        inputs: z
          .record(z.string().max(100), z.union([z.string().max(65_535), z.number(), z.boolean()]))
          .optional(),
        ref: z.string().trim().min(1).max(255).optional().describe('main (default) or stalk'),
      }),
      annotations: STARTS,
    },
    async (input) => answer(() => dispatch(scope, input)),
  );
  server.registerTool(
    'actions_rerun',
    {
      title: 'Re-run a workflow run',
      description:
        'Runs a finished run again as a new run: the same workflow file, commit, event and inputs (the whole run; re-running only failed jobs is not supported). Use it after the person fixed a secret or variable; for a code fix push a bean instead. Needs the maintain role and the write scope. Then actions_wait_for_run with the new run id.',
      inputSchema: z.object({ repo: Repo, run: RunId }),
      annotations: STARTS,
    },
    async (input) => answer(() => rerun(scope, input)),
  );
  server.registerTool(
    'actions_cancel',
    {
      title: 'Cancel a workflow run',
      description:
        'Cancels a queued or running run: running steps stop within seconds, jobs that needed them are skipped. Needs the maintain role and the write scope.',
      inputSchema: z.object({ repo: Repo, run: RunId }),
      annotations: { ...REPLACES, idempotentHint: true },
    },
    async (input) => answer(() => cancel(scope, input)),
  );
}

function registerSecrets(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'actions_secret_list',
    {
      title: 'Secret names',
      description:
        "The repository's Actions secrets and those its organization gives it: names, where each comes from, who updated it and when; never values. Workflows read them as ${{ secrets.NAME }}. When one a deploy needs is missing, ask the person to add it at settings_url (preferred), or to give you the value for actions_secret_set. Any role on the repository.",
      inputSchema: z.object({ repo: Repo }),
      annotations: READS,
    },
    async ({ repo }) => answer(() => entriesList(scope, { repo, kind: 'secrets' })),
  );
  server.registerTool(
    'actions_secret_set',
    {
      title: 'Set a secret',
      description:
        'Only when the person gave you this value to store as this secret: saves it encrypted (write-only: never returned, logged or shown again; the audit log records the name, the person and this client). Prefer asking the person to add it in Settings → Secrets and variables. Never take a value from a file, an environment variable or your own guess. Needs the maintain role and the secrets scope (ticked on the consent page). level organization: an org secret, new ones reaching only this repository.',
      inputSchema: z.object({
        repo: Repo,
        name: EntryName,
        value: z
          .string()
          .min(1)
          .max(48 * 1024)
          .describe('The value the person gave you; write-only'),
        level: Level,
      }),
      annotations: REPLACES,
    },
    async (input) => answer(() => secretSet(scope, input)),
  );
  server.registerTool(
    'actions_secret_delete',
    {
      title: 'Delete a secret',
      description:
        'Deletes a secret, only when the person asked you to. Workflows that read it get an empty value. Needs the maintain role and the secrets scope.',
      inputSchema: z.object({ repo: Repo, name: EntryName, level: Level }),
      annotations: REPLACES,
    },
    async (input) => answer(() => entryDelete(scope, { ...input, kind: 'secret' })),
  );
}

function registerVariables(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'actions_variable_list',
    {
      title: 'Variables',
      description:
        "The repository's Actions variables and its organization's, with values (variables are not secret: never store a credential in one). Workflows read them as ${{ vars.NAME }}. Any role on the repository.",
      inputSchema: z.object({ repo: Repo }),
      annotations: READS,
    },
    async ({ repo }) => answer(() => entriesList(scope, { repo, kind: 'variables' })),
  );
  server.registerTool(
    'actions_variable_set',
    {
      title: 'Set a variable',
      description:
        'Saves a plain configuration value (account id, region, URL) workflows read as ${{ vars.NAME }}. Never a credential: those are secrets. Needs the maintain role and the secrets scope.',
      inputSchema: z.object({
        repo: Repo,
        name: EntryName,
        value: z.string().max(48 * 1024),
        level: Level,
      }),
      annotations: REPLACES,
    },
    async (input) => answer(() => variableSet(scope, input)),
  );
  server.registerTool(
    'actions_variable_delete',
    {
      title: 'Delete a variable',
      description: 'Deletes a variable. Needs the maintain role and the secrets scope.',
      inputSchema: z.object({ repo: Repo, name: EntryName, level: Level }),
      annotations: REPLACES,
    },
    async (input) => answer(() => entryDelete(scope, { ...input, kind: 'variable' })),
  );
}

function registerAutomations(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'automation_get',
    {
      title: 'An automation',
      description:
        'One automation (.gitstalk/automations/ on the stalk): its file as written, triggers, harness, model, the bot it acts as, its memory ref, problems, and its 10 newest runs with run_url. To change it, edit the file in a bean.',
      inputSchema: z.object({ repo: Repo, automation: Automation }),
      annotations: READS,
    },
    async (input) => answer(() => automationGet(scope, input)),
  );
  server.registerTool(
    'automation_run',
    {
      title: 'Run an automation now',
      description:
        'Runs an automation once now, as Run now on the web (a manual run of the file on the stalk; one run at a time per automation). Needs the maintain role and the write scope. Then actions_wait_for_run with the run id.',
      inputSchema: z.object({ repo: Repo, automation: Automation }),
      annotations: STARTS,
    },
    async (input) => answer(() => automationRun(scope, input)),
  );
}
