/**
 * What the browser keeps of the query cache between page loads: opt-in queries only, in
 * sessionStorage (one tab, gone when it closes), for one build and one viewer.
 *
 * A query opts in with `meta: { persist: true }`; only successful data is written. The
 * buster ties a stored cache to the build and the viewer, so a deploy or another person
 * signing in on the same tab never restores someone else's or an older shape of data.
 */
import type { Query } from '@tanstack/react-query';
import type { Persister } from '@tanstack/react-query-persist-client';

declare module '@tanstack/react-query' {
  interface Register {
    /** `persist: true` opts a query into sessionStorage persistence. */
    queryMeta: { readonly persist?: boolean; readonly [key: string]: unknown };
  }
}

/** The sessionStorage key holding the persisted cache. */
export const PERSIST_STORAGE_KEY = 'gitstalk-query';
/**
 * A persisted cache older than this is discarded on restore. Persisted queries keep a `gcTime`
 * at least this long (`freshness` in policy.ts), or a restored query is collected at once.
 */
export const PERSIST_MAX_AGE_MS = 60 * 60_000;

/** The build this bundle came from (next.config.ts `env`), or `'dev'` outside a build. */
export const BUILD_ID: string = process.env.GITSTALK_BUILD_ID ?? 'dev';

/** Whether a query is written to storage: it opted in and holds successful data. */
export function shouldPersistQuery(query: Pick<Query, 'meta' | 'state'>): boolean {
  return query.meta?.persist === true && query.state.status === 'success';
}

/** The persister's buster: a stored cache from another build or viewer is thrown away. */
export function persistBuster(buildId: string, viewer: string): string {
  return `${buildId}:${viewer}`;
}

/**
 * `persister` writing only while the cache's buster is still `currentBuster()`. The provider
 * subscribes once per page load with the buster of that moment; after the viewer changes in
 * place, its writes would carry the previous viewer's buster, so they are dropped until the
 * next load subscribes with the new one.
 */
export function gateByBuster(persister: Persister, currentBuster: () => string): Persister {
  return {
    persistClient: async (client) => {
      if (client.buster === currentBuster()) await persister.persistClient(client);
    },
    restoreClient: () => persister.restoreClient(),
    removeClient: () => persister.removeClient(),
  };
}

/** The part of `Storage` the persister uses. */
export type PersistStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * This tab's sessionStorage, or undefined where there is none or it refuses access (server
 * render, private mode, storage disabled). The persister treats undefined as "persist nothing".
 */
export function sessionStorageOrUndefined(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.sessionStorage;
  } catch {
    // Reading the property itself throws when storage is blocked: run without persistence.
    return undefined;
  }
}

/**
 * `storage` with every call guarded: a read that throws reads as empty, a write or removal
 * that throws (quota, storage revoked mid-session) is dropped, as persistence is best effort.
 */
export function guardedStorage(storage: PersistStorage): PersistStorage {
  return {
    getItem: (key) => {
      try {
        return storage.getItem(key);
      } catch {
        // Unreadable storage restores nothing.
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        storage.setItem(key, value);
      } catch {
        // Full or revoked storage: the cache stays in memory only.
      }
    },
    removeItem: (key) => forgetItem(storage, key),
  };
}

/** Removes the persisted cache; storage errors are ignored (there is then nothing to remove). */
export function forgetPersistedCache(storage: PersistStorage | undefined): void {
  if (storage !== undefined) forgetItem(storage, PERSIST_STORAGE_KEY);
}

function forgetItem(storage: PersistStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Blocked storage holds no cache of ours.
  }
}
