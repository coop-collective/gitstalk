import type { NextConfig } from 'next';

/**
 * Account pages are never cached and send no referrer off the origin. Framing is refused on
 * every response by the Worker's entry (src/security/response-headers.ts).
 */
const ACCOUNT_HEADERS = [
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Cache-Control', value: 'no-store' },
];

/**
 * Names this build in client code (`BUILD_ID`, src/query/persistence.ts), so data a browser
 * persisted under an older build is discarded. A deploy pipeline may pin it; otherwise every
 * build gets its own.
 */
const BUILD_ID = process.env['GITSTALK_BUILD_ID'] ?? Date.now().toString(36);

const nextConfig: NextConfig = {
  env: { GITSTALK_BUILD_ID: BUILD_ID },
  experimental: {
    // vinext reads every multipart POST as a possible progressive server action first and
    // refuses it (413) above this limit, route handlers included. Picture uploads are up to
    // 2 MB plus the form around them (docs/claude-opus/29-settings.md); 1 MB is the default.
    serverActions: { bodySizeLimit: '3mb' },
    // The client router reuses a dynamic page's payload for 30 s (back and forward, a Link
    // to a page just seen) and a prefetched one for 5 minutes. A server action that calls
    // revalidatePath or revalidateTag, sets a cookie or redirects clears both caches.
    staleTimes: { dynamic: 30, static: 300 },
  },
  headers: async () =>
    [
      '/login',
      '/signup',
      '/signup/:path*',
      '/connect',
      '/connect/:path*',
      '/settings',
      '/settings/:path*',
    ].map((source) => ({
      source,
      headers: ACCOUNT_HEADERS,
    })),
};

export default nextConfig;
