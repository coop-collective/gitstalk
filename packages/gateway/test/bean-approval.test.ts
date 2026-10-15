import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApproveBeanRequest } from '@gitstalk/shared-race/bean-approval';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { PushedBeanStatus, RpcResult } from '@gitstalk/shared-race/rpc';
import { PersonalTokenInput, createPersonalToken } from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

import { call, pkt, sha } from './helpers';

/**
 * Approving a held bean end to end (doc 32 §5): a repository whose policy on the stalk routes
 * `src/auth/**` to `card`, beans pushed by its writer and its maintainer, and `approveBean`, the
 * one RPC the web's Approve button and MCP `bean_approve` call. The real Worker, engine and
 * registry on Miniflare; Artifacts and the runner are the tests' fakes.
 */
const gateway = exports.default;
const ZERO = '0'.repeat(40);
const CLAUDE = { kind: 'mcp', name: 'Claude Code', session: 'oauth:claude-code' } as const;

const POLICY = `classes:
  - name: protected
    match: { paths: ["src/auth/**"] }
    route: card
    reviewers: ["@ap-dana"]
`;

type Person = { readonly id: string; readonly handle: string; readonly token: string };

let coop: Person;
let dana: Person;
let erin: Person;
let stranger: Person;
let repo: RepositoryRecord;

beforeAll(async () => {
  [coop, dana, erin, stranger] = await Promise.all([
    signUp('ap-coop'),
    signUp('ap-dana'),
    signUp('ap-erin'),
    signUp('ap-stranger'),
  ]);
  repo = value(
    await gateway.createRepository(coop, {
      name: 'approvals',
      visibility: 'private',
      start: { kind: 'empty' },
    }),
  );
  await Promise.all([invite(dana, 'maintain'), invite(erin, 'write')]);
  await pushFiles(coop, { branch: 'rules', files: { '.gitstalk/policy.yml': POLICY } });
  await waitForPhase('rules', ['green']);
}, 60_000);

