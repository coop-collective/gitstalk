/**
 * What the Actions, secrets and automation tools answer: the gateway's `AgentActionsRpc`,
 * plus the web links (run pages, Settings → Secrets and variables), a one-line `summary` and
 * the `next` step an agent acts on. A secret's value goes to the gateway once and is never in
 * an answer, an error or a log line.
 */
import type {
  AgentActionsRpc,
  AgentRun,
  AgentRunSummary,
  AgentRunWaited,
} from '@gitstalk/shared-race/agent-actions';
import type { AgentPrincipal } from '@gitstalk/shared-race/agent-repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { ToolError } from '../mcp/tool-result';
import { valueOf } from '../repos/agent-gateway';
import type { ToolScope } from '../tools/tool-context';

const DEFAULT_WAIT_SECONDS = 600;

type Session = {
  readonly actions: AgentActionsRpc;
  readonly principal: AgentPrincipal;
  readonly webUrl: string;
};

/** The session's person and the gateway's Actions RPC; only sessions have the tools. */
export function actionsOf(scope: ToolScope): Session {
  if (scope.session === undefined || scope.actions === undefined)
    throw new ToolError(
      scope.session === undefined
        ? 'Actions tools need a signed-in agent session'
        : 'this Gitstalk deployment does not serve Actions to agents yet',
    );
  return { actions: scope.actions, principal: scope.session.principal, webUrl: scope.webUrl };
}

export async function workflowList(scope: ToolScope, repo: string): Promise<object> {
  const { actions, principal } = actionsOf(scope);
  const listed = valueOf(await actions.agentWorkflows(principal, repo));
  const workflows = listed.workflows.filter((workflow) => workflow.kind === 'workflow');
  const invalid = workflows.filter((workflow) => workflow.state === 'invalid').length;
  return {
    ...listed,
    summary:
      listed.workflows.length === 0
        ? `${repo} has no workflows on the stalk. Land .github/workflows/<name>.yml in a bean: it runs on push to main (the stalk moving), workflow_dispatch and schedule.`
        : `${workflows.length} workflows (${invalid} invalid), ${listed.workflows.length - workflows.length} automations. A bean reaching the stalk is a push to ${listed.default_branch === 'stalk' ? 'main' : listed.default_branch}.`,
  };
}

export async function runList(
  scope: ToolScope,
  input: { readonly repo: string } & Parameters<AgentActionsRpc['agentRuns']>[2],
): Promise<object> {
  const session = actionsOf(scope);
  const { repo, ...filter } = input;
  const page = valueOf(await session.actions.agentRuns(session.principal, repo, filter));
  const runs = page.runs.map((run) => withUrl(session, repo, run));
  const failed = runs.filter((run) => run.conclusion === 'failure').length;
  return {
    ...page,
    runs,
    summary:
      runs.length === 0
        ? 'No runs match. A workflow runs when a bean reaches the stalk (push to main), by actions_dispatch, or on its schedule.'
        : `${count(runs.length, 'run')}, newest first; ${failed} failed. actions_run_get for jobs and steps.`,
  };
}

export async function runGet(
  scope: ToolScope,
  input: { readonly repo: string; readonly run: string },
): Promise<object> {
  const session = actionsOf(scope);
  const run = valueOf(await session.actions.agentRun(session.principal, input.repo, input.run));
  return { ...withUrl(session, input.repo, run), next: runNext(run) };
}

export async function jobLog(
  scope: ToolScope,
  input: { readonly repo: string } & Parameters<AgentActionsRpc['agentJobLog']>[2],
): Promise<object> {
  const session = actionsOf(scope);
  const { repo, ...request } = input;
  const log = valueOf(await session.actions.agentJobLog(session.principal, repo, request));
  return {
    ...log,
    summary: `${log.job.name} (${log.job.conclusion ?? log.job.status}): ${log.lines_shown} of ${log.matched ?? log.lines_total} lines${log.truncated ? ', older ones left out (raise tail or use grep)' : ''}${log.complete ? '' : '; the job is still writing'}.`,
  };
}

export async function dispatch(
  scope: ToolScope,
  input: { readonly repo: string } & Parameters<AgentActionsRpc['agentDispatch']>[2],
): Promise<object> {
  const session = actionsOf(scope);
  const { repo, ...request } = input;
  const run = valueOf(await session.actions.agentDispatch(session.principal, repo, request));
  return started(session, repo, run, `Started ${run.workflow_name} #${run.number} on the stalk.`);
}

