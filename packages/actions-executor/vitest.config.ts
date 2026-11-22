import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run the real Worker on Miniflare. Containers need Docker and Cloudflare, so the test
 * config drops the `containers` block (the container side is covered by the Rust tests and the
 * staging runs) and binds ACTIONS_JOBS to a small fake of the gateway's executor sink. No test
 * touches the network.
 *
 * As in the gateway, the test pool's workerd may not know today's compatibility date, so the
 * tests use the newest date it supports.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const compatibilityDate = poolWorkerdCompatibilityDate();

const FAKE_GATEWAY = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export default class extends WorkerEntrypoint {
  async fetch() {
    return new Response('fake gateway');
  }
}
export class ActionsJobs extends WorkerEntrypoint {
  async actionsJobSecrets() { return { ok: true, value: {} }; }
  async actionsJobLogs() { return { ok: true, value: { cancelRequested: false } }; }
  async actionsJobFinished() { return { ok: true, value: { accepted: true } }; }
  async repositoryExists(repoId) { return { ok: true, value: { exists: !repoId.startsWith('gone_') } }; }
}`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: writeTestWranglerConfig() },
      remoteBindings: false,
      miniflare: {
        bindings: {
          ADMIN_TOKEN: 'test-admin-token-0123456789abcdef0123456789',
          LOG_LEVEL: 'error',
          STANDALONE_SECRETS: JSON.stringify({ NPM_TOKEN: 'npm-secret', OTHER: 'not-named' }),
        },
        serviceBindings: {
          ACTIONS_JOBS: { name: 'fake-gateway', entrypoint: 'ActionsJobs' },
        },
        workers: [{ name: 'fake-gateway', modules: true, script: FAKE_GATEWAY, compatibilityDate }],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // The purge test writes 1,205 real R2 objects (Miniflare): the same result on every run, but
    // on a busy machine the writes alone passed the default 5 s, as in the gateway and mcp configs.
    testTimeout: 30_000,
  },
});

/** wrangler.jsonc without `containers`, `services` and `secrets`, under .wrangler/. */
function writeTestWranglerConfig(): string {
  const config: Record<string, unknown> = JSON.parse(
    withoutJsoncSyntax(readFileSync(path.join(here, 'wrangler.jsonc'), 'utf8')),
  );
  delete config['containers'];
  delete config['services'];
  delete config['secrets'];
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
