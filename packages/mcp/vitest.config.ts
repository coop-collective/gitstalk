import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { z } from 'zod';

/**
 * Accounts: a real D1 with packages/shared-identity's migrations and a real KV for OAuth.
 * Tests run the MCP Worker and gateway over a real service binding, with the gateway's
 * SQLite RunDO and RunIndex. Existing recorded-fixture tests still inject their own source.
 * Artifacts has no local simulator and the runner needs Docker: reuse the gateway suite's
 * stand-ins for those external services. No run is started and no test leaves Miniflare.
 * The local MCP configuration removes remote AI; production configuration is untouched.
 *
 * `@cloudflare/vitest-pool-workers` 0.22 bundles a workerd that may not know today's
 * compatibility date, so the tests use the newest date it supports (as the gateway's do).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const compatibilityDate = poolWorkerdCompatibilityDate();
const gatewayScript = bundleGateway();
const identityMigrations = await readD1Migrations(path.join(here, '../shared-identity/migrations'));
const forgeMigrations = await readD1Migrations(path.join(here, '../gateway/migrations'));
/**
 * One identity database and one registry for both Workers, as deployed: a session token the
 * MCP Worker mints is the credential the gateway's git proxy checks.
 */
const IDENTITY_DB_ID = 'local-gitstalk-identity'; // wrangler.jsonc's placeholder id
const FORGE_DB_ID = 'gitstalk-forge-mcp-test';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: writeTestWranglerConfig() },
      remoteBindings: false,
      miniflare: {
        compatibilityDate,
        bindings: {
          LOG_LEVEL: 'error',
          PUBLIC_URL: 'https://gitstalk-mcp.example.workers.dev',
          WEB_URL: 'https://gitstalk-web.example.workers.dev',
          GIT_ORIGIN: 'https://gateway.example.test',
          DEMO_RUN: 'j6boaclinn',
          TEST_MIGRATIONS: identityMigrations,
          FORGE_MIGRATIONS: forgeMigrations,
        },
        d1Databases: { FORGE: FORGE_DB_ID },
        serviceBindings: {
          GATEWAY: 'gitstalk-gateway',
          // Tests plant files on a repository's sprout in the fake Artifacts.
          FAKE_REPOS: { name: 'fake-artifacts', entrypoint: 'FakeRepositories' },
          FAKE_GIT: { name: 'fake-artifacts', entrypoint: 'FakeGitRemote' },
        },
        workers: auxiliaryWorkers(),
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
    // The Actions tools follow real landings and runs on the stub executor (a few seconds).
    testTimeout: 30_000,
  },
});

function auxiliaryWorkers() {
  const gateway = path.join(here, '../gateway');
  // Inline external fixtures: the pool resolves auxiliary module paths from the MCP root.
  return [
    {
      name: 'gitstalk-gateway',
      modules: true,
      scriptPath: gatewayScript,
      compatibilityDate,
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        ADMIN_TOKEN: 'mcp-test-admin-token-0123456789abcdef',
        RUN_TOKEN_SECRET: 'mcp-test-signing-secret-0123456789abcdef',
        LOG_LEVEL: 'error',
        ARTIFACTS_NAMESPACE: 'gitstalk-race',
        RUN_TOKEN_TTL_SECONDS: '3600',
        ARTIFACTS_TOKEN_TTL_SECONDS: '600',
        PUBLIC_URL: 'https://gateway.example.test',
        WEB_URL: 'https://web.example.test',
        ACTIONS_EXECUTOR_MODE: 'stub',
        ACTIONS_MONTHLY_MINUTES: '100',
        ACTIONS_JOB_TIMEOUT_MINUTES: '60',
        ACTIONS_CONCURRENT_JOBS: '4',
        ACTIONS_SECRETS_KEY: 'bWNwLXRlc3QtYWN0aW9ucy1zZWNyZXRzLWtleS0zMmI=',
      },
      r2Buckets: ['ACTIONS_LOGS'],
      // Landings reach Actions through the repo-events queue, as deployed: a stalk move starts
      // the push runs the Actions tools follow.
      queueProducers: { REPO_EVENTS: { queueName: 'gitstalk-repo-events' } },
      queueConsumers: { 'gitstalk-repo-events': { maxBatchSize: 100, maxBatchTimeout: 0 } },
      serviceBindings: {
        ARTIFACTS: { name: 'fake-artifacts', entrypoint: 'FakeArtifacts' },
        REPOS: { name: 'fake-artifacts', entrypoint: 'FakeRepositories' },
      },
      d1Databases: { IDENTITY_DB: IDENTITY_DB_ID, FORGE: FORGE_DB_ID },
      durableObjects: {
        RUNS: { className: 'RunDO', useSQLite: true },
        RUN_INDEX: { className: 'RunIndex', useSQLite: true },
        RUN_STREAMS: { className: 'RunStreamDO', useSQLite: true },
        RUNNER_CAPACITY: { className: 'RunnerCapacity', useSQLite: true },
        RUNNER: { className: 'FakeRunner', scriptName: 'fake-artifacts' },
        ACTIONS_REPOS: { className: 'ActionsRepoDO', useSQLite: true },
        ACTIONS_RUNS: { className: 'ActionsRunDO', useSQLite: true },
      },
      outboundService: { name: 'fake-artifacts', entrypoint: 'FakeGitRemote' },
    },
    {
      // The gateway's fakes: Artifacts, its git remotes and the runner share one worker.
      name: 'fake-artifacts',
      modules: ['fake-artifacts.js', 'fake-pack.js', 'fake-runner.js', 'fake-store.js'].map(
        (file) => ({
          type: 'ESModule' as const,
          path: file,
          contents: readFileSync(path.join(gateway, 'test/fakes', file), 'utf8'),
        }),
      ),
      compatibilityDate,
      // node:zlib reads the real packs the gateway writes (gateway/test/fakes/fake-pack.js).
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { FAKE_RUNNER: { className: 'FakeRunner', useSQLite: true } },
    },
  ];
}