export async function rerun(
  scope: ToolScope,
  input: { readonly repo: string; readonly run: string },
): Promise<object> {
  const session = actionsOf(scope);
  const run = valueOf(await session.actions.agentRerun(session.principal, input.repo, input.run));
  return started(session, input.repo, run, `Re-running as ${run.workflow_name} #${run.number}.`);
}

export async function cancel(
  scope: ToolScope,
  input: { readonly repo: string; readonly run: string },
): Promise<object> {
  const session = actionsOf(scope);
  const run = valueOf(await session.actions.agentCancel(session.principal, input.repo, input.run));
  return {
    run: withUrl(session, input.repo, run),
    summary: `Cancelling ${run.workflow_name} #${run.number}: running steps stop within seconds.`,
  };
}

export async function waitForRun(
  scope: ToolScope,
  input: {
    readonly repo: string;
    readonly run?: string | undefined;
    readonly bean?: string | undefined;
    readonly workflow?: string | undefined;
    readonly timeout_s?: number | undefined;
  },
): Promise<object> {
  const session = actionsOf(scope);
  const { repo, timeout_s: timeout, ...which } = input;
  const waited = valueOf(
    await session.actions.agentWaitRun(session.principal, repo, {
      ...which,
      seconds: timeout ?? DEFAULT_WAIT_SECONDS,
    }),
  );
  return {
    ...waited,
    runs: waited.runs.map((run) => withUrl(session, repo, run)),
    next: waitNext(waited),
  };
}

export async function entriesList(
  scope: ToolScope,
  input: { readonly repo: string; readonly kind: 'secrets' | 'variables' },
): Promise<object> {
  const session = actionsOf(scope);
  const entries = valueOf(await session.actions.agentActionsEntries(session.principal, input.repo));
  const settings = settingsUrl(session, input.repo);
  if (input.kind === 'secrets')
    return {
      repo: entries.repo,
      org: entries.org,
      can_manage: entries.can_manage,
      secrets: entries.secrets,
      settings_url: settings,
      summary: `${count(entries.secrets.length, 'secret')} (names only; values are never shown). Workflows read them as \${{ secrets.NAME }}. A missing one: ask the person to add it at settings_url, or to give you the value for actions_secret_set.`,
    };
  return {
    repo: entries.repo,
    org: entries.org,
    can_manage: entries.can_manage,
    variables: entries.variables,
    settings_url: settings,
    summary: `${count(entries.variables.length, 'variable')}. Workflows read them as \${{ vars.NAME }}.`,
  };
}

export async function secretSet(
  scope: ToolScope,
  input: { readonly repo: string } & Parameters<AgentActionsRpc['agentPutSecret']>[2],
): Promise<object> {
  const session = actionsOf(scope);
  const { repo, ...secret } = input;
  const saved = withSettingsHint(
    session,
    repo,
    await session.actions.agentPutSecret(session.principal, repo, secret),
  );
  return {
    ...saved,
    summary: `Saved ${saved.name} (${saved.level}). Its value cannot be read back. A run that already finished does not see it: actions_rerun that run, or land a change.`,
  };
}

export async function variableSet(
  scope: ToolScope,
  input: { readonly repo: string } & Parameters<AgentActionsRpc['agentPutVariable']>[2],
): Promise<object> {
  const session = actionsOf(scope);
  const { repo, ...variable } = input;
  const saved = withSettingsHint(
    session,
    repo,
    await session.actions.agentPutVariable(session.principal, repo, variable),
  );
  return { ...saved, summary: `Saved ${saved.name} (${saved.level}).` };
}

export async function entryDelete(
  scope: ToolScope,
  input: {
    readonly repo: string;
    readonly name: string;
    readonly level?: 'repository' | 'organization' | undefined;
    readonly kind: 'secret' | 'variable';
  },
): Promise<object> {
  const session = actionsOf(scope);
  const { repo, kind, ...ref } = input;
  const result =
    kind === 'secret'
      ? await session.actions.agentDeleteSecret(session.principal, repo, ref)
      : await session.actions.agentDeleteVariable(session.principal, repo, ref);
  const deleted = withSettingsHint(session, repo, result);
  return {
    ...deleted,
    summary: deleted.deleted
      ? `Deleted ${deleted.name} (${deleted.level}).`
      : `${repo} has no ${kind} ${deleted.name} at the ${deleted.level} level.`,
  };
}

