/**
 * Hits and misses of the read index (`object-cache.ts`): git objects by kind, and the ref
 * memo apart from them, since a ref memo hit saves a `log` call rather than an object read.
 * Counted in memory and stored with the RunDO's infra meter, never with a write of its own.
 *
 * Reads are counted by purpose. A `demand` read is one someone asked for (an engine job, the
 * approval gate, the explorer, a server-side commit). A `prefetch` read is the warm-up after
 * a landing, which walks the new line to fill the index; its misses are objects fetched ahead
 * of any reader, and they can never be hits of their own (the warm-up reads each new object
 * once, by design), so they are kept out of the hit rates. Reads that bypass the cache (a
 * `log` page, a ref given as a commit id) are not counted: they are neither hits nor misses.
 */
import type { CacheCountView, CacheKindsView, CacheView } from '@gitstalk/shared-race/rpc';

import { roundTo } from '../engine/numbers';

export type CachedKind = 'commit' | 'tree' | 'blob' | 'ref';

/** Who a read is for: a reader that asked (`demand`), or the warm-up after a landing. */
export type ReadPurpose = 'demand' | 'prefetch';

/** One read through the cache: answered locally (`hit`) or from Artifacts (`miss`). */
export type CacheRead = {
  readonly kind: CachedKind;
  readonly outcome: 'hit' | 'miss';
  /** Absent: `demand`. */
  readonly purpose?: ReadPurpose;
};

export type CacheCount = { readonly hits: number; readonly misses: number };

type KindCounts = Readonly<Record<CachedKind, CacheCount>>;

/** Demand reads by kind at the top level (as before purposes existed); the warm-up's apart. */
export type CacheStats = KindCounts & { readonly prefetch: KindCounts };

const NONE: CacheCount = { hits: 0, misses: 0 };

function emptyKinds(): KindCounts {
  return { commit: NONE, tree: NONE, blob: NONE, ref: NONE };
}

export function emptyCacheStats(): CacheStats {
  return { ...emptyKinds(), prefetch: emptyKinds() };
}

/** Counts stored before purposes existed: every read was counted as demand. */
export function restoredCacheStats(stored: Partial<CacheStats> | undefined): CacheStats {
  const empty = emptyCacheStats();
  return {
    ...empty,
    ...stored,
    prefetch: { ...empty.prefetch, ...stored?.prefetch },
  };
}

export function countCacheRead(stats: CacheStats, read: CacheRead): CacheStats {
  if (read.purpose === 'prefetch') return { ...stats, prefetch: countIn(stats.prefetch, read) };
  return { ...stats, ...countIn(stats, read) };
}

/** The demand counts with their hit rates (four decimals), and the warm-up's apart. */
export function cacheReport(stats: CacheStats): CacheView {
  return { ...kindsReport(stats), prefetch: kindsReport(stats.prefetch) };
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
