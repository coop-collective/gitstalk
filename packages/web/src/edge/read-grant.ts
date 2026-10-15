/**
 * Proof that the viewer passed a repository's access check on this request (`ReadGrant`), and
 * the private engine key it unlocks (`PrivateEngine`), docs/claude-opus/35-caching.md §3.
 *
 * Cache reads come after the access check, never before: the edge caches key objects by
 * engine, epoch and sha, nothing about the viewer, so a read that skipped the check would serve
 * anyone. Every edge cache function therefore takes an engine key that only a `ReadGrant` can
 * make (`PublicEngine.of(grant, …)` for the shared layers, `PrivateEngine.of(grant, …)` for the
 * private KV layer), and only the access checks make a grant: `lookupRepository`
 * (repositories/flows.ts: the pages, the Changes routes) and `runAccess` (admin/admin-gate.ts:
 * the run routes). `read-grant.test.ts` fails if any other module calls
 * `ReadGrant.afterAccessCheck`. A grant lives for one request: nothing stores it.
 */
import type { RunId } from '@gitstalk/shared-race/ids';

import type { RepositoryRecord } from '../repositories/registry-client';

/**
 * What of a repository's record decides how its reads are cached, and under which epoch: its
 * visibility, and `updated_at`, which the registry moves on every change to the record
 * (visibility, name, owner, archive, settings).
 */
export type CacheScope = Pick<RepositoryRecord, 'visibility' | 'updated_at'>;

export type Visibility = CacheScope['visibility'];

/** The viewer may read this repository: the access check said so on this request. */
export class ReadGrant {
  readonly visibility: Visibility;
  /**
   * The record's cache epoch: part of every edge object key, so any change to the record (a
   * visibility flip, a transfer, a settings save, an operator's takedown edit) leaves every
   * copy cached before it unreachable in every layer.
   */
  readonly epoch: string;
  /** Makes the type nominal: no object literal passes for a grant. */
  private readonly checked = true;

  private constructor(scope: CacheScope) {
    this.visibility = scope.visibility;
    this.epoch = epochOf(scope);
  }

  /**
   * A grant for the record an access check just returned. Only the access checks call this
   * (see the module comment); tests may.
   */
  static afterAccessCheck(scope: CacheScope): ReadGrant {
    return new ReadGrant(scope);
  }

  /** Whether every viewer may read the repository (only then may the shared layers hold it). */
  isPublic(): boolean {
    return this.checked && this.visibility === 'public';
  }
}

/**
 * A private or internal repository's engine, from a grant on this request: the only key the
 * private KV layer accepts (src/edge/private-objects.ts). Never a key of the isolate memory or
 * the Cache API, which are shared and cannot be purged.
 */
export class PrivateEngine {
  readonly engine: RunId;
  readonly epoch: string;

  private constructor(engine: RunId, epoch: string) {
    this.engine = engine;
    this.epoch = epoch;
  }

  /** The engine of a repository the viewer may read, when it is not public; null otherwise. */
  static of(grant: ReadGrant, engine: RunId): PrivateEngine | null {
    return grant.isPublic() ? null : new PrivateEngine(engine, grant.epoch);
  }
}

/** `updated_at` as a key segment: its letters and digits (`20261014T120000000Z`). */
function epochOf(scope: CacheScope): string {
  const compact = scope.updated_at.replace(/[^0-9A-Za-z]/g, '');
  return compact === '' ? '0' : compact;
}
