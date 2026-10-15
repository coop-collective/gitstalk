/**
 * Performs the engine's jobs against the platform: squashes, reverts, suites and ref
 * updates through the runner container; file reads and diffs through the Artifacts
 * binding. Beans are branches of the run repo, so every job works on that one repo. Every
 * runner call gets Artifacts tokens minted for it (write only for the committer
 * instance); none is ever logged.
 */
import type { RunId } from '@gitstalk/shared-race/ids';
import type { RunSuite } from '@gitstalk/shared-race/suite';
import type { RunConfig } from '@gitstalk/shared-race/run-config';

import type {
  ArtifactsPort,
  CommitRange,
  MintedToken,
  RepoRemote,
  TokenScope,
} from '../adapters/artifacts';
import type { CheckInstance, CheckResult, JobOutcome, JobResult, JobSpec } from '../engine/model';
import { assertNever } from '../engine/errors';
import { UpstreamError } from '../errors';
import { changedRanges, diffText } from '../git/diff-text';
import type { Logger } from '../log';
import type { RunnerPort, RunnerRemote } from '../runner/runner-client';
import { continuousRef } from '../push/bean-refs';
import type { RepositoryChecksHost } from '../checks/repository-checks';
import { planCheck } from '../checks/repository-checks';
import type { LandingTree } from '../checks/check-store';
import type { ApprovalHost } from '../approval/approval-gate';
import { judgeLanding } from '../approval/approval-gate';
import { ciInstance, committerInstance, poolSandboxInstance, sandboxInstance } from './run-names';

/** Re-mint a cached token when it has less than this left. */
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;
/** File reads in flight at once (a DO allows six outgoing connections per request). */
const READ_CONCURRENCY = 4;
/** What a diff shows when the binding cannot read one of the commits. */
const DIFF_UNAVAILABLE = '(diff unavailable)';
/**
 * Runs of one check before a suite timeout becomes the job's failure. A timeout is never a
 * verdict on the change (a suite that ran out of time reported nothing): it is re-run, and
 * only a suite that times out every time fails the job, as an infrastructure failure.
 */
export const SUITE_TIMEOUT_ATTEMPTS = 3;

/** The run's repo, as the RunDO stores it: the sprout, the stalk and every bean branch. */
export type RunRepos = { readonly repo: RepoRemote };

/** Mints Artifacts tokens and reuses them until shortly before they expire. */
export type TokenSource = { token(repo: string, scope: TokenScope): Promise<string> };

export function cachingTokenSource(
  artifacts: ArtifactsPort,
  options: { ttlSeconds: number; now: () => number },
): TokenSource {
  const cache = new Map<string, MintedToken>();
  return {
    async token(repo, scope) {
      const key = `${scope}:${repo}`;
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAtMs - options.now() > TOKEN_REFRESH_MARGIN_MS)
        return cached.token;
      const minted = await artifacts.mintToken(repo, scope, options.ttlSeconds);
      cache.set(key, minted);
      return minted.token;
    },
  };
}

export type JobContext = {
  readonly run: RunId;
  readonly artifacts: ArtifactsPort;
  readonly runner: RunnerPort;
  readonly tokens: TokenSource;
  readonly log: Logger;
  readonly repos: () => RunRepos;
  /** The run's test suite (`RunConfig.suite`), sent with every check. */
  readonly suite: RunSuite;
  /**
   * `continuous`: a repository's engine (`RunConfig.continuous`). Its beans are the pushed
   * `refs/heads/bean/<name>` branches, and each pre-land check runs in a sandbox leased for it.
   */
  readonly engine: 'race' | 'continuous';
  /** Which checks trace (the run's `read_maps`); absent: none. */
  readonly readMaps?: RunConfig['read_maps'];
  /** The sandbox index leased for this job (a repository engine's pre-land check). */
  readonly sandboxIndex?: number;
  /** A suite ran past its timeout (it is re-run, or the job fails): for the pool's counts. */
  readonly onSuiteTimeout?: () => void;
  /**
   * A repository's own checks (`checks_source: repository`): each check reads
   * `.gitstalk/checks.yml` from its tree, and `suite` is not used. Absent: `suite` always.
   */
  readonly checks?: RepositoryChecksHost;
  /**
   * Approval rules (`approval_rules`, `approval/approval-gate.ts`): each pre-land check of a
   * bean merge is judged before its suite runs. Absent: off, as before.
   */
  readonly approval?: ApprovalJobHost;
};

