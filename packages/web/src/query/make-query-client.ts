/**
 * The app's QueryClient defaults, shared by the browser (`QueryProvider`, one client per tab)
 * and the server (`getServerQueryClient`, one client per request).
 */
import { QueryClient } from '@tanstack/react-query';

/** Data is fresh for 30 s: navigating back within that window does not refetch. */
export const DEFAULT_STALE_TIME_MS = 30_000;
/** Unused data stays in memory for 10 minutes (and so can be persisted and restored). */
export const DEFAULT_GC_TIME_MS = 10 * 60_000;

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        gcTime: DEFAULT_GC_TIME_MS,
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false,
        retry: 1,
      },
    },
  });
}
