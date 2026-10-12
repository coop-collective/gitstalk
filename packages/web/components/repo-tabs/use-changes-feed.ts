'use client';

/**
 * A repository's beans, kept live: the events and pushed-beans queries (filled by the server's
 * prefetch, refetched through the JSON routes), the engine's feed appending each new batch to
 * the events, and the follow-ups a batch calls for (the pushed beans, a bean's diff). Nothing
 * re-renders the page on the server.
 */
import type { QueryKey } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RepoScope } from '../../src/changes/change-feed';
import {
  changeFeedPaths,
  eventsAfter,
  isEventsAnswer,
  isPushedAnswer,
  movesPushedBeans,
  parseEventBatch,
} from '../../src/changes/change-feed';
import type { PushedBean } from '../../src/changes/pushed-beans';
import { lastSeq } from '../../src/query/append-by-seq';
import { fetchJson } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import type { LiveFeedStatus } from '../../src/query/use-live-feed';
import { useLiveFeed } from '../../src/query/use-live-feed';

export type ChangesFeed = {
  readonly events: readonly RaceEvent[];
  readonly pushed: readonly PushedBean[];
  readonly status: LiveFeedStatus;
};

export type ChangesFeedOptions = {
  /** False keeps the engine's feed closed (the queries still read). Default true. */
  readonly live?: boolean;
  /** More queries a batch of new events makes stale, beyond the pushed beans. */
  readonly staleAfter?: (fresh: readonly RaceEvent[]) => readonly QueryKey[];
};

export function useChangesFeed(scope: RepoScope, options: ChangesFeedOptions = {}): ChangesFeed {
  const keys = qk.repo(scope.uid, scope.owner, scope.repo);
  const paths = changeFeedPaths(scope.base);
  const feed = useLiveFeed<RaceEvent>({
    queryKey: keys.events(),
    url: paths.live,
    parseBatch: parseEventBatch,
    enabled: options.live ?? true,
  });
  const events = useQuery({
    queryKey: keys.events(),
    queryFn: async ({ signal }) =>
      (await fetchJson(paths.events, isEventsAnswer, { signal })).events,
    staleTime: feed.staleTime,
  });
  const pushed = useQuery({
    queryKey: keys.pushed(),
    queryFn: async ({ signal }) =>
      (await fetchJson(paths.pushed, isPushedAnswer, { signal })).pushed,
  });
  const queryClient = useQueryClient();
  const { staleAfter } = options;
  useOnNewEvents(events.data, (fresh) => {
    const stale = [
      ...(movesPushedBeans(fresh) ? [keys.pushed()] : []),
      ...(staleAfter?.(fresh) ?? []),
    ];
    // invalidateQueries does not reject: a failed refetch lands on the query itself.
    for (const queryKey of stale) void queryClient.invalidateQueries({ queryKey, exact: true });
  });
  return { events: events.data ?? [], pushed: pushed.data ?? [], status: feed.status };
}

/**
 * Calls `onNew` with the events past the last seq this component has seen, whenever the list
 * grows (a live batch, or a refetched snapshot). The first list seen is the baseline.
 */
function useOnNewEvents(
  events: readonly RaceEvent[] | undefined,
  onNew: (fresh: readonly RaceEvent[]) => void,
): void {
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (events === undefined) return;
    const previous = seen.current;
    seen.current = Math.max(previous ?? 0, lastSeq(events));
    if (previous === null) return;
    const fresh = eventsAfter(events, previous);
    if (fresh.length > 0) onNew(fresh);
  }, [events, onNew]);
}
