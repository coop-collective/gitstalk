/**
 * The start of every Actions page: the repository (a 404 for anyone who may not read it),
 * the control plane scoped to the viewer, whether they may act (maintain or owner), and the
 * CSRF token their forms carry. Server-only.
 */
import type { ActionsClient } from '../actions/actions-client';
import { currentSession } from '../auth/user';
import { actionsSession } from './actions-source';
import type { RepositoryPage, RepositoryParams } from './repository-page';
import { repositoryPage } from './repository-page';

export type ActionsPage = RepositoryPage & {
  /** Null when no control plane answers on this deployment. */
  readonly actions: ActionsClient | null;
  /** Present for maintainers and the owner: what their forms send. */
  readonly access: ActionsAccess | null;
};

export type ActionsAccess = {
  readonly csrf: string;
  readonly owner: string;
  readonly name: string;
};

export async function actionsPage(params: RepositoryParams): Promise<ActionsPage> {
  // The session (for the CSRF token) is read beside the repository, not after it: the two
  // lookups are independent, and a serial pair cost a round trip on every maintainer's page.
  const [page, viewerSession] = await Promise.all([repositoryPage(params), currentSession()]);
  const canMaintain = page.role === 'owner' || page.role === 'maintain';
  const session = canMaintain ? viewerSession : null;
  const actor = page.user === null ? null : { id: page.user.id, handle: page.user.handle };
  const actions = await actionsSession({ actor, repoId: page.record.id });
  return {
    ...page,
    actions: actions?.client ?? null,
    access:
      session === null
        ? null
        : { csrf: session.csrfToken, owner: page.record.owner.handle, name: page.record.name },
  };
}
