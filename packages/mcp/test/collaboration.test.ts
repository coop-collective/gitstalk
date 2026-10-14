import { createExecutionContext, env } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  BeanContext,
  BeanDiscoverInput,
  BeanInboxPage,
  BeanInboxReadInput,
  BeanPeerSummary,
  BeanThreadPostInput,
  BeanUpdateInput,
} from '@gitstalk/shared-race/collaboration';
import { BeanCommitInput } from '@gitstalk/shared-race/bean-commit';
import type { GatewayRpc } from '@gitstalk/shared-race/rpc';

import { createApp } from '../src/app';
import { authenticate } from '../src/auth/bearer';
import { createLogger } from '../src/log';
import { COLLABORATION_TOOL_NAMES } from '../src/mcp/collaboration-tools';
import { TOOL_NAMES } from '../src/mcp/server';
import { fakeGateway, RUN, SLOT_TOKEN, VIEW_TOKEN } from './fake-gateway';

const ORIGIN = 'https://mcp.test';
const CONTRIBUTOR_TOKEN = 'bst1.contributor-for-t021';
const CREATED_AT = '2026-10-06T00:00:00.000Z';
const clients: Client[] = [];

const POST = {
  event_id: 8,
  bean: 't005',
  thread: 'shipping',
  author_bean: 't005',
  actor: 'shipping-agent',
  kind: 'counterproposal',
  body: 'Preserve days and expose businessDays.',
  references: [],
  reply_to: 7,
  created_at: CREATED_AT,
};
const FOCUS = BeanContext.parse({
  bean: {
    bean: 't021',
    revision: 1,
    intent: 'Add shipment emails',
    approach: null,
    actor: null,
    updated_at: null,
  },
  promises: [],
  reliance: [],
  referenced_promises: [],
  history: [],
  next_cursor: 8,
  current_cursor: 8,
  truncated: false,
});
function peerSummary(bean: string, overrides: Record<string, unknown> = {}) {
  return BeanPeerSummary.parse({
    bean,
    revision: 1,
    updated_at: null,
    intent: 'Unrelated vocabulary',
    intent_truncated: false,
    paths: [],
    approach_summary: null,
    approach_summary_truncated: false,
    promises: [],
    reliance: [],
    current_cursor: 8,
    ...overrides,
  });
}
const INBOX = BeanInboxPage.parse({
  bean: 't021',
  events: [{ event: { kind: 'thread.posted', event_id: 8, post: POST }, acknowledged: false }],
  next_cursor: 8,
  current_cursor: 8,
  unread: 1,
  truncated: false,
});

