import { describe, expect, it } from 'vitest';

import { isSessionsAnswer } from './sessions-answer';

const session = {
  grantId: 'g1',
  clientId: 'c1',
  clientName: 'Claude Code',
  scopes: ['repo:read'],
  createdAt: 1,
  expiresAt: null,
};

describe('the /api/sessions guard', () => {
  it('accepts the route answer, with or without settling sessions', () => {
    expect(isSessionsAnswer({ sessions: [] })).toBe(true);
    expect(isSessionsAnswer({ sessions: [session, { ...session, settling: true }] })).toBe(true);
  });

  it('rejects other shapes', () => {
    expect(isSessionsAnswer(null)).toBe(false);
    expect(isSessionsAnswer({})).toBe(false);
    expect(isSessionsAnswer({ sessions: [{ ...session, createdAt: 'now' }] })).toBe(false);
    expect(isSessionsAnswer({ sessions: [{ ...session, scopes: [1] }] })).toBe(false);
    expect(isSessionsAnswer({ sessions: [{ ...session, settling: 'yes' }] })).toBe(false);
  });
});
