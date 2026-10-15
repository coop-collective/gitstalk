import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RepoRole, RepositoryAction } from '@gitstalk/shared-race/collaborators';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';
import { addSshKey } from '@gitstalk/shared-identity/ssh-keys';
import { PersonalTokenInput, createPersonalToken } from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

import { call, pkt, sha } from './helpers';

/**
 * Collaborators and visibility (docs/claude-opus/22-collaborators.md). The matrix: every role
 * on a private and a public repository, through every transport (HTTPS git, SSH through the
 * gateway RPC, MCP through the agent access RPC, web views and actions through the registry
 * RPC), answers allowed (200), forbidden (403), missing (404) or, for git without a
 * credential, "connect first" (401). Every answer comes from `mayUseEngine`.
 */
const gateway = exports.default;
const INTERNAL = 'http://gateway.internal';
const ZERO = '0'.repeat(40);

type Who = 'owner' | 'maintain' | 'write' | 'read' | 'outsider' | 'anonymous';
type Person = {
  readonly id: string;
  readonly handle: string;
  readonly token: string;
  readonly key: string;
};

/** Public keys only (generated for this test with ssh-keygen; the private halves were discarded). */
const KEYS = [
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHpQoeaV+aDXNOdEaBCLLBXItneC5sRxcY3cSsnXFiun',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ+QFjaDcQRVVnEpD2NWDhmfvkoCTPRvAgEatr3xNDiQ',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIINmUcZ2Fj9dtiiKFWlHoOF60iVzmbkliTF1bf4qJSND',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGd9LJJpl8AB++VcDg8hm14jx1I828au3Li8F18/V432',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINqjlav7MJBN/WN6w879TNkjCGcEWDKlqexHM0UIL5xl',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE0tMZaDfVO38BokUqB9hKZA/NWeOxf02Cz/GcSZUId2',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINSqzLao5za/R3aKP3bFNyPwrX3mmVhKPnwVDHP9NufP',
] as const;
const PEOPLE: readonly Exclude<Who, 'anonymous'>[] = [
  'owner',
  'maintain',
  'write',
  'read',
  'outsider',
];

const people = new Map<Who, Person>();
let repos: { readonly private: RepositoryRecord; readonly public: RepositoryRecord };

beforeAll(async () => {
  const signedUp = await Promise.all(
    PEOPLE.map((who, index) => signUp(`mx-${who}`, KEYS[index] ?? '')),
  );
  for (const [index, who] of PEOPLE.entries()) people.set(who, signedUp[index] ?? person(who));
  const owner = person('owner');
  repos = {
    private: await create(owner, 'matrix-private', 'private'),
    public: await create(owner, 'matrix-public', 'public'),
  };
  const roles = ['maintain', 'write', 'read'] as const;
  await Promise.all(
    Object.values(repos).flatMap((record) => roles.map((role) => join(record, person(role), role))),
  );
});

type Visibility = 'private' | 'public';
const TRANSPORTS = ['https', 'ssh', 'mcp', 'web'] as const;
type Transport = (typeof TRANSPORTS)[number];
type Status = 200 | 401 | 403 | 404;
/** owner, maintain, write, read, outsider, anonymous. */
type Row = readonly [Status, Status, Status, Status, Status, Status];

/**
 * Expected answers, by visibility and action, for each role in WHO order. Git without a
 * credential is asked to connect (401) wherever a person would be refused, so a private
 * repository is never told apart from a missing one.
 */
const EXPECTED: Readonly<Record<Visibility, Readonly<Record<RepositoryAction, Row>>>> = {
  private: {
    read: [200, 200, 200, 200, 404, 404],
    write: [200, 200, 200, 403, 404, 404],
    decide: [200, 200, 403, 403, 404, 404],
    'deploy-tokens': [200, 200, 403, 403, 404, 404],
    actions: [200, 200, 403, 403, 404, 404],
    administer: [200, 403, 403, 403, 404, 404],
  },
  public: {
    read: [200, 200, 200, 200, 200, 200],
    write: [200, 200, 200, 403, 403, 403],
    decide: [200, 200, 403, 403, 403, 403],
    'deploy-tokens': [200, 200, 403, 403, 403, 403],
    actions: [200, 200, 403, 403, 403, 403],
    administer: [200, 403, 403, 403, 403, 403],
  },
};
const WHO: readonly Who[] = ['owner', 'maintain', 'write', 'read', 'outsider', 'anonymous'];

