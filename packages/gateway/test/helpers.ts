import {
  SELF,
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { expect, vi } from 'vitest';

import type { RunListItem } from '@gitstalk/shared-race/rpc';

import Gateway from '../src/index';
import { StoredRunListItem } from '../src/run/run-list';

export const ADMIN = 'test-admin-token-0123456789abcdef0123456789';
export const ORIGIN = 'https://gateway.test';
export const NAMESPACE = 'gitstalk-race';
export const ZERO_SHA = '0'.repeat(40);

/** A task in the arena file format. */
export function arenaTask(id: string): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    prompt: `Implement ${id}.`,
    acceptance_tests: { [`tests/${id}.test.ts`]: `test('${id}');\n` },
    oracle_paths: [`src/${id}.ts`],
    oracle_modules: ['src'],
    kind: 'feature',
    difficulty: 1,
    couplings: [],
  };
}

export type CreatedRun = {
  run: string;
  repo: { name: string; url: string; sprout: string; stalk: string };
  slots: { slot: string; token: string; expires_at: string }[];
  view: { token: string; live_url: string; events_url: string };
};

export async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined && typeof options.body !== 'string')
    headers.set('content-type', 'application/json');
  const body =
    options.body === undefined || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body);
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

export async function json<T>(response: Response): Promise<T> {
  try {
    return await response.clone().json<T>();
  } catch {
    throw new Error(`not JSON (${response.status}): ${await response.text()}`);
  }
}

/** Creates a queue run with the given tasks (defaults: replay agents, no CI latency). */
export async function createRun(config: Record<string, unknown> = {}): Promise<CreatedRun> {
  const response = await call('POST', '/v1/runs', {
    token: ADMIN,
    body: {
      policy: 'queue',
      agents: 2,
      ci_seconds: 0,
      tasks: [arenaTask('t001'), arenaTask('t002')],
      ...config,
    },
  });
  if (response.status !== 201)
    throw new Error(`create failed: ${response.status} ${await response.text()}`);
  return json<CreatedRun>(response);
}

/** A run's row in the run list (D1 `runs`) once its RunDO's background write has landed. */
export async function listedRun(run: string): Promise<RunListItem> {
  return vi.waitFor(
    async () => {
      const row = await env.FORGE.prepare('SELECT body FROM runs WHERE run = ?')
        .bind(run)
        .first<{ body: string }>();
      if (row === null) throw new Error(`run ${run} is not listed yet`);
      return StoredRunListItem.parse(JSON.parse(row.body));
    },
    { timeout: 10_000, interval: 20 },
  );
}

/** Fires the gateway's cron trigger (`scheduled()`) as if at `scheduledTime`. */
export async function fireCron(scheduledTime: number): Promise<void> {
  const ctx = createExecutionContext();
  const gateway = new Gateway(ctx, env);
  await gateway.scheduled(createScheduledController({ scheduledTime, cron: '17 * * * *' }));
  await waitOnExecutionContext(ctx);
}

export function slotToken(run: CreatedRun, slot: string): string {
  const entry = run.slots.find((candidate) => candidate.slot === slot);
  if (entry === undefined) throw new Error(`no slot ${slot}`);
  return entry.token;
}

