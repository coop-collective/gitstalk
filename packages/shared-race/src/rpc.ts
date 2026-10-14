/**
 * The gateway's RPC surface for the web app (`packages/web`) and the MCP server
 * (`packages/mcp`), which reach it through a service binding to the `beanstalk-gateway`
 * Worker's default entrypoint. Workers RPC, not HTTP (AGENTS.md). The binding is the trust
 * boundary for reads and human decisions: the web app authenticates users before calling
 * `decide`, and MCP verifies view/contributor capabilities before reading. Collaboration
 * mutations additionally verify the signed contributor token again inside the gateway.
 *
 * Every method returns a value: expected failures come back as `{ ok: false, error }`.
 * Engine decisions and separately scoped collaboration metadata have write methods.
 * Output sizes are bounded, and a `truncated` flag says when a bound was hit.
 */
import type { RouteReceipt } from './approval-policy';
import type { ApproveBeanRequest, ApprovedBean, BeanHold } from './bean-approval';
import type { ApprovalPolicyView } from './policy-file';
import type {
  BeanContext,
  BeanContextInput,
  BeanDiscoverInput,
  BeanDiscoverPage,
  BeanPeerSummary,
  BeanInboxAckInput,
  BeanInboxAckResult,
  BeanInboxPage,
  BeanInboxReadInput,
  BeanThreadPostInput,
  BeanThreadPostResult,
  BeanUpdateInput,
  BeanUpdateResult,
  ContributorTokenClaims,
} from './collaboration';
import type { BeanCommitInput, BeanCommitResult } from './bean-commit';
import type { StreamFile } from './driver';
import type { FinalCheckFields } from './events';
import type { PolicyName, RunPreset } from './run-config';

export type RpcError = {
  /** `not_found`, `invalid_request`, `invalid_state`, `unknown_card`, `upstream_failed` … */
  readonly code: string;
  /** The HTTP status the same failure gets on the HTTP API. */
  readonly status: number;
  readonly message: string;
};

export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcError };

export type RunPhase = 'created' | 'running' | 'finishing' | 'done';

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

/** Tasks per status. */
export type TaskCounts = Readonly<Record<TaskStatus, number>>;

/** One run in `listRuns`. */
export type RunListItem = {
  readonly run: string;
  readonly policy: PolicyName;
  /** The pinned settings the run was created with (`demo`: v2.5 plus dependency starts, `park` and `red_reset`; `v24`: v2.4), or null. */
  readonly preset: RunPreset | null;
  readonly phase: RunPhase;
  readonly aborted: string | null;
  /** ISO 8601. */
  readonly created_at: string;
  readonly updated_at: string;
  readonly agents: number;
  readonly tasks: TaskCounts & { readonly total: number };
  readonly spent_usd: number;
};

export type SlotView = {
  readonly slot: string;
  readonly activity: 'busy' | 'blocked' | 'idle';
  readonly holding: string | null;
  readonly invocation: string | null;
  /** The slot's driver has a long poll open. */
  readonly asking: boolean;
};

export type CostView = {
  readonly spent_usd: number;
  readonly committed_usd: number;
  readonly budget_usd: number;
};

export type CiView = {
  readonly slots: number;
  readonly claimed: number;
  readonly queued: number;
  readonly running: readonly {
    readonly ci: string;
    readonly purpose: string;
    readonly sha: string;
    readonly slot: number | null;
    readonly status: 'queued' | 'running' | 'latency';
  }[];
};

/** The queue's state (`policy: queue`). */
export type QueuePolicyView = {
  readonly kind: 'queue';
  readonly stalk: string;
  readonly pending: readonly string[];
  readonly inflight: readonly {
    readonly batch: string;
    readonly tasks: readonly string[];
    readonly head: string;
    readonly speculative: boolean;
    readonly ci: string | null;
  }[];
  readonly bisecting: string | null;
  readonly rework_jobs: readonly string[];
  readonly reworking: readonly string[];
  readonly integrator: 'idle' | 'build' | 'land';
  readonly stats: Readonly<Record<string, number | readonly number[]>>;
};

