import { describe, expect, it } from 'vitest';

import { Sha } from '@gitstalk/shared-race/ids';
import { DEFAULT_SUITE, RunSuite } from '@gitstalk/shared-race/suite';

import { UpstreamError } from '../errors';
import type { LogFields, Logger } from '../log';
import { runnerLogLevel } from './runner-container';
import type { RunnerPort } from './runner-client';
import { checkBody, runnerPort } from './runner-client';
import {
  RUNNER_API_HEADER,
  RUNNER_API_VERSION,
  RunnerVersionMismatchError,
  capacityWaitsMs,
} from './runner-transport';

const SHA = Sha.parse('a'.repeat(40));
const TRUNK = { repo: 'https://artifacts.invalid/r.git', token: 'art_v1_x' };
const NO_CAPACITY =
  'Failed to start container: Maximum number of running container instances exceeded. Try again later';
const VERSION_OK = { version: '0.1.0', api_version: RUNNER_API_VERSION, git_sha: 'abc' };
const CHECK_GREEN = {
  green: true,
  tests: 1,
  failures: 0,
  failing_tests: [],
  failing_files: [],
  suite_seconds: 0.1,
};

type Answer = (path: string, request: Request) => Response | Promise<Response>;

/** A fake runner: answers each request with `answer`, recording paths per instance. */
function fakeRunner(answer: Answer): {
  readonly calls: string[];
  readonly waits: number[];
  readonly warnings: string[];
  readonly port: RunnerPort;
} {
  const calls: string[] = [];
  const waits: number[] = [];
  const warnings: string[] = [];
  const port = runnerPort(
    (instance) => ({
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        calls.push(`${instance}${path}`);
        return answer(path, request);
      },
    }),
    {
      log: recordingLogger(warnings),
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  return { calls, waits, warnings, port };
}

function ignore(): void {}

function recordingLogger(warnings: string[]): Logger {
  const logger: Logger = {
    debug: ignore,
    info: ignore,
    warn: (message: string, fields?: LogFields) => {
      warnings.push(`${message} ${JSON.stringify(fields ?? {})}`);
    },
    error: ignore,
    with: () => logger,
  };
  return logger;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { [RUNNER_API_HEADER]: String(RUNNER_API_VERSION), ...headers },
  });
}

function versionThen(answer: Answer): Answer {
  return (path, request) => (path === '/version' ? json(VERSION_OK) : answer(path, request));
}

const check = (port: RunnerPort, instance = 'ci-0') =>
  port.check(instance, { trunk: TRUNK, sha: SHA, extraFiles: null, suite: DEFAULT_SUITE });

const updateRef = (port: RunnerPort) =>
  port.updateRef('committer', {
    trunk: TRUNK,
    ref: 'refs/heads/sprout',
    newSha: SHA,
    oldSha: SHA,
  });

describe('the runner version check', () => {
  it('checks each instance once before its first job', async () => {
    const runner = fakeRunner(versionThen(() => json(CHECK_GREEN)));

    await check(runner.port, 'ci-0');
    await check(runner.port, 'ci-0');
    await check(runner.port, 'ci-1');

    expect(runner.calls).toEqual([
      'ci-0/version',
      'ci-0/v1/check',
      'ci-0/v1/check',
      'ci-1/version',
      'ci-1/v1/check',
    ]);
  });

  it('refuses for good, naming both versions, when the image speaks another contract', async () => {
    const runner = fakeRunner((path) =>
      path === '/version' ? json({ ...VERSION_OK, api_version: 1 }) : json(CHECK_GREEN),
    );

    const failure = await check(runner.port).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunnerVersionMismatchError);
    expect(failure).toMatchObject({ code: 'runner_version_mismatch', retryable: false });
    expect(String(failure)).toMatch(/^.*runner_version_mismatch: .*runner API 1, .*speaks 5/);
    expect(runner.calls).toEqual(['ci-0/version']);
  });

  it('treats an image that reports no api_version as the first contract', async () => {
    const runner = fakeRunner(() => json({ version: '0.1.0', git_sha: 'unknown' }));

    await expect(check(runner.port)).rejects.toThrow(/runner API 1 \(it reports no api_version\)/);
  });

  it('turns a 400 for an unknown field into a version mismatch', async () => {
    const refusal = {
      code: 'invalid_request',
      message: 'invalid request: unknown field `to`, expected one of `repo`, `token`',
    };
    const runner = fakeRunner(versionThen(() => json(refusal, 400, { [RUNNER_API_HEADER]: '4' })));

    const failure = await runner.port
      .revert('committer', {
        trunk: TRUNK,
        onto: SHA,
        commit: SHA,
        to: SHA,
        message: 'Reset',
        unionPaths: [],
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunnerVersionMismatchError);
    expect(failure).toMatchObject({ retryable: false });
    expect(String(failure)).toMatch(/runner API 4, this gateway speaks 5 .*unknown field `to`/);
  });
});

