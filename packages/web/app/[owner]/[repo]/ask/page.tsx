import { AskView } from '../../../../components/repo-tabs/ask-tab';
import type { SearchParams } from '../../../../components/home/repository-home';
import { askPage } from '../../../../src/server/ask-page';
import type { RepositoryParams } from '../../../../src/server/repository-page';

type PageProps = {
  readonly params: RepositoryParams;
  readonly searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `Ask, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

/**
 * Ask: the generated explorer over the engine. Before anything grew, the layout above has
 * already redirected to the start page; this reads the same answer.
 */
export default async function AskPage({ params, searchParams }: PageProps) {
  const [page, query] = await Promise.all([askPage(params), searchParams]);
  return <AskView page={page} ask={page.ask} searchParams={query} />;
}
