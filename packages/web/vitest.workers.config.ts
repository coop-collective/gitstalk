import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The edge cache's tests run in workerd with real bindings (Miniflare): the `OBJECTS` KV
 * namespace and the Cache API. They use a test Worker (test/edge/wrangler.jsonc) rather than
 * the app's config, whose vinext entry, services, AI and Images bindings these tests do not
 * need. The app's other tests stay on plain vitest (vitest.config.ts). The pool's workerd may
 * not know today's compatibility date, so tests use the newest it supports.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/edge/wrangler.jsonc' },
      remoteBindings: false,
      miniflare: { compatibilityDate: poolWorkerdCompatibilityDate() },
    }),
  ],
  test: { include: ['src/**/*.workers.test.ts'] },
});

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