export type CardView = {
  readonly card: string;
  readonly task: string;
  readonly against: readonly string[];
  readonly specs: Readonly<Record<string, string>>;
  readonly status: 'open' | 'decided' | 'done';
  readonly winner: string | null;
  readonly loser: string | null;
  readonly outcome: 'declined' | 'keep-landed' | 'adopt-in-place' | null;
  readonly text: string | null;
  readonly opened_at: number;
  readonly amendment: {
    readonly status: 'amended' | 'none' | 'rejected';
    readonly paths: readonly string[];
  } | null;
};

/** v2's state (`policy: beanstalk-v2`): the sprout, the stalk, beans in flight, cards. */
export type V2PolicyView = {
  readonly kind: 'beanstalk-v2';
  readonly sprout: { readonly sha: string; readonly idx: number };
  readonly stalk: { readonly sha: string; readonly idx: number; readonly ref: string };
  readonly unvalidated: number;
  readonly validating: readonly number[];
  readonly turn: string | null;
  readonly waiting_for_turn: readonly string[];
  readonly beans: readonly {
    readonly task: string;
    readonly slot: string;
    /**
     * The bean's step: `squash`, `check`, `queued-land`, `inherited` (waiting out the sprout's
     * red), `awaiting-agent`, `rework`, `decision` …
     */
    readonly step: string;
    readonly rounds: number;
    readonly rechecks: number;
  }[];
  /** Beans waiting for a free agent (release on check). */
  readonly agent_queue: readonly string[];
  readonly tickets: readonly {
    readonly ticket: string;
    readonly status: string;
    readonly method: string;
    readonly red_idx: number;
    readonly failing: readonly string[];
  }[];
  readonly cards: readonly CardView[];
  /** Tests suspected flaky this run, with how often. */
  readonly flakes: Readonly<Record<string, number>>;
  readonly recent_checks: { readonly count: number; readonly reds: number };
  /**
   * v2.3's sprout window: at most `size` beans above the stalk (`window: aimd`; null when
   * off), and the green beans waiting for room, oldest first.
   */
  readonly window: {
    readonly size: number;
    readonly unvalidated: number;
    readonly waiting: readonly string[];
  } | null;
  /** `recheck: sampled`: re-checking every overlap, or skipping (sampling 1 in 4). */
  readonly recheck_mode: 'checking' | 'skipping';
  readonly settings: {
    readonly recheck: string;
    readonly recheck_fallback: string;
    readonly release_on_check: boolean;
    readonly flake_confirm: boolean;
    readonly inherited_reds: 'readset' | 'validation' | 'off';
    readonly early_tickets: boolean;
    readonly reconcile: boolean;
    readonly decision_outcome: 'reexecute' | 'decline';
    readonly decision_mode: 'oracle' | 'human';
  };
  readonly stats: Readonly<Record<string, number>>;
};

export type PolicyView = QueuePolicyView | V2PolicyView;

export type FinalView =
  | { readonly phase: 'suite' | 'acceptance' | 'files' }
  | ({ readonly phase: 'done' } & FinalCheckFields);

/** `runView`: the run at a glance (also `GET /v1/runs/:run`). */
export type RunView = {
  readonly run: string;
  /** The run repo (`race-<run>`): the sprout, the stalk and every bean branch. */
  readonly repo: string;
  readonly phase: RunPhase;
  readonly aborted: string | null;
  readonly policy: PolicyName;
  readonly agent: string;
  readonly model: string | null;
  readonly created_at: string;
  /** Seconds since the run was created. */
  readonly t: number;
  readonly race_t0: number | null;
  readonly base_sha: string | null;
  /** Events logged so far. */
  readonly events: number;
  readonly tasks: TaskCounts;
  readonly task_status: Readonly<Record<string, TaskStatus>>;
  readonly slots: readonly SlotView[];
  readonly cost: CostView;
  readonly ci: CiView;
  readonly policy_state: PolicyView | null;
  readonly final: FinalView | null;
  /**
   * The engine's read index (git objects by id in its SQLite, plus a 5 s ref memo): hits and
   * misses since the run was created. Absent from gateways older than the counts.
   */
  readonly cache?: CacheView;
};