function collaborationGateway() {
  const update = vi.fn((_token: string, input: unknown) => {
    const parsed = BeanUpdateInput.parse(input);
    return Promise.resolve({
      ok: true,
      value: {
        bean: { ...FOCUS.bean, revision: 2, approach: parsed.changes.approach ?? null },
        event_id: 9,
      },
    });
  });
  const thread = vi.fn((_token: string, input: unknown) => {
    const parsed = BeanThreadPostInput.parse(input);
    return Promise.resolve({
      ok: true,
      value: {
        post: {
          ...POST,
          bean: parsed.bean,
          thread: parsed.thread ?? POST.thread,
          kind: parsed.kind,
          body: parsed.body,
          references: parsed.references,
          event_id: 9,
          author_bean: 't021',
          actor: 'email-agent',
          reply_to: parsed.reply_to ?? null,
        },
        reliance: null,
      },
    });
  });
  const inboxRead = vi.fn((_token: string, _input: unknown) =>
    Promise.resolve({ ok: true, value: INBOX }),
  );
  const inboxAck = vi.fn((_token: string, _input: unknown) =>
    Promise.resolve({ ok: true, value: { acknowledged: [8], unread: 0 } }),
  );
  const commit = vi.fn((_token: string, input: unknown) => {
    const parsed = BeanCommitInput.parse(input);
    return Promise.resolve({
      ok: true,
      value: {
        kind: 'committed',
        bean: parsed.bean,
        branch: `beans/${parsed.bean}`,
        commit: 'c'.repeat(40),
        parent: 'b'.repeat(40),
        tree: 'd'.repeat(40),
        files: parsed.changes.length,
        objects: 4,
        trees_read: 2,
      },
    });
  });
  const context = vi.fn((_run: string, _input: unknown) =>
    Promise.resolve({ ok: true, value: FOCUS }),
  );
  const gateway = fakeGateway({
    verifyMcpToken: (token: string) => {
      if (token === CONTRIBUTOR_TOKEN)
        return Promise.resolve({
          ok: true,
          value: {
            scope: 'contributor',
            run: RUN,
            bean: 't021',
            actor: 'email-agent',
            expires_at: '2026-10-11T00:00:00.000Z',
          },
        });
      if (token === VIEW_TOKEN)
        return Promise.resolve({
          ok: true,
          value: { scope: 'view', run: RUN, sub: 'test', expires_at: '2026-10-11T00:00:00.000Z' },
        });
      return Promise.resolve({
        ok: false,
        error: {
          code: 'forbidden',
          status: 403,
          message: 'slot and seed capabilities cannot use MCP',
        },
      });
    },
    beanContext: context,
    beanUpdate: update,
    beanCommit: commit,
    beanThreadPost: thread,
    beanInboxRead: inboxRead,
    beanInboxAck: inboxAck,
  });
  return { gateway, update, commit, thread, inboxRead, inboxAck, context };
}

