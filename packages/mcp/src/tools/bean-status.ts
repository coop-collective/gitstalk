/**
 * `bean_status`: where one bean stands, for every caller. A run token reads its run's view of
 * the bean (`change-status.ts`); a session naming a repository also gets the pushed bean's
 * verdict (phase, rework, journey). `checks: true` adds the structured check failures
 * (`checks-get.ts`): inherited reds and protected tests flagged.
 */
import type { AgentBean } from '@gitstalk/shared-race/agent-repos';
import type { TaskId } from '@gitstalk/shared-race/ids';

import { ForgeError } from '@gitstalk/shared-ask/forge/forge-errors';

import { ToolError } from '../mcp/tool-result';
import { withNext } from '../repos/repo-answers';
import type { ChangeStatus } from './change-status';
import { changeStatus } from './change-status';
import type { ChecksAnswer } from './checks-get';
import { checksGet } from './checks-get';
import { withInbox } from './collaboration';
import { previewUrl } from './preview-link';
import type { ToolContext, ToolScope } from './tool-context';
import { parseBean } from './tool-context';

export type BeanStatusInput = {
  readonly bean: string;
  readonly repo?: string | undefined;
  readonly checks?: boolean | undefined;
};

/** The bean's status; a `ToolError` or a not-found `ForgeError` when no one knows the bean. */
export async function beanStatus(scope: ToolScope, input: BeanStatusInput): Promise<object> {
  const id = parseBean(input.bean);
  if (id === undefined)
    throw new ToolError(
      `"${input.bean}" is not a bean (like t032, add-total, beans/t032 or bean/add-total)`,
    );
  const ctx = await scope.context(input.repo);
  return withInbox(ctx, () => readBean(scope, { ctx, id, input }));
}

type Read = { readonly ctx: ToolContext; readonly id: TaskId; readonly input: BeanStatusInput };

async function readBean(scope: ToolScope, read: Read): Promise<object> {
  const { ctx, id, input } = read;
  const [engine, pushed, checks] = await Promise.all([
    changeStatus(ctx, id),
    input.repo === undefined ? undefined : pushedBean(scope, input.repo, id),
    input.checks === true ? checksGet(ctx, id) : undefined,
  ]);
  const detail = checks === undefined ? {} : checkDetail(checks);
  if (pushed !== undefined && pushed.ok) return sessionAnswer({ ctx, id, pushed, engine, detail });
  if (engine === undefined) {
    if (pushed !== undefined) throw new ToolError(pushed.message);
    throw new ForgeError(`this run has no bean ${id}`, 'not_found');
  }
  return { ...engine, ...detail };
}

type Pushed =
  | { readonly ok: true; readonly bean: AgentBean }
  | { readonly ok: false; readonly message: string };

/** The pushed bean's verdict for a session; undefined for run tokens. */
async function pushedBean(scope: ToolScope, repo: string, id: TaskId): Promise<Pushed | undefined> {
  const { agents, session } = scope;
  if (agents === undefined || session === undefined) return undefined;
  const result = await agents.agentBean(session.principal, repo, id);
  return result.ok
    ? { ok: true, bean: result.value }
    : { ok: false, message: result.error.message };
}

/**
 * A repository's bean: the pushed verdict leads (its phase and next step are the ones an agent
 * acts on); the engine's view of the same bean, when it has one, is under `engine`.
 */
function sessionAnswer(input: {
  readonly ctx: ToolContext;
  readonly id: TaskId;
  readonly pushed: { readonly bean: AgentBean };
  readonly engine: ChangeStatus | undefined;
  readonly detail: object;
}): object {
  const { ctx, id, engine } = input;
  const bean = withNext(input.pushed.bean, id);
  return {
    bean: id,
    ...bean,
    engine: engine === undefined ? null : engineView(engine),
    ...input.detail,
    preview_url: previewUrl(ctx.webUrl, ctx.run, { kind: 'bean', bean: id }),
    summary: `${id} ${bean.phase}. ${bean.next}`,
  };
}

/**
 * The engine's view without what the pushed verdict already says: the link, the next step,
 * the summary and the engine's internal branch name (the bean's branch is `bean/<name>`).
 */
function engineView(engine: ChangeStatus): object {
  const { preview_url: _link, next: _next, summary: _summary, branch: _branch, ...view } = engine;
  return view;
}

/** The structured checks that replace the counts: failures, history, blame. */
function checkDetail(checks: ChecksAnswer): object {
  const { bean: _bean, summary, checks: counts, blamed_by, ...rest } = checks;
  return { checks: { ...counts, ...rest, summary }, blamed_by };
}
