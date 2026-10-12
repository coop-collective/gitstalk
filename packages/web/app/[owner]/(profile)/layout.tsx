import type { ReactNode } from 'react';

import type { OwnerParams } from '../../../src/server/owner-page';
import { pageOwner } from '../../../src/server/owner-page';

/**
 * A person's or org's page resolves its owner above its `loading.tsx`, so an unknown handle
 * answers 404 and a retired one a real redirect before anything streams. The `(profile)` group
 * keeps the profile skeleton off the repository routes beside it (`[repo]`), whose own layout
 * must also run before streaming: a loading boundary here would enclose it.
 */
export default async function ProfileLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: OwnerParams;
}) {
  await pageOwner(params);
  return children;
}
