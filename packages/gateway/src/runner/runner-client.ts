/**
 * The runner's §3 HTTP API (packages/gateway/container, `wire/`), spoken through a container stub.
 * Request bodies carry Artifacts tokens: they are never logged, and error messages are the
 * runner's own (it redacts tokens from git output). Version checks, capacity waits and error
 * mapping live in `runner-transport.ts`.
 */
import { z } from 'zod';

import { Sha } from '@gitstalk/shared-race/ids';
import { CheckReadMaps, CheckedTree } from '@gitstalk/shared-race/read-maps';
import type { RunSuite } from '@gitstalk/shared-race/suite';
import { TestSelection } from '@gitstalk/shared-race/test-selection';

import type { CheckResult, ConflictHunk, Resolution } from '../engine/model';
import { UpstreamError } from '../errors';
import { createLogger } from '../log';
import type { RunnerStub, TransportOptions } from './runner-transport';
import { runnerTransport } from './runner-transport';

export type { RunnerStub } from './runner-transport';

/** A git remote and the Artifacts token minted for this one job. */
export type RunnerRemote = { readonly repo: string; readonly token: string };

/** The runner's `repo` is the run repo (the sprout and the stalk); its contract calls it the trunk. */
export type SquashCall = {
  readonly trunk: RunnerRemote;
  readonly onto: Sha;
  readonly change: RunnerRemote & { readonly ref: string; readonly base: Sha };
  readonly message: string;
  readonly unionPaths: readonly string[];
  /** The runner's `structural_merge`: false keeps git's line merge alone (the queue). */
  readonly structural: boolean;
};

export type SquashOutcome =
  | {
      readonly result: 'clean';
      readonly sha: Sha;
      readonly files: readonly string[];
      readonly mergeBase: Sha;
      /** The change's own write set (`base..head`), present because the call names the base. */
      readonly changeFiles: readonly string[] | null;
      /** The merge tier that produced it (Mergiraf's when git's line merge conflicted). */
      readonly resolved: Resolution;
    }
  | {
      readonly result: 'conflict';
      readonly files: readonly string[];
      readonly mergeBase: Sha;
      /** Both sides of each conflict block, for the author's prompt. */
      readonly hunks: readonly ConflictHunk[];
    };

export type RevertCall = {
  readonly trunk: RunnerRemote;
  readonly onto: Sha;
  readonly commit: Sha;
  /** Undo `to..commit` at once (the red-window reset); absent: `commit` alone. */
  readonly to?: Sha;
  readonly message: string;
  readonly unionPaths: readonly string[];
};

export type RevertOutcome =
  | { readonly result: 'clean'; readonly sha: Sha; readonly files: readonly string[] }
  | { readonly result: 'conflict'; readonly files: readonly string[] };

export type CheckCall = {
  readonly trunk: RunnerRemote;
  readonly sha: Sha;
  readonly extraFiles: Readonly<Record<string, string>> | null;
  /** The run's suite: its argv, environment and dependency snapshot. */
  readonly suite: RunSuite;
  /** Run only these test files (the suite's `files_argv` plus them); null runs the whole suite. */
  readonly only?: readonly string[] | null;
  /** Also report the passing test files' read sets. */
  readonly allReadSets?: boolean;
  /** Run each test file in its own traced process and report read maps (`read_maps`). */
  readonly trace?: boolean;
  /** Report the checked tree's blob ids (`tree`); implied by `trace`. */
  readonly treeManifest?: boolean;
  readonly testSkipper?: boolean;
};

export type UpdateRefCall = {
  readonly trunk: RunnerRemote;
  readonly ref: string;
  readonly newSha: Sha;
  readonly oldSha: Sha;
};

/** A check's result plus what the runner says about the run itself (logged, never in the engine). */
export type RunnerCheck = CheckResult & {
  /** The suite's network: `loopback` (a namespace with `lo` only) or `host`; null: not reported. */
  readonly network: string | null;
  /** Fetch, checkout, suite and emulated latency on the runner; null: not reported. */
  readonly ciSeconds: number | null;
};

