import type { ReactNode } from 'react';

import type { RepositoryParams } from '../../../../src/server/repository-page';
import { repositoryLayoutAnswers } from '../../../../src/server/repository-page';
import { settingsAccess } from '../../../../src/server/repository-settings';

/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * A repository's settings answer 404 to anyone without a role on it (signed out included)
 * before anything streams. No loading boundary sits above or below: a section this viewer may
 * not open redirects from its page, and that redirect must be the response's status too.
 */
export default async function RepositorySettingsLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: RepositoryParams;
}) {
  // A missing or unreadable repository is the repository layout's 404 (see the helper).
  if (await repositoryLayoutAnswers(params)) return null;
  await settingsAccess(params);
  return children;
}
