/**
 * `TreeAccess` for this request: the signed-in viewer, the same repository lookup as the pages
 * (private and missing both read as not found), and the GATEWAY binding. A public repository's
 * reads share the edge object cache (`sharedReadsFor`); a private or internal one reads fresh.
 * Server-only.
 */
import { env } from 'cloudflare:workers';

import { currentUser } from '../auth/user';
import { sharedReadsFor } from '../repo-pages/cached-reads';
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
  const { record } = found;
  const engine = engineOf(record.engine_id);
  return {
    kind: 'found',
    visibility: record.visibility,
    reads:
      engine === null ? null : engineReads(env.GATEWAY, engine, sharedReadsFor(record, engine)),
  };
}
