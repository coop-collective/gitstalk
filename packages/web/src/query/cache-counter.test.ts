import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { createQueryCounter, keyKind } from './cache-counter';
import { qk } from './keys';
import { makeQueryClient } from './make-query-client';

describe('the development query counter', () => {
  it('names a key by its area and kind, without the viewer or the repository', () => {
    expect(keyKind(qk.repo('u1', 'acme', 'web').events())).toBe('repo/events');
    expect(keyKind(qk.repo(null, 'acme', 'web').bean('fix'))).toBe('repo/bean');
    expect(keyKind(qk.home('u1').activity())).toBe('home/activity');
  });

  it('counts a query served from the cache apart from one that was fetched', async () => {
    const client = makeQueryClient();
    const counter = createQueryCounter();
    const fetches: unknown[] = [];
    client.getQueryCache().subscribe((event) => {
      const fetched = counter.record(event);
      if (fetched !== null) fetches.push(fetched);
    });
    const key = qk.repo('u1', 'acme', 'web').pushed();
    await client.fetchQuery({ queryKey: key, queryFn: () => Promise.resolve('fresh') });
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => Promise.resolve('again'),
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(counter.counts()).toEqual({ 'repo/pushed': { served: 1, fetched: 1 } });
    expect(fetches).toEqual([{ kind: 'repo/pushed', served: 0, fetched: 1 }]);
    unsubscribe();
  });

  it('counts neither watching observers nor stale data that is fetched again as served', async () => {
    const client = makeQueryClient();
    const counter = createQueryCounter();
    client.getQueryCache().subscribe((event) => counter.record(event));
    const key = qk.repo('u1', 'acme', 'web').events();
    await client.fetchQuery({ queryKey: key, queryFn: () => Promise.resolve(['e1']) });
    const watcher = new QueryObserver(client, {
      queryKey: key,
      enabled: false,
      select: () => true,
    });
    const stale = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => Promise.resolve(['e1', 'e2']),
      staleTime: 0,
    });
    const unsubscribes = [watcher, stale].map((observer) => observer.subscribe(() => undefined));
    await client.getQueryCache().find({ queryKey: key })?.promise;
    expect(counter.counts()).toEqual({ 'repo/events': { served: 0, fetched: 2 } });
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
});
