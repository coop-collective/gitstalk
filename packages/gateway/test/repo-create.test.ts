import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createOrg, updateOrg } from '@gitstalk/shared-identity/org-admin';
import { answerOrgInvitation, inviteToOrg } from '@gitstalk/shared-identity/org-members';
import type { OrgRepoCreation, OrgRole } from '@gitstalk/shared-identity/orgs';
import { addSshKey, setKeyMayCreate } from '@gitstalk/shared-identity/ssh-keys';
import {
  PersonalTokenInput,
  createPersonalToken,
  mintSessionToken,
} from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';
import type { AgentPrincipal } from '@gitstalk/shared-race/collaborators';
import type { RepoCreateRequest } from '@gitstalk/shared-race/repo-create';
import { MAX_CREATIONS_PER_HOUR } from '@gitstalk/shared-race/repo-create';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { beanPush, digest, gitPush, value } from './agent-helpers';
import { GIT_UA } from './git-push-helpers';
import { call, pkt } from './helpers';

/**
 * Creating repositories without the web form (docs/claude-opus/20-repositories.md §10): the
 * `repo_create` / `POST /api/repos` RPC with every answer it gives, push-to-create over HTTPS
 * and SSH with each refusal, and the first push into a repository made empty becoming its
 * stalk while every later push stays an ordinary bean.
 */
const gateway = exports.default;
const WEB = 'https://gitstalk-web.example.workers.dev';
const ZERO = '0'.repeat(40);
const T0 = Date.parse('2026-10-14T12:00:00Z');
/** Public key only (generated with ssh-keygen; the private half was discarded). */
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMkz62L72vSCz9ISUgTkieAQ0N/NpZCMKaeBn+Nx2Wns';

type Person = { readonly id: string; readonly handle: string };

