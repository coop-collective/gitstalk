import { cloudflare } from '@cloudflare/vite-plugin';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // The React Compiler memoises components at build time (needs oxc-transform-react).
    vinext({ react: { compiler: true } }),
    // The RSC environment runs in workerd, so server code reads bindings from cloudflare:workers.
    // GITSTALK_WRANGLER_CONFIG: an environment's generated config (wrangler.<env>.jsonc, set by
    // scripts/environments.mjs); unset, the template wrangler.jsonc (local dev).
    cloudflare({
      configPath: process.env['GITSTALK_WRANGLER_CONFIG'] ?? 'wrangler.jsonc',
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    }),
  ],
});
