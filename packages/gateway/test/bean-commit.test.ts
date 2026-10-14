import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BeanCommitInput, BeanCommitResult } from '@gitstalk/shared-race/bean-commit';
import { ContributorTokenClaims } from '@gitstalk/shared-race/collaboration';
import { Sha, TaskId } from '@gitstalk/shared-race/ids';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { commitToBean } from '../src/commit/bean-commit';
import type { FileSave } from '../src/commit/file-save';
import { commitFileSave } from '../src/commit/file-save';
import { keyQueue } from '../src/commit/key-queue';
import type { CommitDeps } from '../src/commit/server-commit';
import type { TreeReader } from '../src/commit/tree-edit';
import { FLUSH_PKT, concatBytes, pktLine } from '../src/git/pkt-line';
import { createLogger } from '../src/log';
import { ADMIN, call, createRun, json, pushCommits } from './helpers';
import type { CreatedRun } from './helpers';

const gateway = exports.default;
const BASE = 'b'.repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
});

async function seededRun(): Promise<{ run: CreatedRun; token: string }> {
  const run = await createRun();
  const seeded = await pushCommits(
    run,
    { 'refs/heads/sprout': BASE, 'refs/heads/stalk': BASE },
    { [BASE]: { files: { 'README.md': '# app\n', 'src/lib/money.ts': 'export {};\n' } } },
  );
  expect(seeded.status).toBe(200);
  const granted = await call('POST', `/v1/runs/${run.run}/contributor-token`, {
    token: ADMIN,
    body: { bean: 't001', actor: 'Doc Bot' },
  });
  return { run, token: (await json<{ token: string }>(granted)).token };
}

