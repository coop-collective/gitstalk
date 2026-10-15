/**
 * The race event schema: one JSON object per line of `events.jsonl`, identical in shape to
 * the local harness (`research/race/harness/core.py` `EventLog.write` and the policies), so
 * `summary.py`, `report.py` and the harness tests read cloud runs unchanged.
 *
 * Every event is `{seq, t, ts, type, ...fields}`: `seq` counts from 1, `t` is seconds since
 * the run was created (3 decimals), `ts` is the wall clock (`2026-10-03T00:17:49.013+00:00`).
 * Field order follows the harness's keyword order, and absent values are `null`, never
 * omitted, wherever the harness writes `None`.
 */

/** JSON value as stored in an event. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

/** Extra keys `run_ci(meta=...)` spreads into `ci.start` and `ci.end`. */
export type CiMeta = {
  readonly batch?: string;
  readonly tasks?: readonly string[];
  readonly prefix?: number;
  readonly check?: 'suite' | 'acceptance';
  /** v2.5: the final suite again, after a red run on a commit validated green. */
  readonly rerun?: true;
  readonly trunk_idx?: number;
  readonly unvalidated?: number;
  readonly ticket?: string;
  readonly without?: string;
  /** `evidence_promotion`: the full suite on the stalk, run as a background audit. */
  readonly audit?: true;
  /** `affected_validation`: only the tests no evidence vouches for (`tests` of them). */
  readonly targeted?: true;
  readonly tests?: number;
};

/** A checked tree that vouched for tests in `promote.evidence`. */
export type EvidenceTree = {
  readonly task: string | null;
  readonly sha: string;
  readonly base_idx: number;
  /** Files that differ between the checked tree and the promoted commit (at most 20 listed). */
  readonly changed: readonly string[];
  readonly changed_count: number;
  /** Tests it vouched for. */
  readonly vouched: number;
};

/** A test whose read set a checked tree's difference met (at most 20 files listed). */
export type EvidenceOverlap = {
  readonly test: string;
  readonly checked: string;
  readonly files: readonly string[];
};

/** `invocation.end` for an invocation that reported (InvocationResult.to_event()). */
export type InvocationEndFields = {
  readonly inv: string;
  readonly kind: string;
  readonly task: string | null;
  readonly agent: string | null;
  readonly spent_usd: number;
  readonly ok: boolean;
  readonly infra_error: string | null;
  readonly timed_out: boolean;
  readonly exit_code: number | null;
  readonly subtype: string | null;
  readonly is_error: boolean;
  readonly cost_usd: number;
  readonly cost_source: string;
  readonly num_turns: number | null;
  readonly duration_ms: number | null;
  readonly duration_api_ms: number | null;
  readonly wall_ms: number;
  readonly startup_ms: number | null;
  readonly session_id: string | null;
  readonly usage: Readonly<Record<string, number>>;
  readonly model_usage: Json;
  readonly permission_denials: Json;
  readonly tool_uses: Readonly<Record<string, number>>;
  readonly result_text: string;
  readonly structured_output: Json;
  readonly transcript: string | null;
  readonly notes: readonly string[];
  readonly rate_limit: Json;
  readonly rate_limited: boolean;
  /** Paths the driver's own merge left conflicted (diagnostics; absent when it reported none). */
  readonly merge_conflicts?: readonly string[];
};

/** `invocation.end` for an invocation killed by an abort (cost estimated from progress). */
export type InvocationKilledFields = {
  readonly inv: string;
  readonly kind: string;
  readonly task: string | null;
  readonly agent: string | null;
  readonly ok: false;
  readonly killed: true;
  readonly cost_usd: number;
  readonly cost_source: 'estimated' | 'none';
  readonly spent_usd: number;
};

export type CiEndFields =
  | ({
      readonly ci: string;
      readonly sha: string;
      readonly purpose: string;
      readonly green: boolean;
      readonly slot: number;
      readonly failing_files: readonly string[] | null;
      readonly failing_tests: readonly string[];
      readonly tests: number;
      readonly failures: number;
      readonly suite_seconds: number;
      readonly ci_seconds: number;
      readonly timed_out: boolean;
    } & CiMeta)
  | ({
      readonly ci: string;
      readonly sha: string;
      readonly purpose: string;
      readonly green: null;
      readonly cancelled: true;
      readonly slot: number;
      readonly ci_seconds: number;
    } & CiMeta);

