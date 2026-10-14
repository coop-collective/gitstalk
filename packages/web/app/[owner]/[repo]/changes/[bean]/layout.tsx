import type { ReactNode } from 'react';

import type { BeanParams } from '../../../../../src/server/bean-page';
import { beanPage } from '../../../../../src/server/bean-page';
import { repositoryLayoutAnswers } from '../../../../../src/server/repository-page';

/**
 * The bean's check, before anything streams: an unknown bean is a 404 (see `beanPage`). The
 * page reads the same answer and streams the bean's diff under its own Suspense boundary.
 */
export default async function BeanLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: BeanParams;
}) {
  // A missing or unreadable repository is the repository layout's 404 (see the helper).
  if (await repositoryLayoutAnswers(params)) return null;
  await beanPage(params);
  return children;
}