/** Bundle actual production code using the esbuild already installed with Wrangler. */
function bundleGateway(): string {
  const fromWrangler = createRequire(fileURLToPath(import.meta.resolve('wrangler')));
  const esbuild: unknown = fromWrangler('esbuild');
  if (typeof esbuild !== 'object' || esbuild === null)
    throw new Error('Wrangler has no esbuild module');
  const buildSync: unknown = Reflect.get(esbuild, 'buildSync');
  if (typeof buildSync !== 'function') throw new Error('Wrangler esbuild has no buildSync');
  const directory = path.join(here, '.wrangler/test');
  mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'gateway.js');
  Reflect.apply(buildSync, esbuild, [
    {
      entryPoints: [path.join(here, '../gateway/src/index.ts')],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      // Some dependencies (the Actions parser's cronstrue) publish only `main`.
      mainFields: ['module', 'main'],
      target: 'es2024',
      conditions: ['workerd', 'worker', 'browser'],
      external: ['cloudflare:*', 'workerd:*', 'node:*', ...builtinModules],
    },
  ]);
  return outfile;
}

function writeTestWranglerConfig(): string {
  const config = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(withoutJsoncSyntax(readFileSync(path.join(here, 'wrangler.jsonc'), 'utf8'))));
  delete config['ai'];
  delete config['$schema'];
  config['main'] = path.join(here, 'src/index.ts');
  config['compatibility_date'] = compatibilityDate;
  const file = path.join(here, '.wrangler/test/wrangler.test.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/** Drop JSONC comments only outside quoted strings. */
function withoutJsoncSyntax(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const pair = text.slice(index, index + 2);
    if (char === '"') {
      const end = stringEnd(text, index);
      output += text.slice(index, end);
      index = end;
    } else if (pair === '//') {
      index = text.indexOf('\n', index) === -1 ? text.length : text.indexOf('\n', index);
    } else if (pair === '/*') {
      index = text.indexOf('*/', index) + 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return output.replace(/,(\s*[}\]])/g, '$1');
}

function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
  return index + 1;
}

/** The compatibility date of the workerd the test pool runs (pool → miniflare → workerd). */
function poolWorkerdCompatibilityDate(): string {
  const fromPool = createRequire(
    fileURLToPath(import.meta.resolve('@cloudflare/vitest-pool-workers')),
  );
  const fromMiniflare = createRequire(fromPool.resolve('miniflare'));
  const workerd: unknown = fromMiniflare('workerd');
  if (typeof workerd === 'object' && workerd !== null && 'compatibilityDate' in workerd) {
    const date = workerd.compatibilityDate;
    if (typeof date === 'string') return date;
  }
  throw new Error('cannot read the test pool workerd compatibility date');
}
