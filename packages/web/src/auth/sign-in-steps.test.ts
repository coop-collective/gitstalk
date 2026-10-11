import { describe, expect, it } from 'vitest';

import { modeOf, nextFromQuery, stepFromQuery, stepPath } from './sign-in-steps';

const CONNECT = '/connect?request=req_ABC-123';

describe('the sign-in flow keeps `next` on every step', () => {
  it('carries an agent connection through code, handle and passkey steps', () => {
    for (const step of ['code', 'handle', 'passkey'] as const) {
      const path = stepPath('signin', step, { next: CONNECT });
      const query = Object.fromEntries(new URL(path, 'https://gitstalk.test').searchParams);
      expect(nextFromQuery(query), step).toBe(CONNECT);
      expect(stepFromQuery(query).step).toBe(step);
    }
  });

  it('keeps the mode: sign-up steps stay on /signup', () => {
    expect(stepPath('signup', 'code', { next: '/' })).toBe('/signup?step=code');
    expect(stepPath('signin', 'start', { next: '/' })).toBe('/login');
    expect(stepPath('signin', 'start', { next: '/settings/tokens' })).toBe(
      '/login?next=%2Fsettings%2Ftokens',
    );
  });

  it('never carries a `next` that leaves the site', () => {
    for (const evil of ['//evil.test', 'https://evil.test/x', '/\\evil.test', 'javascript:x'])
      expect(stepPath('signin', 'code', { next: evil }), evil).toBe('/login?step=code');
    expect(nextFromQuery({ next: '//evil.test' })).toBe('/');
    expect(nextFromQuery({ next: ['/settings', '//evil.test'] })).toBe('/settings');
  });

  it('reads errors and tries left, ignoring anything unknown', () => {
    const path = stepPath('signin', 'code', {
      next: '/',
      error: 'wrong_code',
      attemptsLeft: 3,
    });
    const query = Object.fromEntries(new URL(path, 'https://gitstalk.test').searchParams);
    expect(stepFromQuery(query)).toEqual({ step: 'code', error: 'wrong_code', attemptsLeft: 3 });
    expect(stepFromQuery({ step: 'nope', error: '<script>', left: '-1' })).toEqual({
      step: 'start',
      error: null,
      attemptsLeft: null,
    });
  });

  it('treats any form mode but signup as sign-in', () => {
    expect(modeOf('signup')).toBe('signup');
    expect(modeOf('admin')).toBe('signin');
    expect(modeOf(null)).toBe('signin');
  });
});
