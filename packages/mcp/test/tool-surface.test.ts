import { createExecutionContext, env, SELF } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createLogger } from '../src/log';
import { fakeGateway, RUN, VIEW_TOKEN } from './fake-gateway';
import { person, personalToken } from './repo-fixtures';

/**
 * The tools each kind of caller is offered: a tool its token's scopes or kind can never use
 * is not registered. Sessions run against the real gateway (a person's token); run tokens
 * against the recorded run's fake gateway with the collaboration RPC.
 */
const ORIGIN = 'https://gitstalk-mcp.example.workers.dev';
const CONTRIBUTOR_TOKEN = 'bst1.contributor-for-t021';
const clients: Client[] = [];
/** Clients cap the tools they load (Cursor at 40); the surface stays at 30 or fewer per caller. */
const MAX_TOOLS_PER_CALLER = 30;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const EVERY_CALLER = [
  'ask_repo',
  'bean_context',
  'bean_status',
  'repo_read',
  'repo_status',
  'why_lines',
  'work_overlaps',
];
const READ_SESSION = [
  ...EVERY_CALLER,
  'actions_config_list',
  'actions_job_log',
  'actions_run_get',
  'actions_run_list',
  'actions_wait_for_run',
  'actions_workflow_list',
  'automation_get',
  'bean_wait',
  'git_credentials',
  'repo_list',
  'task_list',
  'whoami',
];
const WRITE_SESSION = [
  ...READ_SESSION,
  'actions_cancel',
  'actions_dispatch',
  'actions_rerun',
  'automation_run',
  'bean_approve',
  'bean_commit',
  'bean_open',
  'task_claim',
];
const SECRETS_SESSION = [...WRITE_SESSION, 'actions_config_delete', 'actions_config_set'];
const CREATE_SESSION = [...WRITE_SESSION, 'repo_create'];
/** Every grantable scope: the largest surface a caller can have. */
const EVERY_SCOPE = [...SECRETS_SESSION, 'repo_create'];
const CONTRIBUTOR = [
  ...EVERY_CALLER,
  'bean_commit',
  'bean_inbox_ack',
  'bean_inbox_read',
  'bean_thread_post',
  'bean_update',
];

type Listed = { readonly name: string; readonly readOnly: boolean };

describe('the tools each caller is offered', () => {
  it.each([
    ['a read-only session', ['read'], READ_SESSION],
    ['a write session', ['read', 'collaborate', 'write'], WRITE_SESSION],
    ['a write and secrets session', ['read', 'collaborate', 'write', 'secrets'], SECRETS_SESSION],
    ['a read and create session', ['read', 'create'], [...READ_SESSION, 'repo_create']],
    ['a write and create session', ['read', 'collaborate', 'write', 'create'], CREATE_SESSION],
    [
      'a session with every scope',
      ['read', 'collaborate', 'write', 'secrets', 'create'],
      EVERY_SCOPE,
    ],
  ])('%s', async (_who, scopes, expected) => {
    const token = await personalToken(await person('mcp-surface'), scopes);
    const tools = await listed(sessionTransport(token));
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(expected.toSorted());
  });

  it('offers no caller more than 30 tools', () => {
    for (const surface of [
      READ_SESSION,
      WRITE_SESSION,
      SECRETS_SESSION,
      CREATE_SESSION,
      EVERY_SCOPE,
      CONTRIBUTOR,
      EVERY_CALLER,
    ])
      expect(surface.length).toBeLessThanOrEqual(MAX_TOOLS_PER_CALLER);
  });

  it('a read-only session is offered only read-only tools, but for git_credentials', async () => {
    const token = await personalToken(await person('mcp-surface'), ['read']);
    const tools = await listed(sessionTransport(token));
    expect(tools.filter((tool) => !tool.readOnly).map((tool) => tool.name)).toEqual([
      'git_credentials',
    ]);
  });

  it('a run view token', async () => {
    const tools = await listed(runTransport(VIEW_TOKEN));
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(EVERY_CALLER.toSorted());
    expect(tools.every((tool) => tool.readOnly)).toBe(true);
  });

  it('a run contributor token', async () => {
    const tools = await listed(runTransport(CONTRIBUTOR_TOKEN));
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(CONTRIBUTOR.toSorted());
  });
});

async function listed(transport: StreamableHTTPClientTransport): Promise<readonly Listed[]> {
  const client = new Client({ name: 'tool-surface-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  const { tools } = await client.listTools();
  return tools.map((tool) => ({
    name: tool.name,
    readOnly: tool.annotations?.readOnlyHint === true,
  }));
}

function sessionTransport(token: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('host', new URL(request.url).host);
      return SELF.fetch(request);
    },
  });
}

function runTransport(token: string): StreamableHTTPClientTransport {
  const app = createApp(() => ({ gateway: runGateway(), log: createLogger('error') }));
  return new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      request.headers.set('host', new URL(request.url).host);
      return app.fetch(request, env, createExecutionContext());
    },
  });
}

function unused(): Promise<unknown> {
  return Promise.resolve({ ok: false, error: { code: 'x', status: 500, message: 'unused' } });
}

/** The recorded run's gateway, with the collaboration RPC that view and contributor use. */
function runGateway() {
  const expires_at = '2026-10-11T00:00:00.000Z';
  return fakeGateway({
    verifyMcpToken: (token: string) =>
      Promise.resolve(
        token === CONTRIBUTOR_TOKEN
          ? {
              ok: true,
              value: { scope: 'contributor', run: RUN, bean: 't021', actor: 'a', expires_at },
            }
          : { ok: true, value: { scope: 'view', run: RUN, sub: 'test', expires_at } },
      ),
    beanContext: unused,
    beanUpdate: unused,
    beanCommit: unused,
    beanThreadPost: unused,
    beanInboxRead: unused,
    beanInboxAck: unused,
  });
}
