import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { notFound } from 'next/navigation';

import { ChangeDetail } from '../../../../../components/repo-tabs/change-detail';
import { repoScopeOf, seedChangeQueries } from '../../../../../components/repo-tabs/changes-tab';
import { changesOf, groupCounts } from '../../../../../src/changes/changes';
import { qk } from '../../../../../src/query/keys';
import { getServerQueryClient } from '../../../../../src/query/server';
import { engineTab } from '../../../../../src/server/repository-tab';

type PageProps = {
  readonly params: Promise<{
    readonly owner: string;
    readonly repo: string;
    readonly bean: string;
  }>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo, bean } = await params;
  return {
    title: `${decodeURIComponent(bean)}, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`,
  };
}

/**
 * One bean's page: its journey, its verdict and its diff. The server reads them once and the
 * browser starts from them (dehydrated), then follows the engine's feed.
 */
export default async function ChangePage({ params }: PageProps) {
  const resolved = await params;
  const tab = await engineTab(Promise.resolve(resolved));
  const name = decodeURIComponent(resolved.bean);
  const [events, pushed, diff] = await Promise.all([
    tab.reads.events(),
    tab.reads.pushed(),
    tab.reads.beanDiff(name).catch(() => null),
  ]);
  const changes = changesOf(events, pushed);
  const change = changes.find((candidate) => candidate.bean === name);
  if (change === undefined) notFound();
  const scope = repoScopeOf(tab);
  const queryClient = getServerQueryClient();
  seedChangeQueries(queryClient, scope, { events, pushed });
  queryClient.setQueryData(qk.repo(scope.uid, scope.owner, scope.repo).bean(name), diff);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ChangeDetail
        tab={tab}
        scope={scope}
        engine={tab.reads.engine}
        change={change}
        openChanges={groupCounts(changes).open}
        nowMs={Date.now()}
      />
    </HydrationBoundary>
  );
}
