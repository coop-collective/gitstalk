import type { ReactNode } from 'react';

import { signedInUser } from '../../../src/server/signed-in';

/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * "Your organizations" asks for a signed-in person above its `loading.tsx`, so a signed-out
 * visit is a real redirect to sign in rather than a 200 skeleton that redirects in the browser.
 * The `(list)` group keeps that skeleton off `/orgs/new` and `/orgs/<org>/settings`, which
 * answer their own redirects and 404s.
 */
export default async function YourOrgsLayout({ children }: { readonly children: ReactNode }) {
  await signedInUser('/orgs');
  return children;
}
