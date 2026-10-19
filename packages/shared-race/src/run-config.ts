import { z } from 'zod';

import { TaskId } from './ids';
import { DEFAULT_SUITE, RunSuite } from './suite';
import { ArenaTask } from './task';

/**
 * Integration policies (plan §6): `beanstalk-v2` is the product, `queue` the baseline. The
 * earlier beanstalk variants are named so a run config can say them; this build runs only
 * `queue` and `beanstalk-v2`.
 */
export const PolicyName = z.enum(['queue', 'beanstalk', 'beanstalk-preland', 'beanstalk-v2']);
export type PolicyName = z.infer<typeof PolicyName>;

/** The agent adapter the driver runs (`replay` applies reference patches; free). */
export const AgentKind = z.enum(['claude', 'codex', 'replay']);
export type AgentKind = z.infer<typeof AgentKind>;

/**
 * Named, pinned engine settings: a run that names one gets exactly those rules whatever the
 * defaults become. `demo` is `V25_SETTINGS` plus dependency-aware starts, `park`, `red_reset`
 * and a 3-minute tail guard (`DEMO_SETTINGS`; its base is the three-seed CF races
 * `cf-v25dep2-sonnet-12-s*`); `v24` is the v2.4 engine (`cf-v24-*`).
 */
export const RunPreset = z.enum(['demo', 'v24']);
export type RunPreset = z.infer<typeof RunPreset>;

/** A footprint the driver predicted for a task before the race (the harness's intake step). */
export const TaskFootprint = z.strictObject({
  method: z.string().max(40),
  selected: z.array(z.string().max(200)).max(50),
  probs: z.record(z.string().max(200), z.number().min(0).max(1)),
});
export type TaskFootprint = z.infer<typeof TaskFootprint>;

/**
 * Body of `POST /v1/runs`: the harness's `RaceConfig` (same names and defaults) plus the
 * tasks themselves. Fields that only the driver uses (model, max turns, timeouts) are
 * carried so every instruction states them and the events record them.
 */
/** The sprout window's defaults (`window: aimd`): start, growth per green, largest, red floor. */
export const WINDOW_DEFAULTS = { start: 8, growth: 2, max: 16, min: 2 } as const;

