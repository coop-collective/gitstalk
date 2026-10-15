/**
 * Response headers for the browser (docs/claude-opus/35-caching.md §4.5). A Worker runs in
 * front of Cloudflare's cache, so these headers never make the CDN keep a response: they speak
 * to the browser only. Edge caching is the explicit object cache (object-cache.ts).
 *
 * Every answer that has passed the viewer's access check is `private` (only this browser may
 * keep it); nothing here sets `s-maxage` or `Vary: Cookie`, so no shared proxy holds per-viewer
 * data. A 304 is only ever answered after the access check, by the route that ran it.
 *
 * A private or internal repository's answers are never kept (`no-store`, `byVisibility`): a
 * kept copy outlives sign-out and revoked access, and a fresh one is reused with no access
 * check at all. Sign-out also sends `Clear-Site-Data: "cache"` (auth/sign-out.ts).
 */
import type { Visibility } from '../query/policy';
import type { EdgeOutcome } from './object-cache';

/** How long a browser may keep an answer. */
export type CacheRule =
  /** Never kept: streams, errors, anything that may change between two requests. */
  | { readonly kind: 'no-store' }
  /** Kept, but revalidated (ETag) before every use. */
  | { readonly kind: 'revalidate' }
  /** Kept and used for `seconds` without asking. */
  | { readonly kind: 'fresh-for'; readonly seconds: number }
  /** Content addressed by commit shas, or a finished job: it never changes. */
  | { readonly kind: 'immutable' };

export const NO_STORE: CacheRule = { kind: 'no-store' };
export const REVALIDATE: CacheRule = { kind: 'revalidate' };
export const IMMUTABLE: CacheRule = { kind: 'immutable' };

/** The rule for a public repository's answer, and the one for everyone else's. */
export type VisibilityRules = {
  readonly public: CacheRule;
  /** A private or internal repository: anything kept would outlive the viewer's access. */
  readonly restricted: CacheRule;
};

/** The rule an answer about a repository of this visibility gets. */
export function byVisibility(visibility: Visibility, rules: VisibilityRules): CacheRule {
  return visibility === 'public' ? rules.public : rules.restricted;
}

/** A year: the longest `max-age` browsers honour. */
const YEAR_SECONDS = 31_536_000;

/** The `Cache-Control` value of a rule. */
export function cacheControl(rule: CacheRule): string {
  switch (rule.kind) {
    case 'no-store':
      return 'no-store';
    case 'revalidate':
      return 'private, no-cache';
    case 'fresh-for':
      return `private, max-age=${rule.seconds}`;
    case 'immutable':
      return `private, max-age=${YEAR_SECONDS}, immutable`;
    default:
      return assertNever(rule);
  }
}

/**
 * Bump when an answer's JSON changes shape, so a 304 never hands a new build's client a body
 * the old build sent.
 */
export const ETAG_VERSION = 'v1';

/** A strong ETag for a diff between two commits. */
export function pairEtag(base: string, head: string): string {
  return `"${ETAG_VERSION}.${base}..${head}"`;
}

/** The newest event of a list, as its ETag needs it. */
export type EventMark = { readonly seq: number; readonly ts: string };

/**
 * A weak ETag for the events after `after` of one engine's log: the engine, and the last
 * event's seq and timestamp. A log that was reset, or a new repository's engine under the same
 * name, never matches an old copy even at the same seq.
 */
export function eventsEtag(engine: string, after: number, last: EventMark | undefined): string {
  const end =
    last === undefined ? `${after}.none` : `${last.seq}.${last.ts.replace(/[^\w.:-]/g, '')}`;
  return `W/"${ETAG_VERSION}.${engine}.${end}"`;
}

/**
 * Whether the request's `If-None-Match` names `etag` (weak comparison, as RFC 9110 asks for
 * `If-None-Match`). Call it only after the access check: a 304 tells the caller the resource
 * exists.
 */
export function isNotModified(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (header === null) return false;
  if (header.trim() === '*') return true;
  const wanted = opaque(etag);
  return header.split(',').some((candidate) => opaque(candidate.trim()) === wanted);
}

export type JsonAnswer = {
  readonly rule: CacheRule;
  readonly etag?: string;
  /** What the edge read came to (a layer's hit, or a KV miss), for `Server-Timing`. */
  readonly timing?: { readonly outcome: EdgeOutcome; readonly ms: number };
};

/** A 200 with the JSON body and the browser headers, or a 304 when the ETag matches. */
export function jsonAnswer(request: Request, body: unknown, answer: JsonAnswer): Response {
  const headers = new Headers({ 'cache-control': cacheControl(answer.rule) });
  if (answer.etag !== undefined) headers.set('etag', answer.etag);
  if (answer.timing !== undefined)
    headers.set('server-timing', serverTiming(answer.timing.outcome, answer.timing.ms));
  if (answer.etag !== undefined && isNotModified(request, answer.etag))
    return new Response(null, { status: 304, headers });
  return Response.json(body, { headers });
}

/** An error answer: never kept, no ETag, no timing. */
export function problem(status: number, message: string): Response {
  return Response.json(
    { error: { message } },
    { status, headers: { 'cache-control': cacheControl(NO_STORE) } },
  );
}

/**
 * `edge;desc="colo-hit";dur=1.8`: what the edge read came to, shown in devtools
 * (`kv-hit-private` and `kv-miss-private` for a private repository's KV namespace).
 */
export function serverTiming(outcome: EdgeOutcome, ms: number): string {
  return `edge;desc="${outcome}";dur=${Math.max(0, ms).toFixed(1)}`;
}

function opaque(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

function assertNever(value: never): never {
  throw new Error(`unknown cache rule ${JSON.stringify(value)}`);
}
