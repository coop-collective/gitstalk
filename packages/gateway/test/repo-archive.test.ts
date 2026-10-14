import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';
import { PersonalTokenInput, createPersonalToken } from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

import { call, pkt, sha } from './helpers';

/**
 * Archive (backlog 2.2, docs/claude-opus/20-repositories.md §7): the owner archives a
 * repository; it stays readable and clonable, leaves the default lists, and refuses pushes,
 * decisions and deploy tokens with a reason that says how to undo it. All of it through the
 * one access rule (`mayUseEngine`).
 */
const gateway = exports.default;
const ZERO = '0'.repeat(40);

type Person = { readonly id: string; readonly handle: string; readonly token: string };

let owner: Person;
let maintainer: Person;
let repo: RepositoryRecord;

beforeAll(async () => {
  owner = await signUp('ar-owner');
  maintainer = await signUp('ar-maint');
  repo = value(
    await gateway.createRepository(owner, {
      name: 'shelf',
      visibility: 'public',
      start: { kind: 'empty' },
    }),
  );
  const invitation = value(
    await gateway.inviteCollaborator(owner, repo.id, {
      handle: maintainer.handle,
      role: 'maintain',
    }),
  );
  value(await gateway.answerInvitation(maintainer, invitation.id, 'accept'));
});

describe('archiving a repository', () => {
  it('is the owner’s alone', async () => {
    expect(await gateway.archiveRepository(maintainer.id, repo.id, 'archived')).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(await gateway.archiveRepository('u_nobody', repo.id, 'archived')).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
  });

  it('makes it read-only, out of the default list, with a reason for every refusal', async () => {
    const archived = value(await gateway.archiveRepository(owner.id, repo.id, 'archived'));
    expect(archived.archived_at).not.toBeNull();

    expect(value(await gateway.listRepositories(owner.id, owner.id))).toEqual([]);
    expect(value(await gateway.listRepositories(owner.id, owner.id, 'archived'))).toEqual([
      expect.objectContaining({ id: repo.id }),
    ]);
    expect(value(await gateway.getRepository(owner.handle, 'shelf', null)).archived_at).toBe(
      archived.archived_at,
    );

    // Clone and fetch still work, for the owner and anyone (it is public).
    expect((await infoRefs(owner.token, 'git-upload-pack')).status).toBe(200);
    expect((await infoRefs(null, 'git-upload-pack')).status).toBe(200);

    const refusal = await infoRefs(maintainer.token, 'git-receive-pack');
    expect(refusal.status).toBe(403);
    expect(await refusal.text()).toBe(
      'ar-owner/shelf is archived, so it is read-only: pushes are refused. Its owner can unarchive it in Settings.\n',
    );
    const pushed = await push(owner.token, 'bean/late', await sha('ar-late'));
    expect(pushed.status).toBe(403);

    expect(
      await gateway.createDeployToken(maintainer, repo.id, {
        name: 'ci',
        access: 'read',
        days: 30,
      }),
    ).toMatchObject({ ok: false, error: { code: 'archived', status: 403 } });
    expect(await gateway.engineAccess(repo.engine_id, maintainer.id, 'decide')).toMatchObject({
      ok: false,
      error: { code: 'archived' },
    });
    expect(
      await gateway.updateRepository(owner.id, repo.id, { description: 'changed' }),
    ).toMatchObject({ ok: false, error: { code: 'archived' } });

    // MCP: the repository tools and `whoami` with a repo ask the same rule, with the same reason.
    const agent = {
      user: { id: maintainer.id, handle: maintainer.handle },
      scopes: ['read', 'write'],
      label: 'Claude Code',
    };
    const slug = `${owner.handle}/shelf`;
    const archivedRefusal = {
      ok: false,
      error: {
        code: 'archived',
        status: 403,
        message:
          'ar-owner/shelf is archived, so it is read-only: pushes are refused. Its owner can unarchive it in Settings.',
      },
    };
    expect(await gateway.agentRepositoryAccess(agent, owner.handle, 'shelf', 'write')).toEqual(
      archivedRefusal,
    );
    expect(
      await gateway.agentOpenBean(agent, slug, { bean: 'late', intent: 'A late change' }),
    ).toEqual(archivedRefusal);
    expect(value(await gateway.agentRepository(agent, slug))).toMatchObject({
      access: 'read',
      role: 'maintain',
    });
    expect(
      value(await gateway.agentRepositoryAccess(agent, owner.handle, 'shelf', 'read')),
    ).toMatchObject({ id: repo.id, viewer_role: 'maintain' });

    const activity = value(await gateway.repositoryActivity(owner.id, 5));
    expect(activity[0]).toMatchObject({ kind: 'archived', repo_name: 'shelf' });
  });

  it('takes pushes again once unarchived', async () => {
    const back = value(await gateway.archiveRepository(owner.id, repo.id, 'active'));
    expect(back.archived_at).toBeNull();
    expect(value(await gateway.listRepositories(owner.id, owner.id))).toHaveLength(1);
    expect((await infoRefs(maintainer.token, 'git-receive-pack')).status).toBe(200);
    const pushed = await push(owner.token, 'bean/back', await sha('ar-back'));
    expect(pushed.status).toBe(200);
    expect(value(await gateway.repositoryActivity(owner.id, 1))[0]?.kind).toBe('unarchived');
  });

  it('refuses an archive state it does not know', async () => {
    const odd = await Reflect.apply(gateway.archiveRepository, gateway, [
      owner.id,
      repo.id,
      'gone',
    ]);
    expect(odd).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

// Helpers ----------------------------------------------------------------------------------

async function signUp(handle: string): Promise<Person> {
  const id = `u_${handle.replace(/-/g, '_')}`;
  await insertUser(env, { id, handle, email: null }, Date.now()).run();
  const pat = await createPersonalToken(env, {
    userId: id,
    request: PersonalTokenInput.parse({ name: 'laptop', scopes: ['read', 'write'], days: 7 }),
  });
  return { id, handle, token: pat.token };
}

function infoRefs(
  token: string | null,
  service: 'git-upload-pack' | 'git-receive-pack',
): Promise<Response> {
  const path = `/git/${repo.owner.handle}/${repo.name}.git/info/refs?service=${service}`;
  return call('GET', path, token === null ? {} : { token });
}

function push(token: string, branch: string, newSha: string): Promise<Response> {
  const commits = { [newSha]: { message: 'A change', parents: [], files: {} } };
  const body = `${pkt(`${ZERO} ${newSha} refs/heads/${branch}\0report-status side-band-64k\n`)}0000PACK${JSON.stringify({ commits })}`;
  return call('POST', `/git/${repo.owner.handle}/${repo.name}.git/git-receive-pack`, {
    token,
    body,
    headers: {
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
  });
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