export type FinalCheckFields =
  | {
      readonly sha: string;
      readonly suite_green: boolean;
      readonly suite_tests: number;
      readonly suite_failures: number;
      readonly acceptance_run_green: boolean;
      readonly tasks_accepted: number;
      readonly tasks_total: number;
      readonly green_tasks_accepted: number;
      readonly green_tasks: number;
      readonly correct: boolean;
      readonly all_tasks_accepted: boolean;
      readonly failing_files: readonly string[];
      readonly base_tests_changed: readonly string[];
    }
  | { readonly error: string };

type TaskRef = { readonly task: string };

/** Fields of every event type, keyed by `type`. */
export type RaceEventFields = {
  'race.setup': {
    readonly policy: string;
    readonly out: string;
    readonly repo: string;
    readonly arena: string;
    readonly arena_digest: string;
    readonly setup_seconds: number;
  };
  'footprint.predicted': TaskRef & {
    readonly method: string;
    readonly selected: readonly string[];
    readonly probs: Readonly<Record<string, number>>;
  };
  'race.start': {
    readonly policy: string;
    readonly agent: string;
    readonly model: string | null;
    readonly agents: number;
    readonly ci_seconds: number;
    readonly ci_slots: number;
    readonly batch: number;
    readonly tasks: readonly string[];
    readonly budget_usd: number;
    readonly seed: number;
    readonly base: string;
    readonly union_merge: boolean;
    readonly snapshot: string;
    readonly queue_hold: boolean;
    readonly protect_tests: string;
    readonly footprint: string;
    readonly error_budget: number;
    readonly intake_seconds: number;
  };
  'task.start': TaskRef & {
    readonly agent: string;
    readonly base: string;
    readonly predicted: readonly string[];
  };
  'invocation.start': {
    readonly inv: string;
    readonly kind: string;
    readonly task: string | null;
    readonly agent: string | null;
    readonly adapter: string;
    readonly model: string | null;
    readonly attempt: number;
    readonly resume: string | null;
    readonly cwd: string;
    readonly budget_cap_usd: number;
  };
  'invocation.end': InvocationEndFields | InvocationKilledFields;
  'invocation.init': { readonly inv: string; readonly [key: string]: Json };
  'invocation.retry': TaskRef & { readonly reason: string };
  'task.commit': TaskRef & {
    readonly sha: string;
    readonly kind: string;
    readonly new_commit: boolean;
    readonly files: readonly string[];
  };
  'acceptance.restored': {
    readonly task?: string;
    readonly ticket?: string;
    readonly paths: readonly string[];
    readonly inv: string;
    readonly others?: readonly string[];
  };
  'task.drop': TaskRef & { readonly reason: string };
  /** v2 `park`: the bean waits for a person; it is done for the race but does not ship. */
  'task.parked': TaskRef & { readonly reason: string };
  'ci.start': {
    readonly ci: string;
    readonly sha: string;
    readonly purpose: string;
    readonly slot: number;
  } & CiMeta;
  'ci.end': CiEndFields;
  land:
    | (TaskRef & {
        readonly sha: string;
        readonly target: string;
        readonly files: readonly string[];
      })
    | {
        readonly task: string | null;
        readonly ticket: string | null;
        readonly kind: string;
        readonly sha: string;
        readonly target: string;
        readonly trunk_idx: number;
        readonly files: readonly string[];
        readonly unvalidated: number;
        readonly prelanded?: boolean;
        /** v2.5: `structural` when a structural merge resolved what git's text merge could not. */
        readonly resolved?: 'structural';
      };
  'green.promote': {
    readonly sha: string;
    readonly trunk_idx?: number;
    readonly tasks: readonly string[];
  };
  'merge.conflict': {
    readonly task: string | null;
    readonly ticket?: string | null;
    readonly onto: string;
    readonly onto_main?: boolean;
    readonly files: readonly string[];
    readonly batch_mates?: readonly string[];
  };
  'rework.start': {
    readonly task: string | null;
    readonly ticket?: string | null;
    readonly reason: string;
    readonly conflicts?: readonly string[];
    readonly failing?: readonly string[];
    readonly attempt: number;
    readonly resumed: boolean;
    /** v2: the landed tasks whose intent and diff the informed rework carries. */
    readonly culprits?: readonly string[];
    /** v2.2: the decision card a re-execution (`reason: decision`) follows. */
    readonly card?: string;
  };
  'rework.markers_left': {
    readonly task: string | null;
    readonly ticket?: string | null;
    readonly files: readonly string[];
  };
  abort: { readonly reason: string };
  error: { readonly where: string; readonly error: string; readonly traceback: string };
  'race.end': {
    readonly aborted: string | null;
    readonly killed_processes: number;
    readonly spent_usd: number;
  };
  'final.check': FinalCheckFields;
  // queue policy (policy_queue.py)
  'queue.enqueue': TaskRef & { readonly sha: string; readonly depth: number };
  'queue.hold': TaskRef & { readonly files: readonly string[]; readonly behind: readonly string[] };
  'queue.eject': TaskRef & {
    readonly reason: 'conflict' | 'red';
    readonly files: readonly string[] | null;
    readonly failing: readonly string[] | null;
  };
  'batch.start': {
    readonly batch: string;
    readonly base: string;
    readonly head: string;
    readonly tasks: readonly string[];
    readonly speculative: boolean;
  };
  'batch.red': {
    readonly batch: string;
    readonly tasks: readonly string[];
    readonly failing: readonly string[] | null;
  };
  'batch.cancel': {
    readonly batch: string;
    readonly tasks: readonly string[];
    readonly because: string;
  };
  'bisect.start': { readonly batch: string; readonly tasks: readonly string[] };
  'bisect.end': {
    readonly batch: string;
    readonly culprit: string;
    readonly landed: readonly string[];
    readonly requeued: readonly string[];
  };
  // beanstalk policies (policy_beanstalk.py, policy_beanstalk_preland.py)
  'placement.decision': TaskRef & {
    readonly rule: string;
    readonly predicted: readonly string[];
    readonly overlap: readonly string[];
    readonly occupied: Readonly<Record<string, readonly string[]>>;
    readonly skipped: readonly string[];
  };
  'budget.pause': { readonly open_reds: number; readonly budget: number };
  'budget.resume': { readonly open_reds: number; readonly budget: number };
  'ticket.open': {
    readonly ticket: string;
    readonly red_sha: string;
    readonly red_idx: number;
    readonly failing: readonly string[];
    readonly method: string;
    readonly suspects: Json;
    readonly concurrent: Json;
    /** v2.3: opened from inherited pre-land reds (`early_tickets`), before any validation. */
    readonly early?: true;
  };
  'ticket.bisect': {
    readonly ticket: string;
    readonly red_idx: number;
    readonly failing: readonly string[];
  };
  'ticket.close': {
    readonly ticket: string;
    readonly how: string;
    readonly attempts: number;
    readonly open_seconds: number;
  };
  'ticket.retry': { readonly ticket: string; readonly why: string; readonly attempt: number };
  'ticket.escalate': { readonly ticket: string; readonly why: string; readonly attempts: number };
  'ticket.culprit': {
    readonly ticket: string;
    readonly trunk_idx: number;
    readonly task: string | null;
    readonly kind: string;
  };
  'ticket.stuck': { readonly ticket: string; readonly culprit_idx: number };
  'ticket.fix_landed': { readonly ticket: string; readonly trunk_idx: number };
  'fixer.dispatch': {
    readonly ticket: string;
    readonly agent: string;
    readonly attempt: number;
    readonly base: string;
    readonly suspects: readonly string[];
  };
  revert: {
    readonly ticket: string;
    readonly task: string | null;
    readonly reverted: string;
    readonly sha: string;
    readonly trunk_idx: number;
  };
  'revert.conflict': {
    readonly ticket: string;
    readonly task: string | null;
    readonly files: readonly string[];
  };
  'race.stuck': { readonly trunk_idx: number; readonly green_idx: number };
  'preland.check': TaskRef & {
    readonly sha: string;
    readonly green: boolean;
    readonly failing_files: readonly string[] | null;
    readonly failing_tests: readonly string[];
    readonly suite_seconds: number;
    readonly check_seconds: number;
    /** v2.2: the red was the sprout's (`inherited_reds`); the bean waits, no rework round. */
    readonly inherited?: true;
    /** v2.5: a targeted check of the exact landing tree ran only these test files. */
    readonly targets?: readonly string[];
  };
  /**
   * v2.5 (`tests_first`): the test author's files for a task, proven on its base. `accepted`:
   * the files that failed there replace the given tests; `fallback`: the given tests stay.
   */
  'tests.first': TaskRef & {
    readonly status: 'accepted' | 'fallback';
    readonly base: string;
    readonly files: readonly string[];
    readonly accepted: readonly string[];
    readonly failing_tests: readonly string[];
    readonly problems: readonly string[];
    readonly inv: string;
  };
  /**
   * v2.4: before a card, the test author reconciled the two tasks' acceptance tests (their
   * changed `files`, carried by the arriving bean), or found a genuine contradiction.
   */
  'decision.reconcile': TaskRef & {
    readonly against: string;
    readonly outcome: 'reconciled' | 'contradiction';
    readonly files: readonly string[];
    readonly reason: string | null;
    readonly inv: string;
    /** v2.5: every landed task in the reconcile (`against` first), when it took in more than one. */
    readonly parties?: readonly string[];
  };
  /**
   * v2.5 (E6 `rescue.start`): the bean's rework rounds ran out; it is re-executed once from
   * scratch on the sprout head (`why`: the last round's red check or conflict).
   */
  'rescue.start': TaskRef & { readonly why: string; readonly rounds: number };
  /**
   * Stall fix (`red_reset`): ticket `ticket`'s red at `red_idx` reset the sprout to the tree of
   * the stalk (`green_idx`) with the commit `sha` at `trunk_idx`, promoted without CI. The beans
   * of the red window (`requeued`, oldest first) go back through their pre-land checks.
   */
  'sprout.reset': {
    readonly ticket: string;
    readonly red_idx: number;
    readonly green_idx: number;
    readonly trunk_idx: number;
    readonly sha: string;
    readonly requeued: readonly string[];
  };
  /**
   * Check reuse (`reuse_checks`): the sprout commit `sha` at `trunk_idx` is the exact commit
   * `task`'s full pre-land check passed, so it counts as validated green without CI (a
   * `green.promote` follows). `cancelled` lists the CI runs of older commits it superseded.
   */
  'check.reused': {
    readonly sha: string;
    readonly trunk_idx: number;
    readonly task: string | null;
    readonly source: 'preland';
    readonly cancelled: readonly string[];
  };
  /**
   * `evidence_promotion`: the sprout commit `sha` at `trunk_idx` is green without a full CI run.
   * Every test of its tree (`tests`) is vouched for by a green full check of a tree (`checked`:
   * the bean or sprout commit checked, the sprout index it was built on, the files that differ
   * between it and `sha`) whose difference misses the test's read set, or (`targeted`) passed
   * the affected validation. `overlaps` lists read sets a checked tree's difference did meet
   * (each such test was vouched for by another tree or run). `beans` are the commits promoted.
   */
  'promote.evidence': {
    readonly sha: string;
    readonly trunk_idx: number;
    readonly green_idx: number;
    readonly beans: readonly string[];
    readonly tests: number;
    readonly checked: readonly EvidenceTree[];
    readonly overlaps: readonly EvidenceOverlap[];
    readonly targeted: { readonly ci: string; readonly tests: readonly string[] } | null;
    readonly cancelled: readonly string[];
  };
  /**
   * `evidence_promotion`: the head at `trunk_idx` has no full evidence, so a validation runs
   * (`affected`: the tests nothing vouches for; empty with a `reason` that rules evidence out).
   */
  'evidence.refused': {
    readonly sha: string;
    readonly trunk_idx: number;
    readonly reason: 'no-read-sets' | 'unchecked-bean' | 'structural' | 'known-red' | 'affected';
    readonly tests: number;
    readonly affected: readonly string[];
    readonly affected_count: number;
    readonly overlaps: readonly EvidenceOverlap[];
  };
  /**
   * `evidence_promotion`: a confirmed red audit of the stalk at `audit_idx` (`failing`): the
   * stalk goes back from `from_idx` to `trunk_idx` (`sha`), the newest commit a full suite
   * passed, and the beans promoted since (`tasks`) are landed again; a ticket follows.
   */
  'green.demote': {
    readonly sha: string;
    readonly trunk_idx: number;
    readonly from_idx: number;
    readonly audit_sha: string;
    readonly audit_idx: number;
    readonly failing: readonly string[];
    readonly tasks: readonly string[];
  };
  /** Stall fix (`red_reset`): a bean the reset took off the sprout (it was `trunk_idx`) lands again. */
  'bean.requeued': TaskRef & { readonly ticket: string; readonly trunk_idx: number };
  /**
   * v2.5 (E6 `dynamic_culprits`): the leave-one-out search for the landed beans that break the
   * bean's own failing tests: the candidates probed, and those whose removal fixed the tests.
   */
  'culprit.dynamic': TaskRef & {
    readonly candidates: readonly string[];
    readonly confirmed: readonly string[];
  };
  /**
   * `live_sync`: beans that landed while this bean's agent worked (`landed`, by the bean's
   * `overlap` or `all`), merged into its branch at `sprout` and handed to its agent (`inv`).
   */
  'sync.applied': TaskRef & {
    readonly sprout: string;
    readonly landed: readonly string[];
    readonly files: readonly string[];
    readonly inv: string;
  };
  /** `live_sync`: the same, but the merge conflicts: the bean's next prompt names them. */
  'sync.noted': TaskRef & {
    readonly sprout: string;
    readonly landed: readonly string[];
    readonly files: readonly string[];
    readonly conflicts: readonly string[];
  };
  /**
   * `live_sync_midrun`: beans that landed while invocation `inv` runs and meet its bean were
   * offered to its driver with the sprout head (`sprout`); `files` are the landed files met.
   */
  'sync.midrun.offered': TaskRef & {
    readonly inv: string;
    readonly sprout: string;
    readonly landed: readonly string[];
    readonly files: readonly string[];
  };
  /** `live_sync_midrun`: the agent's hook merged the offered sprout into its worktree. */
  'sync.midrun.applied': TaskRef & {
    readonly inv: string;
    readonly sprout: string;
    readonly landed: readonly string[];
    readonly files: readonly string[];
  };
  /** `live_sync_midrun`: the hook only told the agent, and why (`reason`). */
  'sync.midrun.noted': TaskRef & {
    readonly inv: string;
    readonly sprout: string;
    readonly landed: readonly string[];
    readonly files: readonly string[];
    readonly reason: string | null;
  };
  /** v2.3: a green bean waits for room in the sprout window (`window: aimd`). */
  'window.wait': TaskRef & { readonly window: number; readonly unvalidated: number };
  /** v2.3: the sprout window grew after a green validation, or halved on a red sprout. */
  'window.resize': {
    readonly window: number;
    readonly previous: number;
    readonly reason: 'green' | 'red';
    readonly trunk_idx: number;
  };
  'preland.optimistic': TaskRef & {
    readonly checked_on: string;
    readonly landed_on: string;
    readonly landed_meanwhile: number;
  };
  'preland.recheck': TaskRef & {
    readonly checked_on: string;
    readonly head: string;
    readonly attempt: number;
    /** v2.4: failing tests whose owner was reverted after the check began (no round spent). */
    readonly stale?: readonly string[];
  };
  // v2 (policy_beanstalk_v2.py)
  'decision.request': {
    readonly card: string;
    readonly task: string;
    readonly against: readonly string[];
    readonly specs: Readonly<Record<string, string>>;
    readonly failing: readonly string[];
    readonly attempts: number;
    /**
     * v2.5: every landed task of the reconcile that ended in this contradiction (`against`
     * first), when it took in more than one; the card itself decides `against`.
     */
    readonly parties?: readonly string[];
    /** v2.5: the reconciling author's CONTRADICTION line. */
    readonly reason?: string;
    /** v2.5: raised when the bean started, against a landed declared partner (`start_cards`). */
    readonly trigger?: 'start';
  };
  'decision.made': {
    readonly card: string;
    readonly winner: string;
    readonly loser: string;
    /** `landed` / `arriving` (the oracle), `human:<actor>`, or `timeout:<oracle>`. */
    readonly oracle: string;
    readonly wait_seconds: number;
    /** v2.2 (`decision_outcome: reexecute`): `keep-landed` or `adopt-in-place`. */
    readonly outcome?: string;
    /** v2.2: the decision line the test author and the re-executed bean read. */
    readonly text?: string;
  };
  // v2.2
  /**
   * The test author's amendment of a decision's loser: accepted (`amended`, with the fail-first
   * proof unless in place), `none` (nothing contradicted the decision, or the author failed),
   * `rejected`, or `rolled-back` (the winner that carried an in-place amendment was dropped).
   */
  'spec.amended': {
    readonly card: string;
    readonly task: string;
    readonly status: 'amended' | 'none' | 'rejected' | 'rolled-back';
    readonly paths: readonly string[];
    readonly in_place: boolean;
    readonly fail_first: {
      readonly sha: string;
      readonly failing_files: readonly string[];
      readonly failing_tests: readonly string[];
    } | null;
    readonly problems: readonly string[];
    readonly inv: string | null;
  };
  /**
   * A red validation whose re-run did not fail the same test file again: the test is recorded
   * as flaky and the validation counts as green (no revert).
   */
  'flake.suspected': {
    readonly trunk_idx: number;
    readonly sha: string;
    readonly failing: readonly string[] | null;
    readonly rerun_failing: readonly string[] | null;
    readonly flaky: readonly string[];
  };
};

