/**
 * How long each kind of client data stays fresh, how long it is kept, and whether it may be
 * persisted (docs/claude-opus/35-caching.md §4.2). Queries take their timing from here rather
 * than repeating numbers:
 *
 * ```ts
 * useQuery({ queryKey: keys.bean(name), queryFn, ...freshness('immutable', { visibility }) });
 * ```
 *
 * - `immutable`: content addressed by a sha (a tree, a file, the diff of a landed bean, a
 *   finished run). Never stale; an event can still invalidate it.
 * - `appendOnly`: the engine's event log. Never stale while its live feed is open (the feed
 *   appends to it), 15 s otherwise.
 * - `mutable`: repository state that moves (heads, the pushed list, an open bean's diff).
 * - `perViewer`: the viewer's own data (sessions, settings). Never persisted.
 *
 * Only a public repository's immutable and append-only data is persisted (sessionStorage, this
 * tab, this build and this viewer): a private or internal repository never leaves memory.
 */
import type { QueryMeta } from '@tanstack/react-query';

import { DEFAULT_GC_TIME_MS, DEFAULT_STALE_TIME_MS } from './make-query-client';
import { PERSIST_MAX_AGE_MS } from './persistence';
import { OFFLINE_STALE_TIME_MS } from './use-live-feed';

export type FreshnessClass = 'immutable' | 'appendOnly' | 'mutable' | 'perViewer';

/** A repository's visibility, as its record names it. */
export type Visibility = 'public' | 'private' | 'internal';

export type FreshnessInput = {
  /** The repository's visibility; persistence needs `public`. Absent: not persisted. */
  readonly visibility?: Visibility;
  /** For `appendOnly`: whether its live feed is open now. */
  readonly live?: boolean;
};

/** The query options a class sets: spread them into `useQuery`. */
export type Freshness = {
  readonly staleTime: number;
  readonly gcTime: number;
  readonly meta: QueryMeta;
};

/** The freshness of one class of data, for one repository's visibility. */
export function freshness(kind: FreshnessClass, input: FreshnessInput = {}): Freshness {
  switch (kind) {
    case 'immutable':
      return kept(Number.POSITIVE_INFINITY, input.visibility);
    case 'appendOnly':
      return kept(
        input.live === true ? Number.POSITIVE_INFINITY : OFFLINE_STALE_TIME_MS,
        input.visibility,
      );
    case 'mutable':
    case 'perViewer':
      return { staleTime: DEFAULT_STALE_TIME_MS, gcTime: DEFAULT_GC_TIME_MS, meta: {} };
    default:
      return assertNever(kind);
  }
}

/**
 * Data worth keeping: held for as long as a persisted copy lives (a restored query whose
 * `gcTime` is shorter than the persister's `maxAge` would be collected straight away), and
 * persisted only for a public repository.
 */
function kept(staleTime: number, visibility: Visibility | undefined): Freshness {
  return {
    staleTime,
    gcTime: PERSIST_MAX_AGE_MS,
    meta: { persist: visibility === 'public' },
  };
}

function assertNever(value: never): never {
  throw new Error(`unknown freshness class ${JSON.stringify(value)}`);
}
