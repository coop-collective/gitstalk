/**
 * The keys of the shared edge caches (docs/claude-opus/35-caching.md §4.6): one place builds
 * them, from a `PublicEngine` (a public repository's engine, taken from the record the viewer's
 * access check returned) and a commit sha, never a ref name. A key holds nothing about the
 * viewer, which is correct only because private and internal repositories never reach here.
 *
 * - Cache API (per colo): `https://<origin>/__edge/v1/<engine>/tree/<sha>`,
 *   `…/file/<sha>/<encodeURIComponent(path)>`, `…/diff/<base>..<head>`.
 * - KV (global): `v1:<engine>:tree:<sha>`, `v1:<engine>:file:<sha>:<sha256(path)>`,
 *   `v1:<engine>:diff:<base>:<head>`. The path is hashed: KV keys are at most 512 bytes.
 *
 * Bump `EDGE_CACHE_VERSION` when a stored payload changes shape: old entries are then never
 * read again and expire by their TTL.
 */
import type { Sha } from '@gitstalk/shared-race/ids';

import type { PublicEngine } from '../repo-pages/event-cache';

export const EDGE_CACHE_VERSION = 'v1';

/** The named Cache API cache holding the objects. */
export const EDGE_CACHE_NAME = `gitstalk-objects-${EDGE_CACHE_VERSION}`;

/** The reserved path the Cache API keys live under; no route answers it (worker/index.ts). */
export const EDGE_PATH_PREFIX = '/__edge/';

/** An object addressed by commit shas: its content can never change. */
export type EdgeObject =
  | { readonly kind: 'tree'; readonly sha: Sha }
  | { readonly kind: 'file'; readonly sha: Sha; readonly path: string }
  | { readonly kind: 'diff'; readonly base: Sha; readonly head: Sha };

export type EdgeObjectKind = EdgeObject['kind'];

/** The Cache API key (a URL on this deployment's own origin) of an object. */
export async function coloKey(
  origin: string,
  engine: PublicEngine,
  object: EdgeObject,
): Promise<string> {
  const base = `${EDGE_PATH_PREFIX}${EDGE_CACHE_VERSION}/${engine.engine}/${engine.epoch}`;
  return new URL(`${base}/${await coloPath(object)}`, origin).toString();
}

/** The KV key of an object. */
export async function kvKey(engine: PublicEngine, object: EdgeObject): Promise<string> {
  const prefix = `${EDGE_CACHE_VERSION}:${engine.engine}:${engine.epoch}`;
  switch (object.kind) {
    case 'tree':
      return `${prefix}:tree:${object.sha}`;
    case 'file':
      return `${prefix}:file:${object.sha}:${await sha256Hex(object.path)}`;
    case 'diff':
      return `${prefix}:diff:${object.base}:${object.head}`;
    default:
      return assertNever(object);
  }
}

/** Whether a request path is under the reserved prefix (answered 404 before any route). */
export function isEdgePath(pathname: string): boolean {
  return pathname.startsWith(EDGE_PATH_PREFIX) || pathname === EDGE_PATH_PREFIX.slice(0, -1);
}

async function coloPath(object: EdgeObject): Promise<string> {
  switch (object.kind) {
    case 'tree':
      return `tree/${object.sha}`;
    case 'file':
      return `file/${object.sha}/${await sha256Hex(object.path)}`;
    case 'diff':
      return `diff/${object.base}..${object.head}`;
    default:
      return assertNever(object);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertNever(value: never): never {
  throw new Error(`unknown edge object ${JSON.stringify(value)}`);
}
