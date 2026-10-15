/**
 * The event-to-view reducer: a pure function from a run's events (in log order) to what the
 * canvas shows. Live runs re-reduce as events arrive; replays reduce the prefix up to the
 * playhead. It follows the gateway engine's rules (slot clocks as `refresh_agents`, red
 * validations as `completeCi`), so its counters match the run's `summary.json`.
 */
import type { Sha, SlotId, TaskId } from '@gitstalk/shared-race/ids';

import { compareText } from '../repo/paths';
import type { RaceEvent, RaceEventOf } from './race-events';
import type {
  Batch,
  Bean,
  BeanPhase,
  BeanStep,
  BeanStepKind,
  CiRun,
  DecisionCard,
  LaneActivity,
  LaneInvocation,
  LaneSegment,
  LineCommit,
  RaceMeta,
  RaceOptions,
  RacePhase,
  RaceState,
  Ticket,
} from './race-state';

/**
 * Folds events into the race state. The draft is private: callers get a readonly value.
 * `options` carries the engine's knobs that no event states (v2.2's agent release).
 */
export function reduceRace(events: readonly RaceEvent[], options: RaceOptions = {}): RaceState {
  const draft = emptyDraft(options);
  for (const event of events) applyEvent(draft, event);
  return snapshot(draft);
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

type BeanDraft = Writable<Omit<Bean, 'steps' | 'files'>> & {
  steps: BeanStep[];
  files: string[];
};

type LaneDraft = {
  slot: SlotId;
  activity: LaneActivity;
  since: number;
  bean: TaskId | null;
  /** The bean held when the current activity began (the open segment's bean). */
  sinceBean: TaskId | null;
  invocation: LaneInvocation | null;
  totals: Record<LaneActivity, number>;
  segments: LaneSegment[];
};

type Draft = {
  options: RaceOptions;
  meta: RaceMeta | null;
  phase: RacePhase;
  clock: number;
  epochMs: number | null;
  beans: Map<string, BeanDraft>;
  order: TaskId[];
  lanes: LaneDraft[];
  commits: Writable<LineCommit>[];
  stalkIdx: number;
  stalkSha: Sha | null;
  ci: Map<string, Writable<CiRun>>;
  cards: Map<string, Writable<DecisionCard>>;
  batches: Map<string, Writable<Batch>>;
  queue: TaskId[];
  tickets: Map<string, Writable<Ticket>>;
  costUsd: number;
  redValidations: number;
  conflicts: number;
  invocations: Record<string, number>;
  ciRuns: Record<string, number>;
  endedAt: number | null;
  aborted: string | null;
  final: RaceState['final'];
  lastSeq: number;
  /** Every file a line commit changed so far (the own-files rule for reworks). */
  lineFiles: Set<string>;
  flaky: Set<string>;
};

function emptyDraft(options: RaceOptions = {}): Draft {
  return {
    options,
    meta: null,
    phase: 'setup',
    clock: 0,
    epochMs: null,
    beans: new Map(),
    order: [],
    lanes: [],
    commits: [],
    stalkIdx: -1,
    stalkSha: null,
    ci: new Map(),
    cards: new Map(),
    batches: new Map(),
    queue: [],
    tickets: new Map(),
    costUsd: 0,
    redValidations: 0,
    conflicts: 0,
    invocations: {},
    ciRuns: {},
    endedAt: null,
    aborted: null,
    final: null,
    lastSeq: 0,
    lineFiles: new Set(),
    flaky: new Set(),
  };
}

function applyEvent(draft: Draft, event: RaceEvent): void {
  draft.clock = Math.max(draft.clock, event.t);
  draft.lastSeq = event.seq;
  draft.epochMs ??= Date.parse(event.ts) - event.t * 1000;
  applyByType(draft, event);
  refreshLanes(draft, event.t);
}

function applyByType(draft: Draft, event: RaceEvent): void {
  switch (event.type) {
    case 'race.setup':
    case 'acceptance.restored':
    case 'abort':
      return;
    case 'race.start':
      return startRace(draft, event);
    case 'race.end':
      return endRace(draft, event);
    case 'final.check':
      draft.final = {
        correct: event.correct ?? null,
        tasksAccepted: event.tasks_accepted ?? null,
        tasksTotal: event.tasks_total ?? null,
        error: event.error ?? null,
      };
      return;
    case 'footprint.predicted':
      bean(draft, event.task).predicted = [...event.selected];
      return;
    case 'task.start':
      return startBean(draft, event);
    case 'invocation.start':
      return startInvocation(draft, event);
    case 'invocation.end':
      return endInvocation(draft, event);
    case 'task.commit':
      return commitBean(draft, event);
    case 'task.drop':
      return dropBean(draft, event);
    case 'task.parked':
      return parkBean(draft, event);
    case 'preland.check':
      return recordCheck(draft, event);
    case 'preland.recheck':
      addStep(draft, event.task, {
        t: event.t,
        kind: 'recheck',
        detail: `attempt ${event.attempt}`,
      });
      return setPhase(draft, event.task, 'checking', event.t);
    case 'preland.optimistic':
      addStep(draft, event.task, {
        t: event.t,
        kind: 'optimistic',
        detail: `${event.landed_meanwhile} landed meanwhile, no shared file`,
      });
      return;
    case 'merge.conflict':
      return recordConflict(draft, event);
    case 'rework.start':
      return startRework(draft, event);
    case 'land':
      return land(draft, event);
    case 'green.promote':
      return promote(draft, event);
    // Parsed for the web app's head watcher; the canvas does not draw a demotion yet.
    case 'green.demote':
      return;
    case 'ci.start':
      return startCi(draft, event);
    case 'ci.end':
      return endCi(draft, event);
    case 'decision.request':
      return openCard(draft, event);
    case 'decision.made':
      return decideCard(draft, event);
    case 'spec.amended':
      return recordAmendment(draft, event);
    case 'flake.suspected':
      return recordFlake(draft, event);
    case 'tests.first':
      return addStep(draft, event.task, {
        t: event.t,
        kind: 'tests-first',
        detail: `${event.status}: ${event.files.join(', ')}`,
      });
    case 'decision.reconcile':
      return recordReconcile(draft, event);
    case 'rescue.start':
      return addStep(draft, event.task, {
        t: event.t,
        kind: 'rescue',
        detail:
          event.rounds > 0
            ? `${event.why}, after ${plural(event.rounds, 'rework round')}`
            : event.why,
      });
    case 'culprit.dynamic':
      return recordCulpritSearch(draft, event);
    case 'sync.applied':
    case 'sync.noted':
    case 'sync.midrun.offered':
    case 'sync.midrun.applied':
    case 'sync.midrun.noted':
      return recordSync(draft, event);
    case 'window.wait':
      return addStep(draft, event.task, {
        t: event.t,
        kind: 'window',
        detail: `${event.unvalidated} unvalidated on the sprout, window ${event.window}`,
      });
    case 'window.resize':
      return;
    case 'ticket.open':
      draft.tickets.set(event.ticket, {
        ticket: event.ticket,
        redIdx: event.red_idx,
        failing: [...event.failing],
        openedAt: event.t,
        status: 'open',
        culprit: null,
      });
      return;
    case 'ticket.culprit':
      return markCulprit(draft, event);
    case 'ticket.close':
      return setTicketStatus(draft, event.ticket, 'closed');
    case 'ticket.escalate':
    case 'ticket.stuck':
      return setTicketStatus(draft, event.ticket, 'escalated');
    case 'revert':
      return revert(draft, event);
    case 'sprout.reset':
      return resetSprout(draft, event);
    case 'bean.requeued':
      return requeueBean(draft, event);
    case 'revert.conflict':
      return;
    case 'queue.enqueue':
      return enqueue(draft, event);
    case 'queue.eject':
      return eject(draft, event);
    case 'queue.hold':
    case 'bisect.start':
      return;
    case 'batch.start':
      return startBatch(draft, event);
    case 'batch.red':
      return updateBatch(draft, event.batch, { status: 'red', failing: event.failing ?? [] });
    case 'batch.cancel':
      return cancelBatch(draft, event);
    case 'bisect.end':
      return endBisect(draft, event);
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected event: ${JSON.stringify(value)}`);
}

// --- the race ---------------------------------------------------------------------------

function startRace(draft: Draft, event: RaceEventOf<'race.start'>): void {
  draft.meta = {
    policy: event.policy === 'queue' ? 'queue' : 'beanstalk',
    agent: event.agent,
    model: event.model,
    agents: event.agents,
    ciSlots: event.ci_slots,
    ciSeconds: event.ci_seconds,
    batch: event.policy === 'queue' ? event.batch : null,
    budgetUsd: event.budget_usd,
    seed: event.seed,
    base: event.base,
    tasks: [...event.tasks],
    startedAt: event.t,
    releaseOnEnqueue: event.queue_hold === false,
  };
  draft.phase = 'running';
  draft.order = [...event.tasks];
  for (const task of event.tasks) bean(draft, task);
  draft.lanes = Array.from({ length: event.agents }, (_, index) => ({
    slot: `a${index}`,
    activity: 'idle',
    since: event.t,
    bean: null,
    sinceBean: null,
    invocation: null,
    totals: { busy: 0, blocked: 0, idle: 0 },
    segments: [],
  }));
}

function endRace(draft: Draft, event: RaceEventOf<'race.end'>): void {
  for (const lane of draft.lanes) {
    lane.invocation = null;
    closeLaneClock(lane, event.t);
  }
  draft.phase = 'ended';
  draft.endedAt = event.t;
  draft.aborted = event.aborted;
}

// --- beans ------------------------------------------------------------------------------

function bean(draft: Draft, id: TaskId): BeanDraft {
  const existing = draft.beans.get(id);
  if (existing !== undefined) return existing;
  const created: BeanDraft = {
    id,
    phase: 'pending',
    since: draft.clock,
    agent: null,
    startedAt: null,
    base: null,
    head: null,
    predicted: [],
    files: [],
    landedAt: null,
    landedIdx: null,
    landedSha: null,
    greenAt: null,
    reworks: 0,
    conflicts: 0,
    checks: 0,
    redChecks: 0,
    invocations: 0,
    costUsd: 0,
    lastMessage: '',
    dropReason: null,
    card: null,
    steps: [],
  };
  draft.beans.set(id, created);
  if (!draft.order.includes(id)) draft.order.push(id);
  return created;
}

function setPhase(draft: Draft, id: TaskId, phase: BeanPhase, t: number): void {
  const target = bean(draft, id);
  if (target.phase === phase) return;
  target.phase = phase;
  target.since = t;
}

function addStep(
  draft: Draft,
  id: TaskId,
  step: { readonly t: number; readonly kind: BeanStepKind; readonly detail: string },
): void {
  const target = bean(draft, id);
  target.steps.push({ ...step, agent: target.agent });
}

function startBean(draft: Draft, event: RaceEventOf<'task.start'>): void {
  const target = bean(draft, event.task);
  target.agent = event.agent;
  target.startedAt = event.t;
  target.base = event.base;
  setPhase(draft, event.task, 'working', event.t);
  holdLane(draft, event.agent, event.task);
  addStep(draft, event.task, { t: event.t, kind: 'started', detail: `on ${event.agent}` });
}

function startInvocation(draft: Draft, event: RaceEventOf<'invocation.start'>): void {
  draft.invocations[event.kind] = (draft.invocations[event.kind] ?? 0) + 1;
  if (event.agent !== null) {
    const lane = laneOf(draft, event.agent);
    if (lane !== undefined) {
      lane.invocation = { inv: event.inv, kind: event.kind, task: event.task, since: event.t };
      if (lane.bean === null && event.task !== null && holdsBean(event.kind)) {
        lane.bean = event.task;
      }
    }
  }
  if (event.task === null) return;
  const target = bean(draft, event.task);
  target.invocations += 1;
  if (event.agent !== null) target.agent = event.agent;
  if (event.kind !== 'initial') setPhase(draft, event.task, 'rework', event.t);
}

/**
 * Whether an invocation's slot carries its bean afterwards. The test author and the
 * reconciler (v2.4+) borrow a slot for one call about a bean they do not own.
 */
function holdsBean(kind: string): boolean {
  return kind !== 'test-author' && kind !== 'reconcile';
}

function endInvocation(draft: Draft, event: RaceEventOf<'invocation.end'>): void {
  draft.costUsd += event.cost_usd;
  if (event.agent !== null) {
    const lane = laneOf(draft, event.agent);
    if (lane?.invocation?.inv === event.inv) lane.invocation = null;
  }
  if (event.task === null) return;
  const target = bean(draft, event.task);
  target.costUsd += event.cost_usd;
  if (event.result_text !== '') target.lastMessage = event.result_text;
}

function commitBean(draft: Draft, event: RaceEventOf<'task.commit'>): void {
  const target = bean(draft, event.task);
  target.head = event.sha;
  target.files = ownFiles(target.files, event, draft.lineFiles);
  addStep(draft, event.task, {
    t: event.t,
    kind: 'committed',
    detail: `${event.kind}: ${plural(event.files.length, 'file')}`,
  });
  if (draft.meta?.policy === 'queue') return;
  setPhase(draft, event.task, 'checking', event.t);
  // v2.2 frees the agent as soon as its bean is submitted for the pre-land check.
  if (draft.options.releaseOnCheck === true) releaseLane(draft, event.task);
}

/**
 * The files a bean itself changes. A first commit's files are exact (`base..head`). A
 * rework merged the line first, so its `base..head` also lists what other beans landed;
 * those files count only if the bean touched them in an earlier commit.
 */
function ownFiles(
  previous: readonly string[],
  event: RaceEventOf<'task.commit'>,
  lineFiles: ReadonlySet<string>,
): string[] {
  if (event.kind === 'initial') return [...event.files];
  const added = event.files.filter((path) => !lineFiles.has(path) || previous.includes(path));
  return [...new Set([...previous, ...added])].toSorted(compareText);
}

function dropBean(draft: Draft, event: RaceEventOf<'task.drop'>): void {
  const target = bean(draft, event.task);
  target.dropReason = event.reason;
  setPhase(draft, event.task, 'dropped', event.t);
  addStep(draft, event.task, { t: event.t, kind: 'dropped', detail: event.reason });
  releaseLane(draft, event.task);
  draft.queue = draft.queue.filter((id) => id !== event.task);
}

/** v2 `park`: the bean waits for a person; its lane is free and the race goes on without it. */
function parkBean(draft: Draft, event: RaceEventOf<'task.parked'>): void {
  setPhase(draft, event.task, 'parked', event.t);
  addStep(draft, event.task, { t: event.t, kind: 'parked', detail: event.reason });
  releaseLane(draft, event.task);
}

function recordCheck(draft: Draft, event: RaceEventOf<'preland.check'>): void {
  const target = bean(draft, event.task);
  target.checks += 1;
  if (!event.green) target.redChecks += 1;
  addStep(draft, event.task, {
    t: event.t,
    kind: event.green ? 'check-green' : 'check-red',
    detail: checkDetail(event),
  });
}

function checkDetail(event: RaceEventOf<'preland.check'>): string {
  if (event.green) return `${Math.round(event.check_seconds)} s`;
  const failing = plural(event.failing_tests.length, 'failing test');
  return event.inherited === true
    ? `${failing}, inherited from the sprout: no rework spent`
    : failing;
}

function recordConflict(draft: Draft, event: RaceEventOf<'merge.conflict'>): void {
  draft.conflicts += 1;
  if (event.task === null) return;
  bean(draft, event.task).conflicts += 1;
  addStep(draft, event.task, { t: event.t, kind: 'conflict', detail: event.files.join(', ') });
}

function startRework(draft: Draft, event: RaceEventOf<'rework.start'>): void {
  if (event.task === null) return;
  const target = bean(draft, event.task);
  target.reworks += 1;
  setPhase(draft, event.task, 'rework', event.t);
  const culprits = event.culprits ?? [];
  const because = culprits.length > 0 ? `, informed by ${culprits.join(', ')}` : '';
  addStep(draft, event.task, {
    t: event.t,
    kind: 'rework',
    detail: `${event.reason}${because}`,
  });
}

// --- lanes (agent slots) -------------------------------------------------------------------

function laneOf(draft: Draft, slot: SlotId): LaneDraft | undefined {
  return draft.lanes.find((lane) => lane.slot === slot);
}

function holdLane(draft: Draft, slot: SlotId, task: TaskId): void {
  const lane = laneOf(draft, slot);
  if (lane !== undefined) lane.bean = task;
}

function releaseLane(draft: Draft, task: TaskId): void {
  for (const lane of draft.lanes) {
    if (lane.bean === task) lane.bean = null;
  }
}

/** `refresh_agents`: busy while running, blocked while holding work, else idle. */
function refreshLanes(draft: Draft, t: number): void {
  if (draft.phase !== 'running') return;
  for (const lane of draft.lanes) {
    const next = laneActivity(lane);
    if (next === lane.activity && lane.bean === lane.sinceBean) continue;
    closeLaneClock(lane, t);
    lane.activity = next;
    lane.sinceBean = lane.bean;
  }
}

function laneActivity(lane: LaneDraft): LaneActivity {
  if (lane.invocation !== null) return 'busy';
  if (lane.bean !== null) return 'blocked';
  return 'idle';
}

function closeLaneClock(lane: LaneDraft, t: number): void {
  lane.totals[lane.activity] += t - lane.since;
  if (t > lane.since) {
    lane.segments.push({ from: lane.since, to: t, activity: lane.activity, bean: lane.sinceBean });
  }
  lane.since = t;
}

// --- the line: the sprout and the stalk ------------------------------------------------------

function land(draft: Draft, event: RaceEventOf<'land'>): void {
  if (event.target !== 'trunk' && event.target !== 'main') return;
  const isQueue = event.target === 'main';
  const idx = event.trunk_idx ?? draft.commits.length;
  draft.commits.push({
    idx,
    sha: event.sha,
    task: event.task,
    kind: event.kind ?? 'task',
    t: event.t,
    files: [...event.files],
    status: isQueue ? 'green' : 'pending',
    redAt: null,
  });
  for (const path of event.files) draft.lineFiles.add(path);
  if (event.task === null) return;
  const target = bean(draft, event.task);
  target.landedAt = event.t;
  target.landedIdx = idx;
  target.landedSha = event.sha;
  setPhase(draft, event.task, isQueue ? 'green' : 'landed', event.t);
  addStep(draft, event.task, {
    t: event.t,
    kind: 'landed',
    detail: isQueue ? 'on the stalk' : `on the sprout as #${idx}${resolvedWords(event.resolved)}`,
  });
  releaseLane(draft, event.task);
}

