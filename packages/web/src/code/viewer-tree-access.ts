/**
 * `TreeAccess` for this request: the signed-in viewer, the same repository lookup as the pages
 * (private and missing both read as not found), and the GATEWAY binding. The lookup's grant
 * opens the repository's cached reads (`cachedReadsFor`): the shared edge layers for a public
 * repository, the private KV namespace otherwise. Server-only.
 */
import { env } from 'cloudflare:workers';

import { currentUser } from '../auth/user';
import { cachedReadsFor } from '../repo-pages/cached-reads';
import { engineOf, engineReads } from '../repo-pages/engine-reads';
import { lookupRepository } from '../repositories/flows';
import { registryClient } from '../repositories/registry-client';
import type { TreeAccess } from './file-tree-api';

export type TreeRouteContext = {
  readonly params: Promise<{ readonly owner: string; readonly repo: string }>;
};

export async function viewerTreeAccess(context: TreeRouteContext): Promise<TreeAccess> {
  const [{ owner, repo }, viewer] = await Promise.all([context.params, currentUser()]);
  const found = await lookupRepository(
    decodeURIComponent(owner),
    decodeURIComponent(repo),
    viewer,
    registryClient(env.GATEWAY),
  );
  if (found.kind === 'not-found') return { kind: 'not-found' };
  const { record, grant } = found;
  const engine = engineOf(record.engine_id);
  return {
    kind: 'found',
    visibility: record.visibility,
    reads: engine === null ? null : engineReads(env.GATEWAY, engine, cachedReadsFor(grant, engine)),
  };
}
