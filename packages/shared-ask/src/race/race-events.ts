/**
 * The race events the web app reads, validated at the boundary. The schema of record is
 * `@gitstalk/shared-race/events` (the harness's `events.jsonl`); these Zod schemas keep only
 * the fields the canvas and the explorer use and strip the rest, so a slimmed fixture and a
 * full gateway event parse the same way. Unknown event types are skipped, not rejected: a
 * newer gateway may log more than this app knows.
 */
import { z } from 'zod';

import { Sha, SlotId, TaskId } from '@gitstalk/shared-race/ids';

export const CardId = z
  .string()
  .regex(/^D\d{3,6}$/)
  .brand<'CardId'>();
export type CardId = z.infer<typeof CardId>;

export const TicketId = z.string().min(1).max(32).brand<'TicketId'>();
export type TicketId = z.infer<typeof TicketId>;

export const BatchId = z.string().min(1).max(32).brand<'BatchId'>();
export type BatchId = z.infer<typeof BatchId>;

const Envelope = {
  seq: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  ts: z.string(),
};

const Paths = z.array(z.string());
const NullableTask = TaskId.nullable();

function event<const K extends string, S extends z.ZodRawShape>(type: K, shape: S) {
  return z.object({ ...Envelope, type: z.literal(type), ...shape });
}

const RaceSetup = event('race.setup', { policy: z.string() });
const FootprintPredicted = event('footprint.predicted', { task: TaskId, selected: Paths });
const RaceStart = event('race.start', {
  policy: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  agents: z.number().int().positive(),
  ci_seconds: z.number(),
  ci_slots: z.number().int(),
  batch: z.number().int().nullable(),
  tasks: z.array(TaskId),
  budget_usd: z.number(),
  seed: z.number(),
  base: Sha,
  queue_hold: z.boolean().nullable().default(null),
});
const TaskStart = event('task.start', { task: TaskId, agent: SlotId, base: Sha });
/** `initial`, `rework`, `fixer`, v2.2's `test-author`, or a kind a newer gateway adds. */
const InvocationKind = z.string().min(1);
const InvocationStart = event('invocation.start', {
  inv: z.string(),
  kind: InvocationKind,
  task: NullableTask,
  agent: SlotId.nullable(),
  attempt: z.number().int(),
});
const InvocationEnd = event('invocation.end', {
  inv: z.string(),
  kind: InvocationKind,
  task: NullableTask,
  agent: SlotId.nullable(),
  ok: z.boolean(),
  cost_usd: z.number().nonnegative(),
  num_turns: z.number().int().nullable().default(null),
  wall_ms: z.number().nullable().default(null),
  result_text: z.string().default(''),
});
const TaskCommit = event('task.commit', {
  task: TaskId,
  sha: Sha,
  kind: z.string(),
  new_commit: z.boolean(),
  files: Paths,
});
const AcceptanceRestored = event('acceptance.restored', {
  task: TaskId.optional(),
  paths: Paths,
});
const TaskDrop = event('task.drop', { task: TaskId, reason: z.string() });
const TaskParked = event('task.parked', { task: TaskId, reason: z.string() });
const CiStart = event('ci.start', {
  ci: z.string(),
  sha: Sha,
  purpose: z.string(),
  slot: z.number().int(),
  trunk_idx: z.number().int().optional(),
  batch: BatchId.optional(),
  tasks: z.array(TaskId).optional(),
  /** v2.5 dynamic bisection: the bean left out of the probe's tree. */
  without: TaskId.optional(),
});
const CiEnd = event('ci.end', {
  ci: z.string(),
  sha: Sha,
  purpose: z.string(),
  green: z.boolean().nullable(),
  slot: z.number().int(),
  cancelled: z.boolean().optional(),
  failing_files: Paths.nullable().default(null),
  failing_tests: z.array(z.string()).default([]),
  tests: z.number().int().optional(),
  trunk_idx: z.number().int().optional(),
  batch: BatchId.optional(),
  without: TaskId.optional(),
});
const Land = event('land', {
  task: NullableTask,
  sha: Sha,
  target: z.string(),
  files: Paths,
  trunk_idx: z.number().int().optional(),
  kind: z.string().optional(),
  /** v2.5: `structural` when a structural merge resolved what git's text merge could not. */
  resolved: z.string().nullable().optional(),
});
const GreenPromote = event('green.promote', {
  sha: Sha,
  trunk_idx: z.number().int().optional(),
  tasks: z.array(TaskId),
});
/**
 * A confirmed red audit of the stalk: it goes back to `sha` (the newest commit a full suite
 * passed) and the beans promoted since (`tasks`) are landed again.
 */
