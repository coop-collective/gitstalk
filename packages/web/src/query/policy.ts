/**
 * How long each kind of client data stays fresh, how long it is kept, and whether it may be
 * persisted (docs/claude-opus/35-caching.md §4.2). Queries take their timing from here rather
 * than repeating numbers:
 *
 * ```ts
 * useQuery({ queryKey: keys.bean(name), queryFn, ...freshness('immutable', { visibility }) });
 * ```
 *
 * - `immutable`: content addressed by a sha (a tree, a folder, the diff of a landed bean, a
 *   finished run). Never stale; an event can still invalidate it.
 * - `immutableBlob`: a file's contents at a sha (the Code tab's file reads). Never stale, like
 *   `immutable`, but kept in memory only and for the default time: one file can be most of the
 *   few MB of sessionStorage that every persisted query shares, and a write over the quota
 *   drops the whole persisted cache.
 * - `appendOnly`: the engine's event log. Never stale while its live feed is open (the feed
 *   appends to it), 15 s otherwise. Kept in memory only: the feed changes it every second
 *   while live, a persisted copy would be re-serialised whole each time, and every page that
 *   shows it hydrates a fresher server copy anyway.
 * - `mutable`: repository state that moves (heads, the pushed list, an open bean's diff).
 * - `perViewer`: the viewer's own data (sessions, settings). Never persisted.
 *
 * A repository's immutable data is persisted, public or private (sessionStorage only, never
 * localStorage: this tab, this build and this viewer, dropped at sign-out and on a change of
 * viewer). A private repository's copy is shown only inside a page the server rendered after
 * its access check, so a revoked viewer gets the 404 page, not the copy. Nothing per-viewer
 * (sessions, settings, tokens, CSRF, secret values), no event log and no moving state is ever
 * persisted.
 */
import type { QueryMeta } from '@tanstack/react-query';

import { DEFAULT_GC_TIME_MS, DEFAULT_STALE_TIME_MS } from './make-query-client';
import { PERSIST_MAX_AGE_MS } from './persistence';
import { OFFLINE_STALE_TIME_MS } from './use-live-feed';

export type FreshnessClass = 'immutable' | 'immutableBlob' | 'appendOnly' | 'mutable' | 'perViewer';

/** A repository's visibility, as its record names it. */
export type Visibility = 'public' | 'private' | 'internal';

export type FreshnessInput = {
  /** The repository's visibility. Absent: not a repository's data, so not persisted. */
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
    case 'immutableBlob':
      return { staleTime: Number.POSITIVE_INFINITY, gcTime: DEFAULT_GC_TIME_MS, meta: {} };
    case 'appendOnly':
      return {
        staleTime: input.live === true ? Number.POSITIVE_INFINITY : OFFLINE_STALE_TIME_MS,
        gcTime: DEFAULT_GC_TIME_MS,
        meta: {},
      };
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
 * persisted for a repository of any visibility (sessionStorage, this tab and viewer only).
 */
function kept(staleTime: number, visibility: Visibility | undefined): Freshness {
  return {
    staleTime,
    gcTime: PERSIST_MAX_AGE_MS,
    meta: { persist: visibility !== undefined },
  };
}

function assertNever(value: never): never {
  throw new Error(`unknown freshness class ${JSON.stringify(value)}`);
}