export type RaceEventType = keyof RaceEventFields;

/** The envelope every event carries before its fields. */
export type EventEnvelope<K extends RaceEventType = RaceEventType> = {
  readonly seq: number;
  readonly t: number;
  readonly ts: string;
  readonly type: K;
};

/** One event of a given type. */
export type RaceEventOf<K extends RaceEventType> = EventEnvelope<K> & RaceEventFields[K];

/** Any race event. */
export type RaceEvent = { [K in RaceEventType]: RaceEventOf<K> }[RaceEventType];

/** Event keys the harness's `ZEvents.REQUIRED` test checks for, by type. */
export const REQUIRED_EVENT_KEYS: Readonly<Partial<Record<RaceEventType, readonly string[]>>> = {
  'race.start': ['policy', 'agent', 'tasks'],
  'task.start': ['task', 'agent', 'base'],
  'invocation.start': ['inv', 'kind', 'agent'],
  'invocation.end': ['inv', 'kind', 'cost_usd', 'ok'],
  'ci.start': ['ci', 'sha', 'purpose', 'slot'],
  'ci.end': ['ci', 'sha', 'purpose', 'green'],
  land: ['sha', 'target'],
  'green.promote': ['sha', 'tasks'],
  'merge.conflict': ['files'],
  'race.end': ['aborted', 'spent_usd'],
  'final.check': ['sha', 'suite_green'],
};

/**
 * Event types after which a line (the sprout or the stalk) has a new head: the base at the
 * start, then landings, reverts, red resets, promotions and demotions. The gateway warms its
 * read index on them and the web app's head watcher refreshes on them: one list, so the two
 * never drift apart.
 */
export const LINE_MOVE_TYPES = [
  'race.start',
  'land',
  'revert',
  'sprout.reset',
  'green.promote',
  'green.demote',
] as const satisfies readonly RaceEventType[];
