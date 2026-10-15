import { env } from 'cloudflare:workers';

import { verifyUserToken } from '@gitstalk/shared-identity/user-tokens';

import { log } from '../../../src/log';
import type { BearerIdentity } from '../../../src/repositories/create-api';
import { createRepoResponse } from '../../../src/repositories/create-api';

/**
 * Creates a repository for a script or a tool: `Authorization: Bearer <personal token with
 * create>` and JSON `{ name, owner?, visibility?, start?, description? }`. Not a browser form:
 * no session cookie is read, so there is nothing for a cross-site request to borrow.
 */
export async function POST(request: Request): Promise<Response> {
  const response = await createRepoResponse(request, { verify, gateway: env.GATEWAY });
  log.info('repository create api', { status: response.status });
  return response;
}

async function verify(token: string): Promise<BearerIdentity | null> {
  const verified = await verifyUserToken(env, token);
  if (verified === null) return null;
  return {
    user: { id: verified.user.id, handle: verified.user.handle },
    scopes: verified.scopes,
    isBound: verified.token.repository !== null,
  };
}
