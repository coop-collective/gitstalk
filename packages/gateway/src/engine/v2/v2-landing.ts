/**
 * A bean's way onto the sprout (plan §6 steps 2-3; `land` and `try_optimistic` of
 * `policy_beanstalk_preland.py` in optimistic mode, with v2.2's re-check rule):
 *
 * 1. Squash the bean onto the sprout head it sees (`head0`) and run the suite on that tree
 *    in the agent's sandbox, outside the turn, in parallel with every other bean. With
 *    `release_on_check` the bean's agent is free from the moment the bean is submitted.
 * 2. Green: take the turn, when the sprout window has room (`window: aimd`, v2.3); else wait,
 *    oldest first. The sprout did not move: land. It moved: squash again; land without
 *    re-checking when the commits that landed meanwhile share no file with the bean, or when
 *    the re-check rule lets it through (`recheck`: `sampled` once re-checks keep coming back
 *    green, `adaptive` while pre-land reds are rare, `hunk` when the changed lines are apart,
 *    `never`); otherwise check again. A re-squash the runner merged structurally is always checked
 *    again. After three re-checks the check runs inside the turn.
 * 3. Red or a conflict: the bean goes back to its author (`v2-repair`), until `max_rework`.
 *    A red that is the sprout's (`inherited_reds`) costs no round: the bean waits for the
 *    sprout to move and checks again (at most three times). It is the sprout's when a
 *    validation already failed the same tests (E6), or (v2.3, `readset`) when the bean
 *    touched neither a failing test nor anything it imports. Two beans' inherited reds on one
 *    sprout commit prove the sprout red: revert-first starts at once (`early_tickets`).
 */
import type { Sha, TaskId } from '@gitstalk/shared-race/ids';
import { prelandSeconds, unionPaths, usesStructuralMerge } from '@gitstalk/shared-race/run-config';

import { markAborted } from '../abort';
import { isRunnableTest } from '../arena';
import { failingTestNames } from '../ci';
import type { ReworkOutcome } from '../context';
import { acceptanceTests, emit, requireTask, setTimer, startJob, taskDefinition } from '../context';
import { EngineInvariantError, assertNever } from '../errors';
import type { CheckResult, ConflictHunk, JobId, JobResult, LineRanges } from '../model';
import { roundTo } from '../numbers';
import { beanstalkLandMessage } from '../prompts';
import { SPROUT_REF } from '../refs';
import { holderOf, release } from '../slots';
import { recordLanding, taskBranch } from '../tasks';
import { releaseAgent, requestAgent } from './v2-agents';
import { settleCarried } from './v2-amendments';
import {
  isSproutRepairing,
  isWindowOn,
  logWindowWait,
  onSproutRed,
  recordRecheck,
  sampledRecheck,
  windowAdmits,
} from './v2-backpressure';
import { boundedEnd, searchEnded, startProgress } from './v2-bounds';
import { rememberGreenCheck } from './v2-check-reuse';
import { GLOBAL_FILE, isEvidenceOn, rememberCheck } from './v2-evidence';
import { onProbeJob, repairWithCulprits } from './v2-culprits';
import { endLanding, latencyTimerKey, parkLanding, requireFlow } from './v2-flows';
import { onReconcileRead } from './v2-reconcile';
import { rescueOnExhaustion } from './v2-rescue';
import { repointBranch } from './v2-reset';
import { partnerMovedSince } from './v2-start';
import { holdForSync, isLiveSync, syncAtBoundary } from './v2-sync';
import {
  appendCommit,
  awaitOutcome,
  filesLandedSince,
  knownRedFiles,
  lastTaskCommit,
  sproutIndex,
  unvalidatedCount,
} from './v2-sprout';
import type { LandingFlow, LandingStep, V2State, V2Step } from './v2-state';
import { isInRedEpisode, openTicket } from './v2-tickets';
import { releaseTurn, requestTurn } from './v2-turn';
import { confirmBySighting, newFailures } from './v2-validator';

/** Re-checks in one attempt before the check moves inside the turn (`rechecks >= 3`). */
const MAX_RECHECKS = 3;
/** Failing tests listed in `preland.check` (`[:20]`). */
const PRELAND_FAILING_TESTS = 20;
/** Pre-land outcomes the `adaptive` rule looks at (`PRELAND_ADAPT_WINDOW`). */
const ADAPT_WINDOW = 20;
/** Outcomes it needs before it may skip a re-check (`min(5, window)`). */
const ADAPT_MIN_CHECKS = 5;
/** The red share under which it skips (`PRELAND_ADAPT_RED`). */
const ADAPT_RED_SHARE = 0.1;
/** Lines between two changes that still count as touching (`PRELAND_HUNK_MARGIN`). */
const HUNK_MARGIN = 3;
/** Targeted checks outside the turn in one attempt; the next runs inside it (v2.5). */
const MAX_TARGETED_OUTSIDE = 1;
/** Emulated latency of a targeted check (E1's `MERGED_SECONDS`), capped at the pre-land latency. */
const TARGETED_SECONDS = 10;
/** Inherited reds a bean waits out before its red checks cost rounds again (E6). */
const MAX_INHERITED_WAITS = 3;

type CheckStep = Extract<LandingStep, { kind: 'check' }>;
type Candidate = Pick<CheckStep, 'head0' | 'candidate' | 'files' | 'mine'>;
type Failure =
  | {
      readonly kind: 'conflict';
      readonly head: Sha;
      readonly files: readonly string[];
      readonly hunks: readonly ConflictHunk[];
    }
  | {
      readonly kind: 'red';
      readonly head: Sha;
      readonly red: CheckResult;
      readonly mine: readonly string[] | null;
      /** The squashed tree the check ran on (dynamic culprits probe it). */
      readonly candidate: Sha;
    };
type Optimistic = {
  readonly head0: Sha;
  readonly head: Sha;
  readonly sha: Sha;
  readonly files: string[];
  readonly mine: string[] | null;
  readonly landedMeanwhile: number;
};

