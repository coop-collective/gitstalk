/**
 * `repoAccess` for this request: the signed-in viewer and the GATEWAY binding. Server-only.
 */
import { env } from 'cloudflare:workers';

import { currentUser } from '../auth/user';
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
    readsFor: (engineId) => {
      const engine = engineOf(engineId);
      return engine === null ? null : engineReads(env.GATEWAY, engine);
    },
  });
}
