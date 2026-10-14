import { describe, expect, it } from 'vitest';

import type {
  AgentPrincipal,
  CollaboratorsRpc,
  RepositoryAction,
} from '@gitstalk/shared-race/collaborators';

import { repositoryAccess } from '../src/tools/repository-access';
import type { AgentSessionContext } from '../src/tools/tool-context';

/**
 * The MCP half of repository access: the session's person, scopes and client go to the
 * gateway's `agentRepositoryAccess` (the gateway's own tests hold the role × visibility
 * matrix), and its answer comes back unchanged, missing repositories included.
 */
const SESSION: AgentSessionContext = {
  userId: 'u_dana',
  handle: 'dana',
  clientName: 'Claude Code',
  agentKey: 'oauth:claude-code',
  via: 'oauth',
  scopes: ['read', 'write'],
  principal: {
    user: { id: 'u_dana', handle: 'dana' },
    scopes: ['read', 'write'],
    label: 'Claude Code',
  },
  mintGitToken: () => Promise.resolve(null),
};

type Asked = { agent: AgentPrincipal; owner: string; name: string; action: RepositoryAction };

function fakeGateway(asked: Asked[]): Pick<CollaboratorsRpc, 'agentRepositoryAccess'> {
  return {
    agentRepositoryAccess(agent, owner, name, action) {
      asked.push({ agent, owner, name, action });
      if (name === 'secret')
        return Promise.resolve({
          ok: false,
          error: {
            code: 'not_found',
            status: 404,
            message: `repository ${owner}/${name} not found`,
          },
        });
      if (action === 'write')
        return Promise.resolve({
          ok: false,
          error: { code: 'forbidden', status: 403, message: 'pushing beans needs the write role' },
        });
      return Promise.resolve({
        ok: true,
        value: {
          id: 'r1',
          owner: { id: 'u_coop', handle: owner },
          owner_kind: 'user',
          name,
          description: '',
          visibility: 'private',
          origin: { kind: 'empty' },
          artifacts_repo: 'repo-r1',
          engine_id: 'r1',
          default_branch: 'stalk',
          created_at: '2026-10-07T00:00:00.000Z',
          updated_at: '2026-10-07T00:00:00.000Z',
          archived_at: null,
          viewer_role: 'read',
        },
      });
    },
  };
}

describe('repositoryAccess', () => {
  it("asks the gateway as the session's person, with its scopes and client", async () => {
    const asked: Asked[] = [];
    const answer = await repositoryAccess(
      { gateway: fakeGateway(asked), session: SESSION },
      'coop/greeter.git',
      'read',
    );
    expect(answer).toMatchObject({ ok: true, repository: { viewer_role: 'read' } });
    expect(asked).toEqual([
      {
        agent: {
          user: { id: 'u_dana', handle: 'dana' },
          scopes: ['read', 'write'],
          label: 'Claude Code',
        },
        owner: 'coop',
        name: 'greeter',
        action: 'read',
      },
    ]);
  });

  it('passes refusals through: forbidden and missing stay apart', async () => {
    const gateway = fakeGateway([]);
    expect(await repositoryAccess({ gateway, session: SESSION }, 'coop/greeter', 'write')).toEqual({
      ok: false,
      status: 403,
      message: 'pushing beans needs the write role',
    });
    expect(
      await repositoryAccess({ gateway, session: SESSION }, 'coop/secret', 'read'),
    ).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('refuses names that are not owner/name, and an older gateway', async () => {
    expect(
      await repositoryAccess({ gateway: fakeGateway([]), session: SESSION }, 'greeter', 'read'),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await repositoryAccess({ gateway: {}, session: SESSION }, 'coop/x', 'read'),
    ).toMatchObject({ ok: false, status: 503 });
  });
});