describe('repo_create and POST /api/repos', () => {
  it('creates a private, empty repository in the person’s namespace and audits the client', async () => {
    const ann = await signUp('rc-ann');
    const created = value(
      await gateway.createRepositoryAs(
        principal(ann, CREATE),
        { name: 'tool-made' },
        'repo_create',
      ),
    );
    expect(created).toMatchObject({
      full_name: `${ann.handle}/tool-made`,
      clone_url: `${WEB}/${ann.handle}/tool-made.git`,
      web_url: `${WEB}/${ann.handle}/tool-made`,
      visibility: 'private',
    });
    expect(created.stalk).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof created.next).toBe('string');
    expect(created.next).toContain('bean/');
    const record = value(await gateway.getRepository(ann.handle, 'tool-made', ann.id));
    expect(record.origin).toEqual({ kind: 'empty', first_push: 'becomes-stalk' });
    const people = value(await gateway.repositoryPeople(record.id, ann.id));
    expect(people.audit).toContainEqual(
      expect.objectContaining({ action: 'repository.create', detail: 'Via: repo_create, private' }),
    );
  });

  it('takes public, a starter and a description', async () => {
    const bo = await signUp('rc-bo');
    const created = value(
      await gateway.createRepositoryAs(
        principal(bo, CREATE),
        { name: 'starter', visibility: 'public', start: 'typescript-starter', description: 'Hi' },
        'api',
      ),
    );
    expect(created.visibility).toBe('public');
    const record = value(await gateway.getRepository(bo.handle, 'starter', bo.id));
    expect(record).toMatchObject({ description: 'Hi', origin: { kind: 'template' } });
  });

  it('answers every refusal with a status, a code and a message', async () => {
    const cy = await signUp('rc-cy');
    value(await gateway.createRepositoryAs(principal(cy, CREATE), { name: 'taken' }, 'api'));
    const cases: readonly [string, AgentPrincipal, unknown, number, string][] = [
      [
        'no create scope',
        principal(cy, ['read', 'write']),
        { name: 'x1' },
        403,
        'insufficient_scope',
      ],
      ['a taken name', principal(cy, CREATE), { name: 'taken' }, 409, 'exists'],
      ['an invalid name', principal(cy, CREATE), { name: 'no spaces' }, 422, 'invalid_request'],
      [
        'internal',
        principal(cy, CREATE),
        { name: 'x2', visibility: 'internal' },
        422,
        'invalid_request',
      ],
      [
        'an unknown org',
        principal(cy, CREATE),
        { name: 'x3', owner: 'rc-no-org' },
        403,
        'forbidden',
      ],
    ];
    for (const [, who, request, status, code] of cases) {
      if (!isRequest(request)) throw new Error('not a request');
      // oxlint-disable-next-line no-await-in-loop -- one refusal after another
      const answer = await gateway.createRepositoryAs(who, request, 'api');
      expect(answer).toMatchObject({ ok: false, error: { status, code } });
      if (!answer.ok) expect(answer.error.message.length).toBeGreaterThan(0);
    }
  });

  it('follows the organization’s repository-creation setting', async () => {
    const { org, member } = await orgWith('rc-org-admins', 'admins');
    const refused = await gateway.createRepositoryAs(
      principal(member, CREATE),
      { name: 'nope', owner: org.handle },
      'repo_create',
    );
    expect(refused).toMatchObject({ ok: false, error: { status: 403, code: 'forbidden' } });

    const open = await orgWith('rc-org-members', 'members');
    const created = value(
      await gateway.createRepositoryAs(
        principal(open.member, CREATE),
        { name: 'team', owner: `@${open.org.handle}` },
        'repo_create',
      ),
    );
    expect(created.full_name).toBe(`${open.org.handle}/team`);
  });

  it(`refuses a person’s ${MAX_CREATIONS_PER_HOUR + 1}th creation within an hour`, async () => {
    const di = await signUp('rc-di');
    const now = Date.now();
    await env.FORGE.batch(
      Array.from({ length: MAX_CREATIONS_PER_HOUR }, (_, index) =>
        env.FORGE.prepare(
          'INSERT INTO repository_creations (actor_id, repo_id, via, at) VALUES (?, ?, ?, ?)',
        ).bind(di.id, `r${index}`, 'web', now - 60_000),
      ),
    );
    const limited = await gateway.createRepositoryAs(
      principal(di, CREATE),
      { name: 'more' },
      'api',
    );
    expect(limited).toMatchObject({ ok: false, error: { status: 429, code: 'rate_limited' } });
  });
});

