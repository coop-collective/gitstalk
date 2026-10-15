/**
 * A repository's reads that outlive the request (`CachedReads`), chosen by the grant the
 * viewer's access check made on this request (docs/claude-opus/35-caching.md §3):
 *
 * - public: its event log, kept by the append-only `EventCache`, and its trees, files and
 *   diffs at commit shas, which never change, through the shared edge object cache (this
 *   isolate's memory, then the colo's Cache API, then KV, then the gateway);
 * - private or internal: its trees, files and diffs through the private KV namespace only
 *   (src/edge/private-object-cache.ts), never the isolate memory or the Cache API; its event
 *   log is read fresh on every request.
 *
 * Cache keys hold the engine, the record's cache epoch and the shas, nothing about the viewer:
 * the access check runs first on every request, and only its grant opens these reads.
 * Server-only.
 */
import { env } from 'cloudflare:workers';

import type { RunId, Sha } from '@gitstalk/shared-race/ids';

import type { ReadGrant } from '../edge/read-grant';
import { PrivateEngine } from '../edge/read-grant';
import { privateObjects } from '../edge/private-objects';
import { publicObjects } from '../edge/public-objects';
import { DIFF_CODEC, FILE_CODEC, TREE_CODEC } from '../edge/stored-objects';
import { forgeForRun } from '../forge/sources';
import type { CachedReads } from './engine-reads';
import { readFile } from './engine-reads';
import { createEventCache, PublicEngine } from './event-cache';

/**
 * Engines and events one isolate keeps (about 250 bytes of JSON an event, so tens of MB at
 * most, beside the object cache's 4 MB). Module scope on purpose: it is the cache across
 * requests, and it holds only public repositories' logs.
 */
const PUBLIC_EVENT_LOGS = createEventCache({ maxEngines: 32, maxEvents: 40_000 });

/** The cached reads of a repository the viewer's access check let them read on this request. */
export function cachedReadsFor(grant: ReadGrant, engine: RunId): CachedReads {
  const shared = PublicEngine.of(grant, engine);
  if (shared !== null) return publicReads(shared, engine);
  const owned = PrivateEngine.of(grant, engine);
  if (owned !== null) return privateReads(owned, engine);
  throw new Error('a grant is either public or not');
}

function publicReads(shared: PublicEngine, engine: RunId): CachedReads {
  const gateway = gatewayReads(engine);
  return {
    events: (readTail) => PUBLIC_EVENT_LOGS.events(shared, readTail),
    tree: async (sha) =>
      (await publicObjects.read(shared, { kind: 'tree', sha }, TREE_CODEC, () => gateway.tree(sha)))
        .value,
    // Null when the commit has no such file (answered, not stored); throws when the gateway
    // failed, so no layer keeps a passing failure.
    file: async (sha, path) =>
      (
        await publicObjects.read(shared, { kind: 'file', sha, path }, FILE_CODEC, () =>
          gateway.file(sha, path),
        )
      ).value,
    diff: async (base, head) =>
      (
        await publicObjects.read(shared, { kind: 'diff', base, head }, DIFF_CODEC, () =>
          gateway.diff(base, head),
        )
      ).value,
  };
}

function privateReads(owned: PrivateEngine, engine: RunId): CachedReads {
  const gateway = gatewayReads(engine);
  return {
    events: null,
    tree: async (sha) =>
      (await privateObjects.read(owned, { kind: 'tree', sha }, TREE_CODEC, () => gateway.tree(sha)))
        .value,
    file: async (sha, path) =>
      (
        await privateObjects.read(owned, { kind: 'file', sha, path }, FILE_CODEC, () =>
          gateway.file(sha, path),
        )
      ).value,
    diff: async (base, head) =>
      (
        await privateObjects.read(owned, { kind: 'diff', base, head }, DIFF_CODEC, () =>
          gateway.diff(base, head),
        )
      ).value,
  };
}

/** The engine's object reads from the gateway, uncached. */
function gatewayReads(engine: RunId) {
  return {
    tree: (sha: Sha) => forgeForRun(env.GATEWAY, engine).repoTree(engine, sha),
    file: (sha: Sha, path: string) => readFile(env.GATEWAY, { engine, ref: sha, path }),
    diff: (base: Sha, head: Sha) => forgeForRun(env.GATEWAY, engine).repoDiff(engine, base, head),
  };
}