const CheckedFields = z
  .strictObject({
    policy: PolicyName,
    /** Pinned settings (`RUN_PRESETS`); a field the preset pins may only be repeated, never changed. */
    preset: RunPreset.nullable().default(null),
    agent: AgentKind.default('replay'),
    model: z.string().max(100).nullable().default(null),
    agents: z.number().int().min(1).max(64).default(4),
    ci_seconds: z.number().min(0).max(3600).default(60),
    ci_slots: z.number().int().min(1).max(16).default(2),
    batch: z.number().int().min(1).max(64).default(4),
    batch_wait: z.number().min(0).max(3600).default(0),
    budget_usd: z.number().positive().max(10_000).default(25),
    max_invocation_usd: z.number().positive().max(1000).default(3),
    /**
     * The spend guard: agent spend plus the run's measured Cloudflare infrastructure cost
     * (`infra` in the summary). Reaching it aborts the run (`budget (max_usd) …`). null: off.
     */
    max_usd: z.number().positive().max(10_000).nullable().default(null),
    /**
     * The run's Artifacts repos are deleted once its final check is done. `true` keeps them
     * for browsing; the gateway's hourly sweep still deletes them a day after the run began.
     */
    keep_repo: z.boolean().default(false),
    /**
     * Streaming diffs: while an implementer invocation runs, the driver posts the bean's
     * working change (`/stream`), and the gateway keeps the latest snapshot per bean and
     * broadcasts a summary on the live feed. Display only: the engine never reads it, and
     * nothing reaches the event log. `false`: as before.
     */
    stream_diffs: z.boolean().default(false),
    /**
     * Experimental Node JS/TS pre-land skipper. Reuses unchanged module dependencies from
     * a full green run in the same runner; unsupported inputs fall back to the full suite.
     * Never applies to validation/final checks or grants full-check reuse. Off by default.
     */
    test_skipper: z.boolean().default(false),
    max_turns: z.number().int().min(1).max(1000).default(40),
    agent_timeout: z.number().positive().max(86_400).default(900),
    seed: z.number().int().default(0),
    /** Open reds that pause new starts; v2 has no error-budget controller (it runs as 999). */
    error_budget: z.number().int().min(0).max(1000).optional(),
    /** Where tasks fork from; the policy decides when absent (v2: the sprout head). */
    snapshot: z.enum(['green', 'head']).optional(),
    merge_drivers: z.enum(['auto', 'union', 'none']).default('auto'),
    queue_hold: z.boolean().default(true),
    /** Which acceptance tests are restored before commits; v2 protects landed ones. */
    protect_tests: z.enum(['own', 'landed']).optional(),
    /** v2: pre-land checks run in parallel and land optimistically, or inside the turn. */
    preland_mode: z.enum(['optimistic', 'locked']).default('optimistic'),
    /** v2: emulated latency of a pre-land check; null means `ci_seconds` (the fair setting). */
    preland_seconds: z.number().min(0).max(3600).nullable().default(null),
    /** v2: how long the race's oracle takes to answer a decision card (emulated human). */
    decision_seconds: z
      .number()
      .min(0)
      .max(24 * 3600)
      .default(30),
    /** v2: who wins a decision card when nobody answers it: the landed spec, the arriving one, or wait. */
    decision_oracle: z.enum(['landed', 'arriving', 'none']).default('landed'),
    /** v2: who answers a card: the oracle after `decision_seconds`, or a human (the decision route). */
    decision_mode: z.enum(['oracle', 'human']).default('oracle'),
    /** v2, human mode: seconds after which the oracle answers instead; null waits for the human. */
    human_timeout_seconds: z
      .number()
      .positive()
      .max(7 * 24 * 3600)
      .nullable()
      .default(null),
    /**
     * v2: what a decision does. `reexecute` (E6): the winner stays landed, a test author amends
     * the loser's acceptance tests to the decided spec and the loser is re-executed (or, when
     * the arriving bean wins, the landed loser's tests are amended in place). `decline` (v2.0):
     * the arriving bean is dropped.
     */
    decision_outcome: z.enum(['reexecute', 'decline']).default('reexecute'),
    /**
     * v2: whether a bean whose check passed on a sprout that has since moved is checked again
     * when the beans that landed meanwhile share a file with it (`PRELAND_RECHECK`). `sampled`
     * (v2.3) re-checks until 5 re-checks in a row are green, then skips all but 1 in 4; a red
     * re-check or a red sprout starts it re-checking again. `adaptive` (v2.2) skips while recent
     * pre-land reds are rare.
     */
    recheck: z.enum(['file', 'never', 'hunk', 'adaptive', 'sampled']).default('sampled'),
    /** v2: what `sampled` and `adaptive` do when they re-check (`PRELAND_ADAPT_FALLBACK`). */
    recheck_fallback: z.enum(['file', 'hunk']).default('file'),
    /**
     * v2.3: at most W beans land above the last validated sprout commit; a green bean beyond
     * the window waits. W starts at `window_start` (8; v2.3: 4), grows by `window_growth` (2)
     * per green validation to `window_max` (16) and halves on a red sprout to `window_min` (2).
     * `off` lands every green bean at once (v2.2).
     */
    window: z.enum(['aimd', 'off']).default('aimd'),
    /** v2: free the agent while its bean is checked; reworks resume its session on a free slot. */
    release_on_check: z.boolean().optional(),
    /** v2: re-run a red validation before revert-first; revert only if the same test file fails again. */
    flake_confirm: z.boolean().default(true),
    /**
     * v2: a pre-land red that is the sprout's, not the bean's, costs no rework round: the bean
     * waits for the sprout to move and checks again (at most 3 times). `validation` (E6, v2.2):
     * every failing test already failed a validation of the sprout it was checked on.
     * `readset` (v2.3) also clears a failing test the bean did not touch: neither the test file
     * nor any file it imports changed in the bean.
     */
    inherited_reds: z.enum(['readset', 'validation', 'off']).default('readset'),
    /**
     * v2.3: two beans' inherited reds on the same sprout commit (or one and a red validation)
     * prove the sprout red: revert-first starts at once, without the validation queue or its
     * flake re-run.
     */
    early_tickets: z.boolean().default(true),
    /**
     * v2.4: before a card, a test author reconciles the two tasks' acceptance tests: it may
     * update assertions that pin a value the other intent legitimately changes. Only a genuine
     * contradiction raises the card. Also re-checks, without a rework round, a red whose
     * failing tests belong to a task reverted after the check began. `false`: v2.3.
     */
    reconcile: z.boolean().default(true),
    /**
     * v2.5: failed informed repairs against one landed counterpart before the bean escalates
     * (reconcile, then a card; a counterpart already reconciled and decided drops the bean).
     * `1`: after one, when a failing test file fails again. `2` (v2.4): after two, whatever failed.
     */
    escalate_after: z.number().int().min(1).max(2).default(1),
    /**
     * v2.5: landed tasks a reconcile takes in: the counterpart, then the owners of the failing
     * tests and the read-set suspects since the bean's base. `1`: the counterpart only (v2.4).
     */
    reconcile_parties: z.number().int().min(1).max(3).default(3),
    /**
     * v2.5: when the read sets narrow a red sprout's suspects to one commit, revert it at once
     * instead of bisecting the unvalidated range (the flake re-run and the validation after
     * the revert still apply). `false`: bisect as the harness does.
     */
    single_suspect_revert: z.boolean().default(true),
    /**
     * v2.5: a sprout validation waiting for a CI slot goes ahead of queued bisect probes. Off
     * by default: in the simulator it slowed red episodes (the head it validates still holds
     * the culprit) and, with `single_suspect_revert`, there is rarely a bisect to overtake.
     */
    validation_first: z.boolean().default(false),
    /**
     * v2.5: a pre-land red names a culprit that landed before the bean started (it is in the
     * bean's base) when the failing tests' read set points to it, after the beans that
     * landed since. `false`: only beans since the bean's base are named.
     */
    base_culprits: z.boolean().default(true),
    /** v2.5: the sprout window's size at the start (`window: aimd`). */
    window_start: z.number().int().min(1).max(256).default(WINDOW_DEFAULTS.start),
    /** v2.5: how much the window grows per green validation. */
    window_growth: z.number().int().min(0).max(256).default(WINDOW_DEFAULTS.growth),
    /** v2.5: the window's largest size. */
    window_max: z.number().int().min(1).max(256).default(WINDOW_DEFAULTS.max),
    /** v2.5: the floor a red sprout halves the window to. */
    window_min: z.number().int().min(1).max(256).default(WINDOW_DEFAULTS.min),
    /**
     * v2.5 (E6): a bean with a declared semantic coupling (`couplings`, type `semantic`) to a
     * landed task raises the decision card when it starts, before any work; against a declared
     * partner still in flight, the first red check that names it goes to reconcile (or the card).
     */
    start_cards: z.boolean().default(true),
    /**
     * v2.5 (E6 `RESCUE`): a bean whose rework rounds run out is re-executed once from scratch
     * on the sprout head, in a fresh session, before it is dropped.
     */
    rescue: z.boolean().default(true),
    /**
     * v2.5 (E6 `DYNAMIC_CULPRITS`): when a bean's own acceptance tests fail its check, the landed
     * beans whose files the failing tests read (declared partners first, then newest, at most 6,
     * no more at once than `ci_slots`), wherever they landed, are confirmed by leave-one-out
     * probes of the checked tree. Confirmed beans replace the read-set guess among commits since
     * the bean's snapshot. One search per bean and set of named counterparts; none once the
     * named counterparts include one a card decided.
     */
    dynamic_culprits: z.boolean().default(true),
    /**
     * v2.5 (E1): before a task's implementer starts, a separate test author writes the task's
     * acceptance tests from its intent; files that fail on the task's base (fail-first) replace
     * the given tests as the task's protected acceptance tests. No failing file: the given
     * tests stay.
     */
    tests_first: z.boolean().default(false),
    /**
     * v2.5 (E1): a bean about to land on a sprout that moved since its check, without a full
     * re-check, first runs a targeted check on the exact landing tree: its own tests, the tests
     * of the beans that landed meanwhile, and known tests whose read set meets its files.
     */
    targeted_landing_check: z.boolean().default(false),
    /**
     * v2.5: a squash that git's line merge conflicts is retried with the runner's structural
     * tier (Mergiraf) on the conflicted paths before it counts as a conflict. v2 only, on by
     * default; the queue never uses it, so it stays the harness's baseline (`false`: v2.4).
     */
    structural_merge: z.boolean().optional(),
    /**
     * Approval rules by kind of change (`approval-policy.ts`): each bean's pre-land check first
     * reads `.gitstalk/policy.toml` from the stalk, classifies the bean, enforces writer limits
     * and holds `card` beans for a person's approval; every route leaves a receipt. Absent or
     * `false`: off, as every run before it (no preset turns it on).
     */
    approval_rules: z.boolean().optional(),
    /**
     * v2: which unstarted bean a free agent takes. `fifo`: priority order. `dependency`: a bean
     * whose predicted footprint and declared couplings clash with no bean in flight and no
     * earlier unlanded bean, longest dependent chain first, with an age bound
     * (`v2-start-order`).
     */
    start_order: z.enum(['fifo', 'dependency']).default('fifo'),
    /**
     * v2 opt-in track: when a bean lands, beans whose agents were working meanwhile get it at
     * their next safe point, the end of their current invocation. A clean merge goes to the
     * agent as a short `sync` turn (its session, the new sprout merged) before the pre-land
     * check; a conflicting one becomes a note on the conflict rework's prompt. `overlap`: only
     * beans whose files (union-merged files aside) or declared couplings meet the landed bean;
     * `all`: every bean that worked while something landed. `off`: as before.
     */
    live_sync: z.enum(['off', 'overlap', 'all']).default('off'),
    /**
     * v2 opt-in track: sync during the agent's work, not only at its end. While an invocation
     * runs, its progress replies offer the beans that landed meanwhile and meet its bean (the
     * `live_sync` rule: `all` if `live_sync` is `all`, else `overlap`); the driver's hook in
     * the agent's session merges the sprout between tool calls when that is safe, or only
     * tells the agent. Independent of `live_sync`. `false`: as before.
     */
    live_sync_midrun: z.boolean().default(false),
    /**
     * v2.5 tail fix: agent invocations one bean may use in all (its initial run, informed and
     * conflict reworks, reconciles, test authors, re-executions, the rescue). A bean whose
     * check fails after that many is dropped, whatever reset its rounds. `0`: no ceiling.
     */
    max_bean_invocations: z.number().int().min(0).max(100).default(10),
    /**
     * v2.5 tail fix: when every bean still in play has failed a check and none has made
     * progress (a failing set it had not seen, or any landing) for this many minutes, each is
     * dropped (with `park`: parked) at its next failed check, so the run ends. `0`: off.
     * v2.5 ran with 10; parking made it 3.
     */
    tail_guard_minutes: z.number().min(0).max(1440).default(3),
    /**
     * v2 parking: a bean that needs a person (a decided contradiction still red, the invocation
     * ceiling, the tail guard, a human-mode card nobody answers) is parked, not retried or
     * dropped. The race finishes when every bean is green, dropped or parked; parked beans do
     * not ship. The queue ignores it. `false`: drop as v2.5 did.
     */
    park: z.boolean().default(true),
    /**
     * Stall fix (the 30-agent post-mortem): a red validation whose culprit no lone-suspect
     * revert removes cleanly resets the sprout to the last green commit (a new commit with that
     * tree, so the sprout and the stalk only move forward) and requeues the beans that landed
     * after it. They re-run their pre-land checks in their own sandboxes and land again; the
     * culprit is named by its own red re-check and repaired by its author. No CI bisection.
     * `false`: bisect and revert, as v2.5.
     */
    red_reset: z.boolean().default(true),
    /**
     * Stall fix: one ticket per red episode. While a ticket is open below it, a red validation
     * opens no ticket and runs no flake re-run, and a bean checked on a sprout known red whose
     * check fails every file the sprout's validation failed waits for the sprout (an inherited
     * red, not a culprit). `false`: every red with new failures opens its own ticket, as v2.5.
     * Off by default: alone it held beans on an unrevertable red and slowed burst30; with
     * `red_reset` it changed nothing (`docs/claude-opus/11`).
     */
    episode_tickets: z.boolean().default(false),
    /**
     * Stall fix: a bean whose full pre-land check is green on a sprout commit known red (it
     * makes the failing tests pass) lands even when the window is full, and the validation of
     * its landing goes ahead of bisect probes. `false`: it waits for the window, as v2.5.
     * Off by default: it changed no simulated race (`docs/claude-opus/11`).
     */
    repair_landing: z.boolean().default(false),
    /**
     * Check reuse: a sprout commit whose exact commit already passed a full pre-land check (the
     * bean landed on the head it was checked on, so the landed commit is the checked one) is
     * green without a CI validation, as the reset commit is. Only greens are reused: a red
     * still needs its flake re-run. `false`: every sprout head is validated on CI.
     */
    reuse_checks: z.boolean().default(true),
    /**
     * Event-driven promotion (`docs/claude-opus/11`, "Event-driven promotion"): a sprout commit
     * is green without CI when every test of its tree is vouched for by a green full check of
     * some tree (a bean's pre-land check, or a validated or promoted sprout commit) whose
     * difference to it misses the test's read set. Read sets come from the checks
     * (`all_read_sets`); a test without one, a bean without a check, a structural merge no check
     * saw, or a red the sprout already knows means no evidence, and a validation runs.
     */
    evidence_promotion: z.boolean().default(false),
    /**
     * Which read sets count as evidence: `complete` only those the runner marks complete
     * (`read_sets_complete`: every resolved, probed and listed path); `static` also the static
     * import closures the runner reports today (a fixture, snapshot or alias read is invisible
     * to them: the audit is then the safety net).
     */
    evidence_read_sets: z.enum(['complete', 'static']).default('complete'),
    /**
     * With `evidence_promotion`: a commit without full evidence is validated on only the tests
     * no evidence vouches for (the full suite when the tree's tests are not all known). Its CI
     * latency is `ci_overhead_seconds` plus `ci_seconds` times the share of tests it runs.
     */
    affected_validation: z.boolean().default(false),
    /**
     * With `evidence_promotion`: the full suite runs as a background audit of the stalk on an
     * idle CI slot once this many commits were promoted without a full suite since the last
     * one, and always before the race ends. A red audit (confirmed by its re-run) moves the
     * stalk back to the newest fully checked commit and opens a ticket like a red validation.
     * 0: only the audit before the end.
     */
    audit_every: z.number().int().min(0).max(100).default(4),
    /**
     * Coop's validation timing rule: a validation a landing asks for starts after
     * min(`validation_debounce_seconds`, time to the next `validation_tick_seconds` tick), so
     * landings close together share it; one a finished validation asks for starts at once.
     * `false`: a validation starts the moment a CI slot is free.
     */
    validation_debounce: z.boolean().default(false),
    validation_debounce_seconds: z.number().min(0).max(600).default(15),
    validation_tick_seconds: z.number().min(1).max(3600).default(60),
    /**
     * Fixed seconds every CI-slot run adds to `ci_seconds` (a runner's setup, as GitHub Actions'
     * about 12 s); the final check has none. An affected validation pays it in full.
     */
    ci_overhead_seconds: z.number().min(0).max(600).default(0),
    /**
     * Read maps (`research/test-impact`, "Read maps in the runner"): which checks run each test
     * file in its own traced process and store what it read in the RunDO (`read-maps/`).
     * `preland`: the pre-land checks in agents' sandboxes, off the CI slots, so maps stay fresh
     * for free while validations stay untraced (they report their tree's manifest, for
     * staleness). `all`: every check. `off`: none.
     */
    read_maps: z.enum(['off', 'preland', 'all']).default('off'),
    /**
     * With `red_reset`, the burst tail fix: each reset's read-set suspects requeue in a chain of
     * their own (not behind an earlier reset's), the next going as soon as the current one's
     * check is green-and-landed or red (it is then with its author), and two suspects of one
     * reset that are red against each other go to reconcile and a card at once. `false`: one
     * chain for every reset, each suspect waiting until the one before landed or left.
     */
    requeue_repair: z.boolean().default(true),
    max_rework: z.number().int().min(0).max(20).default(3),
    max_fix_attempts: z.number().int().min(1).max(20).default(2),
    max_wall_minutes: z
      .number()
      .positive()
      .max(24 * 60)
      .default(360),
    infra_retry_seconds: z.number().min(0).max(600).default(10),
    rework_resume: z.boolean().default(true),
    shuffle: z.boolean().default(false),
    label: z.string().max(200).nullable().default(null),
    arena: z.string().max(200).default('arena'),
    arena_digest: z.string().max(64).default(''),
    footprint: z.string().max(40).default('none'),
    footprint_threshold: z.number().min(0).max(1).default(0.3),
    footprints: z.record(TaskId, TaskFootprint).default({}),
    /**
     * The test suite every check runs and the test hint every prompt gives (`suite.ts`). The
     * default is the designed arena's bare `node --test`; a real-task arena's driver sends its
     * `arena.json` suite.
     */
    suite: RunSuite.default(DEFAULT_SUITE),
    /**
     * A continuous engine for a persistent repository (`docs/claude-opus/18-git-native-flow.md`):
     * no task list, beans arrive by `git push`, the race never finishes (no wall clock, no
     * watchdog on an invocation waiting for its author's next push). `false`: a race.
     */
    continuous: z.boolean().default(false),
    /**
     * Where a continuous engine's checks come from (`checks-config.ts`, backlog 2.3):
     * `repository` reads `.gitstalk/checks.yml` from every tree it checks; `suite` always runs
     * `suite` (races, and engines an operator opened with a suite). Absent: `checksSourceOf`.
     */
    checks_source: z.enum(['suite', 'repository']).optional(),
    /**
     * A continuous engine's pre-land concurrency: at most this many sandboxes run its beans'
     * checks at once, one bean per sandbox, leased on demand from the gateway's runner pool and
     * released when the check ends (`docs/claude-opus/18-git-native-flow.md` §7). null: the
     * gateway's default (32). A race ignores it: each agent slot has its own sandbox.
     */
    preland_sandboxes: z.number().int().min(1).max(64).nullable().default(null),
    tasks: z.array(ArenaTask).max(200),
  })
  .superRefine((config, issues) => {
    if (config.test_skipper && config.policy !== 'beanstalk-v2') {
      issues.addIssue({
        code: 'custom',
        path: ['test_skipper'],
        message: 'test skipper requires beanstalk-v2',
      });
    }
    const ids = config.tasks.map((task) => task.id);
    if (ids.length === 0 && !config.continuous) {
      issues.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'a race needs at least one task',
      });
    }
    if (new Set(ids).size !== ids.length) {
      issues.addIssue({ code: 'custom', path: ['tasks'], message: 'task ids must be unique' });
    }
    if (config.policy === 'beanstalk-v2' && config.protect_tests === 'own') {
      issues.addIssue({
        code: 'custom',
        path: ['protect_tests'],
        message: 'v2 protects landed acceptance tests',
      });
    }
    if (config.policy === 'beanstalk-v2' && config.snapshot === 'green') {
      issues.addIssue({
        code: 'custom',
        path: ['snapshot'],
        message: 'v2 starts tasks from the sprout head',
      });
    }
    if (config.policy === 'queue' && config.structural_merge === true) {
      issues.addIssue({
        code: 'custom',
        path: ['structural_merge'],
        message: 'the queue merges as the harness does; structural_merge is v2 only',
      });
    }
    if (
      config.policy === 'beanstalk-v2' &&
      config.error_budget !== undefined &&
      config.error_budget !== V2_ERROR_BUDGET
    ) {
      issues.addIssue({
        code: 'custom',
        path: ['error_budget'],
        message: 'v2 has no error-budget controller; leave error_budget unset',
      });
    }
    if (config.policy !== 'beanstalk-v2' && (config.tests_first || config.targeted_landing_check)) {
      issues.addIssue({
        code: 'custom',
        path: ['tests_first'],
        message: 'tests_first and targeted_landing_check are beanstalk-v2 rules',
      });
    }
    if (config.policy !== 'beanstalk-v2' && config.live_sync !== 'off') {
      issues.addIssue({
        code: 'custom',
        path: ['live_sync'],
        message: 'live_sync is a beanstalk-v2 rule',
      });
    }
    if (config.policy !== 'beanstalk-v2' && config.live_sync_midrun) {
      issues.addIssue({
        code: 'custom',
        path: ['live_sync_midrun'],
        message: 'live_sync_midrun is a beanstalk-v2 rule',
      });
    }
    const known = new Set<string>(ids);
    for (const id of Object.keys(config.footprints)) {
      if (!known.has(id)) {
        issues.addIssue({ code: 'custom', path: ['footprints', id], message: 'unknown task id' });
      }
    }
  });

