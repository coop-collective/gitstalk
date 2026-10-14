import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  BeanContextInput,
  BeanInboxAckInput,
  BeanInboxReadInput,
  BeanThreadPostInput,
  BeanUpdateInput,
} from '@gitstalk/shared-race/collaboration';
import { BeanCommitInput } from '@gitstalk/shared-race/bean-commit';

import {
  beanCommit,
  beanInboxAck,
  beanInboxRead,
  beanThreadPost,
  beanUpdate,
  withInbox,
} from '../tools/collaboration';
import type { ToolContext } from '../tools/tool-context';
import { beanConversation } from '../tools/bean-conversation';
import { answer } from './tool-result';

export const COLLABORATION_TOOL_NAMES = [
  'bean_context',
  'bean_update',
  'bean_commit',
  'bean_thread_post',
  'bean_inbox_read',
  'bean_inbox_ack',
] as const;

/** The bean id (t032) or its branch (beans/t032): the same handle every tool accepts. */
function acceptingBranch<S extends z.ZodType>(schema: S) {
  return z.preprocess((value) => {
    if (typeof value !== 'object' || value === null || !('bean' in value)) return value;
    const { bean } = value;
    return typeof bean === 'string'
      ? { ...value, bean: bean.trim().replace(/^beans\//, '') }
      : value;
  }, schema);
}
const ContextToolInput = acceptingBranch(BeanContextInput);
const UpdateToolInput = acceptingBranch(BeanUpdateInput);
const ThreadToolInput = acceptingBranch(BeanThreadPostInput);
const CommitToolInput = acceptingBranch(BeanCommitInput);

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Partial injected clients may omit collaboration; view capabilities expose only context. */
export function registerCollaboration(server: McpServer, ctx: ToolContext): void {
  if (typeof ctx.gateway.beanContext === 'function') {
    server.registerTool(
      'bean_context',
      {
        title: 'Context and conversation of a bean',
        description:
          'Read current intent, approach, exact promises, reliance and paged discussion. Promise offers and agreement remain separate from implementation check evidence. Pass next_cursor as since to continue history.',
        inputSchema: ContextToolInput,
        annotations: READ,
      },
      async (input) => answer(() => withInbox(ctx, () => beanConversation(ctx, input))),
    );
  }
  if (ctx.contributor === undefined) return;
  registerUpdate(server, ctx);
  registerCommit(server, ctx);
  registerThread(server, ctx);
  registerInbox(server, ctx);
}

function registerUpdate(server: McpServer, ctx: ToolContext): void {
  if (typeof ctx.gateway.beanUpdate !== 'function') return;
  server.registerTool(
    'bean_update',
    {
      title: 'Update your bean approach and promises',
      description:
        'Revise only your owning bean with an optimistic expected_revision. Offer a promise or pin exact reliance; the gateway derives actor identity from your contributor token. Reuse an idempotency_key only for an exact retry. A promise offer does not establish passing code evidence.',
      inputSchema: UpdateToolInput,
      annotations: WRITE,
    },
    async (input) => answer(() => beanUpdate(ctx, input)),
  );
}

function registerCommit(server: McpServer, ctx: ToolContext): void {
  if (typeof ctx.gateway.beanCommit !== 'function') return;
  server.registerTool(
    'bean_commit',
    {
      title: 'Commit files to your bean without a checkout',
      description:
        'Write or delete files on your own bean branch (beans/<bean>) as one commit the gateway builds; no clone, no push. For small edits by agents without a checkout; with a checkout, keep using git. expected_head is the branch head you read (null creates the branch from the sprout); if the branch moved you get kind "conflict" with current_head, nothing is overwritten. changes: [{path, content} | {path, delete: true}], at most 64 paths and 192 KiB. Reuse idempotency_key only for an exact retry.',
      inputSchema: CommitToolInput,
      annotations: WRITE,
    },
    async (input) => answer(() => beanCommit(ctx, input)),
  );
}

function registerThread(server: McpServer, ctx: ToolContext): void {
  if (typeof ctx.gateway.beanThreadPost !== 'function') return;
  server.registerTool(
    'bean_thread_post',
    {
      title: 'Discuss a change with another bean',
      description:
        'Post a note, request, reply, counterproposal, accept or decline. Responses name thread and exact reply_to event. Acceptance requires one exact promise reference and records reliance for your owning bean. Silence or inbox acknowledgements never imply agreement. Reuse idempotency_key for exact retries.',
      inputSchema: ThreadToolInput,
      annotations: WRITE,
    },
    async (input) => answer(() => beanThreadPost(ctx, input)),
  );
}

function registerInbox(server: McpServer, ctx: ToolContext): void {
  if (typeof ctx.gateway.beanInboxRead === 'function') {
    server.registerTool(
      'bean_inbox_read',
      {
        title: 'Recover events relevant to your bean',
        description:
          'Read a bounded durable inbox for your owning bean. state defaults to all; use unread to fetch pending events. Reading does not acknowledge or accept messages. Continue with next_cursor as after_cursor; current_cursor describes freshness. Recover after disconnects through this same tool.',
        inputSchema: BeanInboxReadInput,
        annotations: READ,
      },
      async (input) => answer(() => beanInboxRead(ctx, input)),
    );
  }
  if (typeof ctx.gateway.beanInboxAck !== 'function') return;
  server.registerTool(
    'bean_inbox_ack',
    {
      title: 'Acknowledge inbox delivery',
      description:
        'Acknowledge handled event_ids only in your owning bean inbox. This records delivery acknowledgement and does not accept a request, change reliance or establish implementation evidence.',
      inputSchema: BeanInboxAckInput,
      annotations: WRITE,
    },
    async (input) => answer(() => beanInboxAck(ctx, input)),
  );
}
