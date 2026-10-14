/**
 * The web Worker's entry: vinext's App Router handler, with the marketing site's paths handed
 * to the site Worker when this deployment binds it as SITE (one origin for both, e.g.
 * gitstalk.io; `scripts/environments.mjs` adds the binding when `urls.site` equals `urls.web`).
 * Without SITE every request goes to the app, exactly as vinext's default entry does.
 *
 * Around both, what search engines see (src/site/search.ts): /robots.txt and /sitemap.xml are
 * answered here, site pages get their canonical link, and a deployment that is not indexed
 * (SEARCH_INDEXING is not "on") marks every response `X-Robots-Tag: noindex`. Every response
 * then gets the security headers (src/security/response-headers.ts): no framing, nosniff, a
 * referrer policy and, on https, HSTS.
 *
 * `/__edge/*` is answered 404 before anything else: the edge object cache keys its Cache API
 * entries under that path (src/edge/cache-keys.ts), and no route may ever claim it.
 */
import app from 'vinext/server/app-router-entry';

import { isEdgePath } from '../src/edge/cache-keys';
import { withResponseHeaders } from '../src/security/response-headers';
import { isSitePath } from '../src/site/forward';
import type { SearchVars } from '../src/site/search';
import { searchSettings } from '../src/site/search';
import { searchFileResponse, servedSiteResponse, withIndexing } from '../src/site/search-responses';

/** The optional binding: generated only for environments that serve the site here. */
type SiteBinding = { readonly SITE?: { fetch(request: Request): Promise<Response> } };

type AppEnv = Parameters<typeof app.fetch>[1];
type AppContext = Parameters<typeof app.fetch>[2];

export default {
  __ensureInstrumentation: app.__ensureInstrumentation,
  async fetch(
    request: Request,
    env: AppEnv & SiteBinding & SearchVars,
    ctx: AppContext,
  ): Promise<Response> {
    return withResponseHeaders(await respond(request, env, ctx), request);
  },
};

async function respond(
  request: Request,
  env: AppEnv & SiteBinding & SearchVars,
  ctx: AppContext,
): Promise<Response> {
  if (isEdgePath(new URL(request.url).pathname)) return reservedPath();
  const settings = searchSettings(env ?? {});
  const site = env?.SITE;
  const searchFile = searchFileResponse(request, settings, site ? 'here' : 'elsewhere');
  if (searchFile !== null) return withIndexing(searchFile, settings);
  if (site && isSitePath(request)) {
    return servedSiteResponse(await site.fetch(request), request, settings);
  }
  return withIndexing(await app.fetch(request, env, ctx), settings);
}

/** The edge cache's reserved path: not a page, and never cached by anyone. */
function reservedPath(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