function input(overrides: Partial<BeanCommitInput> = {}): BeanCommitInput {
  return {
    bean: TaskId.parse('t001'),
    expected_head: null,
    changes: [
      { path: 'docs/guide.md', content: '# Guide\n' },
      { path: 'src/lib/money.ts', content: 'export const cents = 100;\n' },
    ],
    message: 'Document money',
    idempotency_key: 'commit-1',
    ...overrides,
  };
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function committed(result: RpcResult<BeanCommitResult>) {
  const answer = value(result);
  if (answer.kind !== 'committed') throw new Error(`not committed: ${JSON.stringify(answer)}`);
  return answer;
}

describe('bean_commit: commits on the server', () => {
  it('creates the bean branch from the sprout, then moves it with compare-and-swap', async () => {
    const { run, token } = await seededRun();
    const first = committed(await gateway.beanCommit(token, input()));
    expect(first).toMatchObject({ branch: 'beans/t001', parent: BASE, files: 2 });
    // The root, src and src/lib: docs/ is new, and nothing else is read.
    expect(first.trees_read).toBe(3);
    const file = value(await gateway.repoFile(run.run, first.commit, 'docs/guide.md'));
    expect(file.content).toBe('# Guide\n');
    const kept = value(await gateway.repoFile(run.run, first.commit, 'README.md'));
    expect(kept.content).toBe('# app\n');
    const log = value(await gateway.repoLog(run.run, first.commit, null, 1));
    expect(log.commits[0]?.message).toContain('Task: t001\nActor: Doc Bot\nVia: bean_commit');

    const second = committed(
      await gateway.beanCommit(
        token,
        input({
          expected_head: first.commit,
          changes: [{ path: 'docs/guide.md', delete: true }],
          idempotency_key: 'commit-2',
        }),
      ),
    );
    expect(second.parent).toBe(first.commit);
    expect((await gateway.repoFile(run.run, second.commit, 'docs/guide.md')).ok).toBe(false);
  });

  it('answers a conflict with the current head when the branch moved', async () => {
    const { token } = await seededRun();
    const first = committed(await gateway.beanCommit(token, input()));
    const stale = value(
      await gateway.beanCommit(token, input({ expected_head: null, idempotency_key: 'again' })),
    );
    expect(stale).toEqual({
      kind: 'conflict',
      bean: 't001',
      branch: 'beans/t001',
      expected_head: null,
      current_head: first.commit,
    });
  });

  it('replays a retry with the same key and refuses the key with other input', async () => {
    const { token } = await seededRun();
    const first = committed(await gateway.beanCommit(token, input()));
    expect(committed(await gateway.beanCommit(token, input()))).toEqual(first);
    expect(await gateway.beanCommit(token, input({ message: 'Other' }))).toMatchObject({
      ok: false,
      error: { code: 'conflict', status: 409 },
    });
  });

  it('writes only the token’s own bean, never with a view token, and only safe paths', async () => {
    const { run, token } = await seededRun();
    expect(await gateway.beanCommit(token, input({ bean: TaskId.parse('t002') }))).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(await gateway.beanCommit(run.view.token, input())).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    const unsafe = ['../escape', '/etc/passwd', '.git/config', 'a/.GIT/hooks'];
    const refusals = await Promise.all(
      unsafe.map((path) => gateway.beanCommit(token, input({ changes: [{ path, content: 'x' }] }))),
    );
    for (const refusal of refusals)
      expect(refusal).toMatchObject({ ok: false, error: { status: 400 } });
    const twice = input({
      changes: [
        { path: 'a.txt', content: '1' },
        { path: 'a.txt', delete: true },
      ],
    });
    expect(await gateway.beanCommit(token, twice)).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
  });

  it('caps the size of one commit', async () => {
    const { token } = await seededRun();
    const big = 'x'.repeat(100 * 1024);
    const tooBig = input({
      changes: [
        { path: 'a.txt', content: big },
        { path: 'b.txt', content: big },
      ],
    });
    expect(await gateway.beanCommit(token, tooBig)).toMatchObject({
      ok: false,
      error: { status: 400, message: expect.stringContaining('at most') },
    });
  });

  it('is served over HTTP to the contributor token', async () => {
    const { run, token } = await seededRun();
    const response = await call('POST', `/v1/runs/${run.run}/beans/t001/commits`, {
      token,
      body: input(),
    });
    expect(response.status).toBe(201);
    const viewer = await call('POST', `/v1/runs/${run.run}/beans/t001/commits`, {
      token: run.view.token,
      body: input(),
    });
    expect(viewer.status).toBe(403);
  });
});

describe('bean_commit against a remote that refuses the update', () => {
  it('reports the lost race as a conflict, and another refusal with its reason', async () => {
    const { run } = await seededRun();
    const stub = env.RUNS.getByName(run.run);
    const heads = { current: null as string | null };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const url = String(request instanceof Request ? request.url : request);
      if (url.includes('/info/refs'))
        return advertisement({ 'refs/heads/sprout': BASE, ...branch(heads.current) });
      heads.current = 'c'.repeat(40);
      return report('ng refs/heads/beans/t001 fetch first');
    });
    const reader: TreeReader = {
      readCommit: async () => ({ treeHash: 'd'.repeat(40) }),
      readTree: async () => [],
    };
    const claims = ContributorTokenClaims.parse({
      scope: 'contributor',
      run: run.run,
      bean: 't001',
      actor: 'Doc Bot',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const attempt = () =>
      runInDurableObject(stub, (_, state) =>
        commitToBean(
          {
            sql: state.storage.sql,
            read: (use) => use(reader),
            target: async () => ({ remote: 'https://artifacts.test/git/ns/repo.git', token: 't' }),
            queue: keyQueue(),
            now: () => 1_700_000_000_000,
            emailHost: 'example.test',
            log: createLogger('error'),
          },
          claims,
          input({ idempotency_key: `race-${heads.current ?? 'none'}` }),
        ),
      );
    expect(await attempt()).toEqual({
      ok: true,
      value: expect.objectContaining({ kind: 'conflict', current_head: 'c'.repeat(40) }),
    });
    heads.current = null;
    fetchSpy.mockImplementation(async (request) => {
      const url = String(request instanceof Request ? request.url : request);
      if (url.includes('/info/refs')) return advertisement({ 'refs/heads/sprout': BASE });
      return report('ng refs/heads/beans/t001 pre-receive hook declined');
    });
    expect(await attempt()).toMatchObject({
      ok: false,
      error: { code: 'upstream_failed', message: expect.stringContaining('hook declined') },
    });
  });
});

describe("an editor's save goes through the same core", () => {
  const reader: TreeReader = {
    readCommit: async () => ({ treeHash: 'd'.repeat(40) }),
    readTree: async () => [],
  };
  const inObject = async <T>(work: (deps: CommitDeps) => Promise<T>): Promise<T> => {
    const { run } = await seededRun();
    return runInDurableObject(env.RUNS.getByName(run.run), (_, state) =>
      work({
        sql: state.storage.sql,
        read: (use) => use(reader),
        target: async () => ({ remote: 'https://artifacts.test/git/ns/repo.git', token: 't' }),
        queue: keyQueue(),
        now: () => 1_700_000_000_000,
        emailHost: 'example.test',
        log: createLogger('error'),
      }),
    );
  };

  it('validates the path and caps the size as bean_commit does', async () => {
    const answers = await inObject((deps) =>
      Promise.all([
        commitFileSave(deps, save({ path: '../escape' }), {}),
        commitFileSave(deps, save({ path: 'a/.git/config' }), {}),
        commitFileSave(deps, save({ content: 'x'.repeat(129 * 1024) }), {}),
      ]),
    );
    for (const answer of answers)
      expect(answer).toMatchObject({ ok: false, error: { status: 400 } });
    expect(answers[2]).toMatchObject({ error: { message: expect.stringContaining('at most') } });
  });

  it('never moves a bean that exists: a lost race, then a name taken, are conflicts', async () => {
    const pushed: string[] = [];
    const remote = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(request instanceof Request ? request.url : request);
      if (url.includes('/info/refs'))
        return advertisement({
          'refs/heads/sprout': BASE,
          ...Object.fromEntries(pushed.map((ref) => [ref, 'c'.repeat(40)])),
        });
      const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : '';
      const ref = /refs\/heads\/bean\/rules-[0-9a-f]{6}/.exec(body)?.[0] ?? 'none';
      pushed.push(ref);
      return report(`ng ${ref} fetch first`);
    };
    const [lost, taken] = await inObject(async (deps) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(remote);
      return [
        await commitFileSave(deps, save(), {}),
        await commitFileSave(deps, save({ idempotencyKey: 'save-2' }), {}),
      ];
    });
    expect(pushed).toHaveLength(1);
    const conflict = { kind: 'conflict', expected_head: null, current_head: 'c'.repeat(40) };
    expect(lost).toEqual({ ok: true, value: expect.objectContaining(conflict) });
    expect(taken).toEqual({ ok: true, value: expect.objectContaining(conflict) });
  });
});

function save(overrides: Partial<FileSave> = {}): FileSave {
  return {
    editor: { kind: 'rules' },
    actor: 'coop',
    protectedAccess: { allowed: true, who: '@coop (owner, with the web editor)' },
    base: Sha.parse(BASE),
    path: '.gitstalk/policy.yml',
    content: 'classes: []\n',
    message: 'Edit approval rules',
    idempotencyKey: 'save-1',
    ...overrides,
  };
}

function branch(head: string | null): Record<string, string> {
  return head === null ? {} : { 'refs/heads/beans/t001': head };
}

function advertisement(refs: Record<string, string>): Response {
  const lines = Object.entries(refs).map(([ref, sha], index) =>
    pktLine(`${sha} ${ref}${index === 0 ? '\0report-status' : ''}\n`),
  );
  const body = concatBytes([
    pktLine('# service=git-receive-pack\n'),
    FLUSH_PKT,
    ...lines,
    FLUSH_PKT,
  ]);
  return new Response(body, {
    headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
  });
}

function report(line: string): Response {
  const body = concatBytes([pktLine('unpack ok\n'), pktLine(`${line}\n`), FLUSH_PKT]);
  return new Response(body, {
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
  });
}