export type RunnerPort = {
  squash(instance: string, call: SquashCall): Promise<SquashOutcome>;
  revert(instance: string, call: RevertCall): Promise<RevertOutcome>;
  check(instance: string, call: CheckCall): Promise<RunnerCheck>;
  updateRef(instance: string, call: UpdateRefCall): Promise<{ ok: boolean; actual: Sha | null }>;
};

const SquashResponse = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('clean'),
    sha: Sha,
    files: z.array(z.string()),
    merge_base: Sha,
    change_files: z.array(z.string()).optional(),
    resolved: z.enum(['textual', 'structural']).optional(),
  }),
  z.object({
    result: z.literal('conflict'),
    files: z.array(z.string()),
    merge_base: Sha,
    hunks: z.array(z.object({ path: z.string(), onto: z.string(), change: z.string() })).optional(),
  }),
]);

const RevertResponse = z.discriminatedUnion('result', [
  z.object({ result: z.literal('clean'), sha: Sha, files: z.array(z.string()) }),
  z.object({ result: z.literal('conflict'), files: z.array(z.string()) }),
]);

const CheckResponse = z.object({
  green: z.boolean(),
  tests: z.number().int().min(0),
  failures: z.number().int().min(0),
  failing_tests: z.array(
    z.object({ file: z.string(), name: z.string(), message: z.string().optional() }),
  ),
  failing_files: z.array(z.string()).nullable(),
  passing_files: z.array(z.string()).optional(),
  read_set: z.array(z.string()).optional(),
  read_sets: z.record(z.string(), z.array(z.string())).optional(),
  passing_read_sets: z.record(z.string(), z.array(z.string())).optional(),
  /** The runner's word that its read sets hold every resolved, probed and listed path. */
  read_sets_complete: z.boolean().optional(),
  read_depths: z.record(z.string(), z.record(z.string(), z.number().int().min(0))).optional(),
  stack_files: z.array(z.string()).optional(),
  output_excerpt: z.string().optional(),
  suite_seconds: z.number().min(0),
  ci_seconds: z.number().min(0).optional(),
  timed_out: z.boolean().optional(),
  network: z.string().max(20).optional(),
  read_maps: CheckReadMaps.optional(),
  tree: CheckedTree.optional(),
  selection: TestSelection.optional(),
});

const UpdateRefResponse = z.object({ ok: z.boolean(), actual: Sha.nullable().optional() });

/**
 * The runner API over container stubs picked by instance name. `options` default to a warn-level
 * logger and real waits.
 */
