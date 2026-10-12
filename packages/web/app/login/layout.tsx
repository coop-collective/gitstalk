import type { ReactNode } from 'react';

import { publicPageMetadata } from '../../src/site/page-metadata';

/**
 * Sign-in's description, canonical link and link-preview tags (the page sets only its title).
 * It is crawlable but left out of the sitemap (src/site/pages.ts says why).
 */
export const metadata = publicPageMetadata({
  path: '/login',
  title: 'Sign in',
  description:
    'Sign in to Gitstalk with a passkey or a code sent to your email to see your repositories, the agents working on them and the decisions waiting for you.',
});

export default function LoginLayout({ children }: { readonly children: ReactNode }) {
  return children;
}