/** Which actions each transport carries. Agents never decide or administer (people's, on the web). */
const CARRIES: Readonly<Record<Transport, readonly RepositoryAction[]>> = {
  https: ['read', 'write'],
  ssh: ['read', 'write'],
  mcp: ['read', 'write', 'decide', 'administer'],
  web: ['read', 'decide', 'deploy-tokens', 'administer'],
};

const cases = (['private', 'public'] as const).flatMap((visibility) =>
  TRANSPORTS.flatMap((transport) =>
    (CARRIES[transport] ?? []).flatMap((action) =>
      WHO.flatMap((who, index) => {
        const expected = expectedFor({ visibility, transport, action, who, index });
        return expected === null ? [] : [{ visibility, transport, action, who, expected }];
      }),
    ),
  ),
);

describe('access matrix: role × visibility × transport', () => {
  it('covers every combination a transport carries', () => {
    expect(cases).toHaveLength(128);
  });

  it.each(cases)(
    '$visibility $transport $action as $who → $expected',
    async ({ visibility, transport, action, who, expected }) => {
      const status = await attempt({ transport, action, who, record: repos[visibility] });
      expect(status).toBe(expected);
    },
  );
});

function expectedFor(input: {
  visibility: Visibility;
  transport: Transport;
  action: RepositoryAction;
  who: Who;
  index: number;
}): Status | null {
  const base = EXPECTED[input.visibility][input.action][input.index] ?? 404;
  const isAgent = input.transport !== 'web';
  if (input.who === 'anonymous') {
    // SSH and MCP have no anonymous caller; HTTPS git without a credential is told to connect.
    if (input.transport === 'ssh' || input.transport === 'mcp') return null;
    if (input.transport === 'https') return base === 200 ? 200 : 401;
    // Deploy tokens and settings need a signed-in person before the gateway is asked.
    if (input.action === 'deploy-tokens' || input.action === 'administer') return null;
  }
  // Agents (tokens, keys, sessions) never decide or administer: forbidden where people may.
  if (isAgent && (input.action === 'decide' || input.action === 'administer'))
    return base === 200 ? 403 : base;
  return base;
}

async function attempt(input: {
  transport: Transport;
  action: RepositoryAction;
  who: Who;
  record: RepositoryRecord;
}): Promise<number> {
  const { record } = input;
  const who = input.who === 'anonymous' ? null : person(input.who);
  switch (input.transport) {
    case 'https': {
      const service = input.action === 'write' ? 'git-receive-pack' : 'git-upload-pack';
      const response = await call(
        'GET',
        `/git/${record.owner.handle}/${record.name}.git/info/refs?service=${service}`,
        who === null ? {} : { token: who.token },
      );
      return response.status;
    }
    case 'ssh': {
      const service = input.action === 'write' ? 'git-receive-pack' : 'git-upload-pack';
      const request = new Request(
        `${INTERNAL}/git/${record.owner.handle}/${record.name}.git/info/refs?service=${service}`,
      );
      return (await gateway.sshGit(who?.key ?? '', request)).status;
    }
    case 'mcp': {
      if (who === null) throw new Error('MCP has no anonymous caller');
      const agent = { user: who, scopes: ['read', 'write'], label: 'Claude Code' };
      return statusOf(
        await gateway.agentRepositoryAccess(agent, record.owner.handle, record.name, input.action),
      );
    }
    case 'web':
      return web(input.action, who, record);
    default:
      return input.transport;
  }
}

/** The web's views and actions, as its pages and server actions ask the gateway. */
async function web(
  action: RepositoryAction,
  who: Person | null,
  record: RepositoryRecord,
): Promise<number> {
  const viewer = who?.id ?? null;
  switch (action) {
    case 'read':
      return statusOf(await gateway.getRepository(record.owner.handle, record.name, viewer));
    case 'write':
    case 'decide':
    case 'actions':
      return statusOf(await gateway.engineAccess(record.engine_id, viewer, action));
    case 'deploy-tokens':
      if (who === null) throw new Error('signed in only');
      return statusOf(await gateway.listDeployTokens(who, record.id));
    case 'administer':
      if (who === null) throw new Error('signed in only');
      return statusOf(
        await gateway.updateRepository(who.id, record.id, { description: `set by ${who.handle}` }),
      );
    default:
      return action;
  }
}

