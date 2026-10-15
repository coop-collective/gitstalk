/**
 * The Changes tab: the repository's beans in three lists, open (in check, red or waiting),
 * landed (on the sprout or validated on the stalk) and parked (or fallen off), each with who
 * brought it, its intent, where it stands and, when red, the tests that failed. The shell is
 * rendered here; the lists (`ChangesList`) follow the engine's feed in the browser.
 */
import type { QueryClient } from '@tanstack/react-query';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RepoScope } from '../../src/changes/change-feed';
import type { PushedBean } from '../../src/changes/pushed-beans';
import { qk } from '../../src/query/keys';
import type { RepositoryTab } from '../../src/server/repository-tab';
import { ChangesList } from './changes-list';
import { RepositoryShell } from './repository-shell';

export function ChangesTab(props: {
  readonly tab: RepositoryTab;
  /** Open beans when the page rendered, for the tab's count. */
  readonly openChanges: number;
  /** The page's `?show=`, as given. */
  readonly show: string | null;
  readonly nowMs: number;
}) {
  const { tab } = props;
  return (
    <RepositoryShell page={tab} tab="changes" openChanges={props.openChanges}>
      <ChangesList scope={repoScopeOf(tab)} show={props.show} nowMs={props.nowMs} />
    </RepositoryShell>
  );
}

/**
 * Puts what the server read into the request's query client under the keys `useChangesFeed`
 * reads, so the page dehydrates it and the browser starts from it without a fetch.
 */
export function seedChangeQueries(
  queryClient: QueryClient,
  scope: RepoScope,
  read: { readonly events: readonly RaceEvent[]; readonly pushed: readonly PushedBean[] },
): void {
  const keys = qk.repo(scope.uid, scope.owner, scope.repo);
  queryClient.setQueryData(keys.events(), read.events);
  queryClient.setQueryData(keys.pushed(), read.pushed);
}

/** The client data scope of a repository tab: its viewer, owner, name, base path, visibility. */
export function repoScopeOf(tab: RepositoryTab): RepoScope {
  return {
    uid: tab.user?.id ?? null,
    owner: tab.record.owner.handle,
    repo: tab.record.name,
    base: tab.base,
    visibility: tab.record.visibility,
  };
}
