/**
 * The web's side of approving a held bean (`docs/claude-opus/32-approval-rules.md` §5): the
 * gateway's `approveBean` on the GATEWAY binding, the same RPC MCP `bean_approve` calls, its
 * answer validated before the app trusts it; and who may press Approve on a bean's page. A
 * gateway without the method reads as "approvals are not available here". Server-only.
 */
import { z } from 'zod';

import type { ApproveBeanRequest } from '@gitstalk/shared-race/bean-approval';
import { BeanApproval, BeanHold } from '@gitstalk/shared-race/bean-approval';

import type { RepositoryRecord, ViewerRole } from '../repositories/registry-client';

const ApprovedBean = z.object({
  bean: z.string(),
  revision: z.string(),
  approval: BeanApproval,
  resubmitted: z.boolean(),
  replayed: z.boolean(),
  hold: BeanHold,
});
export type ApprovedBean = z.infer<typeof ApprovedBean>;

const Answer = z.union([
  z.object({ ok: z.literal(true), value: ApprovedBean }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type ApprovalOutcome =
  | { readonly ok: true; readonly value: ApprovedBean }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Approves `bean` of the engine `engineId` as the request says. */
export async function approveBeanOn(
  binding: object,
  input: { readonly engineId: string; readonly bean: string; readonly request: ApproveBeanRequest },
): Promise<ApprovalOutcome> {
  const method: unknown = Reflect.get(binding, 'approveBean');
  if (typeof method !== 'function')
    return {
      ok: false,
      code: 'unavailable',
      message: 'Approvals are not running on this deployment.',
    };
  const raw: unknown = await Reflect.apply(method, binding, [
    input.engineId,
    input.bean,
    input.request,
  ]);
  const answer = Answer.safeParse(raw);
  if (!answer.success)
    return {
      ok: false,
      code: 'bad_response',
      message: 'The gateway answered in an unexpected shape.',
    };
  return answer.data.ok
    ? { ok: true, value: answer.data.value }
    : { ok: false, code: answer.data.error.code, message: answer.data.error.message };
}

/** Whether the viewer may press Approve, or why not, as the bean's page says it. */
export type ApproveAccess =
  | {
      readonly kind: 'allowed';
      readonly csrf: string;
      readonly owner: string;
      readonly name: string;
    }
  | { readonly kind: 'read-only'; readonly reason: string };

const DECIDING: ReadonlySet<ViewerRole> = new Set(['owner', 'maintain']);

/**
 * The owner and maintainers approve (the gateway decides again on every press); everyone else
 * reads who can. An archived repository approves nothing.
 */
export function approveAccessOf(input: {
  readonly record: RepositoryRecord;
  readonly role: ViewerRole | null;
  readonly csrf: string | null;
}): ApproveAccess {
  const { record, role, csrf } = input;
  if (record.archived_at !== null)
    return { kind: 'read-only', reason: 'This repository is archived, so nothing is approved.' };
  if (csrf === null)
    return {
      kind: 'read-only',
      reason: 'The owner and maintainers approve it. Sign in if you are one.',
    };
  if (role === null || !DECIDING.has(role))
    return {
      kind: 'read-only',
      reason: `The owner and maintainers approve it; you have ${role === null ? 'no role here' : `the ${role} role`}.`,
    };
  return { kind: 'allowed', csrf, owner: record.owner.handle, name: record.name };
}