describe('invitations', () => {
  it('invites by handle, shows the invitation to the invitee only, and accepting grants the role', async () => {
    const owner = await signUp('inv-owner', null);
    const dana = await signUp('inv-dana', null);
    const record = await create(owner, 'inv-repo', 'private');
    const invitation = value(
      await gateway.inviteCollaborator(owner, record.id, { handle: '@INV-Dana', role: 'write' }),
    );
    expect(invitation).toMatchObject({
      invitee_handle: 'inv-dana',
      role: 'write',
      owner_handle: 'inv-owner',
      repo_name: 'inv-repo',
    });
    // Not yet a member: the repository is still missing for dana.
    expect(statusOf(await gateway.getRepository('inv-owner', 'inv-repo', dana.id))).toBe(404);
    expect(value(await gateway.myInvitations(dana.id)).map((i) => i.id)).toEqual([invitation.id]);
    expect(value(await gateway.myInvitations(owner.id))).toEqual([]);
    // Someone else cannot answer it.
    expect(statusOf(await gateway.answerInvitation(owner, invitation.id, 'accept'))).toBe(404);

    expect(value(await gateway.answerInvitation(dana, invitation.id, 'accept'))).toEqual({
      owner_handle: 'inv-owner',
      repo_name: 'inv-repo',
    });
    expect(value(await gateway.getRepository('inv-owner', 'inv-repo', dana.id))).toMatchObject({
      viewer_role: 'write',
    });
    expect(value(await gateway.sharedRepositories(dana.id)).map((r) => r.name)).toEqual([
      'inv-repo',
    ]);
    expect(value(await gateway.myInvitations(dana.id))).toEqual([]);
  });

  it('refuses unknown handles, the owner, and people who already have a role', async () => {
    const owner = await signUp('inv-owner2', null);
    const erin = await signUp('inv-erin', null);
    const record = await create(owner, 'inv-repo2', 'private');
    expect(
      await gateway.inviteCollaborator(owner, record.id, { handle: 'nobody-here', role: 'read' }),
    ).toMatchObject({ ok: false, error: { code: 'unknown_handle', status: 404 } });
    expect(
      await gateway.inviteCollaborator(owner, record.id, { handle: owner.handle, role: 'read' }),
    ).toMatchObject({ ok: false, error: { status: 400 } });
    await join(record, erin, 'read');
    expect(
      await gateway.inviteCollaborator(owner, record.id, { handle: erin.handle, role: 'write' }),
    ).toMatchObject({ ok: false, error: { code: 'already_member', status: 409 } });
    // Only the owner invites: a member is refused, an outsider does not see the repository.
    const finn = await signUp('inv-finn', null);
    expect(
      statusOf(
        await gateway.inviteCollaborator(erin, record.id, { handle: finn.handle, role: 'read' }),
      ),
    ).toBe(403);
    expect(
      statusOf(
        await gateway.inviteCollaborator(finn, record.id, { handle: finn.handle, role: 'read' }),
      ),
    ).toBe(404);
  });

  it('declines and cancels: the invitation is gone and nobody gained access', async () => {
    const owner = await signUp('inv-owner3', null);
    const gus = await signUp('inv-gus', null);
    const record = await create(owner, 'inv-repo3', 'private');
    const first = value(
      await gateway.inviteCollaborator(owner, record.id, { handle: gus.handle, role: 'read' }),
    );
    value(await gateway.answerInvitation(gus, first.id, 'decline'));
    expect(statusOf(await gateway.answerInvitation(gus, first.id, 'accept'))).toBe(404);
    const second = value(
      await gateway.inviteCollaborator(owner, record.id, { handle: gus.handle, role: 'maintain' }),
    );
    value(await gateway.cancelInvitation(owner, record.id, second.id));
    expect(value(await gateway.myInvitations(gus.id))).toEqual([]);
    expect(statusOf(await gateway.getRepository(owner.handle, record.name, gus.id))).toBe(404);
    const audit = value(await gateway.repositoryPeople(record.id, owner.id)).audit.map(
      (event) => event.action,
    );
    expect(audit).toEqual([
      'collaborator.invite_cancel',
      'collaborator.invite',
      'collaborator.decline',
      'collaborator.invite',
      // Every repository's audit begins with its creation (and the client: web here).
      'repository.create',
    ]);
  });
});

