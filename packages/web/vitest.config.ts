import { defineConfig } from 'vitest/config';

// The app's pure modules (reducer, Ask) run under plain vitest: no bindings involved, and so do
// component render tests (`components/**/*.test.tsx`, rendered to HTML as the server would).
// Tests that need real bindings (`*.workers.test.ts`) run on Miniflare: vitest.workers.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'components/**/*.test.tsx'],
    exclude: ['src/**/*.workers.test.ts'],
  },
});
