/**
 * Hits and misses of the read index (`object-cache.ts`): git objects by kind, and the ref
 * memo apart from them, since a ref memo hit saves a `log` call rather than an object read.
 * Counted in memory and stored with the RunDO's infra meter, never with a write of its own.
 *
 * Reads are counted by purpose. A `demand` read is one someone asked for (an engine job, the
 * approval gate, the explorer, a server-side commit). A `prefetch` read is the warm-up after
 * a landing, which walks the new line to fill the index; its misses are objects fetched ahead
 * of any reader, and they can never be hits of their own (the warm-up reads each new object
 * once, by design), so they are kept out of the hit rates. A `derived` read is the derived-data
 * `RepoDerivedDO` reading objects through the engine (`object-reads.ts`); it is kept apart too,
 * so the engine's own hit rates stay its own. Reads that bypass the cache (a `log` page, a ref
 * given as a commit id) are not counted: they are neither hits nor misses.
 */
import type { CacheCountView, CacheKindsView, CacheView } from '@gitstalk/shared-race/rpc';

import { assertNever } from '../engine/errors';
import { roundTo } from '../engine/numbers';

export type CachedKind = 'commit' | 'tree' | 'blob' | 'ref';

/**
 * Who a read is for: a reader of the engine that asked (`demand`), the warm-up after a landing
 * (`prefetch`), or derivation reading through the engine (`derived`).
 */
export type ReadPurpose = 'demand' | 'prefetch' | 'derived';

/** One read through the cache: answered locally (`hit`) or from Artifacts (`miss`). */
export type CacheRead = {
  readonly kind: CachedKind;
  readonly outcome: 'hit' | 'miss';
  /** Absent: `demand`. */
  readonly purpose?: ReadPurpose;
};

export type CacheCount = { readonly hits: number; readonly misses: number };

type KindCounts = Readonly<Record<CachedKind, CacheCount>>;

/**
 * Demand reads by kind at the top level (as before purposes existed); the warm-up's and
 * derivation's apart.
 */
export type CacheStats = KindCounts & {
  readonly prefetch: KindCounts;
  readonly derived: KindCounts;
};

const NONE: CacheCount = { hits: 0, misses: 0 };

function emptyKinds(): KindCounts {
  return { commit: NONE, tree: NONE, blob: NONE, ref: NONE };
}

export function emptyCacheStats(): CacheStats {
  return { ...emptyKinds(), prefetch: emptyKinds(), derived: emptyKinds() };
}

/**
 * Counts stored before purposes existed (every read was counted as demand), or before
 * derivation read through the engine (its counts start from zero).
 */
export function restoredCacheStats(stored: Partial<CacheStats> | undefined): CacheStats {
  const empty = emptyCacheStats();
  return {
    ...empty,
    ...stored,
    prefetch: { ...empty.prefetch, ...stored?.prefetch },
    derived: { ...empty.derived, ...stored?.derived },
  };
}

export function countCacheRead(stats: CacheStats, read: CacheRead): CacheStats {
  switch (read.purpose) {
    case 'prefetch':
      return { ...stats, prefetch: countIn(stats.prefetch, read) };
    case 'derived':
      return { ...stats, derived: countIn(stats.derived, read) };
    case 'demand':
    case undefined:
      return { ...stats, ...countIn(stats, read) };
    default:
      return assertNever(read.purpose);
  }
}

/** The demand counts with their hit rates (four decimals); the warm-up's and derivation's apart. */
export function cacheReport(stats: CacheStats): CacheView {
  return {
    ...kindsReport(stats),
    prefetch: kindsReport(stats.prefetch),
    derived: kindsReport(stats.derived),
  };
}

function countIn(kinds: KindCounts, read: CacheRead): KindCounts {
  const count = kinds[read.kind];
  const next =
    read.outcome === 'hit'
      ? { hits: count.hits + 1, misses: count.misses }
      : { hits: count.hits, misses: count.misses + 1 };
  return { ...kinds, [read.kind]: next };
}

function kindsReport(kinds: KindCounts): CacheKindsView {
  const objects = {
    hits: kinds.commit.hits + kinds.tree.hits + kinds.blob.hits,
    misses: kinds.commit.misses + kinds.tree.misses + kinds.blob.misses,
  };
  return {
    objects: countReport(objects),
    commit: countReport(kinds.commit),
    tree: countReport(kinds.tree),
    blob: countReport(kinds.blob),
    ref_memo: countReport(kinds.ref),
  };
}

function countReport(count: CacheCount): CacheCountView {
  const reads = count.hits + count.misses;
  return {
    hits: count.hits,
    misses: count.misses,
    hit_rate: reads === 0 ? null : roundTo(count.hits / reads, 4),
  };
}
