import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run the real Worker, MatchDO, BrokerDO and AgentSandbox on Miniflare. Containers need
 * Docker and Cloudflare, so the test config drops the `containers` block: AgentSandbox is then a
 * plain Durable Object whose `start` fails, which the match records as a start error. The
 * gateway binding points at a small fake that answers 404. No test touches the network.
 *
 * As in the gateway, the test pool's workerd may not know today's compatibility date, so the
 * tests use the newest date it supports.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const compatibilityDate = poolWorkerdCompatibilityDate();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: writeTestWranglerConfig() },
      remoteBindings: false,
      miniflare: {
        bindings: {
          SWARM_ADMIN_TOKEN: 'test-swarm-admin-token-0123456789abcdef',
          // 32 bytes of 0x01, base64: a test-only seat key.
          SEAT_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
          OPENAI_API_KEY: 'sk-test-not-a-real-key-0123456789',
          LOG_LEVEL: 'error',
        },
        serviceBindings: { GATEWAY: 'fake-gateway' },
        workers: [
          {
            name: 'fake-gateway',
            modules: true,
            script:
              'export default { fetch() { return Response.json({ error: { code: "not_found" } }, { status: 404 }); } };',
            compatibilityDate,
          },
        ],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // A file's first request starts the Worker and its Durable Objects; on a busy machine that
    // start alone passed the default 5 s, as in the gateway and mcp configs.
    testTimeout: 30_000,
  },
});

/** wrangler.jsonc without `containers`, `services` and `secrets`, written under .wrangler/. */
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