/** v2.5: how a landing's merge was resolved, when git's text merge alone could not. */
function resolvedWords(resolved: string | null | undefined): string {
  return resolved === undefined || resolved === null ? '' : `, ${resolved} merge`;
}

function promote(draft: Draft, event: RaceEventOf<'green.promote'>): void {
  const idx = event.trunk_idx ?? draft.commits.length - 1;
  draft.stalkIdx = Math.max(draft.stalkIdx, idx);
  draft.stalkSha = event.sha;
  for (const commit of draft.commits) {
    if (commit.idx <= idx && commit.status !== 'reverted') commit.status = 'green';
  }
  for (const task of event.tasks) {
    const target = bean(draft, task);
    if (target.greenAt !== null) continue;
    target.greenAt = event.t;
    setPhase(draft, task, 'green', event.t);
    addStep(draft, task, { t: event.t, kind: 'green', detail: `stalk at #${idx}` });
  }
}

function commitAt(draft: Draft, idx: number | undefined): Writable<LineCommit> | undefined {
  return idx === undefined ? undefined : draft.commits.find((commit) => commit.idx === idx);
}

function markCulprit(draft: Draft, event: RaceEventOf<'ticket.culprit'>): void {
  const ticket = draft.tickets.get(event.ticket);
  if (ticket !== undefined) ticket.culprit = event.task;
  const commit = commitAt(draft, event.trunk_idx);
  if (commit !== undefined && commit.status !== 'reverted') commit.status = 'culprit';
}