/** What the approval gate needs around a job: its host, the bean merges, the push lines. */
export type ApprovalJobHost = {
  readonly gate: ApprovalHost;
  saveLandingTree(tree: LandingTree): void;
  landingTree(sha: string): LandingTree | null;
  /** Puts the gate's lines before the lines the check of `sha` already gave. */
  note(sha: string, lines: readonly string[]): void;
};

/** Runs one job; failures come back as outcomes, never as exceptions. */
export async function executeJob(spec: JobSpec, context: JobContext): Promise<JobOutcome> {
  try {
    return { ok: true, result: await perform(spec, context) };
  } catch (error: unknown) {
    const retryable = error instanceof UpstreamError && error.retryable;
    const message = error instanceof Error ? error.message : String(error);
    context.log.warn('job failed', { job: spec.kind, retryable, error });
    return { ok: false, error: message, retryable };
  }
}

async function perform(spec: JobSpec, context: JobContext): Promise<JobResult> {
  switch (spec.kind) {
    case 'squash':
      return squash(spec, context);
    case 'revert':
      return revert(spec, context);
    case 'check':
      return check(spec, context);
    case 'diff':
      return diff(spec, context);
    case 'line-ranges':
      return lineRanges(spec, context);
    case 'update-ref':
      return updateRef(spec, context);
    case 'read-files':
      return readFiles(spec, context);
    default:
      return assertNever(spec);
  }
}

/** The run repo with a token of `scope` minted for this job. */
async function runRepo(context: JobContext, scope: TokenScope): Promise<RunnerRemote> {
  const repo = context.repos().repo;
  return { repo: repo.remote, token: await context.tokens.token(repo.name, scope) };
}

async function squash(
  spec: Extract<JobSpec, { kind: 'squash' }>,
  context: JobContext,
): Promise<JobResult> {
  const [trunk, change] = await Promise.all([runRepo(context, 'write'), runRepo(context, 'read')]);
  const outcome = await context.runner.squash(committerInstance(context.run), {
    trunk,
    onto: spec.onto,
    change: {
      ...change,
      ref: context.engine === 'continuous' ? continuousRef(spec.changeRef) : spec.changeRef,
      base: spec.changeBase,
    },
    message: spec.message,
    unionPaths: spec.unionPaths,
    structural: spec.structural,
  });
  if (outcome.result === 'clean')
    (context.checks ?? context.approval)?.saveLandingTree({
      sha: outcome.sha,
      task: spec.changeKey,
      onto: spec.onto,
      files: outcome.files,
    });
  if (outcome.mergeBase !== spec.changeBase) {
    context.log.warn('runner merge base differs from the engine', {
      task: spec.changeKey,
      engine: spec.changeBase,
      runner: outcome.mergeBase,
    });
  }
  return outcome.result === 'clean'
    ? {
        kind: 'squash',
        outcome: 'clean',
        sha: outcome.sha,
        files: outcome.files,
        changeFiles: outcome.changeFiles,
        resolved: outcome.resolved,
      }
    : { kind: 'squash', outcome: 'conflict', files: outcome.files, hunks: outcome.hunks };
}

