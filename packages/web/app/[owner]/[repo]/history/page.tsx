import { env } from 'cloudflare:workers';

import { HistoryTab } from '../../../../components/repo-tabs/history-tab';
import { changesOf } from '../../../../src/changes/changes';
import { historyOf, landingsOf } from '../../../../src/history/history';
import { indexClient } from '../../../../src/repositories/index-client';
import type { RepositoryParams } from '../../../../src/server/repository-page';
import { engineTab } from '../../../../src/server/repository-tab';

type PageProps = { readonly params: RepositoryParams };

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `History, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

/**
 * The stalk's commits and the sprout's not validated yet (the engine's, four reads), with the
 * validations' verdicts beside them (one D1 read of the repo-events index), all at once. An
 * index that does not answer leaves the commits alone on the page.
 */
export default async function HistoryPage({ params }: PageProps) {
  const tab = await engineTab(params);
  const [stalk, sprout, pushed, events, validation] = await Promise.all([
    tab.reads.log('stalk'),
    tab.reads.log('sprout'),
    tab.reads.pushed(),
    tab.reads.events(),
    indexClient(env.GATEWAY).stalk(tab.record.id, tab.user?.id ?? null),
  ]);
  const history = historyOf({ stalk, sprout, pushed, landings: landingsOf(events) });
  return (
    <HistoryTab
      tab={tab}
      history={history}
      changes={changesOf(events, pushed)}
      validation={validation.ok ? validation.value : null}
      nowMs={Date.now()}
    />
  );
}
