import { describe, expect, it } from 'vitest';

import { DEFAULT_GC_TIME_MS, DEFAULT_STALE_TIME_MS } from './make-query-client';
import { PERSIST_MAX_AGE_MS } from './persistence';
import type { FreshnessClass, Visibility } from './policy';
import { freshness } from './policy';
import { OFFLINE_STALE_TIME_MS } from './use-live-feed';

const NEVER = Number.POSITIVE_INFINITY;

describe('the freshness policy', () => {
  it('never lets content addressed by a sha go stale', () => {
    expect(freshness('immutable').staleTime).toBe(NEVER);
  });

  it('keeps the event log fresh only while its feed is live', () => {
    expect(freshness('appendOnly', { live: true }).staleTime).toBe(NEVER);
    expect(freshness('appendOnly', { live: false }).staleTime).toBe(OFFLINE_STALE_TIME_MS);
    expect(freshness('appendOnly').staleTime).toBe(OFFLINE_STALE_TIME_MS);
  });

  it.each(['mutable', 'perViewer'] as const)('gives %s data the app defaults', (kind) => {
    expect(freshness(kind, { visibility: 'public' })).toEqual({
      staleTime: DEFAULT_STALE_TIME_MS,
      gcTime: DEFAULT_GC_TIME_MS,
      meta: {},
    });
  });

  it('persists immutable data of a public repository only', () => {
    const persisted = (visibility?: Visibility) =>
      freshness('immutable', visibility === undefined ? {} : { visibility }).meta['persist'];
    expect(persisted('public')).toBe(true);
    expect(persisted('private')).toBe(false);
    expect(persisted('internal')).toBe(false);
    expect(persisted()).toBe(false);
  });

  it('never persists the event log, repository state that moves, or the viewer’s own data', () => {
    const kinds: readonly FreshnessClass[] = ['appendOnly', 'mutable', 'perViewer'];
    for (const kind of kinds)
      expect(freshness(kind, { visibility: 'public' }).meta['persist']).toBeUndefined();
  });

  it('keeps a persisted query in memory at least as long as its stored copy lives', () => {
    expect(freshness('immutable', { visibility: 'public' }).gcTime).toBeGreaterThanOrEqual(
      PERSIST_MAX_AGE_MS,
    );
  });
});
