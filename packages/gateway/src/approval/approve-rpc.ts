/**
 * `approveBean`, the one path a held bean is approved by (doc 32 §5): the web's Approve button
 * and MCP `bean_approve` both call it. Here the request is validated, the engine's repository
 * found and the approver checked (`decide`: the owner and maintainers, as `mayUseEngine`
 * decides for git, MCP and the web); the engine checks the revision, the hold and the
 * self-approval rule and saves the approval (`approve-bean.ts`); each new approval is written
 * to the repository's access log with the approver, the client, the revision and the note.
 */
import type { ApprovedBean } from '@gitstalk/shared-race/bean-approval';
import { ApproveBeanRequest, approvalClientName } from '@gitstalk/shared-race/bean-approval';
import type { RunId } from '@gitstalk/shared-race/ids';
import { TaskId } from '@gitstalk/shared-race/ids';
import type { RepositoryForViewer } from '@gitstalk/shared-race/collaborators';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';
import { z } from 'zod';

import type { Deps } from '../deps';
import { accessResult, viewerPrincipal } from '../repos/access';

/** Characters of the note the access log keeps. */
const AUDITED_NOTE = 200;

export async function approveBeanRpc(
  env: Env,
  deps: Deps,
  input: { readonly run: RunId; readonly bean: unknown; readonly request: unknown },
): Promise<RpcResult<ApprovedBean>> {
  const bean = TaskId.safeParse(input.bean);
  const request = ApproveBeanRequest.safeParse(input.request);
  if (!bean.success) return invalid('name a bean (its name, like add-total)');
  if (!request.success) return invalid(z.prettifyError(request.error));
  const { approver, client } = request.data;
  const record = await deps.registry.byEngine(input.run);
  if (record === null)
    return failed({
      code: 'not_found',
      status: 404,
      message: 'approvals are for a repository’s beans; no repository has this engine',
    });
  const allowed = await accessResult(deps.collaborators, record, {
    principal: viewerPrincipal(approver),
    action: 'decide',
    what: input.run,
  });
  if (!allowed.ok) return mayNotApprove(allowed.error);
  const handle = await handleOf(env, approver);
  if (handle === null) return failed({ code: 'forbidden', status: 403, message: 'no such person' });
  const answer = await deps.run(input.run).approveBean(bean.data, {
    actor: handle,
    revision: request.data.revision ?? null,
    note: request.data.note === undefined || request.data.note === '' ? null : request.data.note,
    client,
    idempotencyKey: request.data.idempotency_key ?? null,
    nowMs: deps.now(),
  });
  if (!answer.ok) return { ok: false, error: { ...answer.error } };
  if (!answer.value.replayed)
    await audit(deps, allowed.value, { id: approver, handle }, answer.value);
  deps.log.info('bean approval', {
    engine: input.run,
    bean: bean.data,
    approver: handle,
    client: approvalClientName(client),
    revision: answer.value.revision,
    replayed: answer.value.replayed,
    resubmitted: answer.value.resubmitted,
  });
  return { ok: true, value: answer.value };
}

/** Records a new approval in the repository's access log (the owner reads it in People). */
async function audit(
  deps: Deps,
  repo: RepositoryForViewer,
  actor: { readonly id: string; readonly handle: string },
  approved: ApprovedBean,
): Promise<void> {
  const note = approved.approval.note;
  const detail = [
    `bean ${approved.bean} at ${approved.revision.slice(0, 7)}`,
    `via ${approved.approval.client}`,
    ...(note === null ? [] : [`note: ${note.slice(0, AUDITED_NOTE)}`]),
  ].join('; ');
  await deps.collaborators
    .auditStatement({ repoId: repo.id, actor, action: 'bean.approve', detail })
    .run();
}

/** The person's handle, or null when no account has this id. */
async function handleOf(env: Env, id: string): Promise<string | null> {
  const row = await env.IDENTITY_DB.prepare('SELECT handle FROM users WHERE id = ?')
    .bind(id)
    .first<{ handle: string }>();
  return row?.handle ?? null;
}

/** A refusal by role says who may approve; not-found stays not-found. */
function mayNotApprove(error: RpcError): RpcResult<never> {
  if (error.code !== 'forbidden') return failed(error);
  return failed({
    ...error,
    message: `${error.message.replace('answering decisions', 'approving a held bean')}. The owner and maintainers approve.`,
  });
}

function failed(error: RpcError): RpcResult<never> {
  return { ok: false, error };
}

function invalid(message: string): RpcResult<never> {
  return failed({ code: 'invalid_request', status: 400, message });
}
