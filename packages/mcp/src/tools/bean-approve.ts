/**
 * `bean_approve`: an agent session approves, for its person, a bean the repository's approval
 * rules hold (`docs/claude-opus/32-approval-rules.md` §5). It calls the gateway's
 * `approveBean`, the same RPC as the web's Approve button, which decides who may (the owner
 * and maintainers), refuses a stale revision and applies the self-approval rule. Here: the
 * session must act for a person (never an automation), and the answer carries the receipt,
 * the bean's page and the next step. Also the `held` lines `bean_status` and `bean_wait` add.
 */
import type { AgentBean } from '@gitstalk/shared-race/agent-repos';
import type { ApprovedBean } from '@gitstalk/shared-race/bean-approval';
import { BeanName } from '@gitstalk/shared-race/agent-repos';

import { ToolError } from '../mcp/tool-result';
import type { AgentSessionContext, ToolScope } from './tool-context';

export type BeanApproveInput = {
  readonly repo: string;
  readonly bean: string;
  readonly revision?: string | undefined;
  readonly note?: string | undefined;
  readonly idempotency_key: string;
  readonly confirm_owner_intent?: boolean | undefined;
};

/** Approves the bean and answers with the receipt and the next step. */
export async function beanApprove(scope: ToolScope, input: BeanApproveInput): Promise<object> {
  const session = approverOf(scope.session);
  const bean = BeanName.safeParse(input.bean.trim().replace(/^bean\//, ''));
  if (!bean.success) throw new ToolError(`"${input.bean}" is not a bean name (like add-total)`);
  const ctx = await scope.context(input.repo);
  if (ctx.gateway.approveBean === undefined)
    throw new ToolError('this Gitstalk gateway predates approvals; approve on the bean page');
  const url = approveUrl(scope.webUrl, input.repo, bean.data);
  const result = await ctx.gateway.approveBean(ctx.run, bean.data, {
    approver: session.userId,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.note === undefined ? {} : { note: input.note }),
    client: {
      kind: 'mcp',
      name: session.clientName,
      session: session.agentKey,
      ...(input.confirm_owner_intent === true ? { confirm_owner_intent: true } : {}),
    },
    idempotency_key: input.idempotency_key,
  });
  if (!result.ok) throw new ToolError(refusalText(result.error, url));
  return receiptOf(result.value, { repo: input.repo, url });
}

/**
 * The session as an approver: a person (`sub`) acting through an agent client (`act`). An
 * automation's identity never approves; the gateway also checks the person may decide.
 */
export function approverOf(session: AgentSessionContext | undefined): AgentSessionContext {
  if (session === undefined)
    throw new ToolError('approving needs a person’s agent session (OAuth or a personal token)');
  const isBot =
    session.userId === '' ||
    session.userId.startsWith('actions-job:') ||
    session.handle.includes('[') ||
    session.agentKey === '';
  if (isBot) throw new ToolError('an automation never approves a bean; a person does');
  return session;
}

/** `held` and the bean's page, and the next step, when the bean waits for an approval. */
export function heldLines(bean: AgentBean, webUrl: string): object {
  const hold = bean.pushed?.hold ?? null;
  if (hold === null || hold.state !== 'held' || bean.pushed === null) return {};
  const url = approveUrl(webUrl, bean.repo, bean.pushed.bean);
  const why = hold.class === null ? 'its classes' : `class ${hold.class}`;
  const reviewers =
    hold.reviewers.length === 0 ? '' : ` (named reviewers: ${hold.reviewers.join(', ')})`;
  return {
    held: true,
    approve_url: url,
    next: `held for a person's approval of ${hold.revision.slice(0, 7)} (${why}, ${hold.by})${reviewers}; nothing to fix. Tell your person it waits at approve_url; approve it with bean_approve only if they tell you to. bean_wait wakes when its check runs again.`,
  };
}

/** The bean's page in the web app, where an owner or maintainer approves it. */
export function approveUrl(webUrl: string, repo: string, bean: string): string {
  const [owner = '', name = ''] = repo.split('/');
  const path = [owner, name, 'changes', bean].map(encodeURIComponent).join('/');
  return new URL(`/${path}`, webUrl).toString();
}

function receiptOf(
  approved: ApprovedBean,
  at: { readonly repo: string; readonly url: string },
): object {
  const short = approved.revision.slice(0, 7);
  const next = nextAfter(approved, short);
  return {
    repo: at.repo,
    bean: approved.bean,
    revision: approved.revision,
    approved_by: approved.approval.by,
    approved_at: approved.approval.at,
    note: approved.approval.note,
    client: approved.approval.client,
    resubmitted: approved.resubmitted,
    replayed: approved.replayed,
    hold: approved.hold,
    approve_url: at.url,
    next,
    summary: `${approved.bean} approved at ${short} by @${approved.approval.by}. ${next}`,
  };
}

function nextAfter(approved: ApprovedBean, short: string): string {
  if (approved.replayed)
    return `already approved for ${short}; nothing new happened. bean_wait follows its check.`;
  if (approved.resubmitted)
    return `approved; its pre-land check runs again on ${short} now. bean_wait (until: verdict) wakes at the verdict.`;
  return `approved; it lands at its next pre-land check of ${short}. bean_wait follows it.`;
}

function refusalText(
  error: { readonly code: string; readonly message: string },
  url: string,
): string {
  if (error.code === 'self_approval') return `${error.message} Its page: ${url}`;
  if (error.code === 'stale_revision') return `${error.message} bean_status shows the head.`;
  return error.message;
}
