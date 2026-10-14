/**
 * What the repository tools answer: the gateway's repository RPC, plus the git commands and
 * next steps an agent acts on. Each answer leads with a one-line `summary`.
 */
import { z } from 'zod';

import type { AgentPrincipal, AgentReposRpc } from '@gitstalk/shared-race/agent-repos';
import { BeanCommitResult } from '@gitstalk/shared-race/bean-commit';
import type { BeanCommitInput } from '@gitstalk/shared-race/bean-commit';
import type { PushedBeanStatus } from '@gitstalk/shared-race/rpc';

import { ToolError } from '../mcp/tool-result';
import { withInbox } from '../tools/collaboration';
import { runStatus } from '../tools/run-status';
import type { ToolScope } from '../tools/tool-context';
import { RepositoryAnswer, parsed, valueOf } from './agent-gateway';

const DEFAULT_WAIT_SECONDS = 300;
const SENT_BACK: ReadonlySet<string> = new Set(['red', 'conflict']);
const IN_FLIGHT: ReadonlySet<string> = new Set(['checking', 'waiting']);

/** The session's person and the gateway's repository RPC; only sessions have the tools. */
export function sessionOf(scope: ToolScope): {
  readonly agents: AgentReposRpc;
  readonly principal: AgentPrincipal;
} {
  if (scope.session === undefined || scope.agents === undefined)
    throw new ToolError('repository tools need a signed-in agent session');
  return { agents: scope.agents, principal: scope.session.principal };
}

/** The repository's automations and their newest runs (doc 25 §7). */
export async function automationList(scope: ToolScope, repo: string): Promise<object> {
  const { agents, principal } = sessionOf(scope);
  if (agents.agentAutomations === undefined)
    throw new ToolError('this Gitstalk deployment does not list automations yet');
  const listed = valueOf(await agents.agentAutomations(principal, repo));
  const invalid = listed.automations.filter((automation) => automation.state === 'invalid');
  return {
    ...listed,
    summary: `${listed.automations.length} automations (${invalid.length} with problems), ${listed.runs.length} recent runs`,
  };
}

export async function repoList(scope: ToolScope): Promise<object> {
  const { agents, principal } = sessionOf(scope);
  const repositories = z
    .array(RepositoryAnswer.loose())
    .parse(valueOf(await agents.agentRepositories(principal)));
  return {
    repositories: repositories.map((repository) => ({
      ...repository,
      clone_url: cloneUrl(scope, repository.git_path),
    })),
    summary:
      repositories.length === 0
        ? 'You own no repositories yet; create one on the web, or name a public one as owner/name.'
        : `${repositories.length} repositories: ${repositories.map((repository) => repository.repo).join(', ')}`,
  };
}

/**
 * `repo_status`: a repository's lines and beans for a session naming one; without a
 * repository, the caller's own run (a run token's, with a contributor's inbox).
 */
export async function repoStatus(scope: ToolScope, repo: string | undefined): Promise<object> {
  if (repo === undefined) {
    const own = await scope.context(undefined);
    return withInbox(own, () => runStatus(own));
  }
  const { agents, principal } = sessionOf(scope);
  const ctx = await scope.context(repo);
  const [lines, pushed] = await Promise.all([
    runStatus(ctx),
    agents.agentPushedBeans(principal, repo),
  ]);
  const beans = valueOf(pushed);
  const stalkRuns = await runsAt(scope, { repo, sha: lines.stalk.sha });
  const inFlight = beans.filter((bean) => IN_FLIGHT.has(bean.phase)).map(beanLine);
  const sentBack = beans.filter((bean) => SENT_BACK.has(bean.phase)).map(beanLine);
  return {
    repo,
    stalk: lines.stalk.sha,
    sprout: lines.sprout.sha,
    window: lines.window,
    in_flight: inFlight,
    sent_back: sentBack,
    recent_reds: lines.red_validations.recent,
    open_cards: lines.open_cards,
    stalk_runs: stalkRuns,
    landed: beans.filter((bean) => bean.phase === 'landed' || bean.phase === 'green').length,
    preview_urls: lines.preview_urls,
    summary: [
      `${inFlight.length} in flight`,
      `${sentBack.length} sent back`,
      `window ${lines.window.unvalidated}${lines.window.size === null ? '' : `/${lines.window.size}`}`,
      `${lines.red_validations.count} red validations`,
      `${lines.open_cards.length} open cards`,
      `${stalkRuns.length} workflow runs on the stalk head (${stalkRuns.filter((run) => run.status !== 'completed').length} running, ${stalkRuns.filter((run) => run.conclusion === 'failure').length} failed)`,
    ].join(', '),
  };
}