async function connect(gateway: ReturnType<typeof fakeGateway>, token: string): Promise<Client> {
  const app = createApp(() => ({ gateway, log: createLogger('error') }));
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      request.headers.set('host', new URL(request.url).host);
      return app.fetch(request, env, createExecutionContext());
    },
  });
  const client = new Client({ name: 'contributor-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, input: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: input });
  const content = z
    .array(z.object({ type: z.literal('text'), text: z.string() }))
    .parse(result.content);
  const text = content[0]?.text ?? 'null';
  if (result.isError === true) return { error: text };
  return { value: JSON.parse(text) };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('contributor MCP capabilities', () => {
  it('offers only context to a view caller and never exposes its inbox or writes', async () => {
    const { gateway, inboxRead, update } = collaborationGateway();
    const client = await connect(gateway, VIEW_TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      [...TOOL_NAMES, 'bean_context'].toSorted(),
    );
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(await call(client, 'bean_context', { bean: 't021' })).toHaveProperty(
      'value.bean.revision',
      1,
    );
    await expect(call(client, 'bean_update', { bean: 't021' })).rejects.toThrow('not found');
    expect(inboxRead).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('lists collaboration tools for a contributor and forwards the signed token for writes', async () => {
    const { gateway, update } = collaborationGateway();
    const client = await connect(gateway, CONTRIBUTOR_TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      [...TOOL_NAMES, ...COLLABORATION_TOOL_NAMES].toSorted(),
    );
    expect(tools.find((tool) => tool.name === 'bean_update')?.annotations?.readOnlyHint).toBe(
      false,
    );
    const input = {
      bean: 't021',
      expected_revision: 1,
      changes: {
        approach: { summary: 'Use an explicit businessDays field', paths: ['src/shipping.ts'] },
      },
      idempotency_key: 'approach-1',
    };
    expect(await call(client, 'bean_update', input)).toHaveProperty('value.bean.revision', 2);
    expect(update).toHaveBeenCalledWith(CONTRIBUTOR_TOKEN, input);
    expect(await call(client, 'bean_update', { ...input, actor: 'forged-actor' })).toHaveProperty(
      'error',
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('commits files to the contributor bean through the gateway with the signed token', async () => {
    const { gateway, commit } = collaborationGateway();
    const client = await connect(gateway, CONTRIBUTOR_TOKEN);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'bean_commit')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { bean: expect.anything(), changes: expect.anything() },
    });
    const input = {
      expected_head: null,
      changes: [
        { path: 'docs/a.md', content: '# A\n' },
        { path: 'old.md', delete: true },
      ],
      message: 'Docs',
      idempotency_key: 'commit-1',
    };
    expect(await call(client, 'bean_commit', { ...input, bean: 'beans/t021' })).toHaveProperty(
      'value.kind',
      'committed',
    );
    expect(commit).toHaveBeenCalledWith(CONTRIBUTOR_TOKEN, { ...input, bean: 't021' });
    const unsafe = { ...input, bean: 't021', changes: [{ path: '../x', content: '' }] };
    expect(await call(client, 'bean_commit', unsafe)).toHaveProperty('error');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('accepts a bean branch handle in the collaboration tools and still advertises an object schema', async () => {
    const { gateway, update, context } = collaborationGateway();
    const client = await connect(gateway, CONTRIBUTOR_TOKEN);
    const { tools } = await client.listTools();
    for (const name of ['bean_context', 'bean_update', 'bean_thread_post'])
      expect(tools.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
        type: 'object',
        properties: { bean: expect.anything() },
      });
    expect(await call(client, 'bean_context', { bean: 'beans/t021' })).toHaveProperty(
      'value.bean.bean',
      't021',
    );
    expect(context).toHaveBeenCalledWith(RUN, { bean: 't021' });
    const input = {
      expected_revision: 1,
      changes: { intent: 'Add shipment emails with tracking' },
      idempotency_key: 'branch-1',
    };
    await call(client, 'bean_update', { ...input, bean: 'beans/t021' });
    expect(update).toHaveBeenCalledWith(CONTRIBUTOR_TOKEN, { ...input, bean: 't021' });
    expect(await call(client, 'bean_update', { ...input, bean: 'other/t021' })).toHaveProperty(
      'error',
    );
  });

  it('passes exact replies and rejects acceptance without a promise revision before the gateway', async () => {
    const { gateway, thread } = collaborationGateway();
    const client = await connect(gateway, CONTRIBUTOR_TOKEN);
    const input = {
      bean: 't005',
      thread: 'shipping',
      reply_to: 8,
      kind: 'reply',
      body: 'Can we preserve the existing field?',
      references: [],
      idempotency_key: 'reply-1',
    };
    expect(await call(client, 'bean_thread_post', input)).toHaveProperty(
      'value.post.author_bean',
      't021',
    );
    expect(thread).toHaveBeenCalledWith(CONTRIBUTOR_TOKEN, input);
    expect(await call(client, 'bean_thread_post', { ...input, kind: 'accept' })).toHaveProperty(
      'error',
    );
    expect(thread).toHaveBeenCalledTimes(1);
  });

  it('reminds on ordinary reads without acknowledging events and recovers through explicit inbox paging', async () => {
    const { gateway, inboxRead, inboxAck } = collaborationGateway();
    const client = await connect(gateway, CONTRIBUTOR_TOKEN);
    const cases = [
      ['ask_repo', { question: 'show bean t021' }],
      ['work_overlaps', { paths: ['src/notifications'] }],
      ['bean_status', { bean: 't021' }],
      ['repo_status', {}],
      ['bean_context', { bean: 't021' }],
    ] satisfies readonly [string, Record<string, unknown>][];
    const responses = await Promise.all(cases.map(([name, input]) => call(client, name, input)));
    for (const response of responses) {
      expect(response).toHaveProperty('value.inbox.unread', 1);
      expect(response).toHaveProperty('value.inbox.events.0.event_id', 8);
    }
    expect(inboxAck).not.toHaveBeenCalled();
    expect(await call(client, 'bean_inbox_read', { after_cursor: 7, limit: 3 })).toHaveProperty(
      'value.next_cursor',
      8,
    );
    expect(inboxRead).toHaveBeenLastCalledWith(CONTRIBUTOR_TOKEN, { after_cursor: 7, limit: 3 });
    expect(await call(client, 'bean_inbox_ack', { event_ids: [8] })).toHaveProperty(
      'value.acknowledged',
      [8],
    );
    expect(inboxAck).toHaveBeenCalledWith(CONTRIBUTOR_TOKEN, { event_ids: [8] });
    expect(inboxAck).toHaveBeenCalledTimes(1);
  });

  it('shows gateway authorization and revision failures as tool errors rather than success', async () => {
    const gateway = collaborationGateway().gateway;
    gateway.beanUpdate = () =>
      Promise.resolve({
        ok: false,
        error: { code: 'forbidden', status: 403, message: 'owning bean does not match' },
      });
    const client = await connect(gateway, CONTRIBUTOR_TOKEN);
    const input = {
      bean: 't005',
      expected_revision: 1,
      changes: { intent: 'Spoof ownership' },
      idempotency_key: 'forged-1',
    };
    expect(await call(client, 'bean_update', input)).toHaveProperty(
      'error',
      expect.stringContaining('owning bean does not match'),
    );
    gateway.beanUpdate = () =>
      Promise.resolve({
        ok: false,
        error: { code: 'revision_conflict', status: 409, message: 'expected revision is stale' },
      });
    expect(await call(client, 'bean_update', { ...input, bean: 't021' })).toHaveProperty(
      'error',
      expect.stringContaining('revision_conflict'),
    );
  });

  it('finds a later unread event even when the oldest inbox page was acknowledged', async () => {
    const { gateway, inboxAck } = collaborationGateway();
    gateway.beanInboxRead = (_token, input) => {
      const parsed = BeanInboxReadInput.parse(input);
      const acknowledged = Array.from({ length: 6 }, (_entry, index) => ({
        event: {
          kind: 'thread.posted',
          event_id: index + 1,
          post: { ...POST, event_id: index + 1 },
        },
        acknowledged: true,
      }));
      const events =
        parsed.state === 'unread'
          ? INBOX.events
          : [...acknowledged, ...INBOX.events].slice(0, parsed.limit ?? 100);
      return Promise.resolve({ ok: true, value: BeanInboxPage.parse({ ...INBOX, events }) });
    };
    const client = await connect(gateway, CONTRIBUTOR_TOKEN);
    expect(await call(client, 'repo_status')).toHaveProperty('value.inbox.events.0.event_id', 8);
    expect(inboxAck).not.toHaveBeenCalled();
  });

  it('preserves an exact referenced bean when both optional discovery sources are unavailable', async () => {
    const { gateway } = collaborationGateway();
    const focus = BeanContext.parse({
      ...FOCUS,
      reliance: [
        {
          bean: 't005',
          promise: 'delivery-estimate',
          revision: 2,
          actor: 'email-agent',
          recorded_at: CREATED_AT,
          accepted_event: null,
          source: { bean: 't021', revision: 1, event_id: 8 },
        },
      ],
    });
    gateway.beanContext = () => Promise.resolve({ ok: true, value: focus });
    gateway.beanPeerSummaries = () => Promise.resolve({ ok: true, value: [peerSummary('t005')] });
    gateway.beanDetail = () =>
      Promise.resolve({
        ok: false,
        error: { code: 'upstream_failed', status: 502, message: 'git source offline' },
      });
    gateway.beanDiscover = () =>
      Promise.resolve({
        ok: false,
        error: { code: 'upstream_failed', status: 502, message: 'discovery source offline' },
      });
    const client = await connect(gateway, VIEW_TOKEN);
    const response = await call(client, 'bean_context', { bean: 't021' });
    expect(response).toHaveProperty('value.related_context.related.0.bean', 't005');
    expect(response).toHaveProperty('value.related_context.related.0.reasons', [
      'promise-reference',
    ]);
    expect(response).toHaveProperty(
      'value.related_context.discovery.observed.status',
      'unavailable',
    );
    expect(response).toHaveProperty('value.related_context.truncated', true);
  });

  it('marks a peer excerpt truncated when the gateway cut it and reports beans it could not summarise', async () => {
    const { gateway } = collaborationGateway();
    const focus = BeanContext.parse({
      ...FOCUS,
      reliance: ['t005', 't006'].map((bean) => ({
        bean,
        promise: 'delivery-estimate',
        revision: 1,
        actor: 'email-agent',
        recorded_at: CREATED_AT,
        accepted_event: null,
        source: { bean: 't021', revision: 1, event_id: 8 },
      })),
    });
    gateway.beanContext = () => Promise.resolve({ ok: true, value: focus });
    gateway.beanPeerSummaries = () =>
      Promise.resolve({ ok: true, value: [peerSummary('t005', { intent_truncated: true })] });
    gateway.beanDiscover = () =>
      Promise.resolve({ ok: true, value: { beans: [], truncated: false } });
    const client = await connect(gateway, VIEW_TOKEN);
    const response = await call(client, 'bean_context', { bean: 't021' });
    expect(response).toHaveProperty('value.related_context.related.0.intent.truncated', true);
    expect(response).toHaveProperty(
      'value.related_context.unavailable',
      expect.arrayContaining(['t006']),
    );
  });

  it('discovers approaches before a diff exists and bounds paths and hydrated peers', async () => {
    const { gateway } = collaborationGateway();
    const focus = BeanContext.parse({
      ...FOCUS,
      bean: {
        ...FOCUS.bean,
        approach: {
          summary: 'Shipping business-day estimates',
          paths: Array.from({ length: 64 }, (_entry, index) => `src/shipping-${index}.ts`),
        },
      },
    });
    const peers = Array.from({ length: 32 }, (_entry, index) =>
      peerSummary(`peer${index}`, {
        approach_summary: 'Shipping business-day estimates',
        paths: ['src/shipping-0.ts'],
      }),
    );
    const context = vi.fn<NonNullable<GatewayRpc['beanContext']>>(() =>
      Promise.resolve({ ok: true, value: focus }),
    );
    gateway.beanContext = context;
    const summaries = vi.fn<NonNullable<GatewayRpc['beanPeerSummaries']>>((_run, beans) =>
      Promise.resolve({
        ok: true,
        value: peers.filter((peer) => beans.includes(peer.bean)),
      }),
    );
    gateway.beanPeerSummaries = summaries;
    const discover = vi.fn<NonNullable<GatewayRpc['beanDiscover']>>((_run, input) => {
      expect(BeanDiscoverInput.parse(input).paths).toHaveLength(16);
      expect(input.full).toBeUndefined();
      return Promise.resolve({
        ok: true,
        value: {
          beans: peers.map(({ bean, revision, updated_at, intent, intent_truncated, paths }) => ({
            bean,
            revision,
            updated_at,
            intent,
            intent_truncated,
            paths,
          })),
          truncated: false,
        },
      });
    });
    gateway.beanDiscover = discover;
    gateway.beansByPath = () => Promise.resolve({ ok: true, value: [] });
    const client = await connect(gateway, VIEW_TOKEN);
    const response = await call(client, 'bean_context', { bean: 't021' });
    expect(response).toHaveProperty(
      'value.related_context.related.0.reasons',
      expect.arrayContaining(['shared-path']),
    );
    expect(response).toHaveProperty('value.related_context.discovery.declared.paths_omitted', 48);
    expect(response).toHaveProperty('value.related_context.unfetched_count', 16);
    expect(response).toHaveProperty('value.related_context.truncated', true);
    expect(context).toHaveBeenCalledTimes(1);
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(summaries.mock.calls[0]?.[1]).toHaveLength(16);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('rejects slot capabilities through unified authentication and keeps old gateway reads working', async () => {
    expect(
      await authenticate(collaborationGateway().gateway, `Bearer ${SLOT_TOKEN}`),
    ).toMatchObject({ ok: false, failure: { status: 403 } });
    expect(await authenticate(fakeGateway(), `Bearer ${VIEW_TOKEN}`)).toMatchObject({
      ok: true,
      viewer: { run: RUN, sub: 'test' },
    });
    expect(await authenticate(fakeGateway(), `Bearer ${CONTRIBUTOR_TOKEN}`)).toMatchObject({
      ok: false,
    });
  });
});