/** The bean's first commit is in: its landing loop starts. */
export function startLanding(step: V2Step, task: TaskId): void {
  const slot = requireTask(step.ctx, task).agent;
  if (slot === null) throw new EngineInvariantError(`${task} landed without an agent slot`);
  step.state.landings[task] = {
    task,
    slot,
    rounds: 0,
    rechecks: 0,
    inheritedWaits: 0,
    targeted: 0,
    resolved: 'textual',
    step: { kind: 'queued-locked' },
    ...syncDueAfterInvocation(step),
  };
  startProgress(step, task);
  attempt(step, task);
}

/** One iteration of `land`'s loop: the agent is released, then the first try. */
export function attempt(step: V2Step, task: TaskId): void {
  const flow = requireFlow(step.state, task);
  flow.rechecks = 0;
  flow.targeted = 0;
  delete flow.voucher;
  if (!holdForSync(step, flow)) releaseAgent(step, flow);
  if (step.ctx.env.config.preland_mode === 'locked') {
    flow.step = { kind: 'queued-locked' };
    requestTurn(step, { kind: 'landing', task });
    return;
  }
  squashOntoSprout(step, flow);
}

/** A runner job of a landing flow returned; stale results (an older step) are ignored. */
export function onLandingJob(step: V2Step, task: TaskId, jobId: JobId, result: JobResult): void {
  const flow = step.state.landings[task];
  if (flow === undefined) return;
  const current = flow.step;
  switch (current.kind) {
    case 'squash':
      if (current.jobId === jobId) onSquashed(step, flow, current.head0, result);
      return;
    case 'repoint':
      if (current.jobId === jobId) onRepointed(step, flow, current, result);
      return;
    case 'check':
      if (current.jobId === jobId) onChecked(step, flow, current, result);
      return;
    case 'resquash':
      if (current.jobId === jobId) onResquashed(step, flow, current, result);
      return;
    case 'hunks':
      if (current.jobId === jobId) onHunks(step, flow, current, result);
      return;
    case 'locked-squash':
      if (current.jobId === jobId) onLockedSquashed(step, flow, current.head, result);
      return;
    case 'publish':
      if (current.jobId === jobId) onPublished(step, flow, current, result);
      return;
    case 'reconcile-reading':
      if (current.jobId === jobId) onReconcileRead(step, flow, current, result);
      return;
    case 'culprit-probe':
      onProbeJob(step, flow, current, { jobId, result });
      noteSearchEnd(step, flow);
      return;
    case 'queued-land':
    case 'queued-locked':
    case 'inherited':
    case 'window-wait':
    case 'reconciling':
    case 'diffs':
    case 'awaiting-agent':
    case 'syncing':
    case 'rework':
    case 'decision':
    case 'card-context':
    case 'authoring':
    case 'reading':
    case 'fail-first':
      return;
    default:
      assertNever(current);
  }
}

/**
 * A landing job failed for good (after the engine's retries): only this bean is dropped,
 * and the turn is freed if it held it. A failed sprout update is not contained: the sprout
 * may have moved, which concerns every bean.
 */
export function onLandingJobFailed(
  step: V2Step,
  task: TaskId,
  failure: { jobId: JobId; error: string },
): boolean {
  const flow = step.state.landings[task];
  if (flow === undefined) return true;
  const current = flow.step;
  if (current.kind === 'culprit-probe') {
    onProbeJob(step, flow, current, { jobId: failure.jobId, result: null });
    noteSearchEnd(step, flow);
    return true;
  }
  if (!('jobId' in current) || current.jobId !== failure.jobId) return true;
  if (current.kind === 'publish') return false;
  const isHoldingTurn =
    current.kind === 'resquash' ||
    current.kind === 'hunks' ||
    current.kind === 'locked-squash' ||
    (current.kind === 'check' && current.isInTurn);
  endLanding(step, task, `infrastructure failure: ${failure.error}`);
  if (isHoldingTurn) releaseTurn(step);
  return true;
}

/** A dynamic-culprit probe returned: when the search is over, the tail guard's clock restarts. */
function noteSearchEnd(step: V2Step, flow: LandingFlow): void {
  if (flow.step.kind !== 'culprit-probe') searchEnded(step, flow.task);
}

/** The emulated latency of a pre-land check elapsed. */
export function onLatencyElapsed(step: V2Step, task: TaskId): void {
  const flow = step.state.landings[task];
  if (flow?.step.kind !== 'check' || flow.step.result === null) return;
  finishCheck(step, flow, flow.step);
}

/** The turn came to a waiting bean. */
export function onLandingTurn(step: V2Step, task: TaskId): void {
  const flow = step.state.landings[task];
  const current = flow?.step;
  if (flow === undefined || current === undefined) {
    releaseTurn(step);
    return;
  }
  if (current.kind === 'queued-land') {
    landInTurn(step, flow, current);
    return;
  }
  if (current.kind === 'queued-locked') {
    squashInTurn(step, flow);
    return;
  }
  releaseTurn(step);
}

/**
 * The author's rework finished (`resolve_on` / `repair_before_landing` after the agent):
 * committed work tries again; an unresolved replay, markers or a missing commit drop it.
 */
export function onReworkDone(step: V2Step, outcome: ReworkOutcome): void {
  const flow = step.state.landings[outcome.task];
  if (flow?.step.kind !== 'rework') return;
  if (outcome.subtype === 'unresolved') {
    endLanding(step, flow.task, unresolvedReason(flow.step.reason));
    return;
  }
  if (outcome.markersLeft.length > 0) {
    emit(step.ctx, 'rework.markers_left', {
      task: flow.task,
      ticket: null,
      files: [...outcome.markersLeft],
    });
    endLanding(step, flow.task, 'unresolved conflict after --max-rework attempts');
    return;
  }
  if (!outcome.committed) {
    endLanding(step, flow.task, `driver reported no commit for ${outcome.inv}`);
    return;
  }
  requireTask(step.ctx, flow.task).status = 'running';
  Object.assign(flow, syncDueAfterInvocation(step));
  attempt(step, flow.task);
}

