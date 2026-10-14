/** Gateway-backed collaboration records. A message or acknowledgement never proves code. */
import {
  BeanContext,
  BeanPeerSummaries,
  BeanInboxAckResult,
  BeanInboxPage,
  BeanThreadPostResult,
  BeanUpdateResult,
} from '@gitstalk/shared-race/collaboration';
import type {
  BeanContextInput,
  BeanInboxAckInput,
  BeanInboxReadInput,
  BeanThreadPostInput,
  BeanUpdateInput,
} from '@gitstalk/shared-race/collaboration';

import { BeanCommitResult } from '@gitstalk/shared-race/bean-commit';
import type { BeanCommitInput } from '@gitstalk/shared-race/bean-commit';
import type { TaskId } from '@gitstalk/shared-race/ids';

import { ForgeError } from '@gitstalk/shared-ask/forge/forge-errors';
import { unwrap } from '@gitstalk/shared-ask/forge/gateway-rpc';

import type { ToolContext } from './tool-context';

const INBOX_SUMMARY_LIMIT = 5;

export async function beanContext(ctx: ToolContext, input: BeanContextInput): Promise<BeanContext> {
  if (typeof ctx.gateway.beanContext !== 'function') throw unavailable();
  return unwrap(await ctx.gateway.beanContext(ctx.run, input), BeanContext);
}

/** One gateway read of excerpt-only peer summaries; beans the run does not know are omitted. */
export async function beanPeerSummaries(ctx: ToolContext, beans: readonly TaskId[]) {
  if (typeof ctx.gateway.beanPeerSummaries !== 'function') throw unavailable();
  return unwrap(await ctx.gateway.beanPeerSummaries(ctx.run, beans), BeanPeerSummaries);
}

export async function beanUpdate(
  ctx: ToolContext,
  input: BeanUpdateInput,
): Promise<BeanUpdateResult> {
  const token = contributorToken(ctx);
  if (typeof ctx.gateway.beanUpdate !== 'function') throw unavailable();
  return unwrap(await ctx.gateway.beanUpdate(token, input), BeanUpdateResult);
}

/** A commit on your own bean branch, built by the gateway; a moved branch answers `conflict`. */
export async function beanCommit(
  ctx: ToolContext,
  input: BeanCommitInput,
): Promise<BeanCommitResult> {
  const token = contributorToken(ctx);
  if (typeof ctx.gateway.beanCommit !== 'function') throw unavailable();
  return unwrap(await ctx.gateway.beanCommit(token, input), BeanCommitResult);
}

export async function beanThreadPost(
  ctx: ToolContext,
  input: BeanThreadPostInput,
): Promise<BeanThreadPostResult> {
  const token = contributorToken(ctx);
  if (typeof ctx.gateway.beanThreadPost !== 'function') throw unavailable();
  return unwrap(await ctx.gateway.beanThreadPost(token, input), BeanThreadPostResult);
}

export async function beanInboxRead(
  ctx: ToolContext,
  input: BeanInboxReadInput,
): Promise<BeanInboxPage> {
  const token = contributorToken(ctx);
  if (typeof ctx.gateway.beanInboxRead !== 'function') throw unavailable();
  return unwrap(await ctx.gateway.beanInboxRead(token, input), BeanInboxPage);
}

export async function beanInboxAck(
  ctx: ToolContext,
  input: BeanInboxAckInput,
): Promise<BeanInboxAckResult> {
  const token = contributorToken(ctx);
  if (typeof ctx.gateway.beanInboxAck !== 'function') throw unavailable();
  return unwrap(await ctx.gateway.beanInboxAck(token, input), BeanInboxAckResult);
}

/** A bounded reminder on ordinary reads. It neither acknowledges nor accepts any event. */
export async function withInbox<T extends object>(ctx: ToolContext, read: () => Promise<T>) {
  const [answer, inbox] = await Promise.all([read(), inboxSummary(ctx)]);
  return inbox === undefined ? answer : { ...answer, inbox };
}

async function inboxSummary(ctx: ToolContext) {
  if (ctx.contributor === undefined || typeof ctx.gateway.beanInboxRead !== 'function')
    return undefined;
  try {
    const page = await beanInboxRead(ctx, { state: 'unread', limit: INBOX_SUMMARY_LIMIT });
    return {
      status: 'available',
      bean: page.bean,
      unread: page.unread,
      next_cursor: page.next_cursor,
      current_cursor: page.current_cursor,
      truncated: page.truncated,
      events: page.events
        .filter((entry) => !entry.acknowledged)
        .map(({ event }) => ({
          event_id: event.event_id,
          kind: event.kind,
          bean: event.kind === 'thread.posted' ? event.post.bean : event.bean,
          author_bean: event.kind === 'thread.posted' ? event.post.author_bean : event.author_bean,
          thread: event.kind === 'thread.posted' ? event.post.thread : null,
          post_kind: event.kind === 'thread.posted' ? event.post.kind : null,
        })),
    };
  } catch (error: unknown) {
    ctx.log?.warn('collaboration inbox reminder unavailable', { run: ctx.run, error });
    return { status: 'unavailable', summary: 'Read bean_inbox_read to retry pending events.' };
  }
}

function contributorToken(ctx: ToolContext): string {
  if (ctx.contributor === undefined)
    throw new ForgeError('forbidden: this tool requires a contributor token', 'unavailable');
  return ctx.contributor.token;
}

function unavailable(): ForgeError {
  return new ForgeError('this gateway does not expose bean collaboration', 'unavailable');
}