const GreenDemote = event('green.demote', {
  sha: Sha,
  trunk_idx: z.number().int().optional(),
  from_idx: z.number().int().optional(),
  audit_sha: Sha.optional(),
  failing: z.array(z.string()).default([]),
  tasks: z.array(TaskId).default([]),
});
const MergeConflict = event('merge.conflict', { task: NullableTask, files: Paths });
const ReworkStart = event('rework.start', {
  task: NullableTask,
  reason: z.string(),
  conflicts: Paths.optional(),
  failing: z.array(z.string()).optional(),
  attempt: z.number().int(),
  culprits: z.array(TaskId).optional(),
  /** v2.2: the decision card whose outcome this rework carries out. */
  card: CardId.nullable().optional(),
});
const RaceEnd = event('race.end', { aborted: z.string().nullable(), spent_usd: z.number() });
const FinalCheck = event('final.check', {
  correct: z.boolean().optional(),
  suite_green: z.boolean().optional(),
  tasks_accepted: z.number().int().optional(),
  tasks_total: z.number().int().optional(),
  error: z.string().optional(),
});
const Abort = event('abort', { reason: z.string() });
const QueueEnqueue = event('queue.enqueue', { task: TaskId, sha: Sha, depth: z.number().int() });
const QueueEject = event('queue.eject', {
  task: TaskId,
  reason: z.enum(['conflict', 'red']),
  files: Paths.nullable(),
  failing: z.array(z.string()).nullable(),
});
const QueueHold = event('queue.hold', {
  task: TaskId,
  files: Paths,
  behind: z.array(TaskId),
});
const BisectStart = event('bisect.start', { batch: BatchId, tasks: z.array(TaskId) });
const BatchStart = event('batch.start', {
  batch: BatchId,
  tasks: z.array(TaskId),
  speculative: z.boolean(),
});
const BatchRed = event('batch.red', {
  batch: BatchId,
  tasks: z.array(TaskId),
  failing: z.array(z.string()).nullable(),
});
const BatchCancel = event('batch.cancel', { batch: BatchId, tasks: z.array(TaskId) });
const BisectEnd = event('bisect.end', {
  batch: BatchId,
  culprit: TaskId,
  landed: z.array(TaskId),
  requeued: z.array(TaskId),
});
const TicketOpen = event('ticket.open', {
  ticket: TicketId,
  red_idx: z.number().int(),
  failing: z.array(z.string()),
});
const TicketCulprit = event('ticket.culprit', {
  ticket: TicketId,
  trunk_idx: z.number().int(),
  task: NullableTask,
});
const TicketClose = event('ticket.close', { ticket: TicketId });
const TicketEscalate = event('ticket.escalate', { ticket: TicketId });
/** The engine gave up on a ticket's revert (no culprit it can revert): escalated, no `ticket.escalate`. */
const TicketStuck = event('ticket.stuck', { ticket: TicketId });
const Revert = event('revert', {
  ticket: TicketId,
  task: NullableTask,
  reverted: Sha,
  sha: Sha,
  trunk_idx: z.number().int(),
});
/** `red_reset`: the sprout reset to the stalk's tree; the red window's beans are requeued. */
const SproutReset = event('sprout.reset', {
  ticket: TicketId,
  green_idx: z.number().int(),
  trunk_idx: z.number().int(),
  sha: Sha,
  requeued: z.array(TaskId),
});
const BeanRequeued = event('bean.requeued', {
  task: TaskId,
  ticket: TicketId,
  trunk_idx: z.number().int(),
});
const RevertConflict = event('revert.conflict', {
  ticket: TicketId,
  task: NullableTask,
  files: Paths,
});
const PrelandCheck = event('preland.check', {
  task: TaskId,
  green: z.boolean(),
  failing_tests: z.array(z.string()).default([]),
  check_seconds: z.number(),
  /** v2.2: the red was the sprout's, not the bean's; no rework round is spent. */
  inherited: z.literal(true).optional(),
});
const PrelandRecheck = event('preland.recheck', { task: TaskId, attempt: z.number().int() });
const PrelandOptimistic = event('preland.optimistic', {
  task: TaskId,
  landed_meanwhile: z.number().int(),
});
const DecisionRequest = event('decision.request', {
  card: CardId,
  task: TaskId,
  against: z.array(TaskId),
  specs: z.record(z.string(), z.string()),
  failing: z.array(z.string()),
  attempts: z.number().int(),
  /** v2.5: `start` for a start card, raised before the arriving bean began. */
  trigger: z.string().nullable().optional(),
  /** v2.4: the test author's account of the contradiction. */
  reason: z.string().nullable().optional(),
  /** v2.5: every landed task in the reconcile that led to the card. */
  parties: z.array(TaskId).optional(),
});
const DecisionMade = event('decision.made', {
  card: CardId,
  winner: TaskId,
  loser: TaskId,
  oracle: z.string(),
  wait_seconds: z.number(),
  /** v2.2: `keep-landed` or `adopt-in-place`. */
  outcome: z.string().optional(),
  /** v2.2: the decision line the test author and the re-executed bean read. */
  text: z.string().optional(),
});
const SpecAmended = event('spec.amended', {
  card: CardId,
  task: TaskId,
  status: z.enum(['amended', 'none', 'rejected', 'rolled-back']),
  paths: Paths,
  in_place: z.boolean(),
});
const FlakeSuspected = event('flake.suspected', {
  trunk_idx: z.number().int(),
  flaky: Paths,
});
/** v2.5 `tests_first`: the test author's tests for a task, proven failing on its base. */
const TestsFirst = event('tests.first', {
  task: TaskId,
  status: z.string(),
  files: Paths,
  accepted: Paths.default([]),
});
/** v2.4: before a card, the test author reconciled two tasks' tests, or found a contradiction. */
const DecisionReconcile = event('decision.reconcile', {
  task: TaskId,
  against: TaskId,
  outcome: z.string(),
  files: Paths,
  reason: z.string().nullable().default(null),
  parties: z.array(TaskId).optional(),
});
/** v2.5: the bean's rework rounds ran out; it is re-executed once on the sprout head. */
const RescueStart = event('rescue.start', {
  task: TaskId,
  why: z.string(),
  rounds: z.number().int(),
});
/** v2.5: leave-one-out search for the landed beans that break the bean's own tests. */
const CulpritDynamic = event('culprit.dynamic', {
  task: TaskId,
  candidates: z.array(TaskId),
  confirmed: z.array(TaskId),
});
const SyncFields = { task: TaskId, landed: z.array(TaskId), files: Paths };
/** `live_sync`: beans that landed meanwhile, merged into the bean's branch for its agent. */
const SyncApplied = event('sync.applied', SyncFields);
/** `live_sync`: the same merge conflicted; the bean's next prompt names the conflicts. */
const SyncNoted = event('sync.noted', { ...SyncFields, conflicts: Paths.default([]) });
/** `live_sync_midrun`: the sprout offered to a running agent, merged by it, or only noted. */
const SyncMidrunOffered = event('sync.midrun.offered', SyncFields);
const SyncMidrunApplied = event('sync.midrun.applied', SyncFields);
const SyncMidrunNoted = event('sync.midrun.noted', SyncFields);
/** v2.3: a green bean waits for room in the sprout window. */
const WindowWait = event('window.wait', {
  task: TaskId,
  window: z.number().int(),
  unvalidated: z.number().int(),
});
/** v2.3: the sprout window grew after a green validation, or halved on a red sprout. */
const WindowResize = event('window.resize', {
  window: z.number().int(),
  previous: z.number().int(),
  reason: z.string(),
});

