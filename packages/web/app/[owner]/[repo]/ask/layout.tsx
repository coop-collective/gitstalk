import type { ReactNode } from 'react';

import { askPage } from '../../../../src/server/ask-page';
import type { RepositoryParams } from '../../../../src/server/repository-page';
import { repositoryLayoutAnswers } from '../../../../src/server/repository-page';

/**
 * Ask redirects to the start page until the engine has grown something. That answer is read
 * here, above the tab's `loading.tsx`, so it is a real redirect before anything streams; the
 * page reuses the read (once per request).
 */
export default async function AskLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: RepositoryParams;
}) {
  // A missing or unreadable repository is the repository layout's 404 (see the helper).
  if (await repositoryLayoutAnswers(params)) return null;
  await askPage(params);
  return children;
}
