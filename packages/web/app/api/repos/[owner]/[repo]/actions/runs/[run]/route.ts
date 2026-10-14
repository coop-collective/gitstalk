import { env } from 'cloudflare:workers';

import { isLive, stateOf } from '../../../../../../../../src/actions/run-view';
import { getUser } from '../../../../../../../../src/auth/user';
import type { CacheRule } from '../../../../../../../../src/edge/http-cache';
import { NO_STORE, cacheControl, problem } from '../../../../../../../../src/edge/http-cache';
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

const FINISHED_RUN: CacheRule = { kind: 'fresh-for', seconds: 3600 };

/**
 * `GET …/actions/runs/:run`: the run as the run page's `RunDetail` JSON, for the page's status
 * poll. One control-plane call, behind the repository's read rule (the same 404 as its pages).
 * A running run is never kept by the browser; a finished one for an hour.
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
  // A finished run is final but for a rerun (a new attempt): the browser may keep it an hour.
  const rule = isLive(stateOf(detail.value)) ? NO_STORE : FINISHED_RUN;
  return Response.json(detail.value, { headers: { 'cache-control': cacheControl(rule) } });
}