/** One pkt-line (length prefix included in the length). */
export function pkt(line: string): string {
  return `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
}

/** A receive-pack request body updating one ref (an empty pack follows the commands). */
export function pushBody(ref: string, newSha: string, oldSha = ZERO_SHA): string {
  return pushRefsBody([{ ref, newSha, oldSha }]);
}

/** A receive-pack body updating several refs in one push (capabilities on the first line). */
export function pushRefsBody(
  updates: readonly { ref: string; newSha: string; oldSha?: string }[],
): string {
  const lines = updates.map(({ ref, newSha, oldSha = ZERO_SHA }, index) =>
    pkt(`${oldSha} ${newSha} ${ref}${index === 0 ? '\0report-status' : ''}\n`),
  );
  return `${lines.join('')}0000PACK`;
}

export function gitPath(repo: string, rest: string): string {
  return `/git/${NAMESPACE}/${repo}.git/${rest}`;
}

/** A commit a test push carries (the fake remote stores it; real git would send a pack). */
export type FakeCommit = { parents?: string[]; message?: string; files: Record<string, string> };

/** Pushes refs with the seed token, carrying commits the fake Artifacts can read back. */
export async function pushCommits(
  run: CreatedRun,
  refs: Record<string, string>,
  commits: Record<string, FakeCommit>,
): Promise<Response> {
  const tokenResponse = await call('POST', `/v1/runs/${run.run}/seed-token`, { token: ADMIN });
  const { token } = await json<{ token: string }>(tokenResponse);
  const updates = Object.entries(refs).map(([ref, newSha]) => ({ ref, newSha }));
  return call('POST', gitPath(run.repo.name, 'git-receive-pack'), {
    token,
    body: `${pushRefsBody(updates)}${JSON.stringify({ commits })}`,
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
  });
}

/** Seeds the run repo with the admin's seed token: the base goes to the sprout and the stalk. */
export async function pushBase(
  run: CreatedRun,
  baseSha: string,
  refs: readonly string[] = ['refs/heads/sprout', 'refs/heads/stalk'],
): Promise<Response> {
  const tokenResponse = await call('POST', `/v1/runs/${run.run}/seed-token`, { token: ADMIN });
  const { token } = await json<{ token: string }>(tokenResponse);
  return call('POST', gitPath(run.repo.name, 'git-receive-pack'), {
    token,
    body: pushRefsBody(refs.map((ref) => ({ ref, newSha: baseSha }))),
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
  });
}

type Instruction = {
  inv: string;
  kind: string;
  task: string;
  workspace: {
    bean: string;
    bean_url: string;
    repo_url: string;
    branch: string;
    base_sha: string;
  };
};
export type Next = { invocation?: Instruction; wait?: true; done?: true; aborted?: string | null };

/** A replay-like driver slot: take an instruction, push the branch through the proxy, report. */
export async function driveSlot(run: CreatedRun, slot: string): Promise<string[]> {
  const token = slotToken(run, slot);
  const handled: string[] = [];
  for (let round = 0; round < 20; round += 1) {
    const path = `/v1/runs/${run.run}/agents/${slot}/next`;
    // oxlint-disable-next-line no-await-in-loop -- a driver slot polls, works and reports in turn
    const next = await json<Next>(await call('POST', path, { token }));
    if (next.done === true) return handled;
    const instruction = next.invocation;
    if (instruction === undefined) continue;
    handled.push(`${instruction.inv}:${instruction.task}`);
    // oxlint-disable-next-line no-await-in-loop -- one invocation at a time per slot
    const head = await sha(instruction.inv);
    // oxlint-disable-next-line no-await-in-loop -- the push precedes the result
    const pushed = await call(
      'POST',
      new URL(`${instruction.workspace.bean_url}/git-receive-pack`).pathname,
      {
        token,
        body: pushBody(`refs/heads/${instruction.workspace.branch}`, head),
      },
    );
    expect(pushed.status).toBe(200);
    // oxlint-disable-next-line no-await-in-loop -- the result follows the push
    const result = await call('POST', `/v1/runs/${run.run}/invocations/${instruction.inv}/result`, {
      token,
      body: {
        ok: true,
        subtype: 'success',
        cost_usd: 0.01,
        cost_source: 'reported',
        num_turns: 3,
        wall_ms: 1200,
        session_id: `session-${instruction.task}`,
        head_sha: head,
        new_commit: true,
        pushed_ref: `refs/heads/${instruction.workspace.branch}`,
        files: [`src/${instruction.task}.ts`, `tests/${instruction.task}.test.ts`],
        inv_id: instruction.inv,
        adapter: 'replay',
      },
    });
    expect(result.status).toBe(200);
  }
  throw new Error(`slot ${slot} never finished`);
}

export async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