function setTicketStatus(draft: Draft, id: string, status: Ticket['status']): void {
  const ticket = draft.tickets.get(id);
  if (ticket !== undefined) ticket.status = status;
}

function revert(draft: Draft, event: RaceEventOf<'revert'>): void {
  const reverted = draft.commits.find((commit) => commit.sha === event.reverted);
  if (reverted !== undefined) reverted.status = 'reverted';
  if (commitAt(draft, event.trunk_idx) === undefined) {
    draft.commits.push({
      idx: event.trunk_idx,
      sha: event.sha,
      task: event.task,
      kind: 'revert',
      t: event.t,
      files: reverted === undefined ? [] : [...reverted.files],
      status: 'pending',
      redAt: null,
    });
  }
  if (event.task !== null) {
    addStep(draft, event.task, { t: event.t, kind: 'reverted', detail: `ticket ${event.ticket}` });
  }
}

/** `red_reset`: every commit of the red window is off the sprout; the reset commit is on it. */
function resetSprout(draft: Draft, event: RaceEventOf<'sprout.reset'>): void {
  for (const commit of draft.commits) {
    if (commit.idx > event.green_idx && commit.idx < event.trunk_idx) commit.status = 'reverted';
  }
  if (commitAt(draft, event.trunk_idx) !== undefined) return;
  draft.commits.push({
    idx: event.trunk_idx,
    sha: event.sha,
    task: null,
    kind: 'reset',
    t: event.t,
    files: [],
    status: 'pending',
    redAt: null,
  });
}

