import type { ReactNode } from 'react';

import type { RepositoryParams } from '../../../../src/server/repository-page';
import { repositoryLayoutAnswers } from '../../../../src/server/repository-page';
import { engineTab } from '../../../../src/server/repository-tab';

/**
 * History needs the repository's engine; without one it redirects home. That is decided here,
 * above the tab's `loading.tsx`, so the redirect is the response itself (see `engineTab`).
 */
export default async function HistoryLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: RepositoryParams;
}) {
  // A missing or unreadable repository is the repository layout's 404 (see the helper).
  if (await repositoryLayoutAnswers(params)) return null;
  await engineTab(params);
  return children;
}
