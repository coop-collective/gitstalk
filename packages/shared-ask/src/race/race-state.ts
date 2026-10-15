/**
 * What the canvas shows about a race, derived from its events by `reduceRace`. Times are
 * race seconds: the events' `t`, seconds since the run was created.
 */
import type { Sha, SlotId, TaskId } from '@gitstalk/shared-race/ids';

import type { BatchId, CardId, TicketId } from './race-events';

/** `beanstalk` is every pre-land variant (v2 is the product); `queue` is the merge queue. */
export type PolicyKind = 'beanstalk' | 'queue';

export type RaceMeta = {
  readonly policy: PolicyKind;
  readonly agent: string;
  readonly model: string | null;
  readonly agents: number;
  readonly ciSlots: number;
  readonly ciSeconds: number;
  readonly batch: number | null;
  readonly budgetUsd: number;
  readonly seed: number;
  readonly base: Sha;
  readonly tasks: readonly TaskId[];
  /** `t` of `race.start`: slot clocks and `wall_seconds` count from here. */
  readonly startedAt: number;
  /** The queue without `queue_hold` frees an agent as soon as its bean is enqueued. */
  readonly releaseOnEnqueue: boolean;
};

/** Where a bean is in its life. */
export type BeanPhase =
  /** Not started yet. */
  | 'pending'
  /** Its agent is writing the first version. */
  | 'working'
  /** beanstalk: its pre-land check or landing turn is running; the agent waits. */
  | 'checking'
  /** queue: waiting in the merge queue. */
  | 'queued'
  /** queue: in a CI batch. */
  | 'testing'
  /** Sent back to its author (a rework is running, or waits for an agent). */
  | 'rework'
  /**
   * The approval rules hold it for a person (`preland.check.held`): nothing to fix; a person's
   * approval checks the same revision again, a new push is judged again.
   */
  | 'held'
  /** A decision card about it is open. */
  | 'deciding'
  /** On the sprout, not validated yet. */
  | 'landed'
  /** On the stalk. */
  | 'green'
  | 'dropped'
  /** v2 `park`: it needs a person; the race finishes without it. */
  | 'parked';

export type BeanStepKind =
  | 'started'
  | 'committed'
  | 'check-green'
  | 'check-red'
  /** The approval rules held it for a person at its check (a hold, not a red). */
  | 'held'
  /** A person approved the held revision, so its check runs again on the same commit. */
  | 'approved'
  | 'recheck'
  | 'optimistic'
  | 'conflict'
  | 'rework'
  | 'enqueued'
  | 'batched'
  | 'ejected'
  | 'decision'
  | 'landed'
  | 'green'
  | 'reverted'
  | 'dropped'
  | 'parked'
  /** v2.5 `tests_first`: the test author wrote its tests before the bean began. */
  | 'tests-first'
  /** v2.4: the test author tried to reconcile its tests with a landed bean's. */
  | 'reconcile'
  /** v2.5: rework rounds ran out; re-executed once on the sprout head. */
  | 'rescue'
  /** `red_reset`: the sprout was reset under it; it goes back through its check and lands again. */
  | 'requeued'
  /** v2.5: the landed beans that break its tests, found by leaving each out. */
  | 'culprits'
  /** `live_sync`: beans that landed meanwhile were merged in for its agent. */
  | 'synced'
  /** v2.3: green, waiting for room in the sprout window. */
  | 'window';

/** One thing that happened to a bean, for its timeline. */
export type BeanStep = {
  readonly t: number;
  readonly kind: BeanStepKind;
  /** Short facts for the step: files, failing tests, the culprits, a reason. */
  readonly detail: string;
  readonly agent: SlotId | null;
};

export type Bean = {
  readonly id: TaskId;
  readonly phase: BeanPhase;
  /** When the current phase began. */
  readonly since: number;
  /** The agent that last worked on it. */
  readonly agent: SlotId | null;
  readonly startedAt: number | null;
  readonly base: Sha | null;
  readonly head: Sha | null;
  /** Modules the intake predicted before the race (`footprint.predicted`). */
  readonly predicted: readonly string[];
  /** Files the bean itself changes (see `ownFiles` in reduce-race). */
  readonly files: readonly string[];
  readonly landedAt: number | null;
  /** Position on the line (the sprout, or the queue's stalk). */
  readonly landedIdx: number | null;
  readonly landedSha: Sha | null;
  readonly greenAt: number | null;
  readonly reworks: number;
  readonly conflicts: number;
  readonly checks: number;
  readonly redChecks: number;
  readonly invocations: number;
  readonly costUsd: number;
  /** The agent's last report (`result_text`). */
  readonly lastMessage: string;
  readonly dropReason: string | null;
  readonly card: CardId | null;
  readonly steps: readonly BeanStep[];
};

export type LaneActivity = 'busy' | 'blocked' | 'idle';

export type LaneInvocation = {
  readonly inv: string;
  /** `initial`, `rework`, `fixer`, `test-author` (v2.2) or a newer kind. */
  readonly kind: string;
  readonly task: TaskId | null;
  readonly since: number;
};

/** A closed stretch of one activity on a lane, for swimlanes. */
export type LaneSegment = {
  readonly from: number;
  readonly to: number;
  readonly activity: LaneActivity;
  readonly bean: TaskId | null;
};

