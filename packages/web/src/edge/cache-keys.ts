/**
 * The keys of the edge caches (docs/claude-opus/35-caching.md §7): one place builds them, from
 * an engine key a `ReadGrant` made on this request (`PublicEngine` or `PrivateEngine`, so only
 * after the viewer's access check) and commit shas, never a ref name. A key holds nothing about
 * the viewer: access is checked live on every request, and the content is the same for every
 * viewer who may read it.
 *
 * - Cache API (per colo, public only): `https://<origin>/__edge/v1/<engine>/<epoch>/tree/<sha>`,
 *   `…/file/<sha>/<sha256(path)>`, `…/diff/<base>..<head>`.
 * - KV (global), public: `v1:<engine>:<epoch>:tree:<sha>`, `…:file:<sha>:<sha256(path)>`,
 *   `…:diff:<base>:<head>`. Private and internal: the same under `v1:priv:<engine>:<epoch>:`.
 *   The path is hashed: KV keys are at most 512 bytes.
 *
 * Bump `EDGE_CACHE_VERSION` when a stored payload changes shape: old entries are then never
 * read again and expire by their TTL.
 */
import type { Sha } from '@gitstalk/shared-race/ids';

import type { PublicEngine } from '../repo-pages/event-cache';
import type { PrivateEngine } from './read-grant';

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

/** The KV key of a public repository's object. */
export async function kvKey(engine: PublicEngine, object: EdgeObject): Promise<string> {
  return `${EDGE_CACHE_VERSION}:${engine.engine}:${engine.epoch}:${await kvSuffix(object)}`;
}

/**
 * The KV key of a private or internal repository's object, in its own namespace:
 * `v1:priv:<engine>:<epoch>:<kind>:<sha>[:<sha256(path)>]`. `priv` cannot be an engine id
 * (`RunId` is 6 to 24 characters), so no private key equals a public one.
 */
export async function privateKvKey(engine: PrivateEngine, object: EdgeObject): Promise<string> {
  const prefix = `${EDGE_CACHE_VERSION}:${PRIVATE_KV_NAMESPACE}:${engine.engine}:${engine.epoch}`;
  return `${prefix}:${await kvSuffix(object)}`;
}

/** The segment that sets private entries apart in `OBJECTS`. */
export const PRIVATE_KV_NAMESPACE = 'priv';

async function kvSuffix(object: EdgeObject): Promise<string> {
  switch (object.kind) {
    case 'tree':
      return `tree:${object.sha}`;
    case 'file':
      return `file:${object.sha}:${await sha256Hex(object.path)}`;
    case 'diff':
      return `diff:${object.base}:${object.head}`;
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
