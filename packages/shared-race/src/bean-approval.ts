/**
 * Approving a bean the approval rules hold (`docs/claude-opus/32-approval-rules.md` §5): the
 * hold as every surface shows it (the web's bean page and Changes list, MCP `bean_status`), the
 * request the one RPC takes (`approveBean`, from the web's Approve button and MCP
 * `bean_approve` alike) and its answer. Schemas here; the rules live in the gateway's
 * `approval/`.
 */
import { z } from 'zod';

import { IdempotencyKey } from './bean-commit';

/** Characters of an approval's note. */
export const MAX_APPROVAL_NOTE = 500;

/** A person's approval of one bean revision, as it is shown and audited. */
export const BeanApproval = z.object({
  /** The approver's handle. */
  by: z.string(),
  /** ISO 8601. */
  at: z.string(),
  note: z.string().nullable(),
  /** Where it was given: `web`, or `MCP (<client name>)`. */
  client: z.string(),
});
export type BeanApproval = z.infer<typeof BeanApproval>;

/**
 * A bean whose route is `card`: `held` until a person approves its current revision (its
 * pushed head), then `approved` for that revision. A new push is judged again and needs a new
 * approval. Why it was held is the route receipt's: its classes, the deciding class, who
 * decided (the policy, Clef or the rules when Clef did not answer), Clef's probability, the
 * named reviewers (shown, not enforced) and the policy file it was judged by.
 */
export const BeanHold = z.object({
  state: z.enum(['held', 'approved']),
  revision: z.string(),
  classes: z.array(z.string()),
  class: z.string().nullable(),
  by: z.enum(['policy', 'clef', 'rules']),
  probability: z.number().nullable(),
  reviewers: z.array(z.string()),
  policy: z.object({ path: z.string().nullable(), sha: z.string().nullable() }),
  approval: BeanApproval.nullable(),
});
export type BeanHold = z.infer<typeof BeanHold>;

/** Where an approval comes from: the web app, or an agent session over MCP. */
export const ApprovalClient = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('web') }),
  z.strictObject({
    kind: z.literal('mcp'),
    /** The client the person approved ("Claude Code"). */
    name: z.string().trim().min(1).max(80),
    /** The session as the self-approval check compares it (`AgentPrincipal.session`). */
    session: z.string().min(1).max(300),
    /**
     * The person told the agent to approve a bean this same session may have pushed. Without
     * it the gateway refuses such an approval (doc 32 §5.2).
     */
    confirm_owner_intent: z.boolean().optional(),
  }),
]);
export type ApprovalClient = z.infer<typeof ApprovalClient>;

/** What `approveBean` takes besides the engine and the bean. */
export const ApproveBeanRequest = z.strictObject({
  /** The approving person's account id: the web session's user, or the MCP session's. */
  approver: z.string().min(1).max(64),
  /** The revision approved; the bean's current pushed head when absent. A stale one is refused. */
  revision: z
    .string()
    .regex(/^[0-9a-f]{40}$/u, 'a full commit sha')
    .optional(),
  note: z.string().trim().max(MAX_APPROVAL_NOTE).optional(),
  client: ApprovalClient,
  /** Replays the first answer for the same bean; reuse only for an exact retry. */
  idempotency_key: IdempotencyKey.optional(),
});
export type ApproveBeanRequest = z.input<typeof ApproveBeanRequest>;

/** The answer: the approval, whether the bean was re-submitted, and its hold now. */
export type ApprovedBean = {
  readonly bean: string;
  readonly revision: string;
  readonly approval: BeanApproval;
  /** True when the bean was waiting for its author and its check runs again now. */
  readonly resubmitted: boolean;
  /** True when this revision was already approved (or the key was used): nothing new happened. */
  readonly replayed: boolean;
  readonly hold: BeanHold;
};

/** The client as an approval names it: `web`, or `MCP (Claude Code)`. */
export function approvalClientName(client: ApprovalClient): string {
  return client.kind === 'web' ? 'web' : `MCP (${client.name})`;
}
