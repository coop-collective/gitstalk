/**
 * Response headers for the browser (docs/claude-opus/35-caching.md §4.5). A Worker runs in
 * front of Cloudflare's cache, so these headers never make the CDN keep a response: they speak
 * to the browser only. Edge caching is the explicit object cache (object-cache.ts).
 *
 * Every answer that has passed the viewer's access check is `private` (only this browser may
 * keep it); nothing here sets `s-maxage` or `Vary: Cookie`, so no shared proxy holds per-viewer
 * data. A 304 is only ever answered after the access check, by the route that ran it.
 */
import type { EdgeLayer } from './object-cache';

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

/** A strong ETag for a diff between two commits. */
export function pairEtag(base: string, head: string): string {
  return `"${base}..${head}"`;
}

/** A weak ETag for an event list ending at `seq` (the list is append-only). */
export function seqEtag(seq: number): string {
  return `W/"seq-${seq}"`;
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
  /** The edge layer that served the object, for `Server-Timing`. */
  readonly timing?: { readonly layer: EdgeLayer; readonly ms: number };
};

/** A 200 with the JSON body and the browser headers, or a 304 when the ETag matches. */
export function jsonAnswer(request: Request, body: unknown, answer: JsonAnswer): Response {
  const headers = new Headers({ 'cache-control': cacheControl(answer.rule) });
  if (answer.etag !== undefined) headers.set('etag', answer.etag);
  if (answer.timing !== undefined)
    headers.set('server-timing', serverTiming(answer.timing.layer, answer.timing.ms));
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

/** `edge;desc="colo-hit";dur=1.8`: which layer served the object, shown in devtools. */
export function serverTiming(layer: EdgeLayer, ms: number): string {
  const desc = layer === 'gateway' ? 'gateway-read' : `${layer}-hit`;
  return `edge;desc="${desc}";dur=${Math.max(0, ms).toFixed(1)}`;
}

function opaque(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

function assertNever(value: never): never {
  throw new Error(`unknown cache rule ${JSON.stringify(value)}`);
}
