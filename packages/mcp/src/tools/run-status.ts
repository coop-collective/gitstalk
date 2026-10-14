/**
 * `repo_status` without a repository: the caller's run at a glance. The sprout and the stalk,
 * the window of landings the stalk has not validated yet, beans in flight, open decision
 * cards, red validations, cost, and explorer links for both lines.
 */
import { z } from 'zod';

import type { Sha, SlotId, TaskId } from '@gitstalk/shared-race/ids';

import { unwrap } from '@gitstalk/shared-ask/forge/gateway-rpc';
import { isInFlight, raceCounters } from '@gitstalk/shared-ask/race/race-counters';
import type { RaceState } from '@gitstalk/shared-ask/race/race-state';

import { previewUrl } from './preview-link';
import type { ToolContext } from './tool-context';
import { seconds } from './tool-context';

/** Red validations listed in full; older ones are only counted. */
const RECENT_REDS = 3;
const FAILING_TESTS_SHOWN = 5;
/** CI purposes that validate a line: the sprout's validations and the queue's batches. */
const VALIDATIONS: ReadonlySet<string> = new Set(['validate', 'batch']);

export type RunStatus = {
  readonly run: string;
  readonly policy: string | null;
  readonly phase: RaceState['phase'];
  readonly clock_s: number;
  readonly sprout: { readonly sha: Sha | null; readonly commits: number };
  readonly stalk: { readonly sha: Sha | null; readonly idx: number };
  /**
   * The sprout window: landings the stalk has not validated yet, the most it allows (`size`,
   * null when the policy has no window) and the green beans waiting for room.
   */
  readonly window: {
    readonly size: number | null;
    readonly unvalidated: number;
    readonly beans: readonly TaskId[];
    readonly waiting: readonly string[];
  };
  readonly in_flight: readonly {
    readonly bean: TaskId;
    readonly slot: SlotId | null;
    readonly phase: string;
    readonly since_s: number;
  }[];
  readonly open_cards: readonly {
    readonly card: string;
    readonly bean: TaskId;
    readonly against: readonly TaskId[];
    readonly failing: readonly string[];
  }[];
  readonly red_validations: {
    readonly count: number;
    readonly recent: readonly {
      readonly ci: string;
      readonly sha: Sha;
      readonly at_s: number;
      readonly failing_tests: readonly string[];
    }[];
  };
  readonly beans: { readonly total: number; readonly green: number; readonly dropped: number };
  readonly cost_usd: number;
  /** The explorer on each line. */
  readonly preview_urls: { readonly sprout: string; readonly stalk: string };
  readonly summary: string;
};

/** The part of `runView` read here: v2.3's sprout window, when the policy has one. */
const RunViewWindow = z.object({
  policy_state: z
    .object({
      window: z
        .object({ size: z.number().int(), waiting: z.array(z.string()) })
        .nullable()
        .optional(),
    })
    .nullable(),
});

export async function runStatus(ctx: ToolContext): Promise<RunStatus> {
  const [{ state }, view] = await Promise.all([ctx.snapshot(), ctx.gateway.runView(ctx.run)]);
  const policyWindow = unwrap(view, RunViewWindow).policy_state?.window ?? null;
  const counters = raceCounters(state);
  const { commits, stalkIdx, stalkSha } = state.line;
  const window = commits.filter((commit) => commit.idx > stalkIdx);
  const status = {
    run: ctx.run,
    policy: state.meta?.policy ?? null,
    phase: state.phase,
    clock_s: Math.round(state.clock),
    sprout: { sha: commits.at(-1)?.sha ?? state.meta?.base ?? null, commits: commits.length },
    stalk: { sha: stalkSha ?? state.meta?.base ?? null, idx: stalkIdx },
    window: {
      size: policyWindow?.size ?? null,
      unvalidated: window.length,
      beans: window.flatMap((commit) => (commit.task === null ? [] : [commit.task])),
      waiting: policyWindow?.waiting ?? [],
    },
    in_flight: inFlight(state),
    open_cards: state.cards
      .filter((card) => card.status === 'open')
      .map((card) => ({
        card: card.card,
        bean: card.task,
        against: card.against,
        failing: card.failing,
      })),
    red_validations: { count: counters.redValidations, recent: recentReds(state) },
    beans: { total: counters.beans, green: counters.green, dropped: counters.dropped },
    cost_usd: Math.round(counters.costUsd * 100) / 100,
    preview_urls: {
      sprout: previewUrl(ctx.webUrl, ctx.run, { kind: 'ref', ref: 'sprout' }),
      stalk: previewUrl(ctx.webUrl, ctx.run, { kind: 'ref', ref: 'stalk' }),
    },
  };
  return { ...status, summary: summarize(status) };
}

function inFlight(state: RaceState): RunStatus['in_flight'] {
  return state.order.flatMap((id) => {
    const bean = state.beans[id];
    if (bean === undefined || !isInFlight(bean.phase)) return [];
    return [{ bean: id, slot: bean.agent, phase: bean.phase, since_s: seconds(bean.since) ?? 0 }];
  });
}

function recentReds(state: RaceState): RunStatus['red_validations']['recent'] {
  return state.ci
    .filter((run) => run.green === false && VALIDATIONS.has(run.purpose))
    .slice(-RECENT_REDS)
    .map((run) => ({
      ci: run.ci,
      sha: run.sha,
      at_s: Math.round(run.endedAt ?? run.startedAt),
      failing_tests: run.failingTests.slice(0, FAILING_TESTS_SHOWN),
    }));
}

function summarize(status: Omit<RunStatus, 'summary'>): string {
  const minutes = Math.round(status.clock_s / 60);
  return [
    `${status.phase} at ${minutes} min`,
    `${status.beans.green}/${status.beans.total} green`,
    `${status.in_flight.length} in flight`,
    `window ${status.window.unvalidated}${status.window.size === null ? '' : `/${status.window.size}`}`,
    `${status.open_cards.length} open cards`,
    `${status.red_validations.count} red validations`,
    `$${status.cost_usd.toFixed(2)}`,
  ].join(', ');
}
