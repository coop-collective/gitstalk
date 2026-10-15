import { cloudflare } from '@cloudflare/vite-plugin';
import vinext from 'vinext';
import { defineConfig } from 'vite';

/**
 * TanStack Query keeps its QueryClient in a React context created at module load, so the
 * browser must load each of these packages exactly once. In dev, Vite discovers a dependency a
 * client component imports late (after the first page) and re-optimises it into a second copy;
 * a hook from that copy then reads an empty context and throws "No QueryClient set" (seen going
 * from Changes to History). Pre-bundling them up front and deduping keeps one copy.
 */
const SINGLE_COPY = [
  '@tanstack/react-query',
  '@tanstack/react-query-persist-client',
  '@tanstack/query-sync-storage-persister',
];

export default defineConfig({
  resolve: { dedupe: SINGLE_COPY },
  optimizeDeps: { include: SINGLE_COPY },
  plugins: [
    vinext(),
    // The RSC environment runs in workerd, so server code reads bindings from cloudflare:workers.
    // GITSTALK_WRANGLER_CONFIG: an environment's generated config (wrangler.<env>.jsonc, set by
    // scripts/environments.mjs); unset, the template wrangler.jsonc (local dev).
    cloudflare({
      configPath: process.env['GITSTALK_WRANGLER_CONFIG'] ?? 'wrangler.jsonc',
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    }),
  ],
});