function requeueBean(draft: Draft, event: RaceEventOf<'bean.requeued'>): void {
  const target = bean(draft, event.task);
  target.landedAt = null;
  target.landedIdx = null;
  target.landedSha = null;
  setPhase(draft, event.task, 'checking', event.t);
  addStep(draft, event.task, {
    t: event.t,
    kind: 'requeued',
    detail: `ticket ${event.ticket}, was #${event.trunk_idx}`,
  });
}

// --- CI: validations, batches, bisection -----------------------------------------------------

function startCi(draft: Draft, event: RaceEventOf<'ci.start'>): void {
  draft.ci.set(event.ci, {
    ci: event.ci,
    sha: event.sha,
    purpose: event.purpose,
    slot: event.slot,
    startedAt: event.t,
    endedAt: null,
    green: null,
    cancelled: false,
    trunkIdx: event.trunk_idx ?? null,
    batch: event.batch ?? null,
    tasks: [...(event.tasks ?? [])],
    failingFiles: [],
    failingTests: [],
  });
  const commit = event.purpose === 'validate' ? commitAt(draft, event.trunk_idx) : undefined;
  if (commit?.status === 'pending') commit.status = 'validating';
}

function endCi(draft: Draft, event: RaceEventOf<'ci.end'>): void {
  if (event.purpose !== 'final') {
    const key = event.cancelled === true ? `${event.purpose}-cancelled` : event.purpose;
    draft.ciRuns[key] = (draft.ciRuns[key] ?? 0) + 1;
  }
  const isValidation = event.purpose === 'batch' || event.purpose === 'validate';
  if (event.green === false && isValidation) draft.redValidations += 1;
  const run = draft.ci.get(event.ci);
  if (run !== undefined) {
    run.endedAt = event.t;
    run.green = event.green;
    run.cancelled = event.cancelled === true;
    run.failingFiles = [...(event.failing_files ?? [])];
    run.failingTests = [...event.failing_tests];
  }
  if (event.purpose === 'batch' && event.batch !== undefined && event.green === true) {
    updateBatch(draft, event.batch, { status: 'green' });
  }
  if (event.purpose !== 'validate' || event.green !== false) return;
  const commit = commitAt(draft, event.trunk_idx);
  if (commit === undefined) return;
  commit.redAt = event.t;
  if (commit.status === 'validating' || commit.status === 'pending') commit.status = 'red';
}

