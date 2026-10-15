/**
 * A public repository's reads that outlive the request (`SharedReads`): its event log, kept by
 * the append-only `EventCache`, and its trees and files at a commit sha, which never change and
 * so are read through the edge object cache (src/edge/object-cache.ts: this isolate's memory,
 * then the colo's Cache API, then KV, then the gateway). The cache keys hold the engine, the
 * sha and the path, nothing about the viewer: that is why only a public repository's reads,
 * after the viewer's access check, come here. Server-only.
 */
import { env } from 'cloudflare:workers';

import type { RunId } from '@gitstalk/shared-race/ids';

import { publicObjects } from '../edge/public-objects';
import { FILE_CODEC, TREE_CODEC } from '../edge/stored-objects';
import type { SharedReads } from './engine-reads';
import { engineReads, readFile } from './engine-reads';
import type { CacheScope } from './event-cache';
import { createEventCache, PublicEngine } from './event-cache';

/**
 * Engines and events one isolate keeps (about 250 bytes of JSON an event, so tens of MB at
 * most, beside the object cache's 16 MB). Module scope on purpose: it is the cache across
 * requests, and it holds only public repositories' logs.
 */
const PUBLIC_EVENT_LOGS = createEventCache({ maxEngines: 32, maxEvents: 40_000 });

/**
 * The shared reads of a repository whose record the viewer's access check returned: null for a
 * private or internal repository, which reads everything fresh on every request.
 */
export function sharedReadsFor(record: CacheScope, engine: RunId): SharedReads | null {
  const shared = PublicEngine.of(record, engine);
  if (shared === null) return null;
  return {
    events: (readTail) => PUBLIC_EVENT_LOGS.events(shared, readTail),
    tree: async (sha) => {
      const answer = await publicObjects.read(shared, { kind: 'tree', sha }, TREE_CODEC, () =>
        engineReads(env.GATEWAY, engine).tree(sha),
      );
      return answer.value;
    },
    // Null when the commit has no such file (answered, not stored); throws when the gateway
    // failed, so no layer keeps a passing failure.
    file: async (sha, path) => {
      const answer = await publicObjects.read(shared, { kind: 'file', sha, path }, FILE_CODEC, () =>
        readFile(env.GATEWAY, { engine, ref: sha, path }),
      );
      return answer.value;
    },
  };
}