/** A run's configuration: a preset's settings first, then the fields the request gives. */
export const RunConfig = z.preprocess(
  (input, ctx) =>
    withPreset(input, (key, message) => ctx.addIssue({ code: 'custom', path: [key], message })),
  CheckedFields,
);
export type RunConfig = z.infer<typeof RunConfig>;
export type RunConfigInput = z.input<typeof CheckedFields>;

/** The stall fix of the 30-agent post-mortem off: v2.5 as the `cf-demo-sonnet-30-s7` race ran it. */
export const STALL_FIX_OFF = {
  red_reset: false,
  episode_tickets: false,
  repair_landing: false,
  requeue_repair: false,
} as const satisfies Partial<RunConfigInput>;

/**
 * The stall fix as the simulator chose it (`docs/claude-opus/11`, "30-agent post-mortem" and
 * "Check reuse and the burst tail"): the red-window reset on with its requeue repair; one
 * ticket per episode and repair landings measured and left off.
 */
export const STALL_FIX_ON = {
  red_reset: true,
  episode_tickets: false,
  repair_landing: false,
  requeue_repair: true,
} as const satisfies Partial<RunConfigInput>;

/** Check reuse off (`reuse_checks`): every sprout head is validated on CI, as before it existed. */
export const CHECK_REUSE_OFF = { reuse_checks: false } as const satisfies Partial<RunConfigInput>;

