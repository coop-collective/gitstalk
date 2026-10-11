/**
 * What Home's Activity and growth figures need, read after the page's shell has streamed:
 * one D1 read of every repository's counts (repo-events index), the engines' feeds for the
 * repositories the index has not heard from, and, only for those an older gateway cannot
 * answer in bulk, one `runView` call each, a few at a time and only up to a cap.
 */
import { log } from '../log';
import type { Growth } from '../repositories/engine-summary';
import { growthFromCounts, growthFromIndex } from '../repositories/engine-summary';
import type { ActivityLine, Feed } from '../repositories/home-activity';
import { activityLines, indexLines } from '../repositories/home-activity';
import type { RepositoryGrowth } from '../repositories/index-client';
import type { RepositoryActivity, RepositoryRecord } from '../repositories/registry-client';
import { mapLimit } from './map-limit';

/** Lines in Home's activity. */
export const HOME_LINES = 14;

/** Engine `runView` calls in flight at once. */
export const GROWTH_FALLBACK_CONCURRENCY = 4;

/** Repositories read one by one; the rest show "—" (their page has the details). */
export const GROWTH_FALLBACK_LIMIT = 12;

export type HomeGrowth = {
  /** Growth by repository id, for every repository passed in. */
  readonly byRepo: ReadonlyMap<string, Growth>;
  readonly activity: readonly ActivityLine[];
};

export type GrowthSources = {
  readonly growthByRepo: ReadonlyMap<string, RepositoryGrowth>;
  readonly feeds: ReadonlyMap<string, Feed>;
};

/**
 * Each repository's growth: from the index, else its engine's feed, else its engine's view,
 * read with bounded concurrency for the first `GROWTH_FALLBACK_LIMIT` such repositories.
 */
export async function resolveGrowth(
  records: readonly RepositoryRecord[],
  known: GrowthSources,
  readView: (engineId: string) => Promise<Growth>,
): Promise<ReadonlyMap<string, Growth>> {
  const byRepo = new Map<string, Growth>();
  const fallback: RepositoryRecord[] = [];
  for (const record of records) {
    const line = known.growthByRepo.get(record.id);
    const feed = known.feeds.get(record.engine_id);
    if (line !== undefined) byRepo.set(record.id, growthFromIndex(line));
    else if (feed !== undefined) byRepo.set(record.id, growthFromCounts(feed.tasks));
    else if (fallback.length < GROWTH_FALLBACK_LIMIT) fallback.push(record);
    else byRepo.set(record.id, { kind: 'unknown' });
  }
  const views = await mapLimit(fallback, GROWTH_FALLBACK_CONCURRENCY, (record) =>
    readView(record.engine_id),
  );
  fallback.forEach((record, index) => {
    byRepo.set(record.id, views[index] ?? { kind: 'unknown' });
  });
  return byRepo;
}

/** The index's lines (registry and engines), plus feed lines for repositories not indexed yet. */
export function homeActivity(input: {
  readonly unindexed: readonly RepositoryRecord[];
  readonly registry: readonly RepositoryActivity[];
  readonly feeds: ReadonlyMap<string, Feed>;
}): readonly ActivityLine[] {
  const fromFeeds = activityLines({
    records: input.unindexed,
    registry: [],
    feeds: input.feeds,
    limit: HOME_LINES,
  });
  return [...indexLines(input.registry), ...fromFeeds]
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, HOME_LINES);
}

/** The reads Home's growth needs, each failing soft (see the clients). */
export type GrowthReaders = {
  readonly indexGrowth: (repoIds: readonly string[]) => Promise<readonly RepositoryGrowth[]>;
  readonly engineFeeds: (engineIds: readonly string[]) => Promise<ReadonlyMap<string, Feed>>;
  readonly engineView: (engineId: string) => Promise<Growth>;
};

/** Never rejects: a failed read shows the lists without growth rather than failing the page. */
export async function loadHomeGrowth(
  input: {
    readonly records: readonly RepositoryRecord[];
    readonly registryActivity: readonly RepositoryActivity[];
  },
  read: GrowthReaders,
): Promise<HomeGrowth> {
  try {
    const indexed = await read.indexGrowth(input.records.map((record) => record.id));
    const growthByRepo = new Map(
      indexed.filter((line) => line.indexed).map((line) => [line.repo_id, line]),
    );
    const unindexed = input.records.filter((record) => !growthByRepo.has(record.id));
    const feeds = await read.engineFeeds(unindexed.map((record) => record.engine_id));
    const byRepo = await resolveGrowth(input.records, { growthByRepo, feeds }, read.engineView);
    return {
      byRepo,
      activity: homeActivity({ unindexed, registry: input.registryActivity, feeds }),
    };
  } catch (error: unknown) {
    log.error('home growth unreadable; Home lists repositories without it', { error });
    return {
      byRepo: new Map(),
      activity: homeActivity({ unindexed: [], registry: input.registryActivity, feeds: new Map() }),
    };
  }
}