describe('push-to-create', () => {
  it('creates a private repository from a first push of main and prints its web URL', async () => {
    const eve = await signUp('pc-eve');
    const token = await tokenFor(eve, CREATE);
    const advertised = await receivePackRefs(`${eve.handle}/pushed`, token);
    expect(advertised.status).toBe(200);
    expect(await advertised.text()).toContain('capabilities^{}');

    const head = await digest('pc-eve-main');
    const pushed = await gitPush(`${eve.handle}/pushed`, token, startPush('refs/heads/main', head));
    expect(pushed.report).toContain('ok refs/heads/main');
    expect(pushed.remote).toContain(`${WEB}/${eve.handle}/pushed`);
    expect(pushed.remote).toContain('private');
    const record = value(await gateway.getRepository(eve.handle, 'pushed', eve.id));
    expect(record).toMatchObject({ visibility: 'private', origin: { kind: 'push', ref: 'main' } });
    expect(await lineHeads(record.artifacts_repo)).toEqual({ stalk: head, sprout: head });
    const people = value(await gateway.repositoryPeople(record.id, eve.id));
    expect(people.audit).toContainEqual(
      expect.objectContaining({ action: 'repository.create', detail: 'Via: push, private' }),
    );

    // From now on pushes are ordinary: main is refused, a bean is taken.
    const again = await gitPush(
      `${eve.handle}/pushed`,
      token,
      startPush('refs/heads/main', await digest('pc-eve-2'), head),
    );
    expect(again.report).not.toContain('ok refs/heads/main');
    const bean = await gitPush(
      `${eve.handle}/pushed`,
      token,
      beanPush({ bean: 'second', newSha: await digest('pc-eve-bean') }),
    );
    expect(bean.report).toContain('ok refs/heads/bean/second');
    expect(value(await gateway.getRepository(eve.handle, 'pushed', eve.id)).id).toBe(record.id);
  });

  it('starts from a first bean push too, without opening a bean', async () => {
    const fay = await signUp('pc-fay');
    const token = await tokenFor(fay, CREATE);
    const head = await digest('pc-fay-bean');
    const pushed = await gitPush(
      `${fay.handle}/from-bean`,
      token,
      beanPush({ bean: 'start', newSha: head }),
    );
    expect(pushed.report).toContain('ok refs/heads/bean/start');
    const record = value(await gateway.getRepository(fay.handle, 'from-bean', fay.id));
    expect(record.origin).toEqual({ kind: 'push', ref: 'bean/start' });
    expect(await lineHeads(record.artifacts_repo)).toEqual({ stalk: head, sprout: head });
  });

  it('refuses without the create scope, with a hint to repo_create or /new', async () => {
    const gus = await signUp('pc-gus');
    const token = await tokenFor(gus, ['read', 'write']);
    const pushed = await gitPush(
      `${gus.handle}/no-scope`,
      token,
      startPush('refs/heads/main', await digest('pc-gus')),
    );
    expect(pushed.status).toBe(404);
    expect(pushed.report).toContain('repo_create');
    expect(pushed.report).toContain(`${WEB}/new`);
    expect((await gateway.getRepository(gus.handle, 'no-scope', gus.id)).ok).toBe(false);
  });

  it('refuses a namespace the person may not create in', async () => {
    const { org, member } = await orgWith('pc-org-admins', 'admins');
    const token = await tokenFor(member, CREATE);
    const pushed = await gitPush(
      `${org.handle}/blocked`,
      token,
      startPush('refs/heads/main', await digest('pc-blocked')),
    );
    expect(pushed.status).toBe(404);
    const other = await signUp('pc-other');
    const elsewhere = await gitPush(
      `${other.handle}/theirs`,
      token,
      startPush('refs/heads/main', await digest('pc-theirs')),
    );
    expect(elsewhere.status).toBe(404);

    const open = await orgWith('pc-org-members', 'members');
    const allowed = await gitPush(
      `${open.org.handle}/team`,
      await tokenFor(open.member, CREATE),
      startPush('refs/heads/main', await digest('pc-team')),
    );
    expect(allowed.report).toContain('ok refs/heads/main');
  });

  it('refuses a branch a repository cannot start from, and a name that is not one', async () => {
    const hal = await signUp('pc-hal');
    const token = await tokenFor(hal, CREATE);
    const feature = await gitPush(
      `${hal.handle}/feature`,
      token,
      startPush('refs/heads/feature', await digest('pc-hal')),
    );
    expect(feature.remote).toContain('main, master, stalk or bean/<name>');
    expect((await gateway.getRepository(hal.handle, 'feature', hal.id)).ok).toBe(false);
    const badName = await gitPush(
      `${hal.handle}/${'a'.repeat(70)}`,
      token,
      startPush('refs/heads/main', await digest('pc-hal-2')),
    );
    expect(badName.status).toBe(422);
  });

  it('creates nothing at a renamed-away name: the push reaches the renamed repository', async () => {
    const ida = await signUp('pc-ida');
    const token = await tokenFor(ida, CREATE);
    const record = value(
      await gateway.createRepository(ida, {
        name: 'before',
        description: '',
        visibility: 'private',
        start: { kind: 'empty' },
      }),
    );
    value(await gateway.updateRepository(ida.id, record.id, { name: 'after' }));
    const pushed = await gitPush(
      `${ida.handle}/before`,
      token,
      beanPush({ bean: 'via-old', newSha: await digest('pc-ida') }),
    );
    expect(pushed.remote).toContain(`moved to ${ida.handle}/after`);
    expect(pushed.remote).not.toContain('was created');
    expect(value(await gateway.getRepository(ida.handle, 'before', ida.id)).id).toBe(record.id);
  });

  it('creates over SSH with a key approved with create, and not with one without', async () => {
    const jo = await signUp('pc-jo');
    const added = await addSshKey(env, { userId: jo.id, publicKey: KEY, name: 'laptop', ip: null });
    if (!added.ok) throw new Error(added.reason);
    const before = await sshPush(`${jo.handle}/over-ssh`, await digest('pc-jo-1'));
    expect(before.status).toBe(404);
    const fingerprint = await keyFingerprint(jo.id);
    await setKeyMayCreate(env, { userId: jo.id, fingerprint, mayCreate: true });
    const after = await sshPush(`${jo.handle}/over-ssh`, await digest('pc-jo-2'));
    expect(after.status).toBe(200);
    expect(await after.text()).toContain('ok refs/heads/main');
    expect(value(await gateway.getRepository(jo.handle, 'over-ssh', jo.id)).origin).toEqual({
      kind: 'push',
      ref: 'main',
    });
  });
});

