import { env, SELF } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { verifyUserToken } from '@gitstalk/shared-identity/user-tokens';

import type { Person } from './repo-fixtures';
import {
  collaborator,
  deployToken,
  digest,
  gitPush,
  person,
  personalToken,
  plantOnSprout,
  repository,
  requireChecks,
  slug,
} from './repo-fixtures';

/**
 * The repository tools of an agent session, end to end: the MCP Worker over Streamable HTTP
 * with a person's token, the real gateway behind its service binding (registry, engine,
 * git proxy) and the fake Artifacts and runner.
 */
const ORIGIN = 'https://gitstalk-mcp.example.workers.dev';
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => {
      // The OAuth provider's handler wants the Host header a real client sends.
      const request = new Request(input, init);
      request.headers.set('host', new URL(request.url).host);
      return SELF.fetch(request);
    },
  });
  const client = new Client({ name: 'repo-tools-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const Content = z.array(z.object({ type: z.literal('text'), text: z.string() }));

/** A tool's answer: JSON on success, `{ error }` with the text on a tool error. */
async function tool(client: Client, name: string, input: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: input });
  const text = Content.parse(result.content)[0]?.text ?? '';
  if (result.isError === true) return { error: text };
  const value: unknown = JSON.parse(text);
  return z.record(z.string(), z.unknown()).parse(value);
}

async function session(
  scopes: readonly string[] = ['read', 'write'],
): Promise<{ user: Person; token: string; client: Client }> {
  const user = await person();
  const token = await personalToken(user, scopes);
  return { user, token, client: await connect(token) };
}

const BACKLOG = '- [ ] add-total: Add a total helper\n- [ ] T-2: Charge tax\n- [x] T-3: Done\n';