describe('container capacity', () => {
  it('waits and retries inside the client until an instance starts', async () => {
    let refusals = 2;
    const runner = fakeRunner(
      versionThen(() => {
        if (refusals === 0) return json(CHECK_GREEN);
        refusals -= 1;
        return new Response(NO_CAPACITY, { status: 500 });
      }),
    );

    const result = await check(runner.port);

    expect(result.green).toBe(true);
    expect(runner.waits).toEqual(capacityWaitsMs('ci-0').slice(0, 2));
    expect(runner.warnings).toHaveLength(2);
    expect(runner.warnings[0]).toMatch(/runner capacity exhausted, waiting .*"attempt":1/);
  });

  it('gives up after about four minutes with a retryable failure', async () => {
    const runner = fakeRunner(() => new Response('busy', { status: 503 }));

    const failure = await check(runner.port).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure).toMatchObject({ retryable: true });
    expect(String(failure)).toMatch(/lack of container capacity/);
    const waited = runner.waits.reduce((sum, wait) => sum + wait, 0);
    expect(waited).toBeGreaterThan(200_000);
    expect(waited).toBeLessThanOrEqual(240_000);
  });

  it('spreads its waits between 5 and 20 seconds, the same way every time', () => {
    const waits = capacityWaitsMs('run-x-ci-0');

    expect(capacityWaitsMs('run-x-ci-0')).toEqual(waits);
    expect(capacityWaitsMs('run-x-ci-1')).not.toEqual(waits);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(5_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(20_000);
  });

  it('does not wait on an ordinary server error', async () => {
    const runner = fakeRunner(
      versionThen(() => json({ code: 'internal', message: 'internal error' }, 500)),
    );

    await expect(check(runner.port)).rejects.toMatchObject({ retryable: true });
    expect(runner.waits).toEqual([]);
  });
});

describe('unknown commits', () => {
  const unknownCommit = json(
    { code: 'unknown_commit', message: 'commit aaaa is not reachable' },
    422,
  );

  it('are retryable for a check and a ref update, which are idempotent', async () => {
    const runner = fakeRunner(versionThen(() => unknownCommit.clone()));

    await expect(check(runner.port)).rejects.toMatchObject({ retryable: true });
    await expect(updateRef(runner.port)).rejects.toMatchObject({ retryable: true });
  });

  it('stay final for a squash', async () => {
    const runner = fakeRunner(versionThen(() => unknownCommit.clone()));

    const squash = runner.port.squash('committer', {
      trunk: TRUNK,
      onto: SHA,
      change: { ...TRUNK, ref: 'refs/heads/beans/t001', base: SHA },
      message: 'm',
      unionPaths: [],
      structural: true,
    });

    await expect(squash).rejects.toMatchObject({ retryable: false });
  });
});

describe('the check body', () => {
  const fastify = RunSuite.parse({
    argv: ['node', '--no-use-env-proxy', '--test', 'test/!(listen.5).test.js'],
    files_argv: ['node', '--no-use-env-proxy', '--test'],
    env: { TZ: 'UTC' },
    deps: 'fastify',
    timeout_seconds: 600,
    test_hint: 'Run the suite.',
  });
  const call = { trunk: TRUNK, sha: SHA, extraFiles: { 'test/a.pr1.test.js': 'x' } };

  it('runs the bare node --test of the designed arena by default', () => {
    expect(checkBody({ ...call, suite: DEFAULT_SUITE })).toEqual({
      repo: TRUNK.repo,
      token: TRUNK.token,
      sha: SHA,
      extra_files: { 'test/a.pr1.test.js': 'x' },
      latency_seconds: 0,
      cmd: ['node', '--test'],
      suite_timeout_seconds: 300,
    });
  });

  it("runs the arena's whole suite with its environment and dependency snapshot", () => {
    expect(checkBody({ ...call, suite: fastify })).toMatchObject({
      cmd: ['node', '--no-use-env-proxy', '--test', 'test/!(listen.5).test.js'],
      env: { TZ: 'UTC' },
      deps: 'fastify',
      suite_timeout_seconds: 600,
    });
  });

  it("runs chosen files with the arena's files argv", () => {
    const body = checkBody({
      ...call,
      suite: fastify,
      only: ['test/a.pr1.test.js'],
      allReadSets: true,
    });

    expect(body).toMatchObject({
      cmd: ['node', '--no-use-env-proxy', '--test', 'test/a.pr1.test.js'],
      deps: 'fastify',
      all_read_sets: true,
    });
  });
});

