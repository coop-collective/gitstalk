'use client';

/**
 * A repository's beans, kept live: the events and pushed-beans queries (filled by the server's
 * prefetch, refetched through the JSON routes), the engine's feed appending each new batch to
 * the events, and the follow-ups a batch calls for (`staleKeysFor`: the pushed beans, a bean's
 * diff). Nothing re-renders the page on the server.
 *
 * Freshness follows src/query/policy.ts: the events are append-only (never stale while the
 * feed is live; in memory only), the pushed beans are mutable. While the feed is open a
 * remount does not refetch the events: the feed's own catch-up brings what was missed.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RepoScope } from '../../src/changes/change-feed';
import {
  changeFeedPaths,
  eventsAfter,
  isEventsAnswer,
  isPushedAnswer,
  parseEventBatch,
} from '../../src/changes/change-feed';
import type { PushedBean } from '../../src/changes/pushed-beans';
import { lastSeq } from '../../src/query/append-by-seq';
import { fetchJson } from '../../src/query/fetch-json';
import { staleKeysFor } from '../../src/query/invalidation';
import { qk } from '../../src/query/keys';
import { freshness } from '../../src/query/policy';
import type { LiveFeedStatus } from '../../src/query/use-live-feed';
import { FOLLOWED_BY_FEED, useLiveFeed } from '../../src/query/use-live-feed';

export type ChangesFeed = {
  readonly events: readonly RaceEvent[];
  readonly pushed: readonly PushedBean[];
  readonly status: LiveFeedStatus;
};

export type ChangesFeedOptions = {
  /** False keeps the engine's feed closed (the queries still read). Default true. */
  readonly live?: boolean;
  /** Beans whose diff is on screen: a push or landing of one invalidates its diff. */
  readonly beans?: readonly string[];
};

export function useChangesFeed(scope: RepoScope, options: ChangesFeedOptions = {}): ChangesFeed {
  const keys = qk.repo(scope.uid, scope.owner, scope.repo);
  const paths = changeFeedPaths(scope.base);
  const queryClient = useQueryClient();
  // A gap in the feed may have hidden a move of any bean: read the pushed list again too. (The
  // feed keeps the newest callback in a ref, so a new one each render does not reopen it.)
  const onResync = () => {
    void queryClient.invalidateQueries({ queryKey: keys.pushed(), exact: true });
  };
  const isFollowed = options.live ?? true;
  const feed = useLiveFeed<RaceEvent>({
    queryKey: keys.events(),
    url: paths.live,
    parseBatch: parseEventBatch,
    enabled: isFollowed,
    onResync,
  });
  const events = useQuery({
    queryKey: keys.events(),
    queryFn: async ({ signal }) =>
      (await fetchJson(paths.events, isEventsAnswer, { signal, httpCache: 'revalidate' })).events,
    ...freshness('appendOnly', { live: feed.status === 'live' }),
    ...(isFollowed ? FOLLOWED_BY_FEED : {}),
  });
  const pushed = useQuery({
    queryKey: keys.pushed(),
    queryFn: async ({ signal }) =>
      (await fetchJson(paths.pushed, isPushedAnswer, { signal })).pushed,
    ...freshness('mutable'),
  });
  const { beans } = options;
  useOnNewEvents(events.data, (fresh) => {
    const { invalidate } = staleKeysFor(fresh, keys, beans === undefined ? {} : { beans });
    // invalidateQueries does not reject: a failed refetch lands on the query itself.
    for (const queryKey of invalidate)
      void queryClient.invalidateQueries({ queryKey, exact: true });
  });
  return { events: events.data ?? [], pushed: pushed.data ?? [], status: feed.status };
}

/**
 * Calls `onNew` with the events past the last seq this component has seen, whenever the list
 * grows (a live batch, or a refetched snapshot). The first list seen is the baseline.
 */
export function useOnNewEvents(
  events: readonly RaceEvent[] | undefined,
  onNew: (fresh: readonly RaceEvent[]) => void,
): void {
  const seen = useRef<number | null>(null);
  const latest = useRef(onNew);
  useEffect(() => {
    latest.current = onNew;
  });
  useEffect(() => {
    if (events === undefined) return;
    const previous = seen.current;
    seen.current = Math.max(previous ?? 0, lastSeq(events));
    if (previous === null) return;
    const fresh = eventsAfter(events, previous);
    if (fresh.length > 0) latest.current(fresh);
  }, [events]);
}