/**
 * The workflow runs the stalk's head started (its landing's push runs): what an agent asks
 * after a landing. Empty when the gateway has no Actions RPC, the stalk has no head, or the
 * read fails: a hint, never a reason to fail `repo_status`.
 */
async function runsAt(
  scope: ToolScope,
  input: { readonly repo: string; readonly sha: string | null },
): Promise<
  readonly {
    readonly id: string;
    readonly workflow: string;
    readonly status: string;
    readonly conclusion: string | null;
  }[]
> {
  const { actions, session } = scope;
  if (actions === undefined || session === undefined || input.sha === null) return [];
  const listed = await actions.agentRuns(session.principal, input.repo, {
    sha: input.sha,
    limit: 10,
  });
  if (!listed.ok) return [];
  return listed.value.runs.map((run) => ({
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    conclusion: run.conclusion,
  }));
}

export async function openBean(
  scope: ToolScope,
  input: {
    readonly repo: string;
    readonly bean: string;
    readonly intent: string;
    readonly task?: string | undefined;
  },
): Promise<object> {
  const { agents, principal } = sessionOf(scope);
  const { repo, bean, intent, task } = input;
  const repository = parsed(await agents.agentRepository(principal, repo), RepositoryAnswer);
  const opened = valueOf(
    await agents.agentOpenBean(principal, repo, {
      bean,
      intent,
      ...(task === undefined ? {} : { task }),
    }),
  );
  const branch = opened.branch;
  return {
    ...opened,
    clone_url: cloneUrl(scope, repository.git_path),
    start: `git fetch origin sprout && git switch -c ${branch} origin/sprout`,
    push: `git push origin HEAD:refs/heads/${branch}`,
    wait: `git push -o bean=${opened.bean} origin HEAD:refs/wait/any`,
    summary: `Reserved ${branch} until ${opened.expires_at}${opened.task === null ? '' : ` for task ${opened.task}`}. Start from the sprout, commit, then push; the reserved intent is the bean's. The push returns once the bean is received: take your next task while its check runs; when you are out of work, the wait command (or bean_wait) blocks until the verdict. Never sleep-poll.`,
  };
}

/** `bean_commit` for a session: a commit on `bean/<name>` that the engine checks as a push. */
export async function commitBean(
  scope: ToolScope,
  input: { readonly repo: string } & BeanCommitInput,
): Promise<object> {
  const { agents, principal } = sessionOf(scope);
  if (agents.agentCommitBean === undefined)
    throw new ToolError('this Gitstalk deployment does not commit on the server yet');
  const { repo, ...commit } = input;
  const result = parsed(await agents.agentCommitBean(principal, repo, commit), BeanCommitResult);
  if (result.kind === 'conflict')
    return {
      ...result,
      summary: `${result.branch} is at ${result.current_head ?? 'nothing (it does not exist)'}, not ${result.expected_head ?? 'nothing'}: nothing was written. Read it there and commit again with that expected_head.`,
    };
  return {
    ...result,
    summary: `Committed ${result.commit} on ${result.branch} (${result.files} files) and submitted it as a push: its pre-land check runs now. bean_wait when you are out of other work.`,
  };
}

