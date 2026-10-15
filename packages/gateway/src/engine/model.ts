import type {
  InvocationKind,
  InvocationResult,
  ProgressResponse,
  ReplayHints,
  TestFile,
  WorkspaceMerge,
} from '@gitstalk/shared-race/driver';
import type {
  CheckHold,
  CiMeta,
  EventEnvelope,
  Json,
  RaceEventFields,
  RaceEventType,
} from '@gitstalk/shared-race/events';
import type { InvocationId, Sha, SlotId, TaskId } from '@gitstalk/shared-race/ids';
import type { CheckReadMaps, CheckedTree } from '@gitstalk/shared-race/read-maps';
import type { AgentKind, PolicyName } from '@gitstalk/shared-race/run-config';

/** Seconds since the run was created (the harness's `t`, unrounded). */
export type Seconds = number;

export type CiId = `ci${string}`;
export type JobId = `job${string}`;
export type TimerId = `tm${string}`;

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'queued'
  | 'testing'
  | 'rework'
  | 'landed'
  | 'green'
  | 'dropped'
  | 'parked';

/** The harness's `TaskState`, minus what lives in the driver's worktree. */
export type TaskState = {
  id: TaskId;
  status: TaskStatus;
  agent: SlotId | null;
  baseSha: Sha | null;
  headSha: Sha | null;
  /** Newest landed-line commit merged into the task branch: the merge base of every squash. */
  mergedMain: Sha | null;
  sessionId: string | null;
  /** The driver can resume `sessionId` (its last invocation reported a result and a cost). */
  sessionResumable: boolean;
  startedAt: Seconds | null;
  agentDoneAt: Seconds | null;
  landedAt: Seconds | null;
  greenAt: Seconds | null;
  landedSha: Sha | null;
  writeSet: string[];
  actualModules: string[];
  invocations: InvocationId[];
  conflicts: number;
  reds: number;
  reworks: number;
  infraRetries: number;
  dropReason: string | null;
  /** v2 `park`: why the bean waits for a person (absent in runs created before parking). */
  parkedReason?: string | null;
  /**
   * A pushed bean's fork point: the sprout commit its pushed head grew from, which its start
   * takes as its base instead of the sprout head (absent: an arena task, or not found).
   */
  pushedBase?: Sha | null;
  tamper: string[];
  /** Predicted footprint modules (reported; the queue never places by them). */
  selected: string[];
};

export type SlotActivity = 'busy' | 'blocked' | 'idle';

/** One agent slot of the driver (the harness's `AgentSlot`). */
export type SlotState = {
  id: SlotId;
  state: SlotActivity;
  since: Seconds;
  totals: Record<SlotActivity, number>;
  /** Task (or ticket) bound to this slot. */
  holding: string | null;
  /** Invocation the driver is running for this slot (delivered, no result yet). */
  running: InvocationId | null;
  /** Invocation created for this slot and not yet delivered. */
  outbox: InvocationId | null;
  /** The slot's open long poll, if any: work is only offered to slots that are asking. */
  pollId: string | null;
};

/** The git side of an invocation, before the shell adds gateway URLs. */
export type EngineWorkspace = {
  repoKey: string;
  branch: string;
  baseSha: Sha;
  headSha: Sha | null;
  merge: WorkspaceMerge | null;
  acceptance: Readonly<Record<string, string>>;
  protect: readonly TestFile[];
  unionPaths: readonly string[];
  commitMessage: string;
};

/**
 * A protected landed test as an open invocation stores it: the task whose acceptance test it
 * is and its path. The contents are read at delivery (`toInstruction`), so the state does not
 * carry every landed test once per open invocation.
 */
export type ProtectedTestRef = { readonly task: string; readonly path: string };

/**
 * The workspace an open invocation stores. `protect` holds references; states persisted
 * before references existed hold full test files, which are delivered as they are.
 */
export type StoredWorkspace = Omit<EngineWorkspace, 'protect'> & {
  protect: readonly (ProtectedTestRef | TestFile)[];
};