describe('repository tools', () => {
  it('are listed for agent sessions and not for run tokens', async () => {
    const { client } = await session();
    const names = (await client.listTools()).tools.map((listed) => listed.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'repo_list',
        'repo_status',
        'repo_read',
        'automation_get',
        'bean_open',
        'bean_status',
        'bean_wait',
        'bean_commit',
        'task_list',
        'task_claim',
        'git_credentials',
        'whoami',
      ]),
    );
    expect(names).not.toContain('execute');
    for (const merged of [
      'change_status',
      'checks_get',
      'run_status',
      'preview_link',
      'task_release',
    ])
      expect(names).not.toContain(merged);
    expect(names).not.toContain('git_credential');
  });

  it("repo_list names the person's repositories with access and clone URL", async () => {
    const { user, client } = await session(['read']);
    const repo = await repository(user);
    expect(await tool(client, 'repo_list')).toMatchObject({
      repositories: [
        {
          repo: slug(repo),
          access: 'read',
          clone_url: `https://gateway.example.test/${slug(repo)}.git`,
        },
      ],
    });
  });

  it("automation_get without a name lists a repository's automations and runs; a stranger's is not there", async () => {
    const { user, client } = await session(['read']);
    const repo = await repository(user);
    expect(await tool(client, 'automation_get', { repo: slug(repo) })).toEqual({
      repo: slug(repo),
      automations: [],
      runs: [],
      summary: '0 automations (0 with problems), 0 recent runs',
    });
    const stranger = await session();
    expect(await tool(stranger.client, 'automation_get', { repo: slug(repo) })).toEqual({
      error: `repository ${slug(repo)} not found`,
    });
  });

  it("repo_status reads a repository by name; someone else's private one is not there", async () => {
    const { user, client } = await session();
    const repo = await repository(user);
    expect(await tool(client, 'repo_status', { repo: slug(repo) })).toMatchObject({
      repo: slug(repo),
      in_flight: [],
      sent_back: [],
      summary: expect.stringContaining('0 in flight'),
    });
    const stranger = await session();
    expect(await tool(stranger.client, 'repo_status', { repo: slug(repo) })).toEqual({
      error: `repository ${slug(repo)} not found`,
    });
    expect(await tool(client, 'repo_status', { repo: slug(repo) })).toHaveProperty(
      'preview_urls.stalk',
      expect.stringContaining('ref=stalk'),
    );
    // The read tools take the repository too.
    expect(
      await tool(stranger.client, 'repo_read', { path: 'README.md', repo: slug(repo) }),
    ).toEqual({
      error: `repository ${slug(repo)} not found`,
    });
    expect(
      await tool(stranger.client, 'work_overlaps', { paths: ['src'], repo: slug(repo) }),
    ).toEqual({
      error: `repository ${slug(repo)} not found`,
    });
  });

  it('bean_open needs the write scope, then reserves the name and says how to push', async () => {
    const reader = await session(['read', 'collaborate']);
    const readerTools = (await reader.client.listTools()).tools.map((listed) => listed.name);
    expect(readerTools).not.toContain('bean_open');
    const { user, client } = await session();
    const repo = await repository(user);
    const opened = await tool(client, 'bean_open', {
      repo: slug(repo),
      bean: 'add-total',
      intent: 'Add a total helper',
    });
    expect(opened).toMatchObject({
      branch: 'bean/add-total',
      start: 'git fetch origin sprout && git switch -c bean/add-total origin/sprout',
      push: 'git push origin HEAD:refs/heads/bean/add-total',
      wait: 'git push -o bean=add-total origin HEAD:refs/wait/any',
      clone_url: `https://gateway.example.test/${slug(repo)}.git`,
    });
    expect(
      await tool(client, 'bean_status', { repo: slug(repo), bean: 'add-total' }),
    ).toMatchObject({
      phase: 'open',
      next: expect.stringContaining('git push origin HEAD:refs/heads/bean/add-total'),
    });
    expect(
      await tool(client, 'bean_open', { repo: slug(repo), bean: 'bad name', intent: 'x' }),
    ).toEqual({
      error: expect.stringContaining('not a bean name'),
    });
  });

  it('task_list and task_claim: one claim per task, refused once it is taken or done', async () => {
    const { user, token, client } = await session(['read', 'collaborate', 'write']);
    const repo = await repository(user);
    expect(await tool(client, 'task_list', { repo: slug(repo) })).toMatchObject({
      file: null,
      summary: expect.stringContaining('has no backlog'),
    });
    await plantOnSprout(repo, { '.beanstalk/backlog.md': BACKLOG }, token);
    expect(await tool(client, 'task_list', { repo: slug(repo) })).toMatchObject({
      file: '.beanstalk/backlog.md',
      tasks: [
        { id: 'add-total', state: 'open' },
        { id: 'T-2', state: 'open' },
        { id: 'T-3', state: 'done' },
      ],
    });
    expect(await tool(client, 'task_claim', { repo: slug(repo), task: 'T-2' })).toMatchObject({
      task: { id: 'T-2', state: 'claimed', by: user.handle },
    });
    expect(
      await tool(client, 'task_claim', { repo: slug(repo), task: 'T-2', release: true }),
    ).toMatchObject({
      task: { id: 'T-2', state: 'open' },
      summary: expect.stringContaining('Gave task T-2 back'),
    });
    expect(await tool(client, 'task_claim', { repo: slug(repo), task: 'T-3' })).toEqual({
      error: expect.stringContaining('ticked done'),
    });
    expect(await tool(client, 'task_claim', { repo: slug(repo), task: 'nope' })).toEqual({
      error: expect.stringContaining('has no task nope'),
    });
    const readOnly = await connect(await personalToken(user, ['read']));
    const readOnlyTools = (await readOnly.listTools()).tools.map((listed) => listed.name);
    expect(readOnlyTools).not.toContain('task_claim');
    expect(readOnlyTools).toContain('task_list');
  });

  it('git_credentials: a repository-bound credential that pushes; bean_wait reads the verdict', async () => {
    const { user, client } = await session();
    const [repo, other] = [await repository(user), await repository(user, { name: 'other' })];
    const answer = z
      .object({ credential: z.string(), scopes: z.array(z.string()), expires_at: z.string() })
      .parse(await tool(client, 'git_credentials', { repo: slug(repo), ttl_minutes: 10 }));
    expect(answer.scopes).toEqual(['read', 'write']);
    expect(Date.parse(answer.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(answer.credential).toContain('host=gateway.example.test');
    expect(answer.credential).toContain(`path=${slug(repo)}.git`);
    const password = /^password=(\S+)$/m.exec(answer.credential)?.[1] ?? '';
    expect(password).toMatch(/^bss_/);
    expect((await verifyUserToken(env, password))?.token.repository).toBe(repo.engine_id);

    const pushed = await gitPush(slug(repo), password, {
      bean: 'add-total',
      newSha: await digest('mcp-1'),
      message: 'Add a total helper',
    });
    expect(pushed.remote).toContain('new bean add-total received');
    expect(
      await tool(client, 'bean_wait', { repo: slug(repo), bean: 'add-total', timeout_s: 60 }),
    ).toMatchObject({ phase: expect.stringMatching(/^(landed|green)$/), timed_out: false });
    const status = await tool(client, 'bean_status', { repo: slug(repo), bean: 'bean/add-total' });
    expect(status).toMatchObject({ pushed: { actor: user.handle, title: 'Add a total helper' } });
    expect(JSON.stringify(status['journey'])).toContain('LANDED: add-total');

    // Only that repository, and never as a bearer on /mcp.
    const elsewhere = await gitPush(slug(other), password, {
      bean: 'x',
      newSha: await digest('mcp-2'),
    });
    expect(elsewhere.status).toBe(404);
    const asBearer = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${password}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(asBearer.status).toBe(401);
  });

  it('repo_read reads files, ranges, trees, globs and greps a repository without a checkout', async () => {
    const { user, token } = await session();
    const repo = await repository(user);
    await plantOnSprout(
      repo,
      {
        'README.md': '# app\n',
        'src/total.ts':
          'import { tax } from "./tax";\n\nexport function total(n: number) {\n  return n + tax(n);\n}\n',
        'src/tax.ts': 'export const tax = (n: number) => n / 10;\n',
      },
      token,
    );
    // Reading needs only the read scope.
    const client = await connect(await personalToken(user, ['read']));
    expect(
      await tool(client, 'repo_read', { repo: slug(repo), path: 'src/total.ts', start: 3, end: 4 }),
    ).toMatchObject({
      mode: 'files',
      files: [
        {
          path: 'src/total.ts',
          start: 3,
          end: 4,
          content: 'export function total(n: number) {\n  return n + tax(n);',
          next_start: null,
        },
      ],
    });
    expect(await tool(client, 'repo_read', { repo: slug(repo), path: 'src' })).toMatchObject({
      mode: 'tree',
      entries: expect.arrayContaining([expect.objectContaining({ path: 'src/tax.ts' })]),
    });
    const globbed = await tool(client, 'repo_read', { repo: slug(repo), glob: '**/*.ts' });
    expect(globbed['entries']).toEqual([
      { path: 'src/tax.ts', type: expect.any(String) },
      { path: 'src/total.ts', type: expect.any(String) },
    ]);
    const grep = await tool(client, 'repo_read', {
      repo: slug(repo),
      grep: 'tax(',
      glob: 'src/*.ts',
    });
    expect(grep).toMatchObject({ mode: 'grep', matches: 1, next_cursor: null });
    expect(grep['messages']).toEqual([
      { type: 'begin', data: { path: { text: 'src/total.ts' } } },
      expect.objectContaining({
        type: 'context',
        data: expect.objectContaining({ line_number: 2 }),
      }),
      expect.objectContaining({
        type: 'context',
        data: expect.objectContaining({ line_number: 3 }),
      }),
      {
        type: 'match',
        data: {
          path: { text: 'src/total.ts' },
          lines: { text: '  return n + tax(n);' },
          line_number: 4,
          submatches: [{ match: { text: 'tax(' }, start: 13, end: 17 }],
        },
      },
      expect.objectContaining({
        type: 'context',
        data: expect.objectContaining({ line_number: 5 }),
      }),
      { type: 'end', data: { path: { text: 'src/total.ts' }, stats: { matched_lines: 1 } } },
    ]);
    const regex = await tool(client, 'repo_read', {
      repo: slug(repo),
      grep: '/export (const|function)/',
    });
    expect(regex).toMatchObject({ regex: true, matches: 2 });
  });

  it('bean_commit writes bean/<name> without a checkout and submits it; a stale head is a conflict', async () => {
    const { user, token, client } = await session();
    const repo = await repository(user);
    await plantOnSprout(repo, { 'README.md': '# app\n', 'src/total.ts': 'export {};\n' }, token);
    const input = {
      repo: slug(repo),
      bean: 'bean/docs-total',
      expected_head: null,
      changes: [
        { path: 'docs/total.md', content: '# Totals\n' },
        { path: 'src/total.ts', content: 'export const total = 0;\n' },
      ],
      message: 'Document totals',
      idempotency_key: 'docs-1',
    };
    const committed = await tool(client, 'bean_commit', input);
    expect(committed).toMatchObject({
      kind: 'committed',
      bean: 'docs-total',
      branch: 'bean/docs-total',
      files: 2,
      summary: expect.stringContaining('submitted it as a push'),
    });
    // Compare-and-swap: a head that is not the branch's writes nothing.
    const stale = {
      ...input,
      bean: 'fresh',
      expected_head: committed['commit'],
      idempotency_key: 'f-1',
    };
    expect(await tool(client, 'bean_commit', stale)).toMatchObject({
      kind: 'conflict',
      branch: 'bean/fresh',
      current_head: null,
      summary: expect.stringContaining('nothing was written'),
    });
    expect(
      await tool(client, 'bean_wait', { repo: slug(repo), bean: 'docs-total', timeout_s: 60 }),
    ).toMatchObject({
      phase: expect.stringMatching(/^(landed|green)$/),
      pushed: { actor: user.handle, title: 'Document totals' },
    });
    // An exact retry replays the first answer, even once the bean has landed.
    expect(await tool(client, 'bean_commit', input)).toEqual(committed);
    expect(
      await tool(client, 'bean_commit', {
        ...input,
        idempotency_key: 'docs-3',
        expected_head: committed['commit'],
      }),
    ).toEqual({ error: expect.stringContaining('already landed') });
    const reader = await connect(await personalToken(user, ['read']));
    expect((await reader.listTools()).tools.map((listed) => listed.name)).not.toContain(
      'bean_commit',
    );
    expect(
      await tool(client, 'bean_commit', {
        ...input,
        changes: [{ path: '.git/config', content: '' }],
      }),
    ).toHaveProperty('error');
  });

  it('git_credentials for a read-only session reads but cannot push', async () => {
    const { user, client } = await session(['read']);
    const repo = await repository(user);
    const answer = z
      .object({ credential: z.string(), scopes: z.array(z.string()) })
      .parse(await tool(client, 'git_credentials', { repo: slug(repo) }));
    expect(answer.scopes).toEqual(['read']);
    const password = /^password=(\S+)$/m.exec(answer.credential)?.[1] ?? '';
    const refused = await gitPush(slug(repo), password, { bean: 'x', newSha: await digest('ro') });
    expect(refused.status).toBe(403);
  });

  it('bean_status explains a red: failing tests, the bean it collided with, the next step', async () => {
    const { user, token, client } = await session();
    const repo = await repository(user);
    await requireChecks(repo, token);
    await gitPush(slug(repo), token, {
      bean: 'tax-rate',
      newSha: await digest('tax'),
      message: 'Charge 10% tax\n\nEvery total includes a 10% tax line.',
      options: ['wait'],
    });
    await gitPush(slug(repo), token, { bean: 'red-discount', newSha: await digest('disc') });
    const red = await tool(client, 'bean_wait', { repo: slug(repo), bean: 'red-discount' });
    expect(red).toMatchObject({
      phase: 'red',
      rework: {
        failing_tests: expect.arrayContaining([expect.any(String)]),
        collided_with: expect.arrayContaining([
          expect.objectContaining({
            bean: 'tax-rate',
            intent: expect.stringContaining('10% tax line'),
          }),
        ]),
      },
      next: expect.stringContaining('git rebase origin/sprout'),
    });
    expect(await tool(client, 'repo_status', { repo: slug(repo) })).toMatchObject({
      sent_back: [{ bean: 'red-discount', phase: 'red', actor: user.handle }],
    });
    const status = await tool(client, 'bean_status', {
      repo: slug(repo),
      bean: 'bean/red-discount',
      checks: true,
    });
    expect(status).toMatchObject({
      bean: 'red-discount',
      phase: 'red',
      rework: { failing_tests: ['test/total.test.js > total adds tax'] },
      engine: { phase: 'rework', reworks: 1 },
      checks: {
        red: 1,
        failures: [{ file: 'test/total.test.js', test: 'total adds tax', protected: false }],
      },
      blamed_by: [],
      preview_url: expect.stringContaining('bean=red-discount'),
      next: expect.stringContaining('git rebase origin/sprout'),
    });
  });

  it("follows the person's role: a read collaborator reads but opens no bean; outsiders see nothing", async () => {
    const owner = await person();
    const repo = await repository(owner);
    const reader = await collaborator(owner, repo, 'read');
    const client = await connect(await personalToken(reader, ['read', 'write']));
    expect(await tool(client, 'repo_status', { repo: slug(repo) })).toMatchObject({
      repo: slug(repo),
    });
    expect(await tool(client, 'whoami', { repo: slug(repo) })).toMatchObject({
      role: 'read',
      may: { read: true, push_beans: false },
    });
    expect(await tool(client, 'bean_open', { repo: slug(repo), bean: 'r', intent: 'R' })).toEqual({
      error: expect.stringContaining('needs the write role'),
    });
    expect(
      z
        .object({ scopes: z.array(z.string()) })
        .parse(await tool(client, 'git_credentials', { repo: slug(repo) })).scopes,
    ).toEqual(['read']);
    const writer = await collaborator(owner, repo, 'write');
    const writing = await connect(await personalToken(writer, ['read', 'write']));
    expect(
      await tool(writing, 'bean_open', { repo: slug(repo), bean: 'w', intent: 'W' }),
    ).toMatchObject({
      branch: 'bean/w',
    });
  });

  it('refuses deploy tokens and repository-bound tokens as /mcp bearers', async () => {
    const user = await person();
    const repo = await repository(user);
    const deploy = await deployToken(user, repo);
    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deploy}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });
});
