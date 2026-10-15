import { env } from 'cloudflare:workers';

import { AskTab, isAskQuery } from '../../../../components/repo-tabs/ask-tab';
import { CodeTab } from '../../../../components/repo-tabs/code-tab';
import type { SearchParams } from '../../../../components/home/repository-home';
import { StartHere } from '../../../../components/repository/start-here';
import { readRef } from '../../../../src/code/tree';
import { startGuide } from '../../../../src/repositories/paths';
import { registryClient } from '../../../../src/repositories/registry-client';
import { hasGrownEngine } from '../../../../src/repo-pages/engine-reads';
import { codePage } from '../../../../src/server/code-page';
import type { RepositoryParams } from '../../../../src/server/repository-page';
import { requestSession, startConfig } from '../../../../src/server/repository-page';
import type { RepositoryTab } from '../../../../src/server/repository-tab';
import { repositoryTab } from '../../../../src/server/repository-tab';

type PageProps = {
  readonly params: RepositoryParams;
  readonly searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

/**
 * A repository: until its first bean, the start page (how a person or an agent begins);
 * after that the Code tab on the stalk. Links of the Ask view (`?q=`, `?bean=`) open Ask.
 */
export default async function RepositoryPage({ params, searchParams }: PageProps) {
  const [tab, query] = await Promise.all([repositoryTab(params), searchParams]);
  if (isAskQuery(query)) {
    const ask = await AskTab({ page: tab, searchParams: query });
    if (ask !== null) return ask;
  }
  const grown = tab.reads !== null && (await hasGrownEngine(tab.reads));
  if (!grown) return <StartPage tab={tab} />;
  const ref = readRef(query['ref']);
  const data = await codePage(tab, { ref, path: '', view: 'tree' });
  return (
    <CodeTab
      tab={tab}
      data={data}
      browsing={ref}
      path=""
      view="tree"
      plain={false}
      nowMs={Date.now()}
    />
  );
}

async function StartPage({ tab }: { readonly tab: RepositoryTab }) {
  const { record, base } = tab;
  const [files, config, session] = await Promise.all([
    registryClient(env.GATEWAY).files(record.id, tab.user?.id ?? null),
    startConfig(),
    tab.role === 'owner' || tab.role === 'maintain' ? requestSession() : Promise.resolve(null),
  ]);
  return (
    <main>
      <StartHere
        record={record}
        files={files.ok ? files.value : null}
        guide={startGuide(config, record.owner.handle, record.name)}
        deploy={
          session === null ? null : { repoId: record.id, csrf: session.csrfToken, path: base }
        }
      />
    </main>
  );
}