/** Check reuse on: a landed commit its own full pre-land check passed is green without CI. */
export const CHECK_REUSE_ON = { reuse_checks: true } as const satisfies Partial<RunConfigInput>;

/**
 * Every v2.5 rule off: on top of the defaults, these settings run v2.4 again (the CF v2.4
 * races' engine). Each v2.5 phase turns some back on
 * (`docs/claude-opus/31-gateway-engine-internals.md`, "Version labels").
 */
export const V25_RULES_OFF = {
  escalate_after: 2,
  reconcile_parties: 1,
  single_suspect_revert: false,
  validation_first: false,
  base_culprits: false,
  window_start: 4,
  start_cards: false,
  rescue: false,
  dynamic_culprits: false,
  structural_merge: false,
  max_bean_invocations: 0,
  tail_guard_minutes: 0,
  park: false,
  ...STALL_FIX_OFF,
  ...CHECK_REUSE_OFF,
} as const satisfies Partial<RunConfigInput>;

/** v2.4 (the CF v2.4 races): every v2.5 rule off. A run with these reports `"v2.4"`. */
export const V24_SETTINGS = { ...V25_RULES_OFF } as const satisfies Partial<RunConfigInput>;

/**
 * Every v2.5 rule at its v2.5 value, the tail fix's two bounds included: the defaults when this
 * was written, pinned so a later default cannot change a run that names them. `structural_merge`
 * is pinned for v2 only (`pinnedSettings`): the queue never merges structurally.
 */