/** `live_sync` in optimistic mode: an agent just finished, so the next squash may sync it. */
function syncDueAfterInvocation(step: V2Step): Pick<LandingFlow, 'syncDue'> {
  const isDue = isLiveSync(step.state) && step.ctx.env.config.preland_mode === 'optimistic';
  return isDue ? { syncDue: true } : {};
}

function unresolvedReason(reason: 'conflict' | 'preland-red' | 'decision' | 'rescue'): string {
  switch (reason) {
    case 'conflict':
      return 'replay could not resolve the conflict (limitation of replay agents)';
    case 'preland-red':
      return 'replay could not repair the pre-land failure (limitation of replay agents)';
    case 'decision':
      return 'replay could not re-execute under the decision (limitation of replay agents)';
    case 'rescue':
      return 'replay could not re-execute the rescued bean (limitation of replay agents)';
    default:
      return assertNever(reason);
  }
}

/**
 * `red_reset`: a requeued bean's branch is back on its own head (or already was): its landing
 * attempt starts. A lease that found another commit is retried once from that commit.
 */
function onRepointed(
  step: V2Step,
  flow: LandingFlow,
  repoint: Extract<LandingStep, { kind: 'repoint' }>,
  result: JobResult,
): void {
  if (result.kind !== 'update-ref') throw new EngineInvariantError(`update-ref got ${result.kind}`);
  const found = result.ok ? null : result.actual;
  if (found !== null && found !== repoint.to && !repoint.isRetry) {
    repointBranch(step, flow, { to: repoint.to, from: found, isRetry: true });
    return;
  }
  attempt(step, flow.task);
}

/** Step 1: squash onto the sprout head as it is now, outside the turn. */
function squashOntoSprout(step: V2Step, flow: LandingFlow): void {
  const head0 = step.state.sprout;
  flow.step = { kind: 'squash', head0, jobId: squash(step, flow.task, head0) };
}

function squash(step: V2Step, task: TaskId, onto: Sha): JobId {
  const { ctx } = step;
  const base = requireTask(ctx, task).mergedMain;
  if (base === null) throw new EngineInvariantError(`${task} has no merge base`);
  const jobId = startJob(
    ctx,
    {
      kind: 'squash',
      onto,
      changeKey: task,
      changeRef: `refs/heads/${taskBranch(task)}`,
      changeBase: base,
      message: beanstalkLandMessage(taskDefinition(ctx, task)),
      unionPaths: unionPaths(ctx.env.config),
      structural: usesStructuralMerge(ctx.env.config),
    },
    { kind: 'policy' },
  );
  awaitOutcome(step.state, jobId, { kind: 'landing', task });
  return jobId;
}

function onSquashed(step: V2Step, flow: LandingFlow, head0: Sha, result: JobResult): void {
  if (result.kind !== 'squash') throw new EngineInvariantError(`squash got ${result.kind}`);
  if (flow.syncDue === true) {
    if (syncAtBoundary(step, flow, { head0, result })) return;
    releaseAgent(step, flow);
  }
  if (result.outcome === 'conflict') {
    attemptFailed(step, flow, {
      kind: 'conflict',
      head: head0,
      files: result.files,
      hunks: result.hunks,
    });
    return;
  }
  flow.resolved = result.resolved;
  if (flow.rechecks >= MAX_RECHECKS) {
    step.state.stats.preland_locked_fallbacks += 1;
    flow.step = { kind: 'queued-locked' };
    requestTurn(step, { kind: 'landing', task: flow.task });
    return;
  }
  startCheck(step, flow, { isInTurn: false, targets: null, ...candidateOf(head0, result) });
}

function candidateOf(head0: Sha, result: Extract<JobResult, { kind: 'squash' }>): Candidate {
  if (result.outcome !== 'clean') throw new EngineInvariantError('a conflict has no candidate');
  return {
    head0,
    candidate: result.sha,
    files: [...result.files],
    mine: result.changeFiles === null ? null : [...result.changeFiles],
  };
}

/**
 * The suite (or, v2.5, only `targets`) on a squashed candidate, in the agent's sandbox with
 * a read-only token.
 */
function startCheck(
  step: V2Step,
  flow: LandingFlow,
  check: Candidate & { isInTurn: boolean; targets: string[] | null },
): void {
  const jobId = startJob(
    step.ctx,
    {
      kind: 'check',
      sha: check.candidate,
      extraFiles: null,
      instance: { kind: 'sandbox', slot: flow.slot },
      ...(check.targets === null ? {} : { only: check.targets }),
      ...(step.ctx.env.config.targeted_landing_check || isEvidenceOn(step.state)
        ? { allReadSets: true }
        : {}),
    },
    { kind: 'policy' },
  );
  awaitOutcome(step.state, jobId, { kind: 'landing', task: flow.task });
  flow.step = {
    kind: 'check',
    ...check,
    isRecheck: check.targets === null && flow.rechecks > 0,
    jobId,
    startedAt: step.ctx.now,
    result: null,
  };
}

function onChecked(step: V2Step, flow: LandingFlow, check: CheckStep, result: JobResult): void {
  if (result.kind !== 'check') throw new EngineInvariantError(`check got ${result.kind}`);
  check.jobId = null;
  check.result = result.check;
  const prelandLatency = prelandSeconds(step.ctx.env.config);
  const latency =
    check.targets === null ? prelandLatency : Math.min(TARGETED_SECONDS, prelandLatency);
  if (latency > 0) {
    setTimer(step.ctx, latency, { kind: 'policy', key: latencyTimerKey(flow.task) });
    return;
  }
  finishCheck(step, flow, check);
}

