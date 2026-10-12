import { SELF } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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
 * The Actions, secrets and automation tools of an agent session, end to end: the MCP Worker
 * over Streamable HTTP with a person's token, the real gateway behind its binding (its
 * repo-events queue, Actions control plane and stub executor). The deploy loop an agent runs:
 * set the token the person gave it, push a workflow, wait for the run its landing started,
 * read the failing log; then dispatch, cancel, re-run, variables and automations. No tool's
 * answer, error or log line ever carries a secret's value.
 */
const ORIGIN = 'https://gitstalk-mcp.example.workers.dev';
const WEB = 'https://gitstalk-web.example.workers.dev';
const SECRET_VALUE = 'cf-token-from-the-person-7d41a9';
const clients: Client[] = [];
/** Every tool answer and every line the MCP Worker logged, to search for the secret. */
const seen: string[] = [];
const logSpies: ReturnType<typeof vi.spyOn>[] = [];

const DEPLOY = `name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: echo building
      - name: Deploy
        run: echo deploying with token \${{ secrets.CLOUDFLARE_API_TOKEN }} to \${{ vars.ACCOUNT_ID }}
      - name: Smoke
        run: exit 1
`;
const HANG =
  'name: Hang\non:\n  workflow_dispatch:\njobs:\n  wait:\n    runs-on: ubuntu-latest\n    steps:\n      - run: sleep 600\n';
const NOTE = 'name: Note\non:\n  bean_landed:\nharness: shell\nrun: echo noted\n';