/** Hits and misses of one tier or kind; `hit_rate` is null until something was read. */
export type CacheCountView = {
  readonly hits: number;
  readonly misses: number;
  readonly hit_rate: number | null;
};

/** One purpose's counts: objects together, each kind, and the ref memo apart. */
export type CacheKindsView = {
  /** Commits, trees and blobs together. */
  readonly objects: CacheCountView;
  readonly commit: CacheCountView;
  readonly tree: CacheCountView;
  readonly blob: CacheCountView;
  readonly ref_memo: CacheCountView;
};

/**
 * Reads someone asked for (jobs, the approval gate, the explorer) at the top level; the
 * warm-up after each landing under `prefetch`, where a miss is an object fetched ahead of any
 * reader and a hit one already held. Gateways before 2026-10-14 counted the warm-up as demand
 * and had no `prefetch`.
 */
export type CacheView = CacheKindsView & { readonly prefetch?: CacheKindsView };

/** `runEvents`: one page of `events.jsonl` lines (parse each as a `RaceEvent`). */
export type RunEventsPage = {
  readonly events: readonly string[];
  /** Pass as `after` for the next page. */
  readonly next_after: number;
  readonly done: boolean;
};

/** `viewToken`: a run's view token, for the live WebSocket proxied through the binding's fetch. */
export type ViewToken = {
  readonly token: string;
  readonly expires_at: string;
  /** `GET` this path with `Upgrade: websocket` and `?key=<token>` through the binding. */
  readonly live_path: string;
};

/** `verifyViewToken`: whose view token it is, once its signature, scope and expiry check out. */
export type ViewTokenClaims = {
  /** The one run the token may read. */
  readonly run: string;
  /** Who it was minted for (`web`, `admin`, `mcp` …). */
  readonly sub: string;
  readonly expires_at: string;
};

/** A ref of the run repo: `sprout`, `stalk`, `beans/<task>` or a 40-hex commit. */
export type RepoRef = string;

export type RepoTreeEntry = {
  readonly name: string;
  readonly path: string;
  readonly type: 'tree' | 'blob' | 'symlink' | 'gitlink' | 'exec';
  readonly sha: string;
};

/**
 * One directory level at a ref (at most 1,000 entries), or with `recursive` every entry
 * under the path, sorted by path (at most 5,000).
 */
export type RepoTree = {
  readonly ref: RepoRef;
  readonly commit: string;
  readonly path: string;
  readonly entries: readonly RepoTreeEntry[];
  readonly truncated: boolean;
};

/** A file at a ref (text up to 256 KiB; binary files have no content). */
export type RepoFile = {
  readonly ref: RepoRef;
  readonly commit: string;
  readonly path: string;
  readonly size: number;
  readonly binary: boolean;
  readonly content: string | null;
  readonly truncated: boolean;
};

export type RepoDiffFile = {
  readonly path: string;
  readonly status: 'added' | 'deleted' | 'modified';
  readonly additions: number;
  readonly deletions: number;
};

/** `git diff --stat -p from to` (at most 200 files and 100 KB of patch text). */
export type RepoDiff = {
  readonly from: { readonly ref: RepoRef; readonly commit: string };
  readonly to: { readonly ref: RepoRef; readonly commit: string };
  readonly files: readonly RepoDiffFile[];
  readonly patch: string;
  readonly truncated: boolean;
};

export type RepoCommit = {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: { readonly name: string; readonly email: string };
  /** ISO 8601. */
  readonly committed_at: string;
};

