import { describe, expect, it } from 'vitest';

import type { WebSession } from '@gitstalk/shared-identity/sessions';

import { signOut } from './sign-out';
import type { SignOutPorts } from './sign-out';

const SESSION: WebSession = {
  user: { id: 'usr_1', handle: 'ada', email: null },
  profile: { displayName: '', avatarKey: null },
  sessionHash: 'hash-1',
  csrfToken: 'csrf-1',
};

type Calls = { revoked: string[]; revokedAll: string[]; audited: string[] };

function ports(session: WebSession | null): { ports: SignOutPorts; calls: Calls } {
  const calls: Calls = { revoked: [], revokedAll: [], audited: [] };
  return {
    calls,
    ports: {
      session: async () => session,
      revoke: async (hash) => {
        calls.revoked.push(hash);
      },
      revokeAll: async (userId) => {
        calls.revokedAll.push(userId);
      },
      audit: async (event) => {
        calls.audited.push(event.action);
      },
    },
  };
}

function post(fields: Readonly<Record<string, string>>, origin = 'https://beanstalk.test') {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return new Request('https://beanstalk.test/auth/signout', {
    method: 'POST',
    headers: { origin },
    body,
  });
}

describe('signing out', () => {
  it('revokes this session, clears the cookie and lands on sign-in', async () => {
    const { ports: signOutPorts, calls } = ports(SESSION);
    const response = await signOut(post({ csrf: 'csrf-1' }), signOutPorts, 1);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://beanstalk.test/login?signed_out=1');
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-bs_session=;.*Max-Age=0/);
    expect(calls).toEqual({ revoked: ['hash-1'], revokedAll: [], audited: ['session.signout'] });
  });

  it('signs out every browser with everywhere=1', async () => {
    const { ports: signOutPorts, calls } = ports(SESSION);
    await signOut(post({ csrf: 'csrf-1', everywhere: '1' }), signOutPorts, 1);
    expect(calls).toEqual({
      revoked: [],
      revokedAll: ['usr_1'],
      audited: ['session.signout_all'],
    });
  });

  it('refuses a form without the session CSRF token and revokes nothing', async () => {
    const { ports: signOutPorts, calls } = ports(SESSION);
    const response = await signOut(post({ csrf: 'wrong' }), signOutPorts, 1);
    expect(response.status).toBe(403);
    expect(calls.revoked).toEqual([]);
  });

  it('refuses a cross-site form', async () => {
    const { ports: signOutPorts, calls } = ports(SESSION);
    const response = await signOut(post({ csrf: 'csrf-1' }, 'https://evil.test'), signOutPorts, 1);
    expect(response.status).toBe(403);
    expect(calls.revoked).toEqual([]);
  });

  it('sends a browser that is already signed out to sign in', async () => {
    const { ports: signOutPorts } = ports(null);
    const response = await signOut(post({ csrf: 'csrf-1' }), signOutPorts, 1);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://beanstalk.test/login');
  });
});
