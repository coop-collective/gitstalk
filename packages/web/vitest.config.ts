import { defineConfig } from 'vitest/config';

// The app's pure modules (reducer, Ask) run under plain vitest: no bindings involved. Tests
// that need real bindings (`*.workers.test.ts`) run on Miniflare: vitest.workers.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.workers.test.ts'],
  },
});
