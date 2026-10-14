/**
 * Whether a pushed bean is held for a person's approval, or approved, as every surface shows
 * it (`PushedBeanStatus.hold`: the web's Changes list and bean page, MCP `bean_status`). A
 * bean is held when its latest route receipt is `card`, judged its current head, refused
 * nothing, and no approval names that head; an approval of the head makes it approved. A new
 * push changes the head, so it is judged again and needs a new approval.
 */
import type { RouteReceipt } from '@gitstalk/shared-race/approval-policy';
import type { BeanApproval, BeanHold } from '@gitstalk/shared-race/bean-approval';

import type { PushBean } from '../push/push-bean';
import type { Approval } from './approval-store';

/** Phases in which nothing waits for an approval any more. */
const GONE: ReadonlySet<PushBean['phase']> = new Set(['parked', 'dropped']);

export function holdOf(input: {
  readonly receipt: RouteReceipt | null;
  /** The approval of the bean's current head, if any. */
  readonly approval: Approval | null;
  readonly pushed: { readonly head: string; readonly phase: PushBean['phase'] };
}): BeanHold | null {
  const { receipt, approval, pushed } = input;
  if (receipt === null || receipt.route !== 'card' || receipt.refused !== null) return null;
  const why = {
    revision: pushed.head,
    classes: [...receipt.classes],
    class: receipt.class,
    by: receipt.by,
    probability: receipt.probability,
    reviewers: [...receipt.reviewers],
    policy: { path: receipt.policy.path, sha: receipt.policy.sha },
  };
  if (approval !== null) return { ...why, state: 'approved', approval: shownApproval(approval) };
  if (receipt.revision !== pushed.head || GONE.has(pushed.phase)) return null;
  return { ...why, state: 'held', approval: null };
}

/** An approval as surfaces show it. */
export function shownApproval(approval: Approval): BeanApproval {
  return {
    by: approval.actor,
    at: new Date(approval.atMs).toISOString(),
    note: approval.note,
    client: approval.client === '' ? 'unknown' : approval.client,
  };
}