describe('a held bean', () => {
  it('shows as held for its head, with why and the named reviewers', async () => {
    const head = await pushFiles(erin, { branch: 'login', files: { 'src/auth/login.ts': '1\n' } });
    const bean = await waitForPhase('login', ['red']);
    expect(bean.hold).toMatchObject({
      state: 'held',
      revision: head,
      classes: ['protected'],
      class: 'protected',
      by: 'policy',
      probability: null,
      reviewers: ['@ap-dana'],
      policy: { path: '.gitstalk/policy.yml' },
      approval: null,
    });
    expect(bean.reason).toBe("held for a person's approval (class protected, decided by policy)");
    expect(bean.verdict[0]).toBe(
      "HELD: login waits for a person's approval (class protected, decided by policy); nothing in it needs fixing",
    );
    expect(bean.verdict.join('\n')).not.toMatch(/RED:|fix:/u);
    expect(bean.approvals).toEqual([]);
  }, 30_000);

  it('refuses a writer, and hides the repository from a stranger', async () => {
    const writer = await approve('login', { approver: erin.id, client: { kind: 'web' } });
    expect(writer).toMatchObject({ ok: false, error: { code: 'forbidden', status: 403 } });
    expect(!writer.ok && writer.error.message).toContain('The owner and maintainers approve');
    const outsider = await approve('login', { approver: stranger.id, client: { kind: 'web' } });
    expect(outsider).toMatchObject({ ok: false, error: { code: 'not_found', status: 404 } });
  });

  it('refuses a stale revision', async () => {
    const stale = await approve('login', {
      approver: dana.id,
      revision: 'a'.repeat(40),
      client: { kind: 'web' },
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale_revision', status: 409 } });
  });

  it('approves the head for a maintainer, audits it, re-submits it, and replays a retry', async () => {
    const { head } = await waitForPhase('login', ['red']);
    const request: ApproveBeanRequest = {
      approver: dana.id,
      revision: head,
      note: 'Read the auth change; fine.',
      client: { kind: 'web' },
      idempotency_key: 'approve-login-1',
    };
    const approved = value(await approve('login', request));
    expect(approved).toMatchObject({
      bean: 'login',
      revision: head,
      approval: { by: 'ap-dana', note: 'Read the auth change; fine.', client: 'web' },
      resubmitted: true,
      replayed: false,
      hold: { state: 'approved' },
    });
    expect(value(await approve('login', request))).toMatchObject({
      replayed: true,
      resubmitted: false,
      approval: approved.approval,
    });
    const audited = await env.FORGE.prepare(
      "SELECT actor_handle, detail FROM repository_audit WHERE repo_id = ? AND action = 'bean.approve'",
    )
      .bind(repo.id)
      .all<{ actor_handle: string; detail: string }>();
    expect(audited.results).toEqual([
      {
        actor_handle: 'ap-dana',
        detail: `bean login at ${head.slice(0, 7)}; via web; note: Read the auth change; fine.`,
      },
    ]);
    const landed = await waitForPhase('login', ['landed', 'green']);
    expect(landed.hold).toMatchObject({ state: 'approved', approval: { by: 'ap-dana' } });
    expect(landed.approvals).toEqual([{ ...approved.approval, revision: head }]);
    expect(await checksAndCommits('login')).toEqual([
      { type: 'task.commit', sha: head },
      {
        type: 'preland.check',
        green: false,
        held: { classes: ['protected'], class: 'protected', by: 'policy' },
      },
      { type: 'task.commit', sha: head },
      { type: 'preland.check', green: true },
    ]);
  }, 30_000);

  it('needs a new approval for a new push', async () => {
    const first = await pushFiles(erin, { branch: 'token', files: { 'src/auth/token.ts': '1\n' } });
    await waitForPhase('token', ['red']);
    const second = await pushFiles(erin, {
      branch: 'token',
      from: first,
      files: { 'src/auth/token.ts': '2\n' },
    });
    const held = await vi.waitFor(
      async () => {
        const bean = await pushed('token');
        if (bean.hold?.revision !== second) throw new Error('the new push is not judged yet');
        return bean;
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(held.hold).toMatchObject({ state: 'held', approval: null });
    const stale = await approve('token', {
      approver: dana.id,
      revision: first,
      client: { kind: 'web' },
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale_revision' } });
  }, 30_000);
});

describe('the self-approval rule for agent sessions', () => {
  it("refuses an agent session's approval of its own person's push without the confirmation", async () => {
    await pushFiles(dana, { branch: 'session', files: { 'src/auth/session.ts': '1\n' } });
    await waitForPhase('session', ['red']);
    const refused = await approve('session', { approver: dana.id, client: CLAUDE });
    expect(refused).toMatchObject({ ok: false, error: { code: 'self_approval', status: 403 } });
    expect(!refused.ok && refused.error.message).toContain('confirm_owner_intent');
    const confirmed = value(
      await approve('session', {
        approver: dana.id,
        client: { ...CLAUDE, confirm_owner_intent: true },
      }),
    );
    expect(confirmed.approval).toMatchObject({ by: 'ap-dana', client: 'MCP (Claude Code)' });
  }, 30_000);

  it("lets an agent session approve someone else's bean for its person", async () => {
    await pushFiles(erin, { branch: 'reset', files: { 'src/auth/reset.ts': '1\n' } });
    await waitForPhase('reset', ['red']);
    const approved = value(await approve('reset', { approver: dana.id, client: CLAUDE }));
    expect(approved.approval.client).toBe('MCP (Claude Code)');
  }, 30_000);

  it('refuses a bean that is not held', async () => {
    const refused = await approve('rules', { approver: dana.id, client: { kind: 'web' } });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_state', status: 409 } });
  });
});

// Helpers ----------------------------------------------------------------------------------

function approve(bean: string, request: ApproveBeanRequest) {
  return gateway.approveBean(repo.engine_id, bean, request);
}

async function pushed(bean: string): Promise<PushedBeanStatus> {
  const found = value(await gateway.pushedBeans(repo.engine_id)).find(
    (candidate) => candidate.bean === bean,
  );
  if (found === undefined) throw new Error(`no pushed bean ${bean}`);
  return found;
}

/**
 * The bean's commits and checks as the engine logged them: the journey reads a hold from the
 * check's `held`, and an approval from the same head committed again.
 */
async function checksAndCommits(bean: string): Promise<readonly Record<string, unknown>[]> {
  const page = value(await gateway.runEvents(repo.engine_id, 0, 1000));
  return page.events
    .map((line): unknown => JSON.parse(line))
    .filter(
      (event): event is Record<string, unknown> =>
        typeof event === 'object' &&
        event !== null &&
        Reflect.get(event, 'task') === bean &&
        ['task.commit', 'preland.check'].includes(String(Reflect.get(event, 'type'))),
    )
    .map((event) =>
      event['type'] === 'task.commit'
        ? { type: event['type'], sha: event['sha'] }
        : {
            type: event['type'],
            green: event['green'],
            held: event['held'],
          },
    );
}

async function waitForPhase(bean: string, phases: readonly string[]): Promise<PushedBeanStatus> {
  return vi.waitFor(
    async () => {
      const found = await pushed(bean);
      if (!phases.includes(found.phase)) throw new Error(`${bean} is ${found.phase}`);
      return found;
    },
    { timeout: 20_000, interval: 100 },
  );
}

/** One commit carrying `files` pushed to `bean/<branch>` with the person's token; its sha. */
async function pushFiles(
  who: Person,
  input: {
    readonly branch: string;
    readonly files: Record<string, string>;
    readonly from?: string;
  },
): Promise<string> {
  const head = await sha(`${repo.id}:${input.branch}:${JSON.stringify(input.files)}`);
  const ref = `refs/heads/bean/${input.branch}`;
  const commits = {
    [head]: { message: `Change ${input.branch}`, parents: [], files: input.files },
  };
  const command = pkt(`${input.from ?? ZERO} ${head} ${ref}\0report-status side-band-64k\n`);
  const response = await call(
    'POST',
    `/git/${repo.owner.handle}/${repo.name}.git/git-receive-pack`,
    {
      token: who.token,
      body: `${command}0000PACK${JSON.stringify({ commits })}`,
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        accept: 'application/x-git-receive-pack-result',
      },
    },
  );
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  return head;
}

async function invite(who: Person, role: 'write' | 'maintain'): Promise<void> {
  const invitation = value(
    await gateway.inviteCollaborator(coop, repo.id, { handle: who.handle, role }),
  );
  value(await gateway.answerInvitation(who, invitation.id, 'accept'));
}

async function signUp(handle: string): Promise<Person> {
  const id = `u_${handle.replace(/-/g, '_')}`;
  await insertUser(env, { id, handle, email: null }, Date.now()).run();
  const pat = await createPersonalToken(env, {
    userId: id,
    request: PersonalTokenInput.parse({ name: 'laptop', scopes: ['read', 'write'], days: 7 }),
  });
  return { id, handle, token: pat.token };
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
