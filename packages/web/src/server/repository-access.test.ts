import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RepositoryRecord } from '../repositories/registry-client';
import { repositoryPage } from './repository-page';

/**
 * The repository access check that decides a page's status. The Workers runtime, Next's
 * navigation errors and vinext's per-request cache exist only in the built Worker; here
 * `notFound` and `redirect` throw tagged errors, and `cacheForRequest` holds values until
 * `platform.newRequest()` (one request at a time).
 */
const platform = vi.hoisted(() => {
  const held = new Map<unknown, unknown>();
  const lookups: string[] = [];
  const answers: { lookup: (owner: string, repo: string) => unknown } = {
    lookup: () => ({ kind: 'not-found' }),
  };
  return { held, lookups, answers, newRequest: () => held.clear() };
});

vi.mock('cloudflare:workers', () => ({ env: { GATEWAY: {}, IDENTITY_DB: {} } }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not-found');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock('vinext/cache', () => ({
  cacheForRequest:
    <T>(factory: () => T) =>
    (): T => {
      if (!platform.held.has(factory)) platform.held.set(factory, factory());
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the map holds what `factory` made
      return platform.held.get(factory) as T;
    },
}));
vi.mock('../auth/user', () => ({ currentSession: () => Promise.resolve(null) }));
vi.mock('@gitstalk/shared-identity/profiles', () => ({
  resolveRetiredHandle: () => Promise.resolve(null),
}));
vi.mock('../repositories/flows', () => ({
  lookupRepository: (owner: string, repo: string) => {
    platform.lookups.push(`${owner}/${repo}`);
    return Promise.resolve(platform.answers.lookup(owner, repo));
  },
}));

const address = (owner: string, repo: string) => Promise.resolve({ owner, repo });

function found(handle: string, name: string) {
  return {
    kind: 'found',
    isOwner: false,
    role: null,
    record: RepositoryRecord.parse({
      id: 'repo-1',
      owner: { id: 'user-1', handle },
      name,
      description: '',
      visibility: 'public',
      origin: { kind: 'empty' },
      artifacts_repo: 'a',
      engine_id: 'e',
      default_branch: 'stalk',
      created_at: '2026-10-12T00:00:00Z',
      updated_at: '2026-10-12T00:00:00Z',
    }),
  };
}

beforeEach(() => {
  platform.newRequest();
  platform.lookups.length = 0;
  platform.answers.lookup = () => ({ kind: 'not-found' });
});

describe('the repository access check', () => {
  it('answers not found for a repository the viewer may not read, as the page does', async () => {
    await expect(repositoryPage(address('ada', 'secret'))).rejects.toThrow('not-found');
    await expect(repositoryPage(address('ada', 'secret'))).rejects.toThrow('not-found');
    expect(platform.lookups).toEqual(['ada/secret']);
  });

  it('redirects an old address to the current one', async () => {
    platform.answers.lookup = () => found('ada', 'renamed');
    await expect(repositoryPage(address('ada', 'old-name'))).rejects.toThrow(
      'redirect /ada/renamed',
    );
  });

  it('reads once per request for the layout and the page, and again in the next request', async () => {
    platform.answers.lookup = () => found('ada', 'notes');
    const layout = await repositoryPage(address('ada', 'notes'));
    const page = await repositoryPage(address('ada', 'notes'));
    expect(page).toBe(layout);
    platform.newRequest();
    await repositoryPage(address('ada', 'notes'));
    expect(platform.lookups).toEqual(['ada/notes', 'ada/notes']);
  });
});
