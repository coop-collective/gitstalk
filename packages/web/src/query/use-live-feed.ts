'use client';

/**
 * Keeps a query's event list current from a Server-Sent Events feed. The query (its own
 * `queryFn`, or data the server dehydrated) supplies the snapshot; once it has data, the hook
 * opens the feed at `?after=<last seq>` and appends each batch with `appendBySeq`.
 *
 * While the feed is live the list needs no refetching, so the hook's `staleTime` is
 * `Infinity`; when it drops (or before it opens) `staleTime` is 15 s and the query's usual
 * refetch on focus takes over. A batch that skips seqs, and every reconnect, invalidate the
 * query so the snapshot is read again.
 *
 * ```tsx
 * const key = qk.repo(uid, owner, repo).events();
 * const feed = useLiveFeed({ queryKey: key, url: `/api/repos/${owner}/${repo}/live`, parseBatch });
 * const events = useQuery({ queryKey: key, queryFn: readEvents, staleTime: feed.staleTime });
 * ```
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { Sequenced } from './append-by-seq';
import { appendBySeq, lastSeq } from './append-by-seq';

/** Where the feed stands. `ended` means the server closed it for good (the run finished). */
export type LiveFeedStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'ended';

/** How long the list counts as fresh while the feed is not live. */
export const OFFLINE_STALE_TIME_MS = 15_000;

export type LiveFeedOptions<T extends Sequenced> = {
  /** The query whose data (`readonly T[]`, sorted by seq) the feed appends to. */
  readonly queryKey: QueryKey;
  /** The SSE endpoint, a same-origin path; `?after=<seq>` is added. */
  readonly url: string;
  /** The events in one message's `data` (already JSON-parsed), or null when it is not a batch. */
  readonly parseBatch: (data: unknown) => readonly T[] | null;
  /** The SSE event name carrying batches (default `events`). */
  readonly eventName?: string;
  /** False keeps the feed closed (default true). */
  readonly enabled?: boolean;
};

export type LiveFeed = {
  readonly status: LiveFeedStatus;
  /** Pass to the query's `staleTime`: `Infinity` while live, 15 s otherwise. */
  readonly staleTime: number;
};

export function useLiveFeed<T extends Sequenced>(options: LiveFeedOptions<T>): LiveFeed {
  const queryClient = useQueryClient();
  const { queryKey, url, parseBatch, eventName = 'events', enabled = true } = options;
  const [status, setStatus] = useState<LiveFeedStatus>('idle');
  // Subscribe to "has data" only, so the feed opens once the snapshot is there and is not
  // reopened on every batch.
  const { data: hasSnapshot = false } = useQuery<readonly T[], Error, boolean>({
    queryKey,
    enabled: false,
    select: () => true,
  });
  const keyHash = JSON.stringify(queryKey);

  useEffect(() => {
    if (!enabled || !hasSnapshot) return undefined;
    const held = queryClient.getQueryData<readonly T[]>(queryKey) ?? [];
    const source = new EventSource(withAfter(url, lastSeq(held)));
    setStatus('connecting');
    const onBatch = (message: MessageEvent<string>) => {
      const batch = parseBatch(parseData(message.data));
      if (batch !== null) applyBatch(queryClient, queryKey, batch);
    };
    let dropped = false;
    source.addEventListener('open', () => {
      setStatus('live');
      // Events may have been missed while disconnected: read the snapshot again.
      if (dropped) void queryClient.invalidateQueries({ queryKey, exact: true });
    });
    source.addEventListener('error', () => {
      dropped = true;
      setStatus(source.readyState === EventSource.CLOSED ? 'ended' : 'reconnecting');
    });
    source.addEventListener(eventName, onBatch);
    source.addEventListener('end', () => {
      source.close();
      setStatus('ended');
    });
    return () => {
      source.close();
      setStatus('idle');
    };
    // keyHash stands for queryKey (a new array on every render); parseBatch should be stable
    // (module-level or memoised), or the feed reopens on every render.
  }, [queryClient, keyHash, url, eventName, enabled, hasSnapshot, parseBatch]);

  return {
    status,
    staleTime: status === 'live' ? Number.POSITIVE_INFINITY : OFFLINE_STALE_TIME_MS,
  };
}

/** Appends one batch to the cached list; a gap invalidates the query to fill it. */
function applyBatch(
  queryClient: QueryClient,
  queryKey: QueryKey,
  batch: readonly Sequenced[],
): void {
  let opened = false;
  queryClient.setQueryData<readonly Sequenced[]>(queryKey, (held) => {
    // No snapshot yet: leave the query to fetch one rather than seed it with a fragment.
    if (held === undefined) return undefined;
    const outcome = appendBySeq(held, batch);
    opened = outcome.kind === 'gap';
    return outcome.events;
  });
  if (opened) void queryClient.invalidateQueries({ queryKey, exact: true });
}

function withAfter(url: string, after: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}after=${after}`;
}

function parseData(data: string): unknown {
  try {
    const value: unknown = JSON.parse(data);
    return value;
  } catch {
    // A message that is not JSON carries no batch; parseBatch(null) says so.
    return null;
  }
}
