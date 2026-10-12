import { CodeTab } from '../../../../../../components/repo-tabs/code-tab';
import type { SearchParams } from '../../../../../../components/home/repository-home';
import { pathOf, readRef } from '../../../../../../src/code/tree';
import { codePage } from '../../../../../../src/server/code-page';
import { repositoryTab } from '../../../../../../src/server/repository-tab';

type PageProps = {
  readonly params: Promise<{
    readonly owner: string;
    readonly repo: string;
    readonly path?: readonly string[];
  }>;
  readonly searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo, path } = await params;
  const where = pathOf(path);
  return {
    title: `${where === '' ? '' : `${where}, `}${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`,
  };
}

/** A folder of the repository at the stalk, the sprout or a bean (`?ref=`). */
export default async function TreePage({ params, searchParams }: PageProps) {
  const [resolved, query] = await Promise.all([params, searchParams]);
  const tab = await repositoryTab(Promise.resolve(resolved));
  const ref = readRef(query['ref']);
  const path = pathOf(resolved.path);
  const data = await codePage(tab, { ref, path, view: 'tree' });
  return (
    <CodeTab
      tab={tab}
      data={data}
      browsing={ref}
      path={path}
      view="tree"
      plain={false}
      nowMs={Date.now()}
    />
  );
}