export const V25_SETTINGS = {
  escalate_after: 1,
  reconcile_parties: 3,
  single_suspect_revert: true,
  validation_first: false,
  base_culprits: true,
  window_start: WINDOW_DEFAULTS.start,
  start_cards: true,
  rescue: true,
  dynamic_culprits: true,
  structural_merge: true,
  max_bean_invocations: 10,
  tail_guard_minutes: 10,
  park: false,
  ...STALL_FIX_OFF,
  ...CHECK_REUSE_OFF,
} as const satisfies Partial<RunConfigInput>;

/**
 * The demo engine: `V25_SETTINGS` (the CF races `cf-v25dep2-sonnet-12-s7`, `-s11`, `-s13`) with
 * dependency-aware starts (`start_order`), parking (`park`), the 30-agent stall fix
 * (`red_reset` with `requeue_repair`), check reuse (`reuse_checks`) and the tail guard
 * tightened from 10 to 3 minutes. The opt-in tracks it does not use are pinned off.
 */
export const DEMO_SETTINGS = {
  ...V25_SETTINGS,
  park: true,
  tail_guard_minutes: 3,
  start_order: 'dependency',
  tests_first: false,
  targeted_landing_check: false,
  live_sync: 'off',
  live_sync_midrun: false,
  ...STALL_FIX_ON,
  ...CHECK_REUSE_ON,
} as const satisfies Partial<RunConfigInput>;