/** First-parent history at a ref, optionally only commits that touched `paths`. */
export type RepoLog = {
  readonly ref: RepoRef;
  readonly commits: readonly RepoCommit[];
  /** Commits looked at (at most 200 when filtering by path). */
  readonly scanned: number;
  readonly truncated: boolean;
};

export type RepoGrepMatch = { readonly path: string; readonly line: number; readonly text: string };

/** A regular-expression search at a ref (at most 300 files and 200 matches). */
export type RepoGrep = {
  readonly ref: RepoRef;
  readonly commit: string;
  readonly pattern: string;
  readonly matches: readonly RepoGrepMatch[];
  readonly files_scanned: number;
  readonly truncated: boolean;
};

/** A bean (one task's change) as `beansByPath` lists it. */
export type BeanSummary = {
  readonly bean: string;
  /** Its branch in the run repo (`beans/<task>`). */
  readonly branch: string;
  readonly title: string;
  readonly status: TaskStatus;
  /** The slot that last worked on it. */
  readonly agent: string | null;
  /** Files of its latest commit (or of its landing), relative to its base. */
  readonly files: readonly string[];
  readonly head_sha: string | null;
  readonly landed_sha: string | null;
  /** Decision cards it took part in. */
  readonly cards: readonly string[];
  /** The task's prompt: what the bean is for (the gateway always sets it since v2.3). */
  readonly intent?: string;
};

export type BeanInvocation = {
  readonly inv: string;
  readonly kind: string;
  readonly agent: string | null;
  readonly started_t: number;
  readonly ended_t: number | null;
  readonly ok: boolean | null;
  readonly cost_usd: number | null;
};

export type BeanCheck = {
  readonly t: number;
  readonly sha: string;
  readonly green: boolean;
  readonly failing_files: readonly string[] | null;
  /** The red was the sprout's, not the bean's (`inherited_reds`). */
  readonly inherited: boolean;
};

export type BeanRework = {
  readonly t: number;
  readonly reason: string;
  readonly attempt: number;
  readonly resumed: boolean;
  readonly culprits: readonly string[];
  readonly card: string | null;
};

/**
 * `stream_diffs`: a bean's working change while its agent writes, without the patches. The
 * run's stream socket sends one per accepted post; it is never in the event log.
 * `bean.streaming.end` follows when the invocation ends: its commit (if any) supersedes the
 * snapshot.
 */
export type BeanStreamSummary = {
  readonly type: 'bean.streaming';
  readonly task: string;
  readonly inv: string;
  /** The slot whose agent is writing. */
  readonly agent: string;
  readonly seq: number;
  /** Race seconds when the gateway took the snapshot. */
  readonly t: number;
  readonly files: readonly {
    readonly path: string;
    readonly status: StreamFile['status'];
    readonly additions: number;
    readonly deletions: number;
  }[];
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
  /** Lines the gateway's secret scan replaced. */
  readonly redacted: number;
};

export type BeanStreamEnd = {
  readonly type: 'bean.streaming.end';
  readonly task: string;
  readonly inv: string;
  readonly t: number;
};

/** `beanStream`: the latest snapshot of a bean, patches included. */
export type BeanStream = {
  readonly summary: BeanStreamSummary;
  readonly files: readonly StreamFile[];
};

/**
 * The run's stream socket (`GET /runs/:run/streams`, docs/claude-17-streaming-diffs.md): a
 * subscribed bean's whole snapshot, sent when the socket subscribes to it while it streams.
 */
export type BeanStreamSnapshot = {
  readonly type: 'bean.snapshot';
  readonly task: string;
  readonly inv: string;
  readonly seq: number;
  readonly files: readonly StreamFile[];
};

/**
 * The stream socket: what one accepted post changed in a subscribed bean's snapshot. It
 * applies to the snapshot at `base_seq`; `base_seq: 0` replaces the whole snapshot.
 */
