/**
 * The freshness policy as the browser lives it: a query (TanStack's `QueryObserver`, which
 * `useQuery` wraps) shows what the cache holds at once and refetches in the background only
 * when the data is stale; immutable data is never refetched; only a public repository's
 * data is written to storage.
 */
import type { QueryKey } from '@tanstack/react-query';
import { QueryObserver, dehydrate, focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { qk } from './keys';
import { makeQueryClient } from './make-query-client';
import { shouldPersistQuery } from './persistence';
import type { FreshnessClass, Visibility } from './policy';
import { freshness } from './policy';

const keys = qk.repo('u1', 'acme', 'web');
const MINUTE = 60_000;

/** A query function that counts its calls and answers `v<n>`, with a way to await a call. */
function countingFetch() {
  let calls = 0;
  let waiting: (() => void) | null = null;
  return {
    calls: () => calls,
    queryFn: async () => {
      calls += 1;
      waiting?.();
      return `v${calls}`;
    },
    nextCall: () =>
      new Promise<void>((resolve) => {
        waiting = resolve;
      }),
  };
}

function observe(
  client: ReturnType<typeof makeQueryClient>,
  queryKey: QueryKey,
  options: { readonly kind: FreshnessClass; readonly visibility?: Visibility },
  queryFn: () => Promise<string>,
) {
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn,
    ...freshness(options.kind, options.visibility === undefined ? {} : options),
  });
  const shown: (string | undefined)[] = [];
  const unsubscribe = observer.subscribe((result) => shown.push(result.data));
  return { observer, shown, unsubscribe };
}

/** A query function answering `value`. */
function answer(value: string): () => Promise<string> {
  return () => Promise.resolve(value);
}

afterEach(() => {
  focusManager.setFocused(undefined);
});

describe('stale while revalidate', () => {
  it('shows cached mutable data at once, then refetches it in the background when stale', async () => {
    const client = makeQueryClient();
    client.setQueryData(keys.pushed(), 'cached', { updatedAt: Date.now() - MINUTE });
    const fetch = countingFetch();
    const refetched = fetch.nextCall();
    const { observer, unsubscribe } = observe(
      client,
      keys.pushed(),
      { kind: 'mutable' },
      fetch.queryFn,
    );
    // The first result is the cached value, already marked stale and being refetched.
    const first = observer.getCurrentResult();
    expect(first.data).toBe('cached');
    expect(first.isStale).toBe(true);
    expect(first.fetchStatus).toBe('fetching');
    await refetched;
    await client.getQueryCache().find({ queryKey: keys.pushed() })?.promise;
    expect(observer.getCurrentResult().data).toBe('v1');
    unsubscribe();
  });

  it('does not refetch fresh mutable data on mount', () => {
    const client = makeQueryClient();
    client.setQueryData(keys.pushed(), 'cached');
    const fetch = countingFetch();
    const { observer, unsubscribe } = observe(
      client,
      keys.pushed(),
      { kind: 'mutable' },
      fetch.queryFn,
    );
    expect(observer.getCurrentResult()).toMatchObject({ data: 'cached', isStale: false });
    expect(fetch.calls()).toBe(0);
    unsubscribe();
  });

  it('never refetches immutable data, however old, on mount or on focus', () => {
    const client = makeQueryClient();
    // A mounted client follows the window's focus, as QueryClientProvider's does.
    client.mount();
    const key = keys.diff('a'.repeat(40), 'b'.repeat(40));
    client.setQueryData(key, 'diff', { updatedAt: Date.now() - 600 * MINUTE });
    const fetch = countingFetch();
    const { observer, unsubscribe } = observe(client, key, { kind: 'immutable' }, fetch.queryFn);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    expect(observer.getCurrentResult()).toMatchObject({ data: 'diff', isStale: false });
    expect(fetch.calls()).toBe(0);
    unsubscribe();
    client.unmount();
  });

  it('refetches stale mutable data when the tab regains focus', async () => {
    const client = makeQueryClient();
    client.mount();
    const fetch = countingFetch();
    client.setQueryData(keys.pushed(), 'cached');
    const { unsubscribe } = observe(client, keys.pushed(), { kind: 'mutable' }, fetch.queryFn);
    client.setQueryData(keys.pushed(), 'cached', { updatedAt: Date.now() - MINUTE });
    const refetched = fetch.nextCall();
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await refetched;
    expect(fetch.calls()).toBe(1);
    unsubscribe();
    client.unmount();
  });

  it('still refetches immutable data an event invalidates', async () => {
    const client = makeQueryClient();
    client.setQueryData(keys.bean('fix'), 'landed once');
    const fetch = countingFetch();
    const { observer, unsubscribe } = observe(
      client,
      keys.bean('fix'),
      { kind: 'immutable' },
      fetch.queryFn,
    );
    await client.invalidateQueries({ queryKey: keys.bean('fix'), exact: true });
    expect(fetch.calls()).toBe(1);
    expect(observer.getCurrentResult().data).toBe('v1');
    unsubscribe();
  });
});

describe('what reaches storage', () => {
  it('persists a public repository’s immutable data, and nothing private or mutable', async () => {
    const client = makeQueryClient();
    const subscriptions = [
      observe(client, ['public-diff'], { kind: 'immutable', visibility: 'public' }, answer('a')),
      observe(client, ['private-diff'], { kind: 'immutable', visibility: 'private' }, answer('b')),
      observe(client, ['public-events'], { kind: 'appendOnly', visibility: 'public' }, answer('c')),
      observe(client, ['public-pushed'], { kind: 'mutable' }, answer('d')),
    ];
    await Promise.all(
      subscriptions.map(({ observer }) => observer.refetch().then(() => undefined)),
    );
    const stored = dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery });
    expect(stored.queries.map((query) => query.queryKey)).toEqual([
      ['public-diff'],
      ['public-events'],
    ]);
    for (const { unsubscribe } of subscriptions) unsubscribe();
  });
});
