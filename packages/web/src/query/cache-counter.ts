/**
 * Development-only measurement of the browser's query cache (docs/claude-opus/35-caching.md
 * §5): per kind of key, how often a query was served from the cache when a component mounted
 * and how often it went to the network. `QueryProvider` subscribes it outside production and
 * logs a line through src/log.ts on every fetch.
 */
import type { QueryCache, QueryCacheNotifyEvent, QueryKey } from '@tanstack/react-query';

import { log } from '../log';

export type QueryCounts = Readonly<
  Record<string, { readonly served: number; readonly fetched: number }>
>;

/** The kind of a key, without the viewer or the repository: `repo/events`, `home/activity`. */
export function keyKind(queryKey: QueryKey): string {
  const [area, , third, , fifth] = queryKey;
  const kind = area === 'repo' ? fifth : third;
  return `${String(area)}/${String(kind)}`;
}

/** Counts served and fetched queries by kind, from the cache's notifications. */
export function createQueryCounter() {
  const counts = new Map<string, { served: number; fetched: number }>();
  const bump = (kind: string, field: 'served' | 'fetched') => {
    const held = counts.get(kind) ?? { served: 0, fetched: 0 };
    const next = { ...held, [field]: held[field] + 1 };
    counts.set(kind, next);
    return next;
  };
  return {
    /** Records one notification; returns the kind's counts when it was a fetch. */
    record(event: QueryCacheNotifyEvent) {
      const kind = keyKind(event.query.queryKey);
      if (event.type === 'observerAdded' && event.query.state.data !== undefined)
        bump(kind, 'served');
      if (event.type === 'updated' && event.action.type === 'fetch')
        return { kind, ...bump(kind, 'fetched') };
      return null;
    },
    counts: (): QueryCounts => Object.fromEntries(counts),
  };
}

/** Subscribes a counter to `cache`, logging each fetch with its kind's totals; returns the unsubscribe. */
export function logQueryCounts(cache: QueryCache): () => void {
  const counter = createQueryCounter();
  return cache.subscribe((event) => {
    const fetched = counter.record(event);
    if (fetched !== null) log.info('query.fetch', fetched);
  });
}