beforeAll(() => {
  for (const level of ['log', 'info', 'warn', 'error'] as const)
    logSpies.push(
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        seen.push(args.map(String).join(' '));
      }),
    );
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(() => {
  for (const spy of logSpies) spy.mockRestore();
  expect(seen.some((text) => text.includes(SECRET_VALUE))).toBe(false);
});

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('host', new URL(request.url).host);
      return SELF.fetch(request);
    },
  });
  const client = new Client({ name: 'actions-tools-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const Content = z.array(z.object({ type: z.literal('text'), text: z.string() }));

async function tool(client: Client, name: string, input: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: input });
  const text = Content.parse(result.content)[0]?.text ?? '';
  seen.push(text);
  if (result.isError === true) return { error: text };
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

async function as(user: Person, scopes: readonly string[]): Promise<Client> {
  return connect(await personalToken(user, scopes));
}

const Run = z.object({
  id: z.string(),
  conclusion: z.string().nullable(),
  status: z.string(),
  run_url: z.string(),
});

describe('Actions tools: the deploy loop', () => {
  let owner: Person;
  let repo: Repository;
  let ownerToken: string;

  beforeAll(async () => {
    owner = await person('mcp-deployer');
    repo = await repository(owner, { name: 'site' });
    ownerToken = await personalToken(owner, ['read', 'write', 'secrets']);
  });

  it('are listed for agent sessions, with no execute tool', async () => {
    const names = (await (await connect(ownerToken)).listTools()).tools.map(
      (listed) => listed.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'actions_workflow_list',
        'actions_run_list',
        'actions_run_get',
        'actions_job_log',
        'actions_wait_for_run',
        'actions_dispatch',
        'actions_rerun',
        'actions_cancel',
        'actions_secret_list',
        'actions_secret_set',
        'actions_secret_delete',
        'actions_variable_list',
        'actions_variable_set',
        'actions_variable_delete',
        'automation_get',
        'automation_run',
      ]),
    );
    expect(names).not.toContain('execute');
  });

  it('sets the secret the person gave, pushes a workflow, waits for its run and reads the failure', async () => {
    const client = await connect(ownerToken);
    const saved = await tool(client, 'actions_secret_set', {
      repo: slug(repo),
      name: 'CLOUDFLARE_API_TOKEN',
      value: SECRET_VALUE,
    });
    expect(saved).toMatchObject({ name: 'CLOUDFLARE_API_TOKEN', level: 'repository' });
    expect(
      await tool(client, 'actions_variable_set', {
        repo: slug(repo),
        name: 'account_id',
        value: 'acc-42',
      }),
    ).toMatchObject({ name: 'ACCOUNT_ID' });
    const pushed = await gitPush(slug(repo), ownerToken, {
      bean: 'add-deploy',
      newSha: await digest(`deploy:${repo.id}`),
      files: {
        '.github/workflows/deploy.yml': DEPLOY,
        '.github/workflows/hang.yml': HANG,
        '.gitstalk/automations/note.yml': NOTE,
      },
    });
    expect(pushed.status).toBe(200);

    const waited = await tool(client, 'actions_wait_for_run', {
      repo: slug(repo),
      bean: 'add-deploy',
      timeout_s: 60,
    });
    expect(waited).toMatchObject({ outcome: 'completed', bean: { phase: 'green' } });
    const [run] = z.array(Run.loose()).parse(waited['runs']);
    expect(run).toMatchObject({ conclusion: 'failure', workflow: '.github/workflows/deploy.yml' });
    expect(run?.run_url).toBe(`${WEB}/${slug(repo)}/actions/runs/${run?.id}`);
    expect(JSON.stringify(waited)).toContain('deploying with token *** to acc-42');
    expect(waited['next']).toEqual(expect.stringContaining('fix the cause'));

    const log = await tool(client, 'actions_job_log', {
      repo: slug(repo),
      run: run?.id,
      grep: 'deploying',
    });
    expect(log).toMatchObject({ job: { name: 'deploy', conclusion: 'failure' } });
    expect(log['text']).toEqual(expect.stringContaining('[Deploy] deploying with token ***'));

    const got = await tool(client, 'actions_run_get', { repo: slug(repo), run: run?.id });
    expect(got).toMatchObject({
      beans: ['add-deploy'],
      next: expect.stringContaining('actions_job_log'),
    });
    const listed = await tool(client, 'actions_run_list', { repo: slug(repo), bean: 'add-deploy' });
    expect(
      z
        .array(Run.loose())
        .parse(listed['runs'])
        .map((found) => found.id),
    ).toEqual([run?.id]);
    const status = await tool(client, 'repo_status', { repo: slug(repo) });
    expect(status['stalk_runs']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: run?.id, conclusion: 'failure' })]),
    );
  });

  it('lists secret names only, with the Settings link, and workflows with their triggers', async () => {
    const client = await connect(ownerToken);
    const secrets = await tool(client, 'actions_secret_list', { repo: slug(repo) });
    expect(secrets).toMatchObject({
      secrets: [expect.objectContaining({ name: 'CLOUDFLARE_API_TOKEN' })],
      settings_url: `${WEB}/${slug(repo)}/settings/secrets`,
    });
    const variables = await tool(client, 'actions_variable_list', { repo: slug(repo) });
    expect(variables['variables']).toEqual([
      expect.objectContaining({ name: 'ACCOUNT_ID', value: 'acc-42' }),
    ]);
    const workflows = await tool(client, 'actions_workflow_list', { repo: slug(repo) });
    expect(workflows['workflows']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Deploy', triggers: ['push (main)', 'workflow_dispatch'] }),
      ]),
    );
  });

  it('dispatches, cancels and re-runs; the wait is bounded by timeout_s', async () => {
    const client = await connect(ownerToken);
    const started = await tool(client, 'actions_dispatch', {
      repo: slug(repo),
      workflow: 'hang.yml',
    });
    const hang = Run.loose().parse(started['run']);
    const before = Date.now();
    const bounded = await tool(client, 'actions_wait_for_run', {
      repo: slug(repo),
      run: hang.id,
      timeout_s: 2,
    });
    expect(bounded).toMatchObject({ outcome: 'running' });
    expect(Date.now() - before).toBeLessThan(10_000);
    expect(await tool(client, 'actions_cancel', { repo: slug(repo), run: hang.id })).toMatchObject({
      run: { id: hang.id },
    });
    const cancelled = await tool(client, 'actions_wait_for_run', {
      repo: slug(repo),
      run: hang.id,
      timeout_s: 30,
    });
    expect(z.array(Run.loose()).parse(cancelled['runs'])[0]?.conclusion).toBe('cancelled');
    const again = await tool(client, 'actions_rerun', { repo: slug(repo), run: hang.id });
    const rerun = Run.loose().parse(again['run']);
    expect(rerun.id).not.toBe(hang.id);
    await tool(client, 'actions_cancel', { repo: slug(repo), run: rerun.id });
  });

  it('reads an automation and runs it now', async () => {
    const client = await connect(ownerToken);
    expect(
      await tool(client, 'automation_get', { repo: slug(repo), automation: 'note' }),
    ).toMatchObject({
      path: '.gitstalk/automations/note.yml',
      file: NOTE,
    });
    const started = await tool(client, 'automation_run', { repo: slug(repo), automation: 'Note' });
    const run = Run.loose().parse(started['run']);
    expect(run.run_url).toBe(`${WEB}/${slug(repo)}/automations/runs/${run.id}`);
    const waited = await tool(client, 'actions_wait_for_run', {
      repo: slug(repo),
      run: run.id,
      timeout_s: 30,
    });
    expect(waited).toMatchObject({ outcome: 'completed' });
  });

  it('refuses by scope and role: read-only, no secrets scope, a writer, a stranger', async () => {
    const readOnly = await as(owner, ['read']);
    expect(
      await tool(readOnly, 'actions_dispatch', { repo: slug(repo), workflow: 'deploy.yml' }),
    ).toEqual({ error: expect.stringContaining('needs the write scope') });
    const noSecrets = await as(owner, ['read', 'write']);
    const refused = await tool(noSecrets, 'actions_secret_set', {
      repo: slug(repo),
      name: 'OTHER',
      value: SECRET_VALUE,
    });
    expect(refused).toEqual({ error: expect.stringContaining('needs the secrets scope') });
    expect(refused).toEqual({
      error: expect.stringContaining(`${WEB}/${slug(repo)}/settings/secrets`),
    });
    const writer = await collaborator(owner, repo, 'write');
    const asWriter = await as(writer, ['read', 'write', 'secrets']);
    expect(
      await tool(asWriter, 'actions_secret_set', {
        repo: slug(repo),
        name: 'OTHER',
        value: SECRET_VALUE,
      }),
    ).toEqual({ error: expect.stringContaining('maintain role') });
    expect(
      await tool(asWriter, 'actions_dispatch', { repo: slug(repo), workflow: 'deploy.yml' }),
    ).toEqual({ error: expect.stringContaining('maintain role') });
    expect(await tool(asWriter, 'actions_secret_list', { repo: slug(repo) })).toMatchObject({
      can_manage: false,
    });
    const access = await tool(asWriter, 'repository_access', { repository: slug(repo) });
    expect(access['may']).toMatchObject({ run_workflows: false, set_secrets: false });
    const stranger = await as(await person('mcp-stranger'), ['read', 'write', 'secrets']);
    expect(await tool(stranger, 'actions_run_list', { repo: slug(repo) })).toEqual({
      error: `repository ${slug(repo)} not found`,
    });
    const ownerAccess = await tool(await connect(ownerToken), 'repository_access', {
      repository: slug(repo),
    });
    expect(ownerAccess['may']).toMatchObject({ run_workflows: true, set_secrets: true });
  });

  it('deletes secrets and variables', async () => {
    const client = await connect(ownerToken);
    expect(
      await tool(client, 'actions_variable_delete', { repo: slug(repo), name: 'ACCOUNT_ID' }),
    ).toMatchObject({ deleted: true });
    expect(
      await tool(client, 'actions_secret_delete', {
        repo: slug(repo),
        name: 'CLOUDFLARE_API_TOKEN',
      }),
    ).toMatchObject({ deleted: true });
  });
});