describe('roles, removal and leaving', () => {
  it('a write collaborator pushes a bean; demoted to read, the next push is refused', async () => {
    const owner = await signUp('push-owner', null);
    const hana = await signUp('push-hana', null);
    const record = await create(owner, 'push-repo', 'private');
    await join(record, hana, 'write');

    const pushed = await httpsPush(record, hana.token, 'bean/first-change', await sha('h-1'));
    expect(pushed.status).toBe(200);
    expect(await pushed.text()).toContain('new bean first-change received');

    value(await gateway.setCollaboratorRole(owner, record.id, hana.id, 'read'));
    const refused = await httpsPush(record, hana.token, 'bean/second-change', await sha('h-2'));
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('your role on this repository is read');
    // Reading still works, over HTTPS and SSH.
    expect(await httpsStatus(record, hana.token, 'git-upload-pack')).toBe(200);

    const onRepo = value(await gateway.repositoryPeople(record.id, owner.id));
    expect(onRepo.collaborators.map((c) => [c.handle, c.role])).toEqual([
      ['push-owner', 'owner'],
      ['push-hana', 'read'],
    ]);
    expect(onRepo.sessions).toContainEqual(
      expect.objectContaining({
        handle: 'push-hana',
        via: 'personal-token',
        label: 'laptop',
        pushes: 1,
      }),
    );
    expect(onRepo.audit.map((event) => [event.action, event.detail])).toContainEqual([
      'collaborator.role',
      'write → read',
    ]);
  });

  it('removing a collaborator hides a private repository from them on every transport', async () => {
    const owner = await signUp('rm-owner', null);
    const ivan = await signUp('rm-ivan', KEYS[5] ?? null);
    const record = await create(owner, 'rm-repo', 'private');
    await join(record, ivan, 'maintain');
    expect(await httpsStatus(record, ivan.token, 'git-upload-pack')).toBe(200);

    value(await gateway.removeCollaborator(owner, record.id, ivan.id));
    expect(await httpsStatus(record, ivan.token, 'git-upload-pack')).toBe(404);
    const ssh = new Request(
      `${INTERNAL}/git/rm-owner/rm-repo.git/info/refs?service=git-upload-pack`,
    );
    expect((await gateway.sshGit(ivan.key, ssh)).status).toBe(404);
    expect(statusOf(await gateway.getRepository('rm-owner', 'rm-repo', ivan.id))).toBe(404);
    const agent = { user: ivan, scopes: ['read'], label: 'Codex' };
    expect(
      statusOf(await gateway.agentRepositoryAccess(agent, 'rm-owner', 'rm-repo', 'read')),
    ).toBe(404);
  });

  it('a collaborator leaves; the owner cannot', async () => {
    const owner = await signUp('leave-owner', null);
    const jo = await signUp('leave-jo', null);
    const record = await create(owner, 'leave-repo', 'private');
    await join(record, jo, 'read');
    value(await gateway.removeCollaborator(jo, record.id, jo.id));
    expect(statusOf(await gateway.getRepository(owner.handle, record.name, jo.id))).toBe(404);
    expect(statusOf(await gateway.removeCollaborator(owner, record.id, owner.id))).toBe(400);
    const audit = value(await gateway.repositoryPeople(record.id, owner.id)).audit;
    expect(audit[0]).toMatchObject({ action: 'collaborator.leave', actor_handle: 'leave-jo' });
  });

  it('a maintainer manages deploy tokens; the token outlives their membership', async () => {
    const owner = await signUp('dt-owner', null);
    const kim = await signUp('dt-kim', null);
    const record = await create(owner, 'dt-repo', 'private');
    await join(record, kim, 'maintain');
    const made = value(
      await gateway.createDeployToken(kim, record.id, { name: 'CI', access: 'read', days: 7 }),
    );
    value(await gateway.removeCollaborator(owner, record.id, kim.id));
    expect(await httpsStatus(record, made.token, 'git-upload-pack')).toBe(200);
    expect(statusOf(await gateway.listDeployTokens(kim, record.id))).toBe(404);
    expect(value(await gateway.listDeployTokens(owner, record.id)).map((t) => t.name)).toEqual([
      'CI',
    ]);
  });
});