/** An invocation created by the engine and not yet closed by a result. */
export type OpenInvocation = {
  id: InvocationId;
  kind: InvocationKind;
  task: string;
  slot: SlotId;
  attempt: number;
  prompt: string;
  /**
   * Prompt for the fresh-session retry when resuming `resume` fails; null when it is `prompt`
   * itself (states persisted before this was optional hold the text either way).
   */
  freshPrompt: string | null;
  resume: string | null;
  workspace: StoredWorkspace;
  replay: ReplayHints;
  /** The landed-line commit a commit of this invocation has merged, when `merge.sha` is not it. */
  mergedLine: Sha | null;
  createdAt: Seconds;
  deliveredAt: Seconds | null;
  budgetCapUsd: number | null;
  watchdog: TimerId | null;
  /** When the driver last reported progress on it (absent: never; a lost reply is re-delivered). */
  reportedAt?: Seconds;
};

/** What the summary needs from a closed invocation (`Race.invocations`). */
export type InvocationRecord = {
  inv: InvocationId;
  kind: InvocationKind;
  task: string;
  costUsd: number;
  turns: number | null;
  wallMs: number;
  durationApiMs: number | null;
  startupMs: number | null;
  subtype: string | null;
  infraError: string | null;
  overage: boolean;
  rateLimit: Json;
};

/** Running totals per invocation kind (`Race.inv_stats`). */
export type InvocationStats = {
  count: number;
  cost_usd: number;
  turns: number;
  wall_s: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  infra_errors: number;
  timeouts: number;
  estimated_cost: number;
};

/** One failing test as the runner reports it. */
export type FailingTest = {
  readonly file: string;
  readonly name: string;
  /** The failure's message, when the runner reports it (a `SyntaxError` marks a broken file). */
  readonly message?: string;
};

/** Changed line ranges per file, `[start, end)` in the base's lines, as `git diff -U0` gives them. */
export type LineRanges = Readonly<Record<string, readonly (readonly [number, number])[]>>;

/** A suite run's outcome (the runner's `/v1/check`, the harness's `CIResult`). */
export type CheckResult = {
  readonly green: boolean;
  readonly tests: number;
  readonly failures: number;
  readonly failingTests: readonly FailingTest[];
  /** Null when the suite crashed or timed out before reporting. */
  readonly failingFiles: readonly string[] | null;
  /** Null when the runner does not report passing files. */
  readonly passingFiles: readonly string[] | null;
  /** The failing tests' static import closure, as one set (v2 names culprits by it). */
  readonly readSet: readonly string[];
  readonly readSets: Readonly<Record<string, readonly string[]>>;
  /** v2.5: the passing test files' read sets, when the check asked for them (`allReadSets`). */
  readonly passingReadSets?: Readonly<Record<string, readonly string[]>>;
  /**
   * The runner vouches that every read set it reported is complete: every file the test resolved,
   * probed or listed (`evidence_read_sets: complete` trusts no other). Absent: static closures.
   */
  readonly readSetsComplete?: boolean;
  /** Import hops from each failing test file to each file it reads (suspect ranking). */
  readonly readDepths: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly stackFiles: readonly string[];
  readonly output: string;
  readonly suiteSeconds: number;
  readonly timedOut: boolean;
  /**
   * The runner's read maps of a traced check. The RunDO stores them (`read-maps/`) and removes
   * them, with `tree`, before the engine sees the result; the engine sees `mappedTree`.
   */
  readonly readMaps?: CheckReadMaps;
  /** The checked tree's blob ids (traced, or asked for with `treeManifest`); removed likewise. */
  readonly tree?: CheckedTree;
  /**
   * The tree key this check's manifest (and maps, when traced) were stored under: the `base`
   * or `mapsFrom` of a `ReadMapIndex` query about this tree.
   */
  readonly mappedTree?: string;
  /**
   * The approval rules held the bean for a person (`approval/approval-gate.ts`): a red that says
   * nothing failed. A continuous engine spends no rework round on it (`v2-landing.ts`).
   */
  readonly awaitsApproval?: true;
  /**
   * The hold itself (classes, deciding class, who decided); the `preland.check` event carries it
   * as `held`.
   */
  readonly held?: CheckHold;
};