export type BeanStreamPatch = {
  readonly type: 'bean.patch';
  readonly task: string;
  readonly inv: string;
  readonly seq: number;
  readonly base_seq: number;
  readonly files: readonly StreamFile[];
  readonly removed: readonly string[];
};

/** The stream socket's messages: summaries and ends to all, snapshots and patches to subscribers. */
export type BeanStreamSocketMessage =
  | BeanStreamSummary
  | BeanStreamEnd
  | BeanStreamSnapshot
  | BeanStreamPatch;

/** `beanDetail`: a bean's whole story from the run's event log. */
export type BeanDetail = BeanSummary & {
  readonly intent: string;
  readonly base_sha: string | null;
  readonly started_at: number | null;
  readonly landed_at: number | null;
  readonly green_at: number | null;
  readonly drop_reason: string | null;
  readonly acceptance: readonly { readonly path: string; readonly amended: boolean }[];
  readonly invocations: readonly BeanInvocation[];
  readonly checks: readonly BeanCheck[];
  readonly reworks: readonly BeanRework[];
  readonly decisions: readonly DecisionRecord[];
  /** The approval rules' receipt of its last pre-land check (absent: none, or an older gateway). */
  readonly route?: RouteReceipt | null;
};

/** A decision card and what it did (`decisions`, and in `beanDetail`). */
export type DecisionRecord = {
  readonly card: string;
  readonly task: string;
  readonly against: readonly string[];
  readonly specs: Readonly<Record<string, string>>;
  /** The failing tests of the red check that raised the card, and the reds it took. */
  readonly failing: readonly string[];
  readonly attempts: number;
  readonly status: 'open' | 'decided' | 'done';
  readonly winner: string | null;
  readonly loser: string | null;
  readonly outcome: 'declined' | 'keep-landed' | 'adopt-in-place' | null;
  readonly text: string | null;
  /** `oracle:landed`, `human:<actor>`, `timeout:landed` … */
  readonly by: string | null;
  readonly opened_t: number;
  readonly decided_t: number | null;
  readonly amendment: {
    readonly status: 'amended' | 'none' | 'rejected' | 'rolled-back';
    readonly paths: readonly string[];
  } | null;
  /** Files the beans of the card touched. */
  readonly files: readonly string[];
};

/** An acceptance test whose static import closure covers some of the asked paths. */
export type TestCoverage = {
  readonly test: string;
  /** The task that owns it, and that task's status. */
  readonly task: string;
  readonly status: TaskStatus;
  /** The asked paths it covers. */
  readonly covers: readonly string[];
  readonly closure_size: number;
  readonly amended: boolean;
};

