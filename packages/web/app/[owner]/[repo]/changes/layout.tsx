import type { ReactNode } from 'react';

import type { RepositoryParams } from '../../../../src/server/repository-page';
import { engineTab } from '../../../../src/server/repository-tab';

/**
 * Changes and a bean's page need the repository's engine; without one they redirect home.
 * That is decided here, before anything streams (see `engineTab`). The list's skeleton sits in
 * `(list)/` so a bean's page, which answers its own 404 for an unknown bean, is under none.
 */
export default async function ChangesLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: RepositoryParams;
}) {
  await engineTab(params);
  return children;
}