export type CiPurpose = 'batch' | 'bisect' | 'validate' | 'final';

export type CiRun = {
  id: CiId;
  sha: Sha;
  purpose: CiPurpose;
  meta: CiMeta;
  owner: 'policy' | 'final';
  extraFiles: Readonly<Record<string, string>> | null;
  latency: Seconds;
  status: 'queued' | 'running' | 'latency';
  slot: number | null;
  startedAt: Seconds | null;
  jobId: JobId | null;
  timerId: TimerId | null;
  result: CheckResult | null;
  /** Only these test files (`affected_validation`); absent: the whole suite. */
  only?: readonly string[];
  /** Every passing test's read set is reported too (`evidence_promotion`). */
  allReadSets?: true;
  /**
   * Cancelled while its suite runs (a superseded validation): `ci.end` is logged, the slot stays
   * reserved until the runner's job returns, and that outcome is dropped (absent: not cancelled).
   */
  cancelled?: true;
};

export type CiState = {
  seq: number;
  /** Reservations (`Race.ci_claimed`): taken when a run is requested, released when it ends. */
  claimed: number;
  /** Free emulated CI slots, least recently freed first (the harness's asyncio.Queue). */
  freeSlots: number[];
  queue: CiId[];
  runs: Record<string, CiRun>;
  /** Every finished or cancelled run, for `ci_runs` / `ci_minutes` in the summary. */
  log: { purpose: CiPurpose; cancelled: boolean; seconds: number }[];
};

/**
 * The runner instance a suite runs on: an emulated CI slot, or the sandbox of the agent
 * slot whose bean is checked (v2's pre-land checks). Both get read-only tokens; squashes,
 * reverts and ref updates run on the run's committer instance.
 */
export type CheckInstance =
  | { readonly kind: 'ci'; readonly slot: number }
  | { readonly kind: 'sandbox'; readonly slot: SlotId };

/** Work the shell performs for the engine (Artifacts binding or runner container). */
export type JobSpec =
  | {
      readonly kind: 'squash';
      readonly onto: Sha;
      readonly changeKey: string;
      readonly changeRef: string;
      readonly changeBase: Sha;
      readonly message: string;
      readonly unionPaths: readonly string[];
      /** Retry a line-merge conflict with the runner's structural tier (`usesStructuralMerge`). */
      readonly structural: boolean;
    }
  | {
      readonly kind: 'check';
      readonly sha: Sha;
      readonly extraFiles: Readonly<Record<string, string>> | null;
      readonly instance: CheckInstance;
      /** v2.5's targeted check: run only these test files (default: the whole suite). */
      readonly only?: readonly string[];
      /** v2.5: also report the passing test files' read sets (the targeted check's third source). */
      readonly allReadSets?: true;
      /** Trace each test file for read maps; absent, the run's `read_maps` setting decides. */
      readonly trace?: boolean;
      /** Report the tree's manifest; absent, the run's `read_maps` setting decides. */
      readonly treeManifest?: boolean;
    }
  | {
      /** A commit on `onto` that undoes `commit` (published as a candidate, no ref moved). */
      readonly kind: 'revert';
      readonly onto: Sha;
      readonly commit: Sha;
      /**
       * Undo every commit in `to..commit` at once: the merge's other side is `to`, not the
       * commit's parent. With `commit` = `onto` = the sprout head, the result is exactly `to`'s
       * tree and never conflicts (v2's red-window reset, `red_reset`).
       */
      readonly to?: Sha;
      readonly message: string;
      readonly unionPaths: readonly string[];
    }
  | {
      /** The changed line ranges of `mine` and of `theirs` against `base`, in `files` (v2.2 `hunk`). */
      readonly kind: 'line-ranges';
      readonly base: Sha;
      readonly mine: Sha;
      readonly theirs: Sha;
      readonly files: readonly string[];
    }
  | {
      /** `git diff --stat -p parent sha` of the run repo, cut at `limit` characters. */
      readonly kind: 'diff';
      readonly parent: Sha;
      readonly sha: Sha;
      readonly limit: number;
    }
  | {
      readonly kind: 'update-ref';
      readonly ref: string;
      readonly newSha: Sha;
      readonly oldSha: Sha;
    }
  | { readonly kind: 'read-files'; readonly reads: readonly { ref: Sha; path: string }[] };

