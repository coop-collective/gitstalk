/**
 * A person's approval of a held bean, inside its engine (`RunDO.approveBean`): the checks in
 * order, then the approval saved for the bean's current revision. Who may approve (owners and
 * maintainers) is decided before, by the RPC (`rpc/gateway-rpc.ts`); re-submitting the bean is
 * the engine's. Expected refusals are values.
 *
 * 1. An idempotency key used before for this bean replays the first approval.
 * 2. A named revision that is not the bean's head is stale: a new push needs a new approval.
 * 3. The bean must be held (`bean-hold.ts`); one already approved for its head replays.
 * 4. An agent session may not approve what it may have pushed itself (`self-approval.ts`).
 */
import type { ApprovalClient, BeanHold } from '@gitstalk/shared-race/bean-approval';
import { approvalClientName } from '@gitstalk/shared-race/bean-approval';

import type { PushBean } from '../push/push-bean';
import type { Approval } from './approval-store';
import { readApproval, readApprovalByKey, readRoute, saveApproval } from './approval-store';
import { holdOf, shownApproval } from './bean-hold';
import { selfApprovalRefusal } from './self-approval';

export type EngineApproval = {
  /** The approver's handle (the RPC checked they may decide). */
  readonly actor: string;
  readonly revision: string | null;
  readonly note: string | null;
  readonly client: ApprovalClient;
  readonly idempotencyKey: string | null;
  readonly nowMs: number;
};

export type ApprovalOutcome =
  | {
      readonly kind: 'approved';
      readonly revision: string;
      readonly approval: Approval;
      readonly replayed: boolean;
      readonly hold: BeanHold;
    }
  | {
      readonly kind: 'refused';
      readonly code: 'not_found' | 'stale_revision' | 'invalid_state' | 'self_approval';
      readonly status: 403 | 404 | 409;
      readonly message: string;
    };

export function approveHeldBean(
  sql: SqlStorage,
  input: { readonly pushed: PushBean | null; readonly request: EngineApproval },
): ApprovalOutcome {
  const { pushed, request } = input;
  if (pushed === null)
    return refused('not_found', 404, 'no pushed bean by that name in this repository');
  const replay =
    request.idempotencyKey === null ? null : replayOf(sql, pushed, request.idempotencyKey);
  if (replay !== null) return replay;
  const { head } = pushed;
  if (request.revision !== null && request.revision !== head)
    return refused(
      'stale_revision',
      409,
      `${pushed.bean} is at ${head.slice(0, 7)} now, not ${request.revision.slice(0, 7)}: a new push needs a new approval. Read it again and approve ${head.slice(0, 7)} if it should land.`,
    );
  const receipt = readRoute(sql, pushed.bean)?.receipt ?? null;
  const existing = readApproval(sql, pushed.bean, head);
  const hold = holdOf({ receipt, approval: existing, pushed });
  if (hold === null) return refused('invalid_state', 409, notHeld(pushed, receipt?.revision));
  if (existing !== null)
    return { kind: 'approved', revision: head, approval: existing, replayed: true, hold };
  const self = selfApprovalRefusal({
    bean: pushed.bean,
    client: request.client,
    approver: request.actor,
    pushed: { actor: pushed.actor, pusher: pushed.protectedAccess.pusher },
  });
  if (self !== null) return refused('self_approval', 403, self);
  const approval: Approval = {
    actor: request.actor,
    atMs: request.nowMs,
    note: request.note,
    client: approvalClientName(request.client),
    idempotencyKey: request.idempotencyKey,
  };
  saveApproval(sql, { bean: pushed.bean, revision: head, approval });
  return {
    kind: 'approved',
    revision: head,
    approval,
    replayed: false,
    hold: { ...hold, state: 'approved', approval: shownApproval(approval) },
  };
}

function replayOf(sql: SqlStorage, pushed: PushBean, key: string): ApprovalOutcome | null {
  const first = readApprovalByKey(sql, pushed.bean, key);
  if (first === null) return null;
  const receipt = readRoute(sql, pushed.bean)?.receipt ?? null;
  const hold = holdOf({
    receipt,
    approval: first.approval,
    pushed: { ...pushed, head: first.revision },
  });
  if (hold === null) return null;
  return {
    kind: 'approved',
    revision: first.revision,
    approval: first.approval,
    replayed: true,
    hold,
  };
}

function notHeld(pushed: PushBean, judged: string | null | undefined): string {
  if (judged !== undefined && judged !== null && judged !== pushed.head)
    return `${pushed.bean}'s latest push (${pushed.head.slice(0, 7)}) is still being checked; approve it once it is held`;
  return `${pushed.bean} is not held for an approval (${pushed.phase}: ${pushed.reason})`;
}

function refused(
  code: Extract<ApprovalOutcome, { kind: 'refused' }>['code'],
  status: Extract<ApprovalOutcome, { kind: 'refused' }>['status'],
  message: string,
): ApprovalOutcome {
  return { kind: 'refused', code, status, message };
}