/**
 * A continuous engine's settings: the demo engine's rules, with what a person or an agent
 * pushing by hand needs instead of a race's bounds. No tail guard and no invocation ceiling (a
 * bean is reworked by its author's pushes, as often as it takes), no emulated CI latency, the
 * repository kept, and enough slots for the beans in flight at once (each pushed bean holds a
 * slot while it waits for its author).
 */
export const CONTINUOUS_SETTINGS = {
  ...DEMO_SETTINGS,
  continuous: true,
  tail_guard_minutes: 0,
  max_bean_invocations: 0,
  max_rework: 20,
  agent_timeout: 86_400,
  ci_seconds: 0,
  preland_seconds: 0,
  keep_repo: true,
  agents: 32,
} as const satisfies Partial<RunConfigInput>;

/**
 * Where a run's checks come from: its `checks_source`, else the repository's file for a
 * continuous engine that still has the default suite (every repository opened from the
 * registry), and `suite` for races and engines opened with an operator's suite.
 */
export function checksSourceOf(
  config: Pick<RunConfig, 'checks_source' | 'continuous' | 'suite'>,
): 'suite' | 'repository' {
  if (config.checks_source !== undefined) return config.checks_source;
  const isDefaultSuite = JSON.stringify(config.suite) === JSON.stringify(DEFAULT_SUITE);
  return config.continuous && isDefaultSuite ? 'repository' : 'suite';
}

