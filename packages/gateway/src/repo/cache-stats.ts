/**
 * Hits and misses of the read index (`object-cache.ts`): git objects by kind, and the ref
 * memo apart from them, since a ref memo hit saves a `log` call rather than an object read.
 * Counted in memory and stored with the RunDO's infra meter, never with a write of its own.
 * Reads that bypass the cache (a `log` page, a ref given as a commit id, `hasBlob`) are not
 * counted: they are neither hits nor misses.
 */
import type { CacheCountView, CacheView } from '@gitstalk/shared-race/rpc';

import { roundTo } from '../engine/numbers';

export type CachedKind = 'commit' | 'tree' | 'blob' | 'ref';

/** One read through the cache: answered locally (`hit`) or from Artifacts (`miss`). */
export type CacheRead = { readonly kind: CachedKind; readonly outcome: 'hit' | 'miss' };

export type CacheCount = { readonly hits: number; readonly misses: number };

export type CacheStats = Readonly<Record<CachedKind, CacheCount>>;

const NONE: CacheCount = { hits: 0, misses: 0 };

export function emptyCacheStats(): CacheStats {
  return { commit: NONE, tree: NONE, blob: NONE, ref: NONE };
}

export function countCacheRead(stats: CacheStats, read: CacheRead): CacheStats {
  const count = stats[read.kind];
  const next =
    read.outcome === 'hit'
      ? { hits: count.hits + 1, misses: count.misses }
      : { hits: count.hits, misses: count.misses + 1 };
  return { ...stats, [read.kind]: next };
}

/** The counts with their hit rates (four decimals). */
export function cacheReport(stats: CacheStats): CacheView {
  const objects = {
    hits: stats.commit.hits + stats.tree.hits + stats.blob.hits,
    misses: stats.commit.misses + stats.tree.misses + stats.blob.misses,
  };
  return {
    objects: countReport(objects),
    commit: countReport(stats.commit),
    tree: countReport(stats.tree),
    blob: countReport(stats.blob),
    ref_memo: countReport(stats.ref),
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
