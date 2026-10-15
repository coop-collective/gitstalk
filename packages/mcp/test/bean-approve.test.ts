import { SELF } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { approverOf } from '../src/tools/bean-approve';
import type { AgentSessionContext } from '../src/tools/tool-context';
import type { Person, Repository } from './repo-fixtures';
import {
  collaborator,
  digest,
  gitPush,
  person,
  personalToken,
  repository,
  slug,
} from './repo-fixtures';

/**
 * `bean_approve` end to end (doc 32 §5): the MCP Worker with people's tokens as the bearer, the
 * real gateway behind its binding, a policy on the stalk that holds `src/auth/**` for a person.
 * The gateway's own tests hold the RPC's rules; these hold what the tool adds: the held lines
 * of `bean_status`, the answer, and the self-approval rule as an agent meets it.
 */
const ORIGIN = 'https://gitstalk-mcp.example.workers.dev';
const POLICY =
  'classes:\n  - name: protected\n    match: { paths: ["src/auth/**"] }\n    route: card\n';
const clients: Client[] = [];

let owner: Person;
let ownerToken: string;
let writer: Person;
let writerToken: string;
let repo: Repository;

beforeAll(async () => {
  owner = await person('mcp-approver');
  ownerToken = await personalToken(owner, ['read', 'write']);
  repo = await repository(owner, { name: 'held' });
  writer = await collaborator(owner, repo, 'write');
  writerToken = await personalToken(writer, ['read', 'write']);
  const landed = await gitPush(slug(repo), ownerToken, {
    bean: 'rules',
    newSha: await digest(`rules:${repo.id}`),
    options: ['wait'],
    files: { '.gitstalk/policy.yml': POLICY },
  });
  expect(landed.remote).toContain('LANDED');
  const client = await connect(ownerToken);
  const stalk = await tool(client, 'bean_wait', {
    repo: slug(repo),
    bean: 'rules',
    until: 'stalk',
  });
  expect(stalk['phase']).toBe('green');
}, 60_000);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('bean_approve', () => {
  it("shows a held bean in bean_status with its page, and approves it for the maintainer's person", async () => {
    await pushHeld(writerToken, 'login');
    const client = await connect(ownerToken);
    const status = await tool(client, 'bean_status', { repo: slug(repo), bean: 'login' });
    expect(status).toMatchObject({
      held: true,
      approve_url: `https://gitstalk-web.example.workers.dev/${slug(repo)}/changes/login`,
      next: expect.stringContaining('only if they tell you to'),
    });
    expect(status['summary']).toMatch(/^login held for a person's approval/u);
    const approved = await tool(client, 'bean_approve', {
      repo: slug(repo),
      bean: 'login',
      note: 'My person read it.',
      idempotency_key: 'approve-login',
    });
    expect(approved).toMatchObject({
      bean: 'login',
      approved_by: owner.handle,
      note: 'My person read it.',
      client: 'MCP (personal token)',
      resubmitted: true,
      replayed: false,
      hold: { state: 'approved' },
      next: expect.stringContaining('bean_wait'),
    });
  }, 30_000);

  it('refuses a writer: approving needs the maintain role', async () => {
    await pushHeld(writerToken, 'reset');
    const answer = await tool(await connect(writerToken), 'bean_approve', {
      repo: slug(repo),
      bean: 'reset',
      idempotency_key: 'approve-reset',
    });
    expect(answer['error']).toContain('maintain role');
  }, 30_000);

  it("refuses its person's own push unless the person confirmed it", async () => {
    await pushHeld(ownerToken, 'session');
    const client = await connect(ownerToken);
    const refused = await tool(client, 'bean_approve', {
      repo: slug(repo),
      bean: 'session',
      idempotency_key: 'approve-session',
    });
    expect(refused['error']).toContain('confirm_owner_intent: true');
    expect(refused['error']).toContain(`/${slug(repo)}/changes/session`);
    const confirmed = await tool(client, 'bean_approve', {
      repo: slug(repo),
      bean: 'session',
      confirm_owner_intent: true,
      idempotency_key: 'approve-session-confirmed',
    });
    expect(confirmed).toMatchObject({ approved_by: owner.handle, replayed: false });
  }, 30_000);

  it('refuses a stale revision', async () => {
    await pushHeld(writerToken, 'token');
    const answer = await tool(await connect(ownerToken), 'bean_approve', {
      repo: slug(repo),
      bean: 'token',
      revision: 'a'.repeat(40),
      idempotency_key: 'approve-token',
    });
    expect(answer['error']).toContain('a new push needs a new approval');
  }, 30_000);
});

/** A bean changing `src/auth/<bean>.ts`, pushed with `token` and held by the policy. */
async function pushHeld(token: string, bean: string): Promise<void> {
  const pushed = await gitPush(slug(repo), token, {
    bean,
    newSha: await digest(`${repo.id}:${bean}`),
    options: ['wait'],
    files: { [`src/auth/${bean}.ts`]: 'export {};\n' },
  });
  expect(pushed.remote).toContain("awaiting a person's approval");
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('host', new URL(request.url).host);
      return SELF.fetch(request);
    },
  });
  const client = new Client({ name: 'bean-approve-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const Content = z.array(z.object({ type: z.literal('text'), text: z.string() }));

async function tool(client: Client, name: string, input: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: input });
  const text = Content.parse(result.content)[0]?.text ?? '';
  if (result.isError === true) return { error: text };
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

describe('who may approve through MCP', () => {
  const session = {
    userId: 'u_dana',
    handle: 'dana',
    clientName: 'Claude Code',
    agentKey: 'oauth:claude-code',
    via: 'oauth',
    scopes: ['read', 'write'],
    principal: { user: { id: 'u_dana', handle: 'dana' }, scopes: ['read', 'write'], label: 'x' },
    mintGitToken: () => Promise.resolve(null),
  } satisfies AgentSessionContext;

  it('a person acting through an agent client', () => {
    expect(approverOf(session)).toBe(session);
  });

  it.each([
    ['no session', undefined],
    ['an automation', { ...session, handle: 'nightly[automation]' }],
    ['an Actions job', { ...session, userId: 'actions-job:j1' }],
    ['no agent client', { ...session, agentKey: '' }],
  ])('never %s', (_who, candidate) => {
    expect(() => approverOf(candidate)).toThrow();
  });
});
