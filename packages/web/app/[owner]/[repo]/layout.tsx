import type { ReactNode } from 'react';

import { viewerProfile } from '../../../src/server/header-data';
import type { RepositoryParams } from '../../../src/server/repository-page';
import { repositoryPage } from '../../../src/server/repository-page';

/**
 * The access check of every repository page, above its `loading.tsx`: vinext runs layouts
 * above the first loading boundary before it streams anything, so a repository the viewer may
 * not read (or that does not exist) answers 404, and an old address a real redirect, instead of
 * a 200 skeleton followed by a not-found page. The page reads the same answer (memoised per
 * request); a client navigation still shows the skeleton while the tab loads.
 */
export default async function RepositoryLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: RepositoryParams;
}) {
  // The header's profile is read beside the check, not after it (see `viewerProfile`).
  await Promise.all([repositoryPage(params), viewerProfile()]);
  return children;
}
