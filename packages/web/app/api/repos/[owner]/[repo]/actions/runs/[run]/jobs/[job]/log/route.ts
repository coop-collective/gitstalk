import { env } from 'cloudflare:workers';

import { jobLogResponse } from '../../../../../../../../../../../src/actions/log-stream';
import { getUser } from '../../../../../../../../../../../src/auth/user';
import { lookupRepository } from '../../../../../../../../../../../src/repositories/flows';
import { registryClient } from '../../../../../../../../../../../src/repositories/registry-client';
import { actionsSessionFor } from '../../../../../../../../../../../src/server/actions-source';

type Context = {
  readonly params: Promise<{
    readonly owner: string;
    readonly repo: string;
    readonly run: string;
    readonly job: string;
  }>;
};

/**
 * `GET …/actions/runs/:run/jobs/:job/log?after=<n>`: a job's log lines after line `n` as
 * Server-Sent Events (`lines`, `job` with the steps' states, `end` when the job is done, `failed`),
 * resuming from `Last-Event-ID` on reconnect. `?download=1` answers the whole log as plain
 * text instead. Behind the repository's read rule: the same 404 as its pages for anyone else.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { owner, repo, run, job } = await context.params;
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
  return jobLogResponse(request, session.client, {
    run: decodeURIComponent(run),
    job: decodeURIComponent(job),
    visibility: found.record.visibility,
  });
}

function problem(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}