/** `preland_check` returned: log it, then land, queue for the turn, or go back to the author. */
function finishCheck(step: V2Step, flow: LandingFlow, check: CheckStep): void {
  const result = check.result;
  if (result === null) throw new EngineInvariantError('a check finished without a result');
  if (check.isRecheck) recordRecheck(step.state, result.green);
  if (check.targets !== null) countTargeted(step.state, result.green);
  else if (result.green) rememberGreenFull(step, flow, check);
  learnReadSets(step, result);
  const red = { head: check.head0, result, mine: check.mine };
  const isDiscarded = !result.green && isOnDiscardedTree(step.state, check.head0);
  const inherited = isDiscarded ? null : inheritedFailures(step, flow, red);
  logCheck(step, flow.task, check, { result, isInherited: inherited !== null });
  if (inherited !== null) sightInherited(step, flow, { ...red, failing: inherited });
  const stale = isDiscarded ? discardedFailures(result) : [];
  if (!isDiscarded && inherited === null) stale.push(...staleFailures(step, check.head0, result));
  if (check.isInTurn) {
    if (result.green) {
      publish(step, flow, {
        head: check.head0,
        sha: check.candidate,
        files: check.files,
        ...(isRepairLanding(step, check.head0) ? { repair: true } : {}),
      });
      return;
    }
    if (inherited !== null) {
      waitOutInherited(step, flow, { head: check.head0, failing: inherited });
    } else if (stale.length > 0) {
      recheckStale(step, flow, { checkedOn: check.head0, stale });
    } else {
      attemptFailed(step, flow, {
        kind: 'red',
        head: check.head0,
        red: result,
        mine: check.mine,
        candidate: check.candidate,
      });
    }
    releaseTurn(step);
    return;
  }
  if (inherited !== null) {
    waitOutInherited(step, flow, { head: check.head0, failing: inherited });
    return;
  }
  if (stale.length > 0) {
    recheckStale(step, flow, { checkedOn: check.head0, stale });
    return;
  }
  if (!result.green) {
    attemptFailed(step, flow, {
      kind: 'red',
      head: check.head0,
      red: result,
      mine: check.mine,
      candidate: check.candidate,
    });
    return;
  }
  const { head0, candidate, files, mine } = check;
  const isRepair = isRepairLanding(step, head0);
  if (!isRepair && isWindowFull(step, false)) {
    waitForWindow(step, flow, { head0, candidate, files, mine });
    return;
  }
  flow.step = {
    kind: 'queued-land',
    head0,
    candidate,
    files,
    mine,
    ...(isRepair ? { repair: true } : {}),
  };
  requestTurn(step, { kind: 'landing', task: flow.task });
}

/**
 * A full check was green: its candidate is the commit `reuse_checks` may count as validated, and
 * (`evidence_promotion`) the tree whose read sets vouch for the bean's landing.
 */
function rememberGreenFull(step: V2Step, flow: LandingFlow, check: CheckStep): void {
  const { state } = step;
  rememberGreenCheck(state, flow.task, check.candidate);
  if (!isEvidenceOn(state) || check.result === null) return;
  flow.voucher = check.candidate;
  rememberCheck(state, {
    task: flow.task,
    candidate: check.candidate,
    head0: check.head0,
    files: check.files,
    result: check.result,
  });
}

/**
 * `repair_landing`: the bean's full check was green on a sprout commit known red, so it makes
 * the failing tests pass: it lands past the window, and its validation goes ahead of probes.
 */
function isRepairLanding(step: V2Step, head0: Sha): boolean {
  return step.state.settings.repairLanding === true && knownRedFiles(step.state, head0).length > 0;
}

/** v2.3: the window has no room for this bean (`isCounted`: it already queues for the turn). */
function isWindowFull(step: V2Step, isCounted: boolean): boolean {
  return isWindowOn(step) && !windowAdmits(step.state, isCounted);
}

/** A green bean waits for room in the window (`land` null: it checks inside the turn). */
function waitForWindow(
  step: V2Step,
  flow: LandingFlow,
  land: Extract<LandingStep, { kind: 'window-wait' }>['land'],
): void {
  flow.step = { kind: 'window-wait', land };
  logWindowWait(step, flow.task);
}

/**
 * Beans that waited for the window go to the turn, oldest first, while it has room (each is
 * checked against the window again when the turn comes).
 */
export function admitWaiting(step: V2Step): void {
  const { state } = step;
  if (!isWindowOn(step)) return;
  while (state.window.waiting.length > 0 && windowAdmits(state, false)) {
    const task = state.window.waiting.shift();
    const flow = task === undefined ? undefined : state.landings[task];
    if (flow?.step.kind !== 'window-wait') continue;
    const { land } = flow.step;
    flow.step = land === null ? { kind: 'queued-locked' } : { kind: 'queued-land', ...land };
    requestTurn(step, { kind: 'landing', task: flow.task });
  }
}

function logCheck(
  step: V2Step,
  task: TaskId,
  check: CheckStep,
  outcome: { result: CheckResult; isInherited: boolean },
): void {
  const { state } = step;
  const { result } = outcome;
  const stats = state.stats;
  const seconds = step.ctx.now - check.startedAt;
  stats.preland_checks += 1;
  stats.preland_seconds += seconds;
  if (!result.green) stats.preland_red += 1;
  state.recentChecks = [...state.recentChecks, result.green].slice(-ADAPT_WINDOW);
  emit(step.ctx, 'preland.check', {
    task,
    sha: check.candidate,
    green: result.green,
    failing_files: result.failingFiles,
    failing_tests: failingTestNames(result).slice(0, PRELAND_FAILING_TESTS),
    suite_seconds: roundTo(result.suiteSeconds, 3),
    check_seconds: roundTo(seconds, 3),
    ...(outcome.isInherited ? { inherited: true } : {}),
    ...(check.targets === null ? {} : { targets: [...check.targets] }),
    ...(result.held === undefined ? {} : { held: result.held }),
  });
}

/**
 * v2.5: a targeted check is counted; a red one is contention the full re-checks must see, so
 * the `sampled` meter starts re-checking again. A green one says nothing about full re-checks.
 */
function countTargeted(state: V2State, isGreen: boolean): void {
  state.stats.targeted_checks += 1;
  if (isGreen) return;
  state.stats.targeted_red += 1;
  recordRecheck(state, false);
}