/** The methods the web app calls on its `GATEWAY` service binding. */
export type GatewayRpc = Partial<CollaborationRpc> & {
  listRuns(limit?: number): Promise<readonly RunListItem[]>;
  runView(run: string): Promise<RpcResult<RunView>>;
  runEvents(run: string, after: number, limit: number): Promise<RpcResult<RunEventsPage>>;
  decide(
    run: string,
    card: string,
    winner: string,
    actor: string,
    text?: string,
  ): Promise<RpcResult<{ readonly accepted: true }>>;
  viewToken(run: string): Promise<RpcResult<ViewToken>>;
  repoTree(
    run: string,
    ref: RepoRef,
    path?: string,
    recursive?: boolean,
  ): Promise<RpcResult<RepoTree>>;
  repoFile(run: string, ref: RepoRef, path: string): Promise<RpcResult<RepoFile>>;
  repoDiff(
    run: string,
    fromRef: RepoRef,
    toRef: RepoRef,
    paths?: readonly string[],
  ): Promise<RpcResult<RepoDiff>>;
  repoLog(
    run: string,
    ref: RepoRef,
    paths: readonly string[] | null,
    limit: number,
  ): Promise<RpcResult<RepoLog>>;
  repoGrep(
    run: string,
    ref: RepoRef,
    pattern: string,
    paths?: readonly string[],
    /** Treat `pattern` as a safe-subset regular expression; by default it is a literal. */
    regex?: boolean,
  ): Promise<RpcResult<RepoGrep>>;
  beansByPath(run: string, paths: readonly string[]): Promise<RpcResult<readonly BeanSummary[]>>;
  beanDetail(run: string, bean: string): Promise<RpcResult<BeanDetail>>;
  /**
   * Approval rules (`approval-policy.ts`): the policy on `ref` (the stalk by default), the
   * commit it was read at and what is wrong with it. Absent on a gateway before them.
   */
  policyGet?(run: string, ref?: string): Promise<RpcResult<ApprovalPolicyView>>;
  /** The approval rules' receipt of a bean's last pre-land check; null when none was routed. */
  beanRoute?(run: string, bean: string): Promise<RpcResult<RouteReceipt | null>>;
  /**
   * A person approves a bean a `card` route holds, for its current revision (doc 32 §5): the
   * one path for the web's Approve button and MCP `bean_approve`. The gateway decides who may
   * (`decide`: owners and maintainers), refuses a stale revision and, for an agent session, an
   * approval of a bean that session may have pushed itself unless the person confirmed it;
   * it audits the approval and re-submits the bean at that revision.
   */
  approveBean?(
    run: string,
    bean: string,
    request: ApproveBeanRequest,
  ): Promise<RpcResult<ApprovedBean>>;
  decisions(run: string, paths?: readonly string[]): Promise<RpcResult<readonly DecisionRecord[]>>;
  testsFor(run: string, paths: readonly string[]): Promise<RpcResult<readonly TestCoverage[]>>;
  /**
   * `stream_diffs`: the beans whose agents are writing now, latest snapshot each, no patches.
   * A gateway deployed before streaming diffs lacks both stream methods, so callers check
   * for them (`shared-ask/forge/bean-stream.ts`).
   */
  beanStreams(run: string): Promise<RpcResult<readonly BeanStreamSummary[]>>;
  /** `stream_diffs`: a bean's latest snapshot with its patches; null while nothing streams. */
  beanStream(run: string, bean: string): Promise<RpcResult<BeanStream | null>>;
  /** `unauthorized` (401) for a malformed, forged or expired token; `forbidden` (403) for a slot or seed token. */
  verifyViewToken(token: string): Promise<RpcResult<ViewTokenClaims>>;
};

/** Refs the explorer accepts. */
export const REPO_REF_PATTERN =
  /^(sprout|stalk|beans\/[A-Za-z0-9][A-Za-z0-9._-]{0,31}|[0-9a-f]{40})$/;

/** MCP readers keep their existing scope; contributors are authorized to their own bean. */
export type McpTokenClaims =
  | (ViewTokenClaims & { readonly scope: 'view' })
  | ContributorTokenClaims;

/** Additive for existing clients; the current production gateway exposes this API. */
export type CollaborationRpc = {
  verifyMcpToken(token: string): Promise<RpcResult<McpTokenClaims>>;
  beanContext(run: string, input: BeanContextInput): Promise<RpcResult<BeanContext>>;
  beanDiscover(run: string, input: BeanDiscoverInput): Promise<RpcResult<BeanDiscoverPage>>;
  /** Excerpt-only summaries of up to 32 beans in one read; unknown beans are omitted. */
  beanPeerSummaries(
    run: string,
    beans: readonly string[],
  ): Promise<RpcResult<readonly BeanPeerSummary[]>>;
  beanUpdate(token: string, input: BeanUpdateInput): Promise<RpcResult<BeanUpdateResult>>;
  /** `bean_commit`: a commit on the contributor's own bean branch, built by the gateway. */
  beanCommit(token: string, input: BeanCommitInput): Promise<RpcResult<BeanCommitResult>>;
  beanThreadPost(
    token: string,
    input: BeanThreadPostInput,
  ): Promise<RpcResult<BeanThreadPostResult>>;
  beanInboxRead(token: string, input: BeanInboxReadInput): Promise<RpcResult<BeanInboxPage>>;
  beanInboxAck(token: string, input: BeanInboxAckInput): Promise<RpcResult<BeanInboxAckResult>>;
};

