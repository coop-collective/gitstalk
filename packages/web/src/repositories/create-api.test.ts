import { describe, expect, it } from 'vitest';

import type { AgentPrincipal } from '@gitstalk/shared-race/collaborators';
import type { RepoCreateRequest } from '@gitstalk/shared-race/repo-create';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import type { BearerIdentity, CreateApiDeps } from './create-api';
import { createRepoResponse } from './create-api';

/**
 * `POST /api/repos` as HTTP: the bearer, the body and every status the gateway's creation path
 * answers (the gateway's own tests run that path on real bindings).
 */
const CREATED = {
  full_name: 'ann/tool',
  clone_url: 'https://web.test/ann/tool.git',
  web_url: 'https://web.test/ann/tool',
  stalk: 'a'.repeat(40),
  visibility: 'private',
  next: 'git remote add origin https://web.test/ann/tool.git, then push a bean',
} as const;
const ANN: BearerIdentity = {
  user: { id: 'u1', handle: 'ann' },
  scopes: ['read', 'write', 'create'],
  isBound: false,
};

describe('POST /api/repos', () => {
  it('creates with a token that has create and answers 201 with the tool’s JSON', async () => {
    const calls: [AgentPrincipal, RepoCreateRequest, string][] = [];
    const response = await createRepoResponse(
      post({ name: 'tool' }),
      deps(ANN, async (principal, request, via) => {
        calls.push([principal, request, via]);
        return { ok: true, value: CREATED };
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(CREATED);
    expect(calls).toEqual([
      [expect.objectContaining({ user: ANN.user, scopes: ANN.scopes }), { name: 'tool' }, 'api'],
    ]);
  });

  it.each([
    [403, 'insufficient_scope'],
    [403, 'forbidden'],
    [409, 'exists'],
    [422, 'invalid_request'],
    [429, 'rate_limited'],
  ])('answers %i %s with a message', async (status, code) => {
    const response = await createRepoResponse(
      post({ name: 'tool' }),
      deps(ANN, async () => ({ ok: false, error: { code, status, message: `why ${code}` } })),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: `why ${code}` } });
  });

  it('answers 401 without a valid bearer, or with a token bound to one repository', async () => {
    const cases = [
      [post({ name: 'x' }, null), ANN],
      [post({ name: 'x' }), null],
      [post({ name: 'x' }), { ...ANN, isBound: true }],
    ] as const;
    const responses = await Promise.all(
      cases.map(([request, identity]) => createRepoResponse(request, deps(identity, never))),
    );
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
    }
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const body of bodies)
      expect(body).toMatchObject({ error: { message: expect.any(String) } });
  });

  it('answers 400 for a body that is not a JSON object with a name', async () => {
    const response = await createRepoResponse(
      new Request('https://web.test/api/repos', {
        method: 'POST',
        headers: { authorization: 'Bearer bsu_x' },
        body: 'name=tool',
      }),
      deps(ANN, async () => ({ ok: true, value: CREATED })),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: expect.any(String) } });
  });
});

async function never(): Promise<RpcResult<typeof CREATED>> {
  throw new Error('not called');
}

function post(body: unknown, token: string | null = 'bsu_token'): Request {
  return new Request('https://web.test/api/repos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

function deps(
  identity: BearerIdentity | null,
  createRepositoryAs: (
    principal: AgentPrincipal,
    request: RepoCreateRequest,
    via: string,
  ) => Promise<RpcResult<typeof CREATED>>,
): CreateApiDeps {
  return { verify: async () => identity, gateway: { createRepositoryAs } };
}