export async function automationGet(
  scope: ToolScope,
  input: { readonly repo: string; readonly automation: string },
): Promise<object> {
  const session = actionsOf(scope);
  const found = valueOf(
    await session.actions.agentAutomation(session.principal, input.repo, input.automation),
  );
  return {
    ...found,
    runs: found.runs.map((run) => withUrl(session, input.repo, run)),
    summary: `${found.name} (${found.state}): ${found.triggers.join(', ') || 'no triggers'}; ${found.runs.length} recent runs. To change it, edit ${found.path} in a bean.`,
  };
}

export async function automationRun(
  scope: ToolScope,
  input: { readonly repo: string; readonly automation: string },
): Promise<object> {
  const session = actionsOf(scope);
  const begun = valueOf(
    await session.actions.agentRunAutomation(session.principal, input.repo, input.automation),
  );
  return {
    ...begun,
    run: withUrl(session, input.repo, begun.run),
    summary: `Started ${begun.automation} #${begun.run.number} (a manual run; it keeps its memory).`,
    next: `actions_wait_for_run with run ${begun.run.id}`,
  };
}

/** The run's page on the web app. */
export function runUrl(webUrl: string, repo: string, run: AgentRunSummary): string {
  const section = run.kind === 'automation' ? 'automations' : 'actions';
  return new URL(`/${repo}/${section}/runs/${encodeURIComponent(run.id)}`, webUrl).toString();
}

function withUrl<R extends AgentRunSummary>(
  session: Session,
  repo: string,
  run: R,
): R & { readonly run_url: string } {
  return { ...run, run_url: runUrl(session.webUrl, repo, run) };
}

function started(session: Session, repo: string, run: AgentRunSummary, summary: string): object {
  return {
    run: withUrl(session, repo, run),
    summary,
    next: `actions_wait_for_run with run ${run.id}`,
  };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function settingsUrl(session: Session, repo: string): string {
  return new URL(`/${repo}/settings/secrets`, session.webUrl).toString();
}

/** The value, or an error that tells the agent the person can do it in Settings instead. */
function withSettingsHint<T>(session: Session, repo: string, result: RpcResult<T>): T {
  if (result.ok) return result.value;
  const message = result.error.message.replace(/\.$/, '');
  if (result.error.status !== 403) throw new ToolError(message);
  throw new ToolError(
    `${message}. Ask the person to do it in Settings → Secrets and variables: ${settingsUrl(session, repo)}`,
  );
}

function runNext(run: AgentRun): string {
  if (run.status !== 'completed')
    return `still ${run.status}: actions_wait_for_run with run ${run.id}`;
  if (run.conclusion === 'success') return 'done';
  const failed = run.jobs.find((job) => job.failed_step !== null || job.conclusion === 'failure');
  return failed === undefined
    ? `ended ${run.conclusion ?? ''}: ${run.reason ?? 'see the run page'}`
    : `actions_job_log with run ${run.id} and job "${failed.name}"; fix the cause, then push a bean (or actions_rerun if it was a secret or variable)`;
}

function waitNext(waited: AgentRunWaited): string {
  switch (waited.outcome) {
    case 'completed':
      if (waited.runs.some((run) => run.failures.length > 0))
        return 'read failures[].log_tail (actions_job_log for more), fix the cause in a new bean, push, and wait again; for a missing secret ask the person (actions_secret_list shows names)';
      return waited.runs.every((run) => run.conclusion === 'success')
        ? 'all runs succeeded'
        : `ended ${waited.runs.map((run) => run.conclusion ?? run.status).join(', ')}: actions_rerun runs one again`;
    case 'running':
      return 'still running: call actions_wait_for_run again with the run id';
    case 'bean_not_on_stalk':
      return 'the bean has not reached the stalk: bean_status shows why (red, conflict, waiting for validation)';
    case 'no_run':
      return 'no run started: check actions_workflow_list (triggers, branch and path filters, problems)';
    default:
      return 'see the runs';
  }
}