/**
 * Whether a run judges beans by approval rules: its `approval_rules`, else on for a
 * repository's engine (whose rules are its own `policy.toml`; no file routes every bean `auto`,
 * as before) and off for races, so every benchmark replays as before.
 */
export function approvalRulesOf(
  config: Pick<RunConfig, 'approval_rules' | 'checks_source' | 'continuous' | 'suite'>,
): boolean {
  return config.approval_rules ?? checksSourceOf(config) === 'repository';
}

/** What each preset pins. */
export const RUN_PRESETS = {
  demo: DEMO_SETTINGS,
  v24: V24_SETTINGS,
} as const satisfies Record<RunPreset, Partial<RunConfigInput>>;

/** Pinned fields that only `beanstalk-v2` accepts with a true value; another policy runs without them. */
const V2_ONLY_PINS: readonly string[] = ['structural_merge'];

/** What a preset pins for a policy: everything for v2; for the queue, all but the v2-only rules. */
export function pinnedSettings(
  preset: RunPreset,
  policy: unknown,
): Readonly<Record<string, unknown>> {
  const pinned: Readonly<Record<string, unknown>> = RUN_PRESETS[preset];
  if (policy === 'beanstalk-v2') return pinned;
  return Object.fromEntries(
    Object.entries(pinned).filter(
      ([key, value]) => !(V2_ONLY_PINS.includes(key) && value === true),
    ),
  );
}