describe('visibility', () => {
  it('making a repository private hides it from outsiders everywhere, and is audited', async () => {
    const owner = await signUp('vis-owner', null);
    const lee = await signUp('vis-lee', KEYS[6] ?? null);
    const record = await create(owner, 'vis-repo', 'public');
    expect(await httpsStatus(record, null, 'git-upload-pack')).toBe(200);
    expect(await httpsStatus(record, lee.token, 'git-upload-pack')).toBe(200);
    expect(statusOf(await gateway.getRepository('vis-owner', 'vis-repo', null))).toBe(200);

    value(await gateway.updateRepository(owner.id, record.id, { visibility: 'private' }));
    expect(await httpsStatus(record, null, 'git-upload-pack')).toBe(401);
    expect(await httpsStatus(record, lee.token, 'git-upload-pack')).toBe(404);
    const ssh = new Request(
      `${INTERNAL}/git/vis-owner/vis-repo.git/info/refs?service=git-upload-pack`,
    );
    expect((await gateway.sshGit(lee.key, ssh)).status).toBe(404);
    expect(statusOf(await gateway.getRepository('vis-owner', 'vis-repo', null))).toBe(404);
    expect(statusOf(await gateway.getRepository('vis-owner', 'vis-repo', lee.id))).toBe(404);
    expect(statusOf(await gateway.engineAccess(record.engine_id, lee.id, 'read'))).toBe(404);
    expect(value(await gateway.listRepositories(owner.id, lee.id))).toEqual([]);
    const audit = value(await gateway.repositoryPeople(record.id, owner.id)).audit;
    expect(audit[0]).toMatchObject({ action: 'repository.visibility', detail: 'public → private' });
  });

  it('answers a race engine as "no repository" so race pages keep working', async () => {
    expect(value(await gateway.engineAccess('notarepo0001', null, 'read'))).toEqual({
      repository: null,
    });
  });
});

// Helpers ----------------------------------------------------------------------------------

function person(who: Who): Person {
  const found = people.get(who);
  if (found === undefined) throw new Error(`no ${who}`);
  return found;
}

async function signUp(handle: string, key: string | null): Promise<Person> {
  const id = `u_${handle.replace(/-/g, '_')}`;
  await insertUser(env, { id, handle, email: null }, Date.now()).run();
  const pat = await createPersonalToken(env, {
    userId: id,
    request: PersonalTokenInput.parse({ name: 'laptop', scopes: ['read', 'write'], days: 7 }),
  });
  if (key !== null) {
    const added = await addSshKey(env, { userId: id, publicKey: key, name: 'laptop', ip: null });
    if (!added.ok) throw new Error(`key refused for ${handle}`);
  }
  return { id, handle, token: pat.token, key: key ?? '' };
}

async function create(
  owner: Person,
  name: string,
  visibility: Visibility,
): Promise<RepositoryRecord> {
  return value(
    await gateway.createRepository(owner, { name, visibility, start: { kind: 'empty' } }),
  );
}

/** Invites and accepts, as the owner and the invitee do on the web. */
async function join(record: RepositoryRecord, who: Person, role: RepoRole): Promise<void> {
  const owner = { id: record.owner.id, handle: record.owner.handle };
  const invitation = value(
    await gateway.inviteCollaborator(owner, record.id, { handle: who.handle, role }),
  );
  value(await gateway.answerInvitation(who, invitation.id, 'accept'));
}

async function httpsStatus(
  record: RepositoryRecord,
  token: string | null,
  service: 'git-upload-pack' | 'git-receive-pack',
): Promise<number> {
  const path = `/git/${record.owner.handle}/${record.name}.git/info/refs?service=${service}`;
  return (await call('GET', path, token === null ? {} : { token })).status;
}

function httpsPush(
  record: RepositoryRecord,
  token: string,
  branch: string,
  newSha: string,
): Promise<Response> {
  const commits = { [newSha]: { message: 'A change', parents: [], files: {} } };
  const body = `${pkt(`${ZERO} ${newSha} refs/heads/${branch}\0report-status side-band-64k\n`)}0000PACK${JSON.stringify({ commits })}`;
  return call('POST', `/git/${record.owner.handle}/${record.name}.git/git-receive-pack`, {
    token,
    body,
    headers: {
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
  });
}

function statusOf(result: RpcResult<unknown>): number {
  return result.ok ? 200 : result.error.status;
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