async function revert(
  spec: Extract<JobSpec, { kind: 'revert' }>,
  context: JobContext,
): Promise<JobResult> {
  const outcome = await context.runner.revert(committerInstance(context.run), {
    trunk: await runRepo(context, 'write'),
    onto: spec.onto,
    commit: spec.commit,
    ...(spec.to === undefined ? {} : { to: spec.to }),
    message: spec.message,
    unionPaths: spec.unionPaths,
  });
  return outcome.result === 'clean'
    ? { kind: 'revert', outcome: 'clean', sha: outcome.sha, files: outcome.files }
    : { kind: 'revert', outcome: 'conflict', files: outcome.files };
}

/**
 * Suites never run on the committer and never get a write token. A suite that times out is
 * run again (`SUITE_TIMEOUT_ATTEMPTS`). A bean's check (its sandbox) that times out every time
 * fails as infrastructure, never as a red of the change; a CI slot's run (a validation, a
 * probe, the final check) that does is the shared line's own result and goes to the engine as
 * before, since failing the job there would abort the run.
 */
async function check(
  spec: Extract<JobSpec, { kind: 'check' }>,
  context: JobContext,
): Promise<JobResult> {
  const judged = await judgeCheck(spec, context);
  if (judged !== null && judged.hold !== null) {
    context.approval?.note(spec.sha, judged.lines);
    return { kind: 'check', check: judged.hold };
  }
  const plan =
    context.checks === undefined
      ? { kind: 'run' as const, suite: context.suite }
      : await planCheck(context.checks, spec, context.suite);
  if (judged !== null) context.approval?.note(spec.sha, judged.lines);
  if (plan.kind === 'answer') return { kind: 'check', check: plan.result };
  const suited: JobContext = { ...context, suite: plan.suite };
  const instance = checkInstance(suited, spec.instance);
  for (let attempt = 1; ; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a re-run follows its timed-out run
    const result = await runCheck(spec, suited, instance);
    if (!result.timedOut) return { kind: 'check', check: result };
    suited.onSuiteTimeout?.();
    suited.log.warn('suite timed out', { sha: spec.sha, instance, attempt });
    if (attempt < SUITE_TIMEOUT_ATTEMPTS) continue;
    if (spec.instance.kind === 'ci') return { kind: 'check', check: result };
    throw suiteTimeout(suited, { instance, attempt });
  }
}

/** The approval gate's judgement of a bean merge's pre-land check; null when it judges none. */
async function judgeCheck(
  spec: Extract<JobSpec, { kind: 'check' }>,
  context: JobContext,
): Promise<Awaited<ReturnType<typeof judgeLanding>> | null> {
  if (context.approval === undefined || spec.instance.kind !== 'sandbox') return null;
  const landing = context.approval.landingTree(spec.sha);
  return landing === null ? null : judgeLanding(context.approval.gate, landing, spec.instance);
}

async function runCheck(
  spec: Extract<JobSpec, { kind: 'check' }>,
  context: JobContext,
  instance: string,
): Promise<CheckResult> {
  const { network, ciSeconds, ...result } = await context.runner.check(instance, {
    trunk: await runRepo(context, 'read'),
    sha: spec.sha,
    extraFiles: spec.extraFiles,
    suite: context.suite,
    only: spec.only ?? null,
    allReadSets: spec.allReadSets === true,
    ...readMapOptions(spec, context.readMaps ?? 'off'),
  });
  context.log.info('suite checked', {
    sha: spec.sha,
    green: result.green,
    tests: result.tests,
    suite_seconds: result.suiteSeconds,
    ci_seconds: ciSeconds,
    timed_out: result.timedOut,
    instance,
    network,
    deps: context.suite.deps,
  });
  return result;
}

/** The job's failure once every run timed out: infrastructure, and worded so for the author. */
function suiteTimeout(
  context: JobContext,
  ran: { instance: string; attempt: number },
): UpstreamError {
  return new UpstreamError(
    `suite_timeout: the suite ran past its ${context.suite.timeout_seconds} s limit ${ran.attempt} times ` +
      `on ${ran.instance}, so it reported nothing; this is an infrastructure delay, not a test failure, ` +
      'and the change was not judged',
    false,
  );
}