function enqueue(draft: Draft, event: RaceEventOf<'queue.enqueue'>): void {
  if (!draft.queue.includes(event.task)) draft.queue.push(event.task);
  setPhase(draft, event.task, 'queued', event.t);
  addStep(draft, event.task, { t: event.t, kind: 'enqueued', detail: `depth ${event.depth}` });
  if (draft.meta?.releaseOnEnqueue === true) releaseLane(draft, event.task);
}

function eject(draft: Draft, event: RaceEventOf<'queue.eject'>): void {
  draft.queue = draft.queue.filter((id) => id !== event.task);
  setPhase(draft, event.task, 'rework', event.t);
  const why = event.reason === 'conflict' ? (event.files ?? []) : (event.failing ?? []);
  addStep(draft, event.task, {
    t: event.t,
    kind: 'ejected',
    detail: `${event.reason}: ${why.join(', ')}`,
  });
}

function startBatch(draft: Draft, event: RaceEventOf<'batch.start'>): void {
  draft.batches.set(event.batch, {
    batch: event.batch,
    tasks: [...event.tasks],
    speculative: event.speculative,
    startedAt: event.t,
    status: 'testing',
    failing: [],
    culprit: null,
  });
  draft.queue = draft.queue.filter((id) => !event.tasks.includes(id));
  for (const task of event.tasks) {
    setPhase(draft, task, 'testing', event.t);
    addStep(draft, task, { t: event.t, kind: 'batched', detail: event.batch });
  }
}

