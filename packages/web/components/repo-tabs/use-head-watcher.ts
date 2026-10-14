'use client';

/**
 * Keeps a server-rendered tab (Code on a line, History) current without polling: it follows
 * the engine's feed from the seq the page was rendered at and, when a line it shows moves past
 * the commit it rendered (a landing, a promotion, a revert, a reset), renders the page again
 * with `router.refresh()` inside a transition, so the old page stays on screen until the new
 * one arrives (no skeleton). History also refreshes, at most every 2 s, for validation
 * activity that moves no head (`staleKeysFor`, src/query/invalidation.ts).
 *
 * It holds only the events after the rendered seq (`qk.repo(...).tail(seq)`), read through the
 * same feed and JSON route as the Changes tab, so the page never ships the whole event log.
 * Every event in the tail is newer than the page, so the whole tail is checked on every change:
 * a page restored from the router cache (with an older seq) refreshes at once if its heads
 * moved meanwhile. A refresh renders a newer seq, which starts a new tail, so it cannot loop.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { startTransition, useEffect, useMemo } from 'react';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RepoScope } from '../../src/changes/change-feed';
import { changeFeedPaths, isEventsAnswer, parseEventBatch } from '../../src/changes/change-feed';
import { fetchJson } from '../../src/query/fetch-json';
import type { LineHeads, Refresh } from '../../src/query/invalidation';
import { staleKeysFor } from '../../src/query/invalidation';
import { qk } from '../../src/query/keys';
import { freshness } from '../../src/query/policy';
import { useLiveFeed } from '../../src/query/use-live-feed';

/** History's refresh for activity that moves no head waits this long, to batch a burst. */
export const ACTIVITY_REFRESH_MS = 2000;

export type HeadWatch = {
  readonly scope: RepoScope;
  /** The commit each line was at when the page rendered; null for a line it does not show. */
  readonly heads: LineHeads;
  /** The newest event the page was rendered with. */
  readonly seq: number;
  /** Whether validation activity also refreshes the page (History). */
  readonly activity?: boolean;
};

/** Mounts the watcher from a server component; renders nothing. */
export function HeadWatcher(props: HeadWatch): null {
  useHeadWatcher(props);
  return null;
}

export function useHeadWatcher(watch: HeadWatch): void {
  const { scope, seq, heads } = watch;
  const keys = qk.repo(scope.uid, scope.owner, scope.repo);
  const paths = changeFeedPaths(scope.base);
  const tailKey = keys.tail(seq);
  const feed = useLiveFeed<RaceEvent>({
    queryKey: tailKey,
    url: paths.live,
    parseBatch: parseEventBatch,
    after: seq,
  });
  const tail = useQuery({
    queryKey: tailKey,
    queryFn: async ({ signal }) =>
      (
        await fetchJson(`${paths.events}?after=${seq}`, isEventsAnswer, {
          signal,
          httpCache: 'revalidate',
        })
      ).events,
    // Nothing has happened since the render until the feed says so.
    initialData: [],
    ...freshness('appendOnly', { live: feed.status === 'live' }),
  });
  const activity = watch.activity === true;
  const refresh = useMemo(
    () =>
      staleKeysFor(tail.data, keys, {
        heads: { stalk: heads.stalk, sprout: heads.sprout },
        activity,
      }).refresh,
    // keys is a new object each render; the repository's parts stand for it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above
    [tail.data, heads.stalk, heads.sprout, activity, scope.uid, scope.owner, scope.repo],
  );
  useRefresh(refresh);
}

/** Renders the page again when asked: at once, or after `ACTIVITY_REFRESH_MS`. */
function useRefresh(refresh: Refresh): void {
  const router = useRouter();
  useEffect(() => {
    if (refresh === 'none') return undefined;
    const timer = setTimeout(
      () => startTransition(() => router.refresh()),
      refresh === 'now' ? 0 : ACTIVITY_REFRESH_MS,
    );
    return () => clearTimeout(timer);
  }, [refresh, router]);
}
