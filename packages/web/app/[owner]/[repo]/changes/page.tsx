import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { redirect } from 'next/navigation';

import {
  ChangesTab,
  repoScopeOf,
  seedChangeQueries,
} from '../../../../components/repo-tabs/changes-tab';
import type { SearchParams } from '../../../../components/home/repository-home';
import { changesOf, groupCounts } from '../../../../src/changes/changes';
import { getServerQueryClient } from '../../../../src/query/server';
import type { RepositoryParams } from '../../../../src/server/repository-page';
import { repositoryTab } from '../../../../src/server/repository-tab';

type PageProps = {
  readonly params: RepositoryParams;
  readonly searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `Changes, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

/**
 * The repository's beans: open, landed, parked. Two gateway reads, however many beans; the
 * browser starts from them (dehydrated) and follows the engine's feed from there.
 */
export default async function ChangesPage({ params, searchParams }: PageProps) {
  const [tab, query] = await Promise.all([repositoryTab(params), searchParams]);
  if (tab.reads === null) redirect(tab.base);
  const [events, pushed] = await Promise.all([tab.reads.events(), tab.reads.pushed()]);
  const queryClient = getServerQueryClient();
  seedChangeQueries(queryClient, repoScopeOf(tab), { events, pushed });
  const show = query['show'];
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ChangesTab
        tab={tab}
        openChanges={groupCounts(changesOf(events, pushed)).open}
        show={typeof show === 'string' ? show : null}
        nowMs={Date.now()}
      />
    </HydrationBoundary>
  );
}