/**
 * v2.5: remembers every test's read set a check reported, failing or passing: the targeted
 * check's third source of tests.
 */
function learnReadSets(step: V2Step, result: CheckResult): void {
  if (!step.ctx.env.config.targeted_landing_check) return;
  const reported = { ...result.passingReadSets, ...result.readSets };
  for (const [test, reads] of Object.entries(reported)) step.state.readSets[test] = [...reads];
}

/**
 * `inherited_reds` (E6): the red check's failing files, when every one of them already
 * failed a validation of the sprout the bean was checked on, or of an earlier commit with
 * no green validation and no revert since. Such a red is the sprout's: null otherwise.
 */
function inheritedFailures(
  step: V2Step,
  flow: LandingFlow,
  check: { head: Sha; result: CheckResult; mine: string[] | null },
): string[] | null {
  const { state } = step;
  const mode = step.ctx.env.config.inherited_reds;
  const failing = check.result.failingFiles;
  const episode = episodeRed(step, flow, check);
  if (episode !== null) return episode;
  if (
    mode === 'off' ||
    check.result.green ||
    flow.inheritedWaits >= MAX_INHERITED_WAITS ||
    failing === null ||
    failing.length === 0
  ) {
    return null;
  }
  const isInherited =
    mode === 'validation'
      ? failedValidation(state, check.head, failing)
      : failing.every(
          (path) => isUntouched(path, check) || failedValidation(state, check.head, [path]),
        );
  return isInherited ? [...failing] : null;
}

/**
 * `episode_tickets`: the bean was checked on a sprout known red, and its check failed every
 * file the sprout's validation failed: the break is still there, so nothing in the check can
 * be judged (its own new tests fail with the suite). The bean waits for the sprout, without
 * the three-wait bound while the sprout is being repaired.
 */
function episodeRed(
  step: V2Step,
  flow: LandingFlow,
  check: { head: Sha; result: CheckResult },
): string[] | null {
  const { state } = step;
  const failing = check.result.failingFiles;
  if (state.settings.episodeTickets !== true || check.result.green || failing === null) return null;
  const red = knownRedFiles(state, check.head);
  if (red.length === 0 || !red.every((path) => failing.includes(path))) return null;
  if (flow.inheritedWaits >= MAX_INHERITED_WAITS && !isSproutRepairing(state)) return null;
  state.stats.episode_inherited = (state.stats.episode_inherited ?? 0) + 1;
  return [...failing];
}

/**
 * E6: every one of `files` already failed one validation of the sprout at or below `head`,
 * with no green validation and no revert since.
 */
function failedValidation(state: V2State, head: Sha, files: readonly string[]): boolean {
  for (let idx = sproutIndex(state, head); idx >= 0; idx -= 1) {
    const red = state.redValidations[idx] ?? [];
    if (files.every((path) => red.includes(path))) return true;
    if (state.validated[idx] === true || state.commits[idx]?.kind === 'revert') return false;
  }
  return false;
}

/**
 * v2.3 (`readset`): the bean changed neither the failing test file nor any file it imports
 * (its read set at the checked tree), nor a file every test depends on. Unknown read sets or
 * changes never clear a failure.
 */
function isUntouched(test: string, check: { result: CheckResult; mine: string[] | null }): boolean {
  const reads = check.result.readSets[test];
  const mine = check.mine;
  if (mine === null || reads === undefined || mine.some((path) => GLOBAL_FILE.test(path))) {
    return false;
  }
  const changed = new Set(mine);
  return !changed.has(test) && !reads.some((path) => changed.has(path));
}

/**
 * v2.3 (`early_tickets`): an inherited red sights a red sprout at the commit it was checked
 * on. Two beans' sightings of one test file there, or one and a red validation of that
 * commit, prove it: a validation waiting for its flake re-run settles now, and revert-first
 * starts at once, with read-set suspects among the commits since the last green validation.
 */
function sightInherited(
  step: V2Step,
  flow: LandingFlow,
  red: { head: Sha; result: CheckResult; failing: readonly string[] },
): void {
  const { state } = step;
  const idx = sproutIndex(state, red.head);
  if (!step.ctx.env.config.early_tickets || idx <= state.greenIdx) return;
  if (isInRedEpisode(state, idx)) return;
  const seen = state.sightings[idx] ?? {};
  for (const path of red.failing) {
    const beans = seen[path] ?? [];
    if (!beans.includes(flow.task)) seen[path] = [...beans, flow.task];
  }
  state.sightings[idx] = seen;
  confirmBySighting(step, idx);
  const validated = state.redValidations[idx] ?? [];
  const proven = Object.entries(seen)
    .filter(([path, beans]) => beans.length >= 2 || validated.includes(path))
    .map(([path]) => path);
  const files = newFailures(state, idx, { ...red.result, failingFiles: proven });
  if (files.length === 0) return;
  state.stats.early_tickets += 1;
  onSproutRed(step, idx);
  openTicket(step, { idx, result: red.result, files, early: true });
}

/**
 * `red_reset`: the bean was checked on a sprout commit a reset discarded since (it held beans the
 * reset took off). Its red says nothing about the bean: the window's own failures fail with it,
 * so it re-checks on the new sprout without a round and blames nobody (burst30 seed 7: t023 and
 * t031 blamed t001 and t002 for such reds).
 */
function isOnDiscardedTree(state: V2State, head: Sha): boolean {
  const checkedOn = sproutIndex(state, head);
  return state.commits
    .slice(0, checkedOn + 1)
    .some(
      (commit) =>
        commit.reverted &&
        (commit.revertedAt ?? -1) > checkedOn &&
        state.commits[commit.revertedAt ?? -1]?.reset === true,
    );
}

/** What a red on a discarded tree failed (the suite itself when it reported no file). */
function discardedFailures(result: CheckResult): string[] {
  const files = result.failingFiles ?? [];
  return files.length > 0 ? [...files] : ['(suite crashed)'];
}

