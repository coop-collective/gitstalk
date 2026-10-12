import { HydrationBoundary, dehydrate } from '@tanstack/react-query';

import { ChangeDetail } from '../../../../../components/repo-tabs/change-detail';
import { repoScopeOf, seedChangeQueries } from '../../../../../components/repo-tabs/changes-tab';
import { StreamedBeanDiff } from '../../../../../components/repo-tabs/streamed-bean-diff';
import { groupCounts } from '../../../../../src/changes/changes';
import { getServerQueryClient } from '../../../../../src/query/server';
import type { BeanParams } from '../../../../../src/server/bean-page';
import { beanPage } from '../../../../../src/server/bean-page';

type PageProps = { readonly params: BeanParams };

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo, bean } = await params;
  return {
    title: `${decodeURIComponent(bean)}, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`,
  };
}

/**
 * One bean's page: its journey, its verdict and its diff. The bean (read by its layout, which
 * answers 404 for an unknown one) renders at once and the browser starts from it (dehydrated),
 * then follows the engine's feed; the diff streams in after.
 */
export default async function ChangePage({ params }: PageProps) {
  const { tab, name, change, changes, events, pushed } = await beanPage(params);
  const scope = repoScopeOf(tab);
  const queryClient = getServerQueryClient();
  seedChangeQueries(queryClient, scope, { events, pushed });
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ChangeDetail
        tab={tab}
        scope={scope}
        change={change}
        openChanges={groupCounts(changes).open}
        diff={<StreamedBeanDiff reads={tab.reads} scope={scope} bean={name} />}
        nowMs={Date.now()}
      />
    </HydrationBoundary>
  );
}
