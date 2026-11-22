import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run the real Worker and RunDO on Miniflare. Two bindings have no local simulator:
 * Artifacts (remote only) and the runner container (needs Docker). The tests use
 * wrangler.jsonc without those two blocks, bind ARTIFACTS and REPOS (two namespaces, as
 * deployed) to a fake Artifacts worker (which also hosts the fake runner) that
 * also serves the git remotes the proxy forwards to (all outbound fetches go there), and
 * point RUNNER at a fake runner Durable Object. No test touches the network.
 *
 * `@cloudflare/vitest-pool-workers` 0.22 (the last release before its rename to
 * `@cloudflare/vitest-plugin`) bundles a workerd that does not know today's compatibility
 * date, so the test config uses the newest date that workerd supports.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const compatibilityDate = poolWorkerdCompatibilityDate();
// The identity database (people's git tokens), migrated before each test file.
const identityMigrations = await readD1Migrations(path.join(here, '../shared-identity/migrations'));
/** The repository registry's D1 migrations, applied to the test database by test/apply-migrations.ts. */
const registryMigrations = await readD1Migrations(path.join(here, 'migrations'));
/** A throwaway OIDC signing key for the Actions issuer's tests (never a real secret). */
const oidcKey = await testSigningKey();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: writeTestWranglerConfig() },
      remoteBindings: false,
      miniflare: {
        bindings: {
          ADMIN_TOKEN: 'test-admin-token-0123456789abcdef0123456789',
          RUN_TOKEN_SECRET: 'test-run-token-secret-0123456789abcdef0123',
          // 32 bytes, base64: the Actions secrets key for tests only.
          ACTIONS_SECRETS_KEY: 'dGVzdC1hY3Rpb25zLXNlY3JldHMta2V5LTMyYnl0ZXM=',
          OIDC_SIGNING_KEYS: JSON.stringify({ active: oidcKey.kid, keys: [oidcKey] }),
          OIDC_REQUEST_SECRET: 'test-oidc-request-secret-0123456789abcdef',
          LOG_LEVEL: 'error',
          // A deployed origin (wrangler.jsonc's template points at local dev): live log tickets are wss://.
          PUBLIC_URL: 'https://gitstalk-gateway.example.workers.dev',
          WEB_URL: 'https://gitstalk-web.example.workers.dev',
          // The tests run jobs on the echo executor (the container executor has its own tests).
          ACTIONS_EXECUTOR_MODE: 'stub',
          TEST_MIGRATIONS: identityMigrations,
          FORGE_MIGRATIONS: registryMigrations,
        },
        serviceBindings: {
          ARTIFACTS: { name: 'fake-artifacts', entrypoint: 'FakeArtifacts' },
          REPOS: { name: 'fake-artifacts', entrypoint: 'FakeRepositories' },
        },
        durableObjects: { RUNNER: { className: 'FakeRunner', scriptName: 'fake-artifacts' } },
        outboundService: { name: 'fake-artifacts', entrypoint: 'FakeGitRemote' },
        workers: [
          {
            // The fake runner lives in the fake Artifacts' worker (one isolate), so its squashes
            // land in the trunk repo the way the real runner pushes its candidates.
            name: 'fake-artifacts',
            modulesRoot: path.join(here, 'test/fakes'),
            modules: ['fake-artifacts.js', 'fake-pack.js', 'fake-runner.js', 'fake-store.js'].map(
              (file) => ({
                type: 'ESModule' as const,
                path: path.join(here, 'test/fakes', file),
              }),
            ),
            compatibilityDate,
            // node:zlib reads the real packs the gateway writes (test/fakes/fake-pack.js).
            compatibilityFlags: ['nodejs_compat'],
            durableObjects: { FAKE_RUNNER: { className: 'FakeRunner', useSQLite: true } },
          },
        ],
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
    // Many tests run whole simulated races: deterministic but CPU-heavy, and several agents
    // share this machine's cores, so 5 s timed out under load. Simulations still finish in ~2 s quiet.
    testTimeout: 20_000,
    // Hooks here push real commits and wait for a run on the stub executor, more work than most
    // tests, yet they had only the default 10 s and timed out on a busy machine.
    hookTimeout: 60_000,
  },
});

/**
 * wrangler.jsonc without `containers` and `artifacts` (and `secrets`: the bindings above
 * supply them; `ai`: Workers AI is remote only, and the automations' model proxy takes a fake
 * in its tests), written under .wrangler/ (ignored).
 */
function writeTestWranglerConfig(): string {
  const config: Record<string, unknown> = JSON.parse(
    withoutJsoncSyntax(readFileSync(path.join(here, 'wrangler.jsonc'), 'utf8')),
  );
  delete config['containers'];
  delete config['artifacts'];
  delete config['secrets'];
  delete config['services'];
  delete config['ai'];
  delete config['$schema'];
  config['main'] = path.join(here, 'src/index.ts');
  if (
    typeof config['compatibility_date'] === 'string' &&
    config['compatibility_date'] > compatibilityDate
  ) {
    config['compatibility_date'] = compatibilityDate;
  }
  const directory = path.join(here, '.wrangler', 'test');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'wrangler.test.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
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

/** Drops comments and trailing commas outside strings, turning JSONC into JSON. */
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

/** An ES256 private JWK in the shape `OIDC_SIGNING_KEYS` holds (packages/shared-oidc). */
async function testSigningKey(): Promise<Record<string, unknown> & { kid: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { ...jwk, kid: 'test-key', alg: 'ES256' };
}
