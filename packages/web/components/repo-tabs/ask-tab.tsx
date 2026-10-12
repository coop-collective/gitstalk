/**
 * The Ask tab: the generated explorer over the repository's engine (the stalk, Growing now,
 * What happened, and answers to questions), the same home a race's repository has. Its links
 * carry `?q=` and `?bean=` on the repository's root, which also opens here.
 */
import type { SearchParams } from '../home/repository-home';
import { RepositoryHome } from '../home/repository-home';
import type { AskData } from '../../src/server/ask-page';
import { askData } from '../../src/server/ask-page';
import type { RepositoryPage } from '../../src/server/repository-page';

/** Query keys that belong to the Ask view rather than the Code tab. */
const ASK_KEYS = ['q', 'bean', 't', 'removed'] as const;

export function isAskQuery(query: SearchParams): boolean {
  return ASK_KEYS.some((key) => query[key] !== undefined);
}

/** The Ask view, or null when the engine has nothing to show yet (the caller shows the start). */
export async function AskTab(props: {
  readonly page: RepositoryPage;
  readonly searchParams: SearchParams;
}) {
  const ask = await askData(props.page.record);
  if (ask === null) return null;
  return <AskView page={props.page} ask={ask} searchParams={props.searchParams} />;
}

/** The Ask view over an engine that has grown something (`askData`). */
export function AskView(props: {
  readonly page: RepositoryPage;
  readonly ask: AskData;
  readonly searchParams: SearchParams;
}) {
  const { record, base } = props.page;
  const { run, source, data } = props.ask;
  return (
    <RepositoryHome
      frame={{
        run,
        base,
        repository: { owner: record.owner.handle, name: record.name },
        kind: 'repository',
        visibility: record.visibility,
        ownerHref: `/${record.owner.handle}`,
      }}
      data={data}
      source={source}
      searchParams={props.searchParams}
    />
  );
}
