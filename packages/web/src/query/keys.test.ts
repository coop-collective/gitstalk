import { describe, expect, it } from 'vitest';

import { ANONYMOUS_VIEWER, qk, viewerKey } from './keys';

describe('query keys', () => {
  it('put the viewer right after the area in every key', () => {
    expect(qk.viewer('u1').sessions()).toEqual(['viewer', 'u1', 'sessions']);
    expect(qk.home('u1').activity()).toEqual(['home', 'u1', 'activity']);
    expect(qk.home('u1').growth()).toEqual(['home', 'u1', 'growth']);
    const repo = qk.repo('u1', 'acme', 'web');
    expect(repo.events()).toEqual(['repo', 'u1', 'acme', 'web', 'events']);
    expect(repo.pushed()).toEqual(['repo', 'u1', 'acme', 'web', 'pushed']);
    expect(repo.bean('fix-login')).toEqual(['repo', 'u1', 'acme', 'web', 'bean', 'fix-login']);
    expect(repo.run('r9')).toEqual(['repo', 'u1', 'acme', 'web', 'run', 'r9']);
  });

  it('name a signed-out viewer anon', () => {
    expect(qk.home(null).activity()).toEqual(['home', ANONYMOUS_VIEWER, 'activity']);
    expect(viewerKey(undefined)).toBe('anon');
    expect(viewerKey('')).toBe('anon');
  });

  it('give two viewers of the same repository different keys', () => {
    const events = (uid: string | null) => qk.repo(uid, 'acme', 'web').events();
    expect(events('u1')).not.toEqual(events('u2'));
    expect(events(null)).not.toEqual(events('u1'));
  });

  it('make an area key a prefix of its queries, for invalidation', () => {
    const repo = qk.repo('u1', 'acme', 'web');
    for (const key of [repo.events(), repo.pushed(), repo.bean('b'), repo.run('r')])
      expect(key.slice(0, repo.all.length)).toEqual(repo.all);
    expect(qk.home('u1').activity().slice(0, 2)).toEqual(qk.home('u1').all);
  });
});
