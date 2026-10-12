import { env } from 'cloudflare:workers';

import { getUser } from '../../../../../../../../src/auth/user';
import { lookupRepository } from '../../../../../../../../src/repositories/flows';
import { registryClient } from '../../../../../../../../src/repositories/registry-client';
import { actionsSessionFor } from '../../../../../../../../src/server/actions-source';

type Context = {
  readonly params: Promise<{
    readonly owner: string;
    readonly repo: string;
    readonly run: string;
  }>;
};

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * `GET …/actions/runs/:run`: the run as the run page's `RunDetail` JSON, for the page's status
 * poll. One control-plane call, behind the repository's read rule (the same 404 as its pages).
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { owner, repo, run } = await context.params;
  const user = await getUser(request);
  const found = await lookupRepository(
    decodeURIComponent(owner),
    decodeURIComponent(repo),
    user,
    registryClient(env.GATEWAY),
  );
  if (found.kind === 'not-found') return problem(404, 'no such repository');
  const actor = user === null ? null : { id: user.id, handle: user.handle };
  const session = actionsSessionFor(request, { actor, repoId: found.record.id });
  if (session === null) return problem(503, 'Actions are not running on this deployment');
  const detail = await session.client.run(decodeURIComponent(run));
  if (!detail.ok) return problem(404, 'no such run');
  return Response.json(detail.value, { headers: NO_STORE });
}

function problem(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status, headers: NO_STORE });
}
