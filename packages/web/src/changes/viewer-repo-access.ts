/**
 * `repoAccess` for this request: the signed-in viewer and the GATEWAY binding. A public
 * repository's reads share the isolate's caches (`sharedReadsFor`), as its pages do; a private
 * or internal one reads fresh. Server-only.
 */
import { env } from 'cloudflare:workers';

import { currentUser } from '../auth/user';
import { sharedReadsFor } from '../repo-pages/cached-reads';
import { engineOf, engineReads } from '../repo-pages/engine-reads';
import { registryClient } from '../repositories/registry-client';
import type { RepoAccess } from './changes-api';
import { repoAccess } from './repo-access';

export type RepoRouteContext = {
  readonly params: Promise<{ readonly owner: string; readonly repo: string }>;
};

export async function viewerRepoAccess(context: RepoRouteContext): Promise<RepoAccess> {
  const [{ owner, repo }, viewer] = await Promise.all([context.params, currentUser()]);
  return repoAccess({
    owner,
    repo,
    viewer,
    registry: registryClient(env.GATEWAY),
    readsFor: (record) => {
      const engine = engineOf(record.engine_id);
      return engine === null
        ? null
        : engineReads(env.GATEWAY, engine, sharedReadsFor(record, engine));
    },
  });
}
