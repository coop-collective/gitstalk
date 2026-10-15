/**
 * `POST /api/repos` (`docs/claude-opus/20-repositories.md` §10): creates a repository for a
 * script (the setup script's `create`) with a person's token that has the `create` scope. The
 * gateway decides through the one creation path the web form and `repo_create` use; this
 * module turns its answer into HTTP: 201 with `{ full_name, clone_url, web_url, stalk,
 * visibility, next }`, or `{ error: { code, message } }` with 401, 403, 409, 422 or 429.
 */
import type { Scope } from '@gitstalk/shared-identity/scopes';
import type { AgentPrincipal } from '@gitstalk/shared-race/collaborators';
import type { RepoCreateRequest, RepoCreateRpc } from '@gitstalk/shared-race/repo-create';

import { problem } from '../auth/http';

/** Who a bearer token is, as the identity database verifies it; null when it is not valid. */
export type BearerIdentity = {
  readonly user: { readonly id: string; readonly handle: string };
  readonly scopes: readonly Scope[];
  /** A session token bound to one repository (or one address) never creates through the API. */
  readonly isBound: boolean;
};

export type CreateApiDeps = {
  verify(token: string): Promise<BearerIdentity | null>;
  /** The GATEWAY binding; a gateway without `createRepositoryAs` answers 503. */
  readonly gateway: object;
};

const MAX_BODY_BYTES = 4096;
const BEARER = /^Bearer\s+(\S+)$/i;

export async function createRepoResponse(request: Request, deps: CreateApiDeps): Promise<Response> {
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
  const identity = token === undefined ? null : await deps.verify(token);
  if (identity === null || identity.isBound) return unauthorized();
  const body = await jsonBody(request);
  if (body === null) return problem(400, 'invalid_request', 'send a JSON object: {"name": "..."}');
  const rpc = repoCreateRpc(deps.gateway);
  if (rpc === null)
    return problem(503, 'unavailable', 'this deployment cannot create repositories yet');
  const principal: AgentPrincipal = {
    user: identity.user,
    scopes: identity.scopes,
    label: 'API',
    session: 'token',
  };
  const created = await rpc.createRepositoryAs(principal, body, 'api');
  if (!created.ok) return problem(created.error.status, created.error.code, created.error.message);
  return Response.json(created.value, { status: 201, headers: { 'cache-control': 'no-store' } });
}

function unauthorized(): Response {
  const response = problem(
    401,
    'unauthorized',
    'send Authorization: Bearer <a personal token with the create scope> (Settings, Tokens)',
  );
  response.headers.set('www-authenticate', 'Bearer realm="gitstalk"');
  return response;
}

/** The request's JSON object, or null when it is not one (or too large). */
async function jsonBody(request: Request): Promise<RepoCreateRequest | null> {
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRequestShaped(value) ? value : null;
  } catch {
    return null;
  }
}

/** An object with a string name; the gateway validates the rest (422 with the rule broken). */
function isRequestShaped(value: unknown): value is RepoCreateRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, 'name') === 'string'
  );
}

function repoCreateRpc(binding: object): RepoCreateRpc | null {
  return isRepoCreateRpc(binding) ? binding : null;
}

function isRepoCreateRpc(binding: object): binding is RepoCreateRpc {
  return typeof Reflect.get(binding, 'createRepositoryAs') === 'function';
}
