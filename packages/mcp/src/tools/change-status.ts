/**
 * The run's view of one bean, for `bean_status` (`bean-status.ts`): where it stands after its
 * author submitted it. Landed on the sprout and awaiting validation, green on the stalk, sent
 * back for rework, waiting on a decision, reverted or dropped; with what to do next and the
 * latest steps as evidence.
 */
import type { Sha, SlotId, TaskId } from '@gitstalk/shared-race/ids';
import { RouteReceipt } from '@gitstalk/shared-race/approval-policy';

import type { BeanDetail, BeanStatus } from '@gitstalk/shared-ask/forge/forge-source';

import { previewUrl } from './preview-link';
import type { ToolContext } from './tool-context';
import { branchOf, clip, editingNow, seconds } from './tool-context';

const STEPS_SHOWN = 5;
const MESSAGE_CHARS = 300;

export type ChangeStatus = {
  readonly bean: TaskId;
  readonly branch: string;
  readonly title: string;
  readonly status: BeanStatus;
  readonly phase: string;
  readonly slot: SlotId | null;
  readonly head: Sha | null;
  readonly landed_idx: number | null;
  readonly checks: { readonly total: number; readonly red: number };
  readonly reworks: number;
  readonly conflicts: number;
  readonly card: string | null;
  readonly drop_reason: string | null;
  readonly last_message: string;
  readonly recent_steps: readonly {
    readonly at_s: number;
    readonly kind: string;
    readonly detail: string;
  }[];
  /**
   * `stream_diffs`: what its agent is editing right now, before the commit (the observed
   * footprint); null when nothing streams.
   */
  readonly editing_now: {
    readonly files: readonly { path: string; additions: number; deletions: number }[];
    readonly snapshot: number;
    readonly at_s: number;
  } | null;
  /**
   * The approval rules' receipt of its last pre-land check: its classes, the route (`auto`,
   * `triage`, `card`), who decided (`policy`, `clef`, `rules`) and how sure, the approval; null
   * when the engine routed none (rules off, or a gateway before them).
   */
  readonly route: RouteReceipt | null;
  readonly next: string;
  readonly preview_url: string;
  readonly summary: string;
};

/** The bean's status, or undefined when the run has no such bean. */
export async function changeStatus(
  ctx: ToolContext,
  bean: TaskId,
): Promise<ChangeStatus | undefined> {
  const [detail, editing, route] = await Promise.all([
    ctx.source.beanDetail(ctx.run, bean),
    editingNow(ctx),
    routeOf(ctx, bean),
  ]);
  if (detail === undefined) return undefined;
  const stream = editing.get(bean);
  const next = route?.approval.state === 'awaiting' ? awaitingStep(route) : nextStep(detail);
  return {
    bean,
    branch: branchOf(bean),
    title: detail.title,
    status: detail.status,
    phase: detail.phase,
    slot: detail.agent,
    head: detail.head,
    landed_idx: detail.landedIdx,
    checks: { total: detail.checks, red: detail.redChecks },
    reworks: detail.reworks,
    conflicts: detail.conflicts,
    card: detail.card,
    drop_reason: detail.dropReason,
    last_message: clip(detail.lastMessage, MESSAGE_CHARS),
    recent_steps: detail.steps.slice(-STEPS_SHOWN).map((step) => ({
      at_s: seconds(step.t) ?? 0,
      kind: step.kind,
      detail: step.detail,
    })),
    editing_now:
      stream === undefined
        ? null
        : {
            files: stream.files.map(({ path, additions, deletions }) => ({
              path,
              additions,
              deletions,
            })),
            snapshot: stream.seq,
            at_s: seconds(stream.t) ?? 0,
          },
    route,
    next,
    preview_url: previewUrl(ctx.webUrl, ctx.run, { kind: 'bean', bean }),
    summary: `${bean} ${detail.status} (${detail.phase}). ${next}`,
  };
}

/**
 * The bean's route receipt; null when the gateway has none or predates approval rules, or the
 * read fails (a hint, never a reason to fail the tool).
 */
async function routeOf(ctx: ToolContext, bean: TaskId): Promise<RouteReceipt | null> {
  if (ctx.gateway.beanRoute === undefined) return null;
  try {
    const answer = await ctx.gateway.beanRoute(ctx.run, bean);
    if (!answer.ok || answer.value === null) return null;
    const parsed = RouteReceipt.safeParse(answer.value);
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    ctx.log?.warn('reading a route receipt failed', { bean, error });
    return null;
  }
}

function awaitingStep(route: RouteReceipt): string {
  const why = route.class === null ? 'its classes' : `class ${route.class}`;
  return `Held for a person's approval (${why}, ${route.by}). Do not change the code for this; wait, and poll bean_status.`;
}

function nextStep(detail: BeanDetail): string {
  if (detail.phase === 'held')
    return "Held for a person's approval: nothing to fix. Do not change the code for this; wait, and poll bean_status.";
  if (detail.phase === 'rework')
    return 'Sent back: read bean_status with checks: true, fix the code, resubmit.';
  if (detail.phase === 'deciding')
    return `Decision card ${detail.card ?? '(unnamed)'} is open; a person decides. Wait.`;
  switch (detail.status) {
    case 'pending':
      return 'Not started yet.';
    case 'in-flight':
      return 'In flight: poll bean_status again.';
    case 'landed':
      return 'On the sprout, awaiting validation: poll again.';
    case 'green':
      return 'On the stalk. Done.';
    case 'reverted':
      return 'Reverted from the sprout: read bean_status with checks: true.';
    case 'dropped':
      return `Dropped: ${detail.dropReason ?? 'no reason recorded'}.`;
    case 'parked':
      return 'Parked: it needs a person (see its last step). Stop working on it.';
    default:
      return assertNever(detail.status);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected bean status ${String(value)}`);
}