/** The preset's settings under the request's fields; a request that contradicts its preset is refused. */
function withPreset(input: unknown, refuse: (key: string, message: string) => void): unknown {
  if (!isFields(input)) return input;
  const fields = input;
  const preset = RunPreset.safeParse(fields['preset']);
  if (!preset.success) return input;
  const pinned = pinnedSettings(preset.data, fields['policy']);
  for (const [key, value] of Object.entries(pinned)) {
    if (key in fields && fields[key] !== value)
      refuse(key, `preset ${preset.data} pins ${key} to ${String(value)}`);
  }
  return { ...pinned, ...fields };
}

function isFields(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/** v2.3: v2.4 without the reconcile. */
export const V23_SETTINGS = {
  ...V25_RULES_OFF,
  reconcile: false,
} as const satisfies Partial<RunConfigInput>;

/** v2.2: adaptive re-checks, no window, validation-only inherited reds, no early tickets. */
export const V22_SETTINGS = {
  ...V25_RULES_OFF,
  recheck: 'adaptive',
  window: 'off',
  inherited_reds: 'validation',
  early_tickets: false,
  reconcile: false,
} as const satisfies Partial<RunConfigInput>;

/**
 * v2.0 (the harness's v2): replay parity, byte for byte (`parity.test.ts`), with every later
 * rule and every opt-in track off.
 */
export const V20_SETTINGS = {
  ...V25_RULES_OFF,
  recheck: 'file',
  release_on_check: false,
  flake_confirm: false,
  inherited_reds: 'off',
  window: 'off',
  early_tickets: false,
  reconcile: false,
  decision_outcome: 'decline',
  tests_first: false,
  targeted_landing_check: false,
  start_order: 'fifo',
} as const satisfies Partial<RunConfigInput>;

/** The harness default for `--error-budget`, and what v2 runs with (`--error-budget 999`). */
const DEFAULT_ERROR_BUDGET = 3;
const V2_ERROR_BUDGET = 999;

/** `--error-budget` as the run reports it: v2 runs without the controller (999). */
export function errorBudget(config: Pick<RunConfig, 'policy' | 'error_budget'>): number {
  if (config.policy === 'beanstalk-v2') return V2_ERROR_BUDGET;
  return config.error_budget ?? DEFAULT_ERROR_BUDGET;
}

/** Which acceptance tests the driver restores before a commit (`--protect-tests`). */
export function protectTestsMode(
  config: Pick<RunConfig, 'policy' | 'protect_tests'>,
): 'own' | 'landed' {
  return config.protect_tests ?? (config.policy === 'beanstalk-v2' ? 'landed' : 'own');
}

/** Where a task forks from (`--snapshot`): v2 always starts from the sprout head (`head`). */
export function snapshotMode(config: Pick<RunConfig, 'policy' | 'snapshot'>): 'green' | 'head' {
  return config.snapshot ?? (config.policy === 'beanstalk-v2' ? 'head' : 'green');
}

/** Whether an agent is freed while its bean is checked (E5): on by default for v2. */
export function releasesOnCheck(config: Pick<RunConfig, 'policy' | 'release_on_check'>): boolean {
  return config.release_on_check ?? config.policy === 'beanstalk-v2';
}

/**
 * Whether the runner retries a conflicted squash with its structural tier: v2 (unless
 * `structural_merge: false`), never the queue, so the queue stays the harness's baseline.
 */
export function usesStructuralMerge(
  config: Pick<RunConfig, 'policy' | 'structural_merge'>,
): boolean {
  return config.policy === 'beanstalk-v2' && config.structural_merge !== false;
}

/** v2's pre-land check latency: `preland_seconds`, or the CI latency when unset. */
export function prelandSeconds(config: Pick<RunConfig, 'preland_seconds' | 'ci_seconds'>): number {
  return config.preland_seconds ?? config.ci_seconds;
}

/** The harness's `RaceConfig.union()`: CHANGELOG files merge with `merge=union`. */
export function usesUnionMerge(config: Pick<RunConfig, 'merge_drivers' | 'policy'>): boolean {
  if (config.merge_drivers === 'auto') return config.policy !== 'queue';
  return config.merge_drivers === 'union';
}

/** The `.git/info/attributes` patterns the harness writes when the union driver is on. */
export const UNION_PATTERNS: readonly string[] = [
  'CHANGELOG.md',
  'CHANGELOG*.md',
  '**/CHANGELOG.md',
];

/** Paths (git attribute patterns) that merge with the union driver in this run. */
export function unionPaths(config: Pick<RunConfig, 'merge_drivers' | 'policy'>): readonly string[] {
  return usesUnionMerge(config) ? UNION_PATTERNS : [];
}