/**
 * v2.4 (`reconcile`): failing tests whose owner was on the checked sprout and was reverted
 * after it (or taken off by a reset and requeued). Such a red is stale: it raises no card and
 * costs no round.
 */
function staleFailures(step: V2Step, head: Sha, result: CheckResult): string[] {
  if (!step.ctx.env.config.reconcile || result.green || result.failingFiles === null) return [];
  const { ctx, state } = step;
  const checkedOn = sproutIndex(state, head);
  const requeues = state.requeues ?? {};
  const owners = new Map<string, TaskId>();
  for (const id of ctx.state.order) {
    const isRequeued = (requeues[id] ?? 0) > 0;
    if (ctx.state.tasks[id]?.landedSha === null && !isRequeued) continue;
    for (const path of Object.keys(acceptanceTests(ctx, id))) owners.set(path, id);
  }
  return result.failingFiles.filter((path) => {
    const owner = owners.get(path);
    const commit = owner === undefined ? undefined : lastTaskCommit(state, owner);
    return commit !== undefined && commit.idx <= checkedOn && (commit.revertedAt ?? -1) > checkedOn;
  });
}

/** A stale red: the bean checks again on the sprout as it is now, without a round. */
function recheckStale(
  step: V2Step,
  flow: LandingFlow,
  red: { checkedOn: Sha; stale: readonly string[] },
): void {
  const { ctx, state } = step;
  state.stats.stale_rechecks += 1;
  emit(ctx, 'preland.recheck', {
    task: flow.task,
    checked_on: red.checkedOn,
    head: state.sprout,
    attempt: flow.rechecks,
    stale: [...red.stale],
  });
  squashOntoSprout(step, flow);
}

/** The bean waits for the sprout to move (`wakeInherited`); no round is spent. */
function waitOutInherited(
  step: V2Step,
  flow: LandingFlow,
  red: { head: Sha; failing: string[] },
): void {
  flow.inheritedWaits += 1;
  step.state.stats.inherited_reds += 1;
  flow.step = { kind: 'inherited', head: red.head, failing: red.failing };
}

/**
 * Beans waiting out an inherited red check again once the sprout moved, or at once when
 * nothing repairs the sprout any more (an escalated ticket, a flake): no wait is endless.
 */
export function wakeInherited(step: V2Step): void {
  const { state } = step;
  const isRepairing = isSproutRepairing(state);
  for (const flow of Object.values(state.landings)) {
    if (flow.step.kind === 'inherited' && (flow.step.head !== state.sprout || !isRepairing)) {
      attempt(step, flow.task);
    }
  }
}

/** Holding the turn after a green check: land as is, or squash onto the moved sprout. */
function landInTurn(
  step: V2Step,
  flow: LandingFlow,
  queued: Extract<LandingStep, { kind: 'queued-land' }>,
): void {
  if (queued.repair !== true && isWindowFull(step, true)) {
    const { head0, candidate, files, mine } = queued;
    waitForWindow(step, flow, { head0, candidate, files, mine });
    releaseTurn(step);
    return;
  }
  const head = step.state.sprout;
  if (head === queued.head0) {
    publish(step, flow, {
      head,
      sha: queued.candidate,
      files: queued.files,
      ...(queued.repair === true ? { repair: true } : {}),
    });
    return;
  }
  const jobId = squash(step, flow.task, head);
  flow.step = {
    kind: 'resquash',
    head0: queued.head0,
    head,
    candidate: queued.candidate,
    mine: queued.mine,
    jobId,
  };
}

function onResquashed(
  step: V2Step,
  flow: LandingFlow,
  resquash: Extract<LandingStep, { kind: 'resquash' }>,
  result: JobResult,
): void {
  if (result.kind !== 'squash') throw new EngineInvariantError(`squash got ${result.kind}`);
  if (result.outcome === 'conflict') {
    attemptFailed(step, flow, {
      kind: 'conflict',
      head: resquash.head,
      files: result.files,
      hunks: result.hunks,
    });
    releaseTurn(step);
    return;
  }
  flow.resolved = result.resolved;
  const delta = filesLandedSince(step.state, resquash.head0);
  const mine = resquash.mine;
  const shared = mine === null ? delta : delta.filter((path) => mine.includes(path));
  const landing: Optimistic = {
    head0: resquash.head0,
    head: resquash.head,
    sha: result.sha,
    files: [...result.files],
    mine,
    landedMeanwhile: delta.length,
  };
  // A structural resolution means the bean's lines met the ones that landed meanwhile: the
  // tree it would land is new, so it is checked whatever the re-check rule says (t010 in
  // cf-demo-sonnet-30-s7 landed such a tree unchecked and broke the whole suite).
  if (result.resolved === 'structural' || partnerMovedSince(step, flow.task, resquash.head0)) {
    recheck(step, flow, resquash.head0);
    return;
  }
  if (mine !== null && shared.length === 0) {
    landOnMovedSprout(step, flow, landing);
    return;
  }
  const rule = recheckRule(step);
  switch (rule) {
    case 'skip':
      landOnMovedSprout(step, flow, landing);
      return;
    case 'hunk':
      compareHunks(step, flow, { landing, candidate: resquash.candidate, shared });
      return;
    case 'file':
      recheck(step, flow, resquash.head0);
      return;
    default:
      assertNever(rule);
  }
}

/**
 * `skip_recheck` up to the hunk comparison: `never` skips, `file` re-checks, `adaptive`
 * skips while recent pre-land checks are calm and otherwise falls back.
 */
function recheckRule(step: V2Step): 'skip' | 'file' | 'hunk' {
  const config = step.ctx.env.config;
  switch (config.recheck) {
    case 'never':
      return 'skip';
    case 'file':
      return 'file';
    case 'hunk':
      return 'hunk';
    case 'adaptive':
      if (isCalm(step.state)) {
        step.state.stats.preland_skipped_rechecks += 1;
        return 'skip';
      }
      return config.recheck_fallback;
    case 'sampled':
      if (sampledRecheck(step.state) === 'recheck') return config.recheck_fallback;
      step.state.stats.preland_skipped_rechecks += 1;
      return 'skip';
    default:
      return assertNever(config.recheck);
  }
}