/** The runner's merge tier behind a clean squash: git's line merge, or Mergiraf after it. */
export type Resolution = 'textual' | 'structural';

/** One conflict block of a squash: the sprout's side and the bean's side. */
export type ConflictHunk = {
  readonly path: string;
  readonly sprout: string;
  readonly bean: string;
};

export type JobResult =
  | {
      readonly kind: 'squash';
      readonly outcome: 'clean';
      readonly sha: Sha;
      readonly files: readonly string[];
      /** The change's own write set (`changeBase..head`); null when the runner left it out. */
      readonly changeFiles: readonly string[] | null;
      readonly resolved: Resolution;
    }
  | {
      readonly kind: 'squash';
      readonly outcome: 'conflict';
      readonly files: readonly string[];
      readonly hunks: readonly ConflictHunk[];
    }
  | {
      readonly kind: 'revert';
      readonly outcome: 'clean';
      readonly sha: Sha;
      readonly files: readonly string[];
    }
  | { readonly kind: 'revert'; readonly outcome: 'conflict'; readonly files: readonly string[] }
  | { readonly kind: 'diff'; readonly text: string }
  | { readonly kind: 'line-ranges'; readonly mine: LineRanges; readonly theirs: LineRanges }
  | { readonly kind: 'check'; readonly check: CheckResult }
  | { readonly kind: 'update-ref'; readonly ok: boolean; readonly actual: Sha | null }
  | { readonly kind: 'read-files'; readonly contents: readonly (string | null)[] };

export type JobOutcome =
  | { readonly ok: true; readonly result: JobResult }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

export type JobOwner =
  | { readonly kind: 'ci'; readonly ciId: CiId }
  | { readonly kind: 'final' }
  | { readonly kind: 'policy' };

export type JobRecord = {
  spec: JobSpec;
  owner: JobOwner;
  attempts: number;
};

export type TimerPurpose =
  | { readonly kind: 'ci-latency'; readonly ciId: CiId }
  | { readonly kind: 'initial-retry'; readonly task: TaskId }
  | { readonly kind: 'job-retry'; readonly jobId: JobId }
  | { readonly kind: 'wall-clock' }
  | { readonly kind: 'watchdog'; readonly inv: InvocationId }
  | { readonly kind: 'policy'; readonly key: string };

export type TimerRecord = { at: Seconds; purpose: TimerPurpose };

/** Per-task outcome of the final acceptance run (`final.per_task`). */
export type FinalTaskCheck = {
  acceptance_pass: boolean;
  status: TaskStatus;
  committed_tests_intact: boolean;
};

export type FinalState =
  | {
      phase: 'suite';
      sha: Sha;
      ciId: CiId;
      /** v2.5: this is the re-run of a red final suite (`rerunsRedFinalSuite`). */
      rerun?: true;
    }
  | { phase: 'acceptance'; sha: Sha; suite: CheckResult; ciId: CiId }
  | {
      phase: 'files';
      sha: Sha;
      suite: CheckResult;
      acceptance: CheckResult;
      jobId: JobId;
      /** Test files the landed changes touched, read at the base to see whether they existed. */
      candidates: string[];
    }
  | { phase: 'done'; report: FinalReport };

export type FinalReport =
  | {
      sha: Sha;
      suite_green: boolean;
      suite_tests: number;
      suite_failures: number;
      acceptance_run_green: boolean;
      tasks_accepted: number;
      tasks_total: number;
      green_tasks_accepted: number;
      green_tasks: number;
      correct: boolean;
      all_tasks_accepted: boolean;
      failing_files: string[];
      base_tests_changed: string[];
      per_task: Record<string, FinalTaskCheck>;
    }
  | { error: string };

