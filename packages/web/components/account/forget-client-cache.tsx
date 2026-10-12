'use client';

/**
 * Rendered where a browser lands signed out (signing out, a deleted account): drops the
 * TanStack Query persister's copy of the last person's data from sessionStorage, so the next
 * account on this tab never starts from it. Renders nothing.
 */
import { useEffect } from 'react';

/** The sessionStorage key the query persister writes. */
export const QUERY_CACHE_KEY = 'gitstalk-query';

export function ForgetClientCache() {
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(QUERY_CACHE_KEY);
    } catch {
      // Storage blocked (private mode, policy): there is nothing persisted to forget.
    }
  }, []);
  return null;
}