describe('the first push into a repository made empty', () => {
  it('becomes its stalk, keeps old credentials working, and later pushes are beans', async () => {
    const kim = await signUp('fp-kim');
    const token = await tokenFor(kim, ['read', 'write']);
    value(
      await gateway.createRepositoryAs(principal(kim, CREATE), { name: 'project' }, 'repo_create'),
    );
    const seeded = value(await gateway.getRepository(kim.handle, 'project', kim.id));
    // A git_credentials token minted before the first push is bound to the seed's engine.
    const bound = await mintSessionToken(env, {
      userId: kim.id,
      label: 'agent (MCP git)',
      scopes: ['read', 'write'],
      repository: seeded.engine_id,
    });

    const head = await digest('fp-kim-history');
    const first = await gitPush(
      `${kim.handle}/project`,
      token,
      beanPush({ bean: 'start', newSha: head }),
    );
    expect(first.report).toContain('ok refs/heads/bean/start');
    expect(first.remote).toContain('became its stalk');
    const adopted = value(await gateway.getRepository(kim.handle, 'project', kim.id));
    expect(adopted.origin).toEqual({ kind: 'push', ref: 'bean/start' });
    expect(adopted.engine_id).not.toBe(seeded.engine_id);
    expect(await lineHeads(adopted.artifacts_repo)).toEqual({ stalk: head, sprout: head });

    const later = await gitPush(
      `${kim.handle}/project`,
      bound.token,
      beanPush({ bean: 'next', newSha: await digest('fp-kim-next'), oldSha: ZERO }),
    );
    expect(later.report).toContain('ok refs/heads/bean/next');
    expect(later.remote).not.toContain('became its stalk');
    const beans = value(
      await gateway.agentPushedBeans(principal(kim, CREATE), `${kim.handle}/project`),
    );
    expect(JSON.stringify(beans)).toContain('next');
  });

  it('leaves a repository made on the web alone: its first bean is an ordinary bean', async () => {
    const lu = await signUp('fp-lu');
    const token = await tokenFor(lu, ['read', 'write']);
    value(
      await gateway.createRepository(lu, {
        name: 'web-made',
        description: '',
        visibility: 'private',
        start: { kind: 'empty' },
      }),
    );
    const pushed = await gitPush(
      `${lu.handle}/web-made`,
      token,
      beanPush({ bean: 'first', newSha: await digest('fp-lu') }),
    );
    expect(pushed.report).toContain('ok refs/heads/bean/first');
    expect(pushed.remote).not.toContain('became its stalk');
    expect(value(await gateway.getRepository(lu.handle, 'web-made', lu.id)).origin).toEqual({
      kind: 'empty',
    });
  });
});