/** The engine's instruction for a slot; the shell adds the gateway git URLs on delivery. */
export type EngineInstruction = {
  readonly inv: InvocationId;
  readonly kind: InvocationKind;
  readonly task: string;
  readonly slot: SlotId;
  readonly attempt: number;
  readonly prompt: string;
  readonly resume: string | null;
  readonly adapter: AgentKind;
  readonly model: string | null;
  readonly max_turns: number;
  readonly timeout_seconds: number;
  readonly budget_cap_usd: number;
  readonly workspace: EngineWorkspace;
  readonly replay: ReplayHints;
};

export type EngineReply =
  | { readonly invocation: EngineInstruction }
  | { readonly wait: true }
  | { readonly done: true; readonly aborted: string | null };

/** Labels for `race.setup` that only the shell knows (run id, run repo). */
export type RunLabels = { readonly out: string; readonly repo: string };

export type EngineInput =
  | {
      readonly kind: 'start';
      readonly at: number;
      readonly baseSha: Sha;
      readonly labels: RunLabels;
    }
  | { readonly kind: 'stop'; readonly at: number; readonly reason: string }
  | { readonly kind: 'poll'; readonly at: number; readonly slot: SlotId; readonly pollId: string }
  | {
      readonly kind: 'poll-expired';
      readonly at: number;
      readonly slot: SlotId;
      readonly pollId: string;
    }
  | {
      readonly kind: 'result';
      readonly at: number;
      readonly slot: SlotId;
      readonly inv: InvocationId;
      readonly result: InvocationResult;
    }
  | {
      readonly kind: 'progress';
      readonly at: number;
      readonly slot: SlotId;
      readonly inv: InvocationId;
      readonly costUsd: number;
      /** `live_sync_midrun`: the paths the agent has changed so far (absent: unknown). */
      readonly files?: readonly string[];
    }
  | {
      readonly kind: 'job-done';
      readonly at: number;
      readonly jobId: JobId;
      readonly outcome: JobOutcome;
    }
  | { readonly kind: 'tick'; readonly at: number }
  | {
      /**
       * A continuous engine takes a bean that arrived by push (`intake.ts`). The shell adds
       * the bean's definition to the run's tasks first; this makes it a pending task.
       */
      readonly kind: 'admit';
      readonly at: number;
      readonly task: TaskId;
      /** The sprout commit the pushed head grew from, when the shell found it. */
      readonly base: Sha | null;
    }
  | {
      /** An answer to a decision card (the admin route); the oracle answers with a timer. */
      readonly kind: 'decision';
      readonly at: number;
      readonly card: string;
      readonly winner: string;
      /** Who answered (`admin` for the HTTP route, the web app's user for RPC). */
      readonly actor: string;
      /** The decision line, when the human wrote one. */
      readonly text: string | null;
    }
  | { readonly kind: 'restart'; readonly at: number }
  | {
      readonly kind: 'fault';
      readonly at: number;
      readonly where: string;
      readonly error: string;
      readonly traceback: string;
    };

/** Expected refusals the shell maps to HTTP statuses. */
export type EngineRefusal = {
  readonly code:
    | 'invalid_state'
    | 'unknown_invocation'
    | 'wrong_slot'
    | 'closed_invocation'
    | 'unknown_card'
    | 'invalid_winner';
  readonly message: string;
};

export type EngineResponse =
  | { readonly kind: 'none' }
  | { readonly kind: 'poll'; readonly reply: EngineReply | null }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'progress'; readonly response: ProgressResponse }
  | { readonly kind: 'refused'; readonly refusal: EngineRefusal };

/** An event as the engine emits it (any type's fields behind the common envelope). */
export type EmittedEvent = EventEnvelope & RaceEventFields[RaceEventType];

export type Effects = {
  events: EmittedEvent[];
  replies: { pollId: string; reply: EngineReply }[];
  jobs: { id: JobId; spec: JobSpec }[];
};

/** The policy names this build can run. */
export const SUPPORTED_POLICIES: readonly PolicyName[] = ['queue', 'beanstalk-v2'];