/** Every event type the web app understands. */
export const RaceEvent = z.discriminatedUnion('type', [
  RaceSetup,
  FootprintPredicted,
  RaceStart,
  TaskStart,
  InvocationStart,
  InvocationEnd,
  TaskCommit,
  AcceptanceRestored,
  TaskDrop,
  TaskParked,
  CiStart,
  CiEnd,
  Land,
  GreenPromote,
  GreenDemote,
  MergeConflict,
  ReworkStart,
  RaceEnd,
  FinalCheck,
  Abort,
  QueueEnqueue,
  QueueEject,
  QueueHold,
  BisectStart,
  BatchStart,
  BatchRed,
  BatchCancel,
  BisectEnd,
  TicketOpen,
  TicketCulprit,
  TicketClose,
  TicketEscalate,
  TicketStuck,
  Revert,
  SproutReset,
  BeanRequeued,
  RevertConflict,
  PrelandCheck,
  PrelandRecheck,
  PrelandOptimistic,
  DecisionRequest,
  DecisionMade,
  SpecAmended,
  FlakeSuspected,
  TestsFirst,
  DecisionReconcile,
  RescueStart,
  CulpritDynamic,
  SyncApplied,
  SyncNoted,
  SyncMidrunOffered,
  SyncMidrunApplied,
  SyncMidrunNoted,
  WindowWait,
  WindowResize,
]);
export type RaceEvent = z.infer<typeof RaceEvent>;
export type RaceEventType = RaceEvent['type'];
export type RaceEventOf<K extends RaceEventType> = Extract<RaceEvent, { type: K }>;