export function runnerPort(
  stubFor: (instance: string) => RunnerStub,
  options: Partial<TransportOptions> = {},
): RunnerPort {
  const transport = runnerTransport(stubFor, {
    log: options.log ?? createLogger('warn', { component: 'runner-client' }),
    sleep: options.sleep ?? sleep,
  });
  const post = async <T>(
    instance: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> => {
    const response = await transport.post(instance, path, body);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new UpstreamError(`runner ${path} answered an unexpected body`, false);
    return parsed.data;
  };
  return {
    async squash(instance, call) {
      const response = await post(instance, '/v1/squash', squashBody(call), SquashResponse);
      return response.result === 'clean'
        ? {
            result: 'clean',
            sha: response.sha,
            files: response.files,
            mergeBase: response.merge_base,
            changeFiles: response.change_files ?? null,
            resolved: response.resolved ?? 'textual',
          }
        : {
            result: 'conflict',
            files: response.files,
            mergeBase: response.merge_base,
            hunks: (response.hunks ?? []).map(({ path, onto, change }) => ({
              path,
              sprout: onto,
              bean: change,
            })),
          };
    },
    async revert(instance, call) {
      const body = {
        repo: call.trunk.repo,
        token: call.trunk.token,
        onto: call.onto,
        commit: call.commit,
        ...(call.to === undefined ? {} : { to: call.to }),
        message: call.message,
        union_paths: call.unionPaths,
      };
      const response = await post(instance, '/v1/revert', body, RevertResponse);
      return response.result === 'clean'
        ? { result: 'clean', sha: response.sha, files: response.files }
        : { result: 'conflict', files: response.files };
    },
    async check(instance, call) {
      const response = await post(instance, '/v1/check', checkBody(call), CheckResponse);
      if (response.selection?.mode === 'selected' && call.testSkipper !== true)
        throw new UpstreamError('runner skipped tests on a required full check', false);
      return toCheckResult(response);
    },
    async updateRef(instance, call) {
      const body = {
        repo: call.trunk.repo,
        token: call.trunk.token,
        ref: call.ref,
        new: call.newSha,
        old: call.oldSha,
      };
      const response = await post(instance, '/v1/update-ref', body, UpdateRefResponse);
      return { ok: response.ok, actual: response.actual ?? null };
    },
  };
}

function squashBody(call: SquashCall): Record<string, unknown> {
  return {
    repo: call.trunk.repo,
    token: call.trunk.token,
    onto: call.onto,
    change: {
      repo: call.change.repo,
      token: call.change.token,
      ref: call.change.ref,
      base: call.change.base,
    },
    message: call.message,
    union_paths: call.unionPaths,
    structural_merge: call.structural,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `POST /v1/check`'s body: the run's suite argv (or its files argv with the chosen files), its
 * environment and its dependency snapshot, on every check alike.
 */
export function checkBody(call: CheckCall): Readonly<Record<string, unknown>> {
  const { suite } = call;
  const cmd =
    call.only === undefined || call.only === null
      ? [...suite.argv]
      : [...suite.files_argv, ...call.only];
  return {
    repo: call.trunk.repo,
    token: call.trunk.token,
    sha: call.sha,
    extra_files: call.extraFiles ?? {},
    latency_seconds: 0,
    cmd,
    ...(Object.keys(suite.env).length === 0 ? {} : { env: suite.env }),
    ...(suite.deps === null ? {} : { deps: suite.deps }),
    suite_timeout_seconds: suite.timeout_seconds,
    ...(call.allReadSets === true ? { all_read_sets: true } : {}),
    ...(call.trace === true ? { trace: true } : {}),
    ...(call.treeManifest === true ? { tree_manifest: true } : {}),
    ...(call.testSkipper === true ? { test_skipper: true } : {}),
  };
}

function toCheckResult(response: z.infer<typeof CheckResponse>): RunnerCheck {
  return {
    ...(response.selection === undefined ? {} : { selection: response.selection }),
    network: response.network ?? null,
    ciSeconds: response.ci_seconds ?? null,
    green: response.green,
    tests: response.tests,
    failures: response.failures,
    failingTests: response.failing_tests.map((test) =>
      test.message === undefined
        ? { file: test.file, name: test.name }
        : { file: test.file, name: test.name, message: test.message },
    ),
    failingFiles: response.failing_files,
    passingFiles: response.passing_files ?? null,
    readSet: response.read_set ?? [],
    readSets: response.read_sets ?? {},
    ...(response.passing_read_sets === undefined
      ? {}
      : { passingReadSets: response.passing_read_sets }),
    ...(response.read_sets_complete === undefined
      ? {}
      : { readSetsComplete: response.read_sets_complete }),
    readDepths: response.read_depths ?? {},
    stackFiles: response.stack_files ?? [],
    output: response.output_excerpt ?? '',
    suiteSeconds: response.suite_seconds,
    timedOut: response.timed_out ?? false,
    ...(response.read_maps === undefined ? {} : { readMaps: response.read_maps }),
    ...(response.tree === undefined ? {} : { tree: response.tree }),
  };
}