function updateBatch(draft: Draft, id: string, change: Partial<Writable<Batch>>): void {
  const batch = draft.batches.get(id);
  if (batch !== undefined) Object.assign(batch, change);
}

function cancelBatch(draft: Draft, event: RaceEventOf<'batch.cancel'>): void {
  updateBatch(draft, event.batch, { status: 'cancelled' });
  requeue(draft, event.tasks, event.t);
}

function endBisect(draft: Draft, event: RaceEventOf<'bisect.end'>): void {
  updateBatch(draft, event.batch, { culprit: event.culprit });
  requeue(draft, event.requeued, event.t);
}

function requeue(draft: Draft, tasks: readonly TaskId[], t: number): void {
  for (const task of tasks) {
    if (!draft.queue.includes(task)) draft.queue.push(task);
    setPhase(draft, task, 'queued', t);
  }
}

// --- decision cards -----------------------------------------------------------------------

function openCard(draft: Draft, event: RaceEventOf<'decision.request'>): void {
  draft.cards.set(event.card, {
    card: event.card,
    task: event.task,
    against: [...event.against],
    specs: { ...event.specs },
    failing: [...event.failing],
    attempts: event.attempts,
    trigger: event.trigger ?? null,
    reason: event.reason ?? null,
    openedAt: event.t,
    status: 'open',
    winner: null,
    loser: null,
    oracle: null,
    decidedAt: null,
    outcome: null,
    text: null,
    amendment: null,
  });
  for (const task of [event.task, ...event.against]) bean(draft, task).card = event.card;
  setPhase(draft, event.task, 'deciding', event.t);
  const start = event.trigger === 'start' ? ', before it started' : '';
  addStep(draft, event.task, {
    t: event.t,
    kind: 'decision',
    detail: `${event.card} opened against ${event.against.join(', ')}${start}`,
  });
}