const KNOWN_TYPES: ReadonlySet<string> = new Set(
  RaceEvent.options.map((option) => option.shape.type.value),
);

/** Events parsed from a log, plus how many were skipped (unknown types or bad fields). */
export type SkippedEvent = {
  readonly seq: number | null;
  /** `unknown`: a type this app does not model (expected); `invalid`: a bad event. */
  readonly kind: 'unknown' | 'invalid';
  readonly reason: string;
};

export type ParsedEvents = {
  readonly events: readonly RaceEvent[];
  readonly skipped: readonly SkippedEvent[];
};

/**
 * Parses raw events (objects or JSON text lines) in log order. Never throws for bad input:
 * an event of an unknown type, or one that fails its schema, is reported in `skipped`.
 */
export function parseRaceEvents(raw: readonly unknown[]): ParsedEvents {
  const events: RaceEvent[] = [];
  const skipped: SkippedEvent[] = [];
  for (const item of raw) {
    const value = typeof item === 'string' ? parseJson(item) : item;
    const result = RaceEvent.safeParse(value);
    if (result.success) {
      events.push(result.data);
      continue;
    }
    skipped.push(skip(value, result.error));
  }
  return { events, skipped };
}

/** Splits `events.jsonl` text into lines and parses them. */
export function parseEventLog(text: string): ParsedEvents {
  return parseRaceEvents(text.split('\n').filter((line) => line.trim() !== ''));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Reported by the schema check as a non-event; the caller sees it in `skipped`.
    return undefined;
  }
}

function seqOf(value: unknown): number | null {
  const envelope = z.object({ seq: z.number() }).safeParse(value);
  return envelope.success ? envelope.data.seq : null;
}

function skip(value: unknown, error: z.ZodError): SkippedEvent {
  const seq = seqOf(value);
  const typed = z.object({ type: z.string() }).safeParse(value);
  if (!typed.success) return { seq, kind: 'invalid', reason: 'not an event' };
  const type = typed.data.type;
  if (!KNOWN_TYPES.has(type)) return { seq, kind: 'unknown', reason: `unknown type ${type}` };
  return { seq, kind: 'invalid', reason: `${type}: ${z.prettifyError(error)}` };
}