/** One agent slot: what it holds and runs, with the harness's busy/blocked/idle clock. */
export type Lane = {
  readonly slot: SlotId;
  readonly activity: LaneActivity;
  readonly since: number;
  readonly bean: TaskId | null;
  readonly invocation: LaneInvocation | null;
  /** Seconds spent per activity, closed intervals only (the open one is `now - since`). */
  readonly totals: Readonly<Record<LaneActivity, number>>;
  /** Closed activity stretches, oldest first (the open one runs from `since`). */
  readonly segments: readonly LaneSegment[];
};

export type CommitStatus = 'pending' | 'validating' | 'green' | 'red' | 'culprit' | 'reverted';

/** A commit on the line: the sprout for beanstalk, the stalk itself for the queue. */
export type LineCommit = {
  readonly idx: number;
  readonly sha: Sha;
  readonly task: TaskId | null;
  readonly kind: string;
  readonly t: number;
  readonly files: readonly string[];
  readonly status: CommitStatus;
  /** When a validation that ended at this commit came back red. */
  readonly redAt: number | null;
};

export type Line = {
  readonly commits: readonly LineCommit[];
  /** The stalk pointer: index of the newest validated commit, -1 for the base. */
  readonly stalkIdx: number;
  readonly stalkSha: Sha | null;
};

export type CiRun = {
  readonly ci: string;
  readonly sha: Sha;
  readonly purpose: string;
  readonly slot: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly green: boolean | null;
  readonly cancelled: boolean;
  readonly trunkIdx: number | null;
  readonly batch: BatchId | null;
  readonly tasks: readonly TaskId[];
  readonly failingFiles: readonly string[];
  readonly failingTests: readonly string[];
};

export type DecisionCard = {
  readonly card: CardId;
  /** The arriving bean whose reworks kept failing against `against`. */
  readonly task: TaskId;
  readonly against: readonly TaskId[];
  /** One-line spec per bean (its task title). */
  readonly specs: Readonly<Record<string, string>>;
  readonly failing: readonly string[];
  readonly attempts: number;
  /** v2.5: `start` for a start card (raised before the arriving bean began), else null. */
  readonly trigger: string | null;
  /** v2.4: the test author's account of the contradiction that raised the card. */
  readonly reason: string | null;
  readonly openedAt: number;
  readonly status: 'open' | 'decided';
  readonly winner: TaskId | null;
  readonly loser: TaskId | null;
  readonly oracle: string | null;
  readonly decidedAt: number | null;
  /** v2.2: `keep-landed` or `adopt-in-place`. */
  readonly outcome: string | null;
  /** v2.2: the decision, in the words the test author and the loser read. */
  readonly text: string | null;
  /** v2.2: the test author's amendment of the loser's acceptance tests. */
  readonly amendment: { readonly status: string; readonly paths: readonly string[] } | null;
};

export type Batch = {
  readonly batch: BatchId;
  readonly tasks: readonly TaskId[];
  readonly speculative: boolean;
  readonly startedAt: number;
  readonly status: 'testing' | 'green' | 'red' | 'cancelled';
  readonly failing: readonly string[];
  readonly culprit: TaskId | null;
};

export type Ticket = {
  readonly ticket: TicketId;
  readonly redIdx: number;
  readonly failing: readonly string[];
  readonly openedAt: number;
  readonly status: 'open' | 'escalated' | 'closed';
  readonly culprit: TaskId | null;
};

export type RaceTotals = {
  readonly costUsd: number;
  /** Red `ci.end` of a validation or a queue batch (`state.redValidations`). */
  readonly redValidations: number;
  readonly conflicts: number;
  readonly invocations: Readonly<Record<string, number>>;
  /** CI runs by purpose, `-cancelled` for cancelled ones, the final check excluded. */
  readonly ciRuns: Readonly<Record<string, number>>;
};

export type FinalCheck = {
  readonly correct: boolean | null;
  readonly tasksAccepted: number | null;
  readonly tasksTotal: number | null;
  readonly error: string | null;
};

export type RacePhase = 'setup' | 'running' | 'ended';

export type RaceState = {
  readonly meta: RaceMeta | null;
  readonly phase: RacePhase;
  /** `t` of the newest event. */
  readonly clock: number;
  /** Wall-clock milliseconds of t = 0, from the first event's `ts`. */
  readonly epochMs: number | null;
  readonly beans: Readonly<Record<string, Bean>>;
  /** Bean ids in task order. */
  readonly order: readonly TaskId[];
  readonly lanes: readonly Lane[];
  readonly line: Line;
  readonly ci: readonly CiRun[];
  readonly cards: readonly DecisionCard[];
  readonly batches: readonly Batch[];
  /** queue: beans waiting for a batch, oldest first. */
  readonly queue: readonly TaskId[];
  readonly tickets: readonly Ticket[];
  readonly totals: RaceTotals;
  readonly endedAt: number | null;
  readonly aborted: string | null;
  readonly final: FinalCheck | null;
  /** Seq of the newest event applied. */
  readonly lastSeq: number;
  /** Test files a flake confirmation recorded as flaky (v2.2). */
  readonly flaky: readonly string[];
};

/** How the engine ran: knobs the events do not state, from the run's view. */
export type RaceOptions = {
  /** v2.2 `release_on_check`: a bean's agent is free as soon as the bean is submitted. */
  readonly releaseOnCheck?: boolean;
};