/**
 * `openRepoEngine`'s input: a repository the repository side created, whose continuous engine
 * the gateway opens (`docs/claude-opus/18-git-native-flow.md`). Idempotent per `owner/repoName`.
 */
export type OpenRepoEngineInput = {
  /** The repository's name in its owner's namespace: the clone URL is `/git/<owner.handle>/<repoName>.git`. */
  readonly repoName: string;
  /** The Artifacts repo (in the gateway's namespace) that holds the repository's git. */
  readonly artifactsRepo: string;
  readonly owner: { readonly id: string; readonly handle: string };
  readonly settings?: {
    /** The checks: `RunSuite` (`@gitstalk/shared-race/suite`); default `node --test`. */
    readonly suite?: unknown;
    /** Where the sprout and the stalk start when the repo has neither (default `main`, then `master`). */
    readonly base_branch?: string;
    /** A bean's web page, `{bean}` replaced by its name; shown in push verdicts. */
    readonly bean_url?: string;
    /**
     * Engine settings over the continuous defaults, for load tests and paired comparisons:
     * `preland_sandboxes` (pre-land checks at once, one sandbox per bean; default 32),
     * `ci_slots` (validations at once; default 2), and the evidence-promotion track
     * (`read_maps`, `evidence_promotion`, `evidence_read_sets`, `affected_validation`, `audit_every`).
     */
    readonly engine?: Readonly<Record<string, unknown>>;
  };
};

export type RepoEngineOpened = {
  /** Keys every read RPC (`runView`, `runEvents`, `beansByPath`, `beanDetail`, `decisions`, `repo*`). */
  readonly engineId: string;
  /** False when the engine already existed (same repository, same Artifacts repo). */
  readonly created: boolean;
  /** Where the sprout and the stalk started. */
  readonly base_sha: string;
  /** The clone URL's path on the gateway: `/git/<owner>/<repo>.git`. */
  readonly git_path: string;
};

/** A pushed bean as its status ref and the pushes see it (`pushedBeans`). */
export type PushedBeanStatus = {
  readonly bean: string;
  readonly title: string;
  readonly task: string | null;
  readonly actor: string;
  readonly head: string;
  readonly pushes: number;
  readonly phase:
    | 'checking'
    | 'landed'
    | 'green'
    | 'red'
    | 'conflict'
    | 'waiting'
    | 'parked'
    | 'dropped';
  readonly reason: string;
  readonly landed_sha: string | null;
  /** The last verdict's `remote:` lines (without the `gitstalk:` prefix, or the older `beanstalk:`). */
  readonly verdict: readonly string[];
  /** Held for a person's approval, or approved for its head; null when no `card` route applies. */
  readonly hold: BeanHold | null;
};

/** A git credential for one repository engine (`git` scope: clone, fetch, push beans). */
export type GitToken = { readonly token: string; readonly expires_at: string };

/** The repository side's RPC for continuous engines, on the gateway's default entrypoint. */
export type RepoEngineRpc = {
  openRepoEngine(input: OpenRepoEngineInput): Promise<RpcResult<RepoEngineOpened>>;
  /** Until user tokens exist: a `git` run token for `user` on the engine (default 1 hour, at most 30 days). */
  gitToken(
    engineId: string,
    user: { readonly id: string; readonly handle: string },
    ttlSeconds?: number,
  ): Promise<RpcResult<GitToken>>;
  pushedBeans(engineId: string): Promise<RpcResult<readonly PushedBeanStatus[]>>;
  /** Stops the engine (no more pushes); `deleteRepo` also deletes its Artifacts repo. */
  closeRepoEngine(
    engineId: string,
    options: { readonly deleteRepo: boolean },
  ): Promise<RpcResult<{ readonly closed: true }>>;
};