/** At least five recent pre-land outcomes, under 10% of them red. */
function isCalm(state: V2State): boolean {
  const window = state.recentChecks;
  const reds = window.filter((green) => !green).length;
  return (
    window.length >= Math.min(ADAPT_MIN_CHECKS, ADAPT_WINDOW) &&
    reds / window.length < ADAPT_RED_SHARE
  );
}

/** The `hunk` rule: compare the lines the bean changed with the lines that landed meanwhile. */
function compareHunks(
  step: V2Step,
  flow: LandingFlow,
  compare: { landing: Optimistic; candidate: Sha; shared: readonly string[] },
): void {
  const { landing } = compare;
  const jobId = startJob(
    step.ctx,
    {
      kind: 'line-ranges',
      base: landing.head0,
      mine: compare.candidate,
      theirs: landing.head,
      files: [...compare.shared],
    },
    { kind: 'policy' },
  );
  awaitOutcome(step.state, jobId, { kind: 'landing', task: flow.task });
  flow.step = { kind: 'hunks', ...landing, jobId };
}

function onHunks(
  step: V2Step,
  flow: LandingFlow,
  hunks: Extract<LandingStep, { kind: 'hunks' }>,
  result: JobResult,
): void {
  if (result.kind !== 'line-ranges') throw new EngineInvariantError(`hunks got ${result.kind}`);
  const stats = step.state.stats;
  if (rangesTouch(result.mine, result.theirs)) {
    stats.preland_hunk_overlap += 1;
    recheck(step, flow, hunks.head0);
    return;
  }
  stats.preland_hunk_disjoint += 1;
  landOnMovedSprout(step, flow, hunks);
}

/** `a0 - m < b1 and b0 - m < a1` for some pair of ranges in a shared file. */
function rangesTouch(mine: LineRanges, theirs: LineRanges): boolean {
  return Object.entries(mine).some(([path, ranges]) =>
    ranges.some(([a0, a1]) =>
      (theirs[path] ?? []).some(([b0, b1]) => a0 - HUNK_MARGIN < b1 && b0 - HUNK_MARGIN < a1),
    ),
  );
}

/**
 * The bean lands on the moved sprout without a full re-check. With `targeted_landing_check`
 * (v2.5, E1) it first runs a targeted check of that exact tree: once outside the turn (a
 * green one brings it back to the turn, checked on the new head), and inside the turn when
 * the sprout moved again meanwhile, so a busy sprout cannot keep it chasing. With nothing
 * to run, it lands as before.
 */
function landOnMovedSprout(step: V2Step, flow: LandingFlow, landing: Optimistic): void {
  const targets = step.ctx.env.config.targeted_landing_check
    ? targetedTests(step, flow.task, landing)
    : [];
  if (targets.length === 0) {
    landOptimistically(step, flow, landing);
    return;
  }
  const isInTurn = flow.targeted >= MAX_TARGETED_OUTSIDE;
  flow.targeted += 1;
  startCheck(step, flow, {
    isInTurn,
    targets,
    head0: landing.head,
    candidate: landing.sha,
    files: landing.files,
    mine: landing.mine,
  });
  // The bean left its inbound step first, so the next holder's window does not count it.
  if (!isInTurn) releaseTurn(step);
}

/**
 * What a targeted check runs: the bean's own acceptance tests, the acceptance tests and test
 * files of the beans that landed since `head0` (and are still in), and every test whose
 * known read set meets the bean's files. A test whose known read set misses either side (the
 * bean's files, or the files that landed meanwhile) cannot see them combine, and is left to
 * the validation's full suite; so is everything when no test reads both sides. A file every
 * test depends on, or a bean whose files are unknown, keeps every candidate.
 */
function targetedTests(step: V2Step, task: TaskId, landing: Optimistic): string[] {
  const { ctx, state } = step;
  const meanwhile = state.commits
    .slice(sproutIndex(state, landing.head0) + 1)
    .filter((commit) => commit.kind === 'task' && !commit.reverted);
  const theirTests = meanwhile.flatMap((commit) =>
    commit.task === null ? [] : Object.keys(acceptanceTests(ctx, commit.task)),
  );
  const theirFiles = meanwhile.flatMap((commit) => commit.files.filter(isRunnableTest));
  const theirs = [...theirTests, ...theirFiles];
  const mine = new Set(landing.mine ?? []);
  const readers = Object.entries(state.readSets)
    .filter(([, reads]) => reads.some((path) => mine.has(path)))
    .map(([test]) => test);
  const own = Object.keys(acceptanceTests(ctx, task));
  const candidates = [...new Set([...own, ...theirs, ...readers])].toSorted();
  const delta = new Set(filesLandedSince(state, landing.head0));
  const isGlobal = [...mine, ...delta].some((path) => GLOBAL_FILE.test(path));
  if (landing.mine === null || isGlobal) return candidates;
  return candidates.filter((test) => {
    const reads = state.readSets[test];
    return (
      reads === undefined ||
      (reads.some((path) => mine.has(path)) && reads.some((path) => delta.has(path)))
    );
  });
}

/** Lands on the moved sprout without checking again (`preland.optimistic`). */
function landOptimistically(step: V2Step, flow: LandingFlow, landing: Optimistic): void {
  step.state.stats.preland_optimistic_landings += 1;
  emit(step.ctx, 'preland.optimistic', {
    task: flow.task,
    checked_on: landing.head0,
    landed_on: landing.head,
    landed_meanwhile: landing.landedMeanwhile,
  });
  publish(step, flow, { head: landing.head, sha: landing.sha, files: landing.files });
}

/** The bean checks again on the sprout as it is now; the turn goes to the next in line. */
function recheck(step: V2Step, flow: LandingFlow, head0: Sha): void {
  const { ctx, state } = step;
  flow.rechecks += 1;
  state.stats.preland_rechecks += 1;
  emit(ctx, 'preland.recheck', {
    task: flow.task,
    checked_on: head0,
    head: state.sprout,
    attempt: flow.rechecks,
  });
  // The bean leaves its inbound step before the turn passes, so the next holder's window
  // check does not count it as landing.
  squashOntoSprout(step, flow);
  releaseTurn(step);
}