function decideCard(draft: Draft, event: RaceEventOf<'decision.made'>): void {
  const card = draft.cards.get(event.card);
  if (card !== undefined) {
    card.status = 'decided';
    card.winner = event.winner;
    card.loser = event.loser;
    card.oracle = event.oracle;
    card.decidedAt = event.t;
    card.outcome = event.outcome ?? null;
    card.text = event.text ?? null;
  }
  const arriving = card?.task;
  if (arriving !== undefined && arriving === event.winner) {
    setPhase(draft, arriving, 'checking', event.t);
  }
  addStep(draft, event.winner, {
    t: event.t,
    kind: 'decision',
    detail: `${event.card}: kept over ${event.loser} (${event.oracle})`,
  });
}

function recordAmendment(draft: Draft, event: RaceEventOf<'spec.amended'>): void {
  const card = draft.cards.get(event.card);
  if (card !== undefined) card.amendment = { status: event.status, paths: [...event.paths] };
  addStep(draft, event.task, {
    t: event.t,
    kind: 'decision',
    detail: `${event.card}: tests ${event.status}${event.paths.length > 0 ? ` (${event.paths.join(', ')})` : ''}`,
  });
}

function recordReconcile(draft: Draft, event: RaceEventOf<'decision.reconcile'>): void {
  const parties = event.parties ?? [event.against];
  const what =
    event.outcome === 'reconciled'
      ? `reconciled with ${parties.join(', ')}`
      : `contradicts ${parties.join(', ')}`;
  addStep(draft, event.task, { t: event.t, kind: 'reconcile', detail: what });
}

