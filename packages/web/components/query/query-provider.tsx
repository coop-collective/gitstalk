'use client';

/**
 * The app's TanStack Query client, around every page (app/layout.tsx). One client per tab;
 * queries that opt in with `meta: { persist: true }` (a repository's immutable data, public or
 * private, src/query/policy.ts) are kept in sessionStorage for an hour, for this build and this
 * viewer only (src/query/persistence.ts). When the viewer changes (sign in, sign out, another
 * account), the cache and the stored copy are dropped; a sign-out form drops them as it posts.
 */
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { logQueryCounts } from '../../src/query/cache-counter';
import { viewerKey } from '../../src/query/keys';
import { makeQueryClient } from '../../src/query/make-query-client';
import {
  BUILD_ID,
  PERSIST_MAX_AGE_MS,
  PERSIST_STORAGE_KEY,
  forgetPersistedCache,
  gateByBuster,
  guardedStorage,
  persistBuster,
  sessionStorageOrUndefined,
  shouldPersistQuery,
} from '../../src/query/persistence';
import { SIGN_OUT_PATH } from '../../src/shell/header-entries';

export function QueryProvider(props: {
  /** The signed-in person's id, or null when signed out. */
  readonly uid: string | null;
  readonly children: ReactNode;
}) {
  const viewer = viewerKey(props.uid);
  const buster = persistBuster(BUILD_ID, viewer);
  const currentBuster = useRef(buster);
  const [queryClient] = useState(makeQueryClient);
  const [persister] = useState(() => gateByBuster(createPersister(), () => currentBuster.current));
  const previousViewer = useRef(viewer);
  useEffect(() => {
    // The buster moves first, so the writes `clear()` triggers (old buster) are dropped.
    currentBuster.current = buster;
    if (previousViewer.current === viewer) return;
    previousViewer.current = viewer;
    queryClient.clear();
    forgetPersistedCache(sessionStorageOrUndefined());
  }, [queryClient, viewer, buster]);
  // Signing out: nothing of this viewer's stays in the tab, not even until the next page load.
  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      if (!isSignOutForm(event.target)) return;
      queryClient.clear();
      forgetPersistedCache(sessionStorageOrUndefined());
    };
    document.addEventListener('submit', onSubmit);
    return () => document.removeEventListener('submit', onSubmit);
  }, [queryClient]);
  // Development only: how often each kind of query is served from the cache or fetched.
  useEffect(
    () =>
      process.env.NODE_ENV === 'production'
        ? undefined
        : logQueryCounts(queryClient.getQueryCache()),
    [queryClient],
  );
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE_MS,
        buster,
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      }}
    >
      {props.children}
    </PersistQueryClientProvider>
  );
}

/** Whether a submitted form posts to sign-out (the header menu's, Settings → Sessions'). */
function isSignOutForm(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLFormElement)) return false;
  return new URL(target.action, window.location.href).pathname === SIGN_OUT_PATH;
}

function createPersister() {
  const storage = sessionStorageOrUndefined();
  return createSyncStoragePersister({
    storage: storage === undefined ? undefined : guardedStorage(storage),
    key: PERSIST_STORAGE_KEY,
  });
}