/** The locked path (fallback or `preland_mode: locked`): squash and check inside the turn. */
function squashInTurn(step: V2Step, flow: LandingFlow): void {
  if (isWindowFull(step, true)) {
    waitForWindow(step, flow, null);
    releaseTurn(step);
    return;
  }
  const head = step.state.sprout;
  flow.step = { kind: 'locked-squash', head, jobId: squash(step, flow.task, head) };
}

function onLockedSquashed(step: V2Step, flow: LandingFlow, head: Sha, result: JobResult): void {
  if (result.kind !== 'squash') throw new EngineInvariantError(`squash got ${result.kind}`);
  if (result.outcome === 'conflict') {
    attemptFailed(step, flow, { kind: 'conflict', head, files: result.files, hunks: result.hunks });
    releaseTurn(step);
    return;
  }
  flow.resolved = result.resolved;
  startCheck(step, flow, { isInTurn: true, targets: null, ...candidateOf(head, result) });
}

/** `publish`: move the sprout to the bean's commit with a lease on the head it was built on. */
function publish(
  step: V2Step,
  flow: LandingFlow,
  landing: { head: Sha; sha: Sha; files: string[]; repair?: true },
): void {
  const jobId = startJob(
    step.ctx,
    { kind: 'update-ref', ref: SPROUT_REF, newSha: landing.sha, oldSha: landing.head },
    { kind: 'policy' },
  );
  awaitOutcome(step.state, jobId, { kind: 'landing', task: flow.task });
  flow.step = { kind: 'publish', ...landing, jobId };
}

function onPublished(
  step: V2Step,
  flow: LandingFlow,
  landing: Extract<LandingStep, { kind: 'publish' }>,
  result: JobResult,
): void {
  if (result.kind !== 'update-ref') throw new EngineInvariantError(`update-ref got ${result.kind}`);
  const { ctx, state } = step;
  if (!result.ok && result.actual !== landing.sha) {
    markAborted(
      ctx,
      `the sprout moved unexpectedly: expected ${landing.head}, found ${String(result.actual)}`,
    );
    return;
  }
  // The landing carries its check (`evidence_promotion`) when it is the checked tree, or a
  // textual re-squash of it; a structural merge's tree only counts as checked when it was.
  const voucher = flow.voucher;
  const isFromCheck =
    voucher !== undefined && (voucher === landing.sha || flow.resolved === 'textual');
  const commit = appendCommit(step, {
    sha: landing.sha,
    parent: landing.head,
    kind: 'task',
    task: flow.task,
    ticket: null,
    files: landing.files,
    ...(landing.repair === true ? { repair: true } : {}),
    ...(isFromCheck ? { voucher } : {}),
    ...(flow.resolved === 'structural' ? { structural: true } : {}),
  });
  state.stats.landings += 1;
  if (landing.repair === true) state.stats.repair_landings = (state.stats.repair_landings ?? 0) + 1;
  emit(ctx, 'land', {
    task: flow.task,
    ticket: null,
    kind: 'task',
    sha: landing.sha,
    target: 'trunk',
    trunk_idx: commit.idx,
    files: [...landing.files],
    unvalidated: unvalidatedCount(state),
    prelanded: true,
    ...(flow.resolved === 'structural' ? { resolved: 'structural' } : {}),
  });
  landed(step, flow, landing);
  releaseTurn(step);
}

/**
 * The bean is on the sprout: record it, free its agent (when it still holds the bean), and
 * make the in-place amendments it carried the losers' specs (`task_flow`'s tail).
 */
function landed(step: V2Step, flow: LandingFlow, landing: { sha: Sha; files: string[] }): void {
  const { ctx } = step;
  const task = requireTask(ctx, flow.task);
  task.status = 'landed';
  task.landedAt = ctx.now;
  recordLanding(ctx, task, landing.sha, landing.files);
  if (holderOf(ctx, flow.task)?.id === flow.slot) release(ctx, flow.slot);
  delete step.state.landings[flow.task];
  settleCarried(step, flow.task);
}

/**
 * `land`'s loop after an attempt that did not land: back to the author, or drop. The v2.5
 * bounds (`v2-bounds`) come first: no reset of the rounds gets past them.
 */
function attemptFailed(step: V2Step, flow: LandingFlow, failure: Failure): void {
  const { ctx, state } = step;
  flow.rounds += 1;
  const bound = boundedEnd(step, flow.task, {
    kind: failure.kind,
    files: failure.kind === 'red' ? (failure.red.failingFiles ?? []) : failure.files,
  });
  if (bound?.kind === 'park') {
    parkLanding(step, flow.task, bound.reason);
    return;
  }
  if (bound !== null) {
    if (failure.kind === 'red') state.stats.preland_drops += 1;
    endLanding(step, flow.task, bound.reason);
    return;
  }
  if (flow.rounds > ctx.env.config.max_rework) {
    if (rescueOnExhaustion(step, flow, failure.kind === 'red' ? failure.red : null)) return;
    if (failure.kind === 'red') state.stats.preland_drops += 1;
    endLanding(
      step,
      flow.task,
      failure.kind === 'red'
        ? 'pre-land check still red after --max-rework attempts'
        : 'unresolved conflict after --max-rework attempts',
    );
    return;
  }
  if (failure.kind === 'red') {
    repairWithCulprits(step, flow, failure);
    return;
  }
  ctx.state.conflictsMet += 1;
  requireTask(ctx, flow.task).conflicts += 1;
  emit(ctx, 'merge.conflict', {
    task: flow.task,
    ticket: null,
    onto: failure.head,
    files: [...failure.files],
  });
  requestAgent(step, flow, {
    kind: 'conflict',
    head: failure.head,
    files: failure.files,
    hunks: failure.hunks,
  });
}