function recordCulpritSearch(draft: Draft, event: RaceEventOf<'culprit.dynamic'>): void {
  const found =
    event.confirmed.length > 0
      ? `confirmed ${event.confirmed.join(', ')}`
      : 'none confirmed on its own';
  addStep(draft, event.task, {
    t: event.t,
    kind: 'culprits',
    detail: `left out ${plural(event.candidates.length, 'landed bean')} one at a time: ${found}`,
  });
}

type SyncEvent = RaceEventOf<
  | 'sync.applied'
  | 'sync.noted'
  | 'sync.midrun.offered'
  | 'sync.midrun.applied'
  | 'sync.midrun.noted'
>;

function recordSync(draft: Draft, event: SyncEvent): void {
  addStep(draft, event.task, {
    t: event.t,
    kind: 'synced',
    detail: `${event.landed.join(', ')} ${syncWords(event.type)} (${plural(event.files.length, 'file')})`,
  });
}

function syncWords(type: SyncEvent['type']): string {
  if (type.endsWith('.applied')) return 'merged in';
  if (type.endsWith('.offered')) return 'offered';
  return 'noted only';
}

/** A red validation that did not repeat: the test is flaky and the commit is not to blame. */
function recordFlake(draft: Draft, event: RaceEventOf<'flake.suspected'>): void {
  for (const path of event.flaky) draft.flaky.add(path);
  const commit = commitAt(draft, event.trunk_idx);
  if (commit?.status === 'red') commit.status = 'validating';
}

// --- the readonly result ----------------------------------------------------------------------

function snapshot(draft: Draft): RaceState {
  return {
    meta: draft.meta,
    phase: draft.phase,
    clock: draft.clock,
    epochMs: draft.epochMs,
    beans: Object.fromEntries(draft.beans),
    order: draft.order,
    lanes: draft.lanes,
    line: {
      commits: draft.commits.toSorted((a, b) => a.idx - b.idx),
      stalkIdx: draft.stalkIdx,
      stalkSha: draft.stalkSha,
    },
    ci: [...draft.ci.values()],
    cards: [...draft.cards.values()],
    batches: [...draft.batches.values()],
    queue: draft.queue,
    tickets: [...draft.tickets.values()],
    totals: {
      costUsd: draft.costUsd,
      redValidations: draft.redValidations,
      conflicts: draft.conflicts,
      invocations: draft.invocations,
      ciRuns: draft.ciRuns,
    },
    endedAt: draft.endedAt,
    aborted: draft.aborted,
    final: draft.final,
    lastSeq: draft.lastSeq,
    flaky: [...draft.flaky],
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