// Helpers ----------------------------------------------------------------------------------

const CREATE = ['read', 'collaborate', 'write', 'create'] as const;
let people = 0;

async function signUp(prefix: string): Promise<Person> {
  people += 1;
  const handle = `${prefix}-${people}`;
  const id = `u_${handle.replace(/-/g, '_')}`;
  await insertUser(env, { id, handle, email: null }, Date.now()).run();
  return { id, handle };
}

function principal(who: Person, scopes: readonly string[]): AgentPrincipal {
  return { user: who, scopes, label: 'Claude Code', session: 'token' };
}

async function tokenFor(who: Person, scopes: readonly string[]): Promise<string> {
  const issued = await createPersonalToken(env, {
    userId: who.id,
    request: PersonalTokenInput.parse({ name: 'laptop', scopes, days: 7 }),
  });
  return issued.token;
}

async function orgWith(
  handle: string,
  creation: OrgRepoCreation,
): Promise<{ org: { id: string; handle: string }; member: Person }> {
  const owner = await signUp(`${handle}-own`);
  const org = orgValue(await createOrg(env, owner, { handle, name: handle }, T0));
  orgValue(await updateOrg(env, owner, org.id, { repoCreation: creation }, T0));
  const member = await signUp(`${handle}-mem`);
  await join(org.id, owner, member, 'member');
  return { org, member };
}

async function join(orgId: string, owner: Person, who: Person, role: OrgRole): Promise<void> {
  const invitation = orgValue(
    await inviteToOrg(env, { actor: owner, orgId, invite: { handle: who.handle, role } }, T0),
  );
  orgValue(
    await answerOrgInvitation(
      env,
      { user: who, invitationId: invitation.id, answer: 'accept' },
      T0,
    ),
  );
}

function orgValue<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } } | RpcResult<T>,
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** A push of one branch, as git sends it (the fake remote reads the JSON pack). */
function startPush(ref: string, newSha: string, oldSha = ZERO): string {
  const caps = 'report-status side-band-64k agent=git/2.47.0';
  const commits = { [newSha]: { message: 'Start', parents: [], files: { 'README.md': '# hi\n' } } };
  return `${pkt(`${oldSha} ${newSha} ${ref}\0${caps}\n`)}0000PACK${JSON.stringify({ commits })}`;
}

function receivePackRefs(repo: string, token: string): Promise<Response> {
  return call('GET', `/git/${repo}.git/info/refs?service=git-receive-pack`, {
    headers: { ...GIT_UA, authorization: `Basic ${btoa(`x:${token}`)}` },
  });
}

async function lineHeads(artifactsRepo: string): Promise<{ stalk: string; sprout: string }> {
  using repo = await env.REPOS.get(artifactsRepo);
  const [stalk, sprout] = await Promise.all(
    ['stalk', 'sprout'].map(async (ref) => (await repo.log({ ref, limit: 1 }))[0]?.hash ?? ''),
  );
  return { stalk: stalk ?? '', sprout: sprout ?? '' };
}

function sshPush(repo: string, newSha: string): Promise<Response> {
  const request = new Request(`http://gateway.internal/git/${repo}.git/git-receive-pack`, {
    method: 'POST',
    body: startPush('refs/heads/main', newSha),
    headers: { ...GIT_UA, 'content-type': 'application/x-git-receive-pack-request' },
  });
  return gateway.sshGit(KEY, request);
}

async function keyFingerprint(userId: string): Promise<string> {
  const row = await env.IDENTITY_DB.prepare('SELECT fingerprint FROM ssh_keys WHERE user_id = ?')
    .bind(userId)
    .first<{ fingerprint: string }>();
  if (row === null) throw new Error('no key');
  return row.fingerprint;
}

/** Lets a test send what a client might: the gateway validates every field itself. */
function isRequest(candidate: unknown): candidate is RepoCreateRequest {
  return typeof candidate === 'object' && candidate !== null;
}
