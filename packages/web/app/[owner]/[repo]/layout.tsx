import type { ReactNode } from 'react';

import { RepositoryFrame } from '../../../components/repo-tabs/repository-frame';
import type { RepositoryParams } from '../../../src/server/repository-page';
import { repositoryPage } from '../../../src/server/repository-page';

/**
 * The access check of every repository page, above its `loading.tsx`: vinext runs layouts
 * above the first loading boundary before it streams anything, so a repository the viewer may
 * not read (or that does not exist) answers 404, and an old address a real redirect, instead of
 * a 200 skeleton followed by a not-found page. The page reads the same answer (memoised per
 * request); a client navigation still shows the skeleton while the tab loads.
 *
 * The repository's header and tabs are drawn here, once, so moving between tabs and settings
 * sections keeps them mounted and swaps only the page (`RepositoryFrame`). Keyed by the
 * repository, so another repository's header never carries this one's state.
 */
export default async function RepositoryLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: RepositoryParams;
}) {
  const { record, base, role } = await repositoryPage(params);
  const facts = {
    base,
    owner: record.owner.handle,
    name: record.name,
    visibility: record.visibility,
    archived: record.archived_at !== null,
    role,
  };
  return (
    <RepositoryFrame key={base} facts={facts}>
      {children}
    </RepositoryFrame>
  );
}