export async function beanWait(
  scope: ToolScope,
  input: {
    readonly repo: string;
    readonly bean: string;
    readonly until?: 'verdict' | 'stalk' | undefined;
    readonly timeout_s?: number | undefined;
  },
): Promise<object> {
  const { agents, principal } = sessionOf(scope);
  const waited = valueOf(
    await agents.agentWaitBean(principal, input.repo, input.bean, {
      until: input.until ?? 'verdict',
      seconds: input.timeout_s ?? DEFAULT_WAIT_SECONDS,
    }),
  );
  return withNext(waited, input.bean);
}

export async function taskList(scope: ToolScope, repo: string): Promise<object> {
  const { agents, principal } = sessionOf(scope);
  const backlog = valueOf(await agents.agentBacklog(principal, repo));
  const open = backlog.tasks.filter((task) => task.state === 'open').length;
  return {
    ...backlog,
    summary:
      backlog.file === null
        ? `${repo} has no backlog (.gitstalk/backlog.md or BACKLOG.md); land one as a bean to start one`
        : `${backlog.tasks.length} tasks in ${backlog.file}, ${open} open`,
  };
}

export async function taskClaim(
  scope: ToolScope,
  input: { readonly repo: string; readonly task: string },
): Promise<object> {
  const { agents, principal } = sessionOf(scope);
  const claimed = valueOf(await agents.agentClaimTask(principal, input.repo, input.task));
  return {
    ...claimed,
    summary: `Task ${claimed.task.id} is yours until ${claimed.task.until ?? 'its bean lands'}. Next: bean_open with task ${claimed.task.id}.`,
  };
}

export async function taskRelease(
  scope: ToolScope,
  input: { readonly repo: string; readonly task: string },
): Promise<object> {
  const { agents, principal } = sessionOf(scope);
  const released = valueOf(await agents.agentReleaseTask(principal, input.repo, input.task));
  return {
    ...released,
    summary: `Gave task ${released.task.id} back; it is ${released.task.state} now.`,
  };
}

/**
 * The clone URL of a repository: on the web host, as GitHub serves it (`<web>/<owner>/<repo>.git`;
 * the gateway's `/git/<owner>/<repo>.git` path still works).
 */
export function cloneUrl(scope: ToolScope, gitPath: string): string {
  return new URL(gitPath.replace(/^\/git\//, '/'), scope.gitOrigin).toString();
}

function beanLine(bean: PushedBeanStatus) {
  return {
    bean: bean.bean,
    title: bean.title,
    actor: bean.actor,
    phase: bean.phase,
    reason: bean.reason,
    task: bean.task,
  };
}

/** The answer with the one next step its phase calls for. */
export function withNext<T extends { readonly phase: string }>(
  bean: T,
  name: string,
): T & { next: string } {
  return { ...bean, next: nextStep(bean.phase, name) };
}

function nextStep(phase: string, bean: string): string {
  const branch = `bean/${bean.replace(/^beans?\//, '')}`;
  switch (phase) {
    case 'open':
      return `commit on ${branch}, then git push origin HEAD:refs/heads/${branch} and take your next task`;
    case 'checking':
    case 'waiting':
      return `the pre-land check is running: keep working; when out of work, bean_wait or git push -o bean=${branch.slice('bean/'.length)} origin HEAD:refs/wait/any (wakes at the verdict)`;
    case 'landed':
      return 'landed on the sprout; it reaches the stalk when the sprout validates (bean_wait until: stalk), and that starts push workflows (actions_wait_for_run with bean)';
    case 'green':
      return `on the stalk (a push to main): if the repository has workflows, actions_wait_for_run with bean ${bean.replace(/^beans?\//, '')} follows the runs it started`;
    case 'red':
      return `git fetch origin sprout && git rebase origin/sprout; fix the code so the failing tests pass, keeping the collided beans' intent; git push -f origin HEAD:refs/heads/${branch}`;
    case 'conflict':
      return `git fetch origin sprout && git rebase origin/sprout; resolve keeping both intents; git push -f origin HEAD:refs/heads/${branch}`;
    case 'parked':
      return 'a person decides (decision card); wait, do not work around it';
    case 'dropped':
      return 'dropped: read the reason; start a new bean if the change is still needed';
    default:
      return 'read the reason';
  }
}
