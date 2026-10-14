'use client';

/**
 * The app's TanStack Query client, around every page (app/layout.tsx). One client per tab;
 * queries that opt in with `meta: { persist: true }` (a public repository's immutable and
 * append-only data, src/query/policy.ts) are kept in sessionStorage for an hour, for this
 * build and this viewer only (src/query/persistence.ts). When the viewer changes (sign in,
 * sign out, another account), the cache and the stored copy are dropped.
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

function createPersister() {
  const storage = sessionStorageOrUndefined();
  return createSyncStoragePersister({
    storage: storage === undefined ? undefined : guardedStorage(storage),
    key: PERSIST_STORAGE_KEY,
  });
}
