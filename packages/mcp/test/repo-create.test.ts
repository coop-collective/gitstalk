import { env, SELF } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { verifyUserToken } from '@gitstalk/shared-identity/user-tokens';

import { digest, gitPush, person, personalToken } from './repo-fixtures';

/**
 * `repo_create` and `git_credentials` for a new address, end to end: the MCP Worker with a
 * person's token, the real gateway behind its service binding (the one creation path the web
 * form uses) and the fake Artifacts.
 */
const ORIGIN = 'https://gitstalk-mcp.example.workers.dev';
/** The gateway's web origin in these tests (it serves git and the pages). */
const WEB = 'https://web.example.test';
const CREATE = ['read', 'collaborate', 'write', 'create'] as const;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('repo_create', () => {
  it('creates a private, empty repository and says how to push the first bean', async () => {
    const { user, client } = await session(CREATE);
    const created = await tool(client, 'repo_create', { name: 'from-mcp' });
    expect(created).toEqual({
      full_name: `${user.handle}/from-mcp`,
      clone_url: `${WEB}/${user.handle}/from-mcp.git`,
      web_url: `${WEB}/${user.handle}/from-mcp`,
      stalk: expect.stringMatching(/^[0-9a-f]{40}$/),
      visibility: 'private',
      next: expect.stringContaining('git push origin HEAD:refs/heads/bean/start'),
    });
    const listed = await tool(client, 'repo_list');
    expect(JSON.stringify(listed)).toContain(`${user.handle}/from-mcp`);
  });

  it('answers a taken name, a forbidden namespace and an invalid name as tool errors', async () => {
    const { client } = await session(CREATE);
    await tool(client, 'repo_create', { name: 'twice', visibility: 'public' });
    expect(await tool(client, 'repo_create', { name: 'twice' })).toEqual({
      error: expect.stringContaining('already has a repository named twice'),
    });
    expect(await tool(client, 'repo_create', { name: 'x', owner: 'no-such-org' })).toEqual({
      error: expect.stringContaining('your own namespace'),
    });
    expect(await tool(client, 'repo_create', { name: '.dot' })).toEqual({
      error: expect.stringContaining('Start with a letter or a digit'),
    });
  });

  it('is not offered without the create scope', async () => {
    const { client } = await session(['read', 'write']);
    const { tools } = await client.listTools();
    expect(tools.map((listed) => listed.name)).not.toContain('repo_create');
  });
});

describe('git_credentials for an address with no repository', () => {
  it('mints a create credential whose push creates the repository, private', async () => {
    const { user, client } = await session(CREATE);
    const answer = z
      .object({ credential: z.string(), scopes: z.array(z.string()), summary: z.string() })
      .parse(await tool(client, 'git_credentials', { repo: `${user.handle}/pushed-here` }));
    expect(answer.scopes).toEqual(['read', 'write', 'create']);
    expect(answer.summary).toContain('creates one, private');
    const password = /^password=(\S+)$/m.exec(answer.credential)?.[1] ?? '';
    expect((await verifyUserToken(env, password))?.token.repository).toBe(
      `new:${user.handle}/pushed-here`,
    );

    const pushed = await gitPush(`${user.handle}/pushed-here`, password, {
      bean: 'start',
      newSha: await digest('mcp-push-create'),
    });
    expect(pushed.remote).toContain(`${WEB}/${user.handle}/pushed-here`);
    // The credential opens that address only.
    const elsewhere = await gitPush(`${user.handle}/another`, password, {
      bean: 'start',
      newSha: await digest('mcp-push-elsewhere'),
    });
    expect(elsewhere.status).toBe(404);
  });

  it('stays not found without the create scope', async () => {
    const { user, client } = await session(['read', 'write']);
    expect(await tool(client, 'git_credentials', { repo: `${user.handle}/missing` })).toEqual({
      error: expect.stringContaining('missing'),
    });
  });
});

async function session(scopes: readonly string[]) {
  const user = await person('mcp-create');
  const token = await personalToken(user, scopes);
  return { user, client: await connect(token) };
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
  const client = new Client({ name: 'repo-create-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const Content = z.array(z.object({ type: z.literal('text'), text: z.string() }));

async function tool(client: Client, name: string, input: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: input });
  const text = Content.parse(result.content)[0]?.text ?? '';
  if (result.isError === true) return { error: text };
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}