describe('the runner container', () => {
  it('logs at the Worker’s LOG_LEVEL, and at info when it is not a level', () => {
    expect(runnerLogLevel('error')).toBe('error');
    expect(runnerLogLevel('loud')).toBe('info');
  });
});

/** A runner that answers every job with `response`, keeping the request bodies. */
function recordingRunner(response: unknown): { bodies: unknown[]; port: RunnerPort } {
  const bodies: unknown[] = [];
  const port = runnerPort(
    () => ({
      fetch: async (request) => {
        if (new URL(request.url).pathname === '/version') return json(VERSION_OK);
        bodies.push(await request.json());
        return json(response);
      },
    }),
    { log: recordingLogger([]), sleep: async () => {} },
  );
  return { bodies, port };
}

describe('traced and selective checks', () => {
  const MAPS = {
    status: 'traced',
    environment: 'node 25.9.0; runner abc',
    files: [
      {
        file: 'src/a.test.ts',
        passed: true,
        tests: 2,
        failures: 0,
        seconds: 0.3,
        timed_out: false,
        traced: true,
        reads: ['src/a.test.ts', 'src/a.ts'],
        probes: ['src/package.json'],
        dirs: [],
        packages: [],
        hashes: { 'src/a.ts': 'f'.repeat(40) },
      },
    ],
  };
  const TREE = {
    commit: 'a'.repeat(40),
    extra_files: false,
    blobs: { 'src/a.ts': 'f'.repeat(40) },
  };

  it('asks for traces and a manifest by the runner field names', async () => {
    const runner = recordingRunner(CHECK_GREEN);

    await runner.port.check('sandbox-0', {
      trunk: TRUNK,
      sha: SHA,
      extraFiles: null,
      suite: DEFAULT_SUITE,
      only: ['src/a.test.ts'],
      trace: true,
      treeManifest: true,
    });

    expect(runner.bodies[0]).toMatchObject({
      cmd: ['node', '--test', 'src/a.test.ts'],
      trace: true,
      tree_manifest: true,
    });
  });

  it('leaves the read-map fields out of an untraced check', async () => {
    const runner = recordingRunner(CHECK_GREEN);

    await check(runner.port);

    expect(runner.bodies[0]).not.toHaveProperty('trace');
    expect(runner.bodies[0]).not.toHaveProperty('tree_manifest');
  });

  it('hands back the read maps and the tree the runner reported', async () => {
    const runner = recordingRunner({ ...CHECK_GREEN, read_maps: MAPS, tree: TREE });

    const result = await check(runner.port);

    expect(result.readMaps?.files[0]?.reads).toEqual(['src/a.test.ts', 'src/a.ts']);
    expect(result.tree?.blobs).toEqual(TREE.blobs);
  });
});

describe('test skipper wire contract', () => {
  const selection = {
    mode: 'selected',
    reason: 'unchanged-transitive-dependencies',
    baseline_sha: SHA,
    selected_files: ['a.test.ts'],
    skipped_files: ['b.test.ts'],
  };
  it('only sends the opt-in when enabled and carries execution evidence back', async () => {
    const bodies: unknown[] = [];
    const runner = fakeRunner(
      versionThen(async (_, request) => {
        bodies.push(await request.json());
        return json({ ...CHECK_GREEN, ...(bodies.length === 2 ? { selection } : {}) });
      }),
    );
    await check(runner.port);
    const result = await runner.port.check('ci-0', {
      trunk: TRUNK,
      sha: SHA,
      extraFiles: null,
      testSkipper: true,
      suite: DEFAULT_SUITE,
    });
    expect(bodies[0]).not.toHaveProperty('test_skipper');
    expect(bodies[1]).toHaveProperty('test_skipper', true);
    expect(result.selection).toEqual(selection);
  });

  it('refuses a selected result when the caller required a full check', async () => {
    const runner = fakeRunner(versionThen(() => json({ ...CHECK_GREEN, selection })));
    await expect(check(runner.port)).rejects.toThrow('required full check');
  });
});