/**
 * `preland` traces the pre-land checks (agents' sandboxes, off the CI slots) and asks every
 * other check for its tree's manifest, so maps from bean trees can be compared with the
 * validated sprout; `all` traces every check. With either, a check that asks for every test's
 * read set (`allReadSets`: evidence promotion's checks and validations) is traced too, so its
 * read sets are what the tests observed and complete (`read_sets_complete`). A job's own
 * `trace`/`treeManifest` wins.
 */
export function readMapOptions(
  spec: Extract<JobSpec, { kind: 'check' }>,
  mode: RunConfig['read_maps'],
): { trace: boolean; treeManifest: boolean } {
  const traced =
    mode === 'all' ||
    (mode === 'preland' && (spec.instance.kind === 'sandbox' || spec.allReadSets === true));
  return {
    trace: spec.trace ?? traced,
    treeManifest: spec.treeManifest ?? mode !== 'off',
  };
}

function checkInstance(context: JobContext, instance: CheckInstance): string {
  switch (instance.kind) {
    case 'ci':
      return ciInstance(context.run, instance.slot);
    case 'sandbox':
      return context.engine === 'continuous'
        ? poolSandboxInstance(context.run, context.sandboxIndex ?? 0)
        : sandboxInstance(context.run, instance.slot);
    default:
      return assertNever(instance);
  }
}

async function diff(
  spec: Extract<JobSpec, { kind: 'diff' }>,
  context: JobContext,
): Promise<JobResult> {
  const changes = await context.artifacts.changedFiles(context.repos().repo.name, {
    from: spec.parent,
    to: spec.sha,
  });
  return {
    kind: 'diff',
    text: changes === null ? DIFF_UNAVAILABLE : diffText(changes, spec.limit),
  };
}

/** The `-U0` line ranges of two changes against one base, in the files they share (`hunk`). */
async function lineRanges(
  spec: Extract<JobSpec, { kind: 'line-ranges' }>,
  context: JobContext,
): Promise<JobResult> {
  const [mine, theirs] = await Promise.all([
    rangesOf(context, { from: spec.base, to: spec.mine, paths: spec.files }),
    rangesOf(context, { from: spec.base, to: spec.theirs, paths: spec.files }),
  ]);
  return { kind: 'line-ranges', mine, theirs };
}

async function rangesOf(
  context: JobContext,
  range: CommitRange & { paths: readonly string[] },
): Promise<Record<string, [number, number][]>> {
  const changes = await context.artifacts.changedFiles(context.repos().repo.name, range);
  if (changes === null) {
    throw new UpstreamError(`cannot read ${range.from}..${range.to} of the run repo`, true);
  }
  const files = new Set(range.paths);
  return Object.fromEntries(
    changes
      .filter((change) => files.has(change.path))
      .map((change) => [change.path, changedRanges(change.before, change.after)]),
  );
}

async function updateRef(
  spec: Extract<JobSpec, { kind: 'update-ref' }>,
  context: JobContext,
): Promise<JobResult> {
  const outcome = await context.runner.updateRef(committerInstance(context.run), {
    trunk: await runRepo(context, 'write'),
    ref: spec.ref,
    newSha: spec.newSha,
    oldSha: spec.oldSha,
  });
  return { kind: 'update-ref', ok: outcome.ok, actual: outcome.actual };
}

async function readFiles(
  spec: Extract<JobSpec, { kind: 'read-files' }>,
  context: JobContext,
): Promise<JobResult> {
  const repo = context.repos().repo;
  const contents: (string | null)[] = [];
  for (let start = 0; start < spec.reads.length; start += READ_CONCURRENCY) {
    const batch = spec.reads.slice(start, start + READ_CONCURRENCY);
    const reads = batch.map(({ ref, path }) => context.artifacts.readFile(repo.name, ref, path));
    // oxlint-disable-next-line no-await-in-loop -- batches bound the connections in flight
    contents.push(...(await Promise.all(reads)));
  }
  return { kind: 'read-files', contents };
}
