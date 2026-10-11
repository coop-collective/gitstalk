/**
 * The server's QueryClient: one per request (React's `cache` scopes it to the render), so a
 * server component can prefetch and the page can dehydrate what it fetched:
 *
 * ```tsx
 * const queryClient = getServerQueryClient();
 * await queryClient.prefetchQuery({ queryKey: qk.home(uid).activity(), queryFn: readActivity });
 * return <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>;
 * ```
 *
 * Server components only: a client component uses `useQueryClient()`.
 */
import type { QueryClient } from '@tanstack/react-query';
import { cache } from 'react';

import { makeQueryClient } from './make-query-client';

export const getServerQueryClient: () => QueryClient = cache(makeQueryClient);
