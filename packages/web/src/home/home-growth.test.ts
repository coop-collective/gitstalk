import { describe, expect, it } from 'vitest';

import type { Growth } from '../repositories/engine-summary';
import type { RepositoryRecord } from '../repositories/registry-client';
import {
  GROWTH_FALLBACK_CONCURRENCY,
  GROWTH_FALLBACK_LIMIT,
  loadHomeGrowth,
  resolveGrowth,
} from './home-growth';

function repo(n: number): RepositoryRecord {
  return {
    id: `repo${n}`,
    owner: { id: 'u1', handle: 'coop' },
    owner_kind: 'user',
    name: `r${n}`,
    description: '',
    visibility: 'private',
    origin: { kind: 'empty' },
    artifacts_repo: `art${n}`,
    engine_id: `engine${n}`,
    default_branch: 'stalk',
    created_at: '2026-10-07T13:39:40Z',
    updated_at: '2026-10-07T13:39:40Z',
    archived_at: null,
    website: '',
    topics: [],
    social_image_key: null,
  };
}

const grown: Growth = { kind: 'grown', onStalk: 2, growing: 0 };

describe('resolveGrowth', () => {
  it('prefers the index, then the engine feed, then the engine view', async () => {
    const records = [repo(1), repo(2), repo(3)];
    const byRepo = await resolveGrowth(
      records,
      {
        growthByRepo: new Map([
          ['repo1', { repo_id: 'repo1', landed: 3, growing: 1, indexed: true }],
        ]),
        feeds: new Map([['engine2', { engine_id: 'engine2', tasks: { landed: 1 }, items: [] }]]),
      },
      () => Promise.resolve(grown),
    );
    expect(byRepo.get('repo1')).toEqual({ kind: 'grown', onStalk: 3, growing: 1 });
    expect(byRepo.get('repo2')).toEqual({ kind: 'grown', onStalk: 1, growing: 0 });
    expect(byRepo.get('repo3')).toEqual(grown);
  });

  it('reads at most the cap by engine view, a few at a time, and shows the rest as unknown', async () => {
    const records = Array.from({ length: GROWTH_FALLBACK_LIMIT + 5 }, (_, n) => repo(n));
    let inFlight = 0;
    let peak = 0;
    let reads = 0;
    const byRepo = await resolveGrowth(
      records,
      { growthByRepo: new Map(), feeds: new Map() },
      async () => {
        reads += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return grown;
      },
    );
    expect(reads).toBe(GROWTH_FALLBACK_LIMIT);
    expect(peak).toBeLessThanOrEqual(GROWTH_FALLBACK_CONCURRENCY);
    expect(byRepo.get(`repo${GROWTH_FALLBACK_LIMIT}`)).toEqual({ kind: 'unknown' });
    expect(byRepo.size).toBe(records.length);
  });
});

describe('loadHomeGrowth', () => {
  it('does not reject when a read fails', async () => {
    const answer = await loadHomeGrowth(
      { records: [repo(1)], registryActivity: [] },
      {
        indexGrowth: () => Promise.reject(new Error('index down')),
        engineFeeds: () => Promise.resolve(new Map()),
        engineView: () => Promise.resolve(grown),
      },
    );
    expect(answer.byRepo.size).toBe(0);
    expect(answer.activity).toEqual([]);
  });
});
