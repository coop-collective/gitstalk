import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { listAudit } from '../src/audit';
import {
  PersonalTokenInput,
  createPersonalToken,
  listUserTokens,
  mintSessionToken,
  revokeClientTokens,
  revokeUserToken,
  verifyUserToken,
} from '../src/user-tokens';
import { T0, signUp } from './helpers';

const DAY = 24 * 3600 * 1000;

describe('personal access tokens', () => {
  it('verifies a new token to its owner and scopes, and stores only a hash', async () => {
    const { user } = await signUp('tokens');
    const request = PersonalTokenInput.parse({
      name: 'laptop git',
      scopes: ['read', 'write'],
      days: '30',
    });
    const { token, summary } = await createPersonalToken(
      env,
      { userId: user.id, request },
      () => T0,
    );
    expect(token).toMatch(/^bsu_[A-Za-z0-9_-]{43}$/);
    expect(summary).toMatchObject({
      kind: 'personal',
      name: 'laptop git',
      scopes: ['read', 'write'],
    });
    expect(summary.hint).toBe(`bsu_…${token.slice(-4)}`);
    expect(await verifyUserToken(env, token, () => T0 + 1)).toEqual({
      user,
      scopes: ['read', 'write'],
      token: {
        id: summary.id,
        kind: 'personal',
        expiresAt: T0 + 30 * DAY,
        repository: null,
        clientId: null,
      },
    });
    const stored = await env.IDENTITY_DB.prepare('SELECT * FROM user_tokens WHERE id = ?')
      .bind(summary.id)
      .first();
    expect(JSON.stringify(stored)).not.toContain(token.slice(4));
  });

  it('refuses malformed, unknown, expired and revoked tokens', async () => {
    const { user } = await signUp('refuse');
    const request = PersonalTokenInput.parse({ name: 'ci', scopes: ['read'], days: 7 });
    const { token, summary } = await createPersonalToken(
      env,
      { userId: user.id, request },
      () => T0,
    );
    expect(await verifyUserToken(env, 'bsu_short', () => T0)).toBeNull();
    expect(await verifyUserToken(env, `bsu_${'A'.repeat(43)}`, () => T0)).toBeNull();
    expect(await verifyUserToken(env, `bss_${token.slice(4)}`, () => T0)).toBeNull();
    expect(await verifyUserToken(env, token, () => T0 + 7 * DAY)).toBeNull();
    expect(await revokeUserToken(env, { userId: user.id, tokenId: summary.id }, () => T0)).toBe(
      true,
    );
    expect(await verifyUserToken(env, token, () => T0 + 1)).toBeNull();
    expect(await revokeUserToken(env, { userId: user.id, tokenId: summary.id }, () => T0)).toBe(
      false,
    );
  });

  it('lets nobody else revoke a token', async () => {
    const { user: owner } = await signUp('owner');
    const { user: other } = await signUp('other');
    const request = PersonalTokenInput.parse({ name: 'mine', scopes: ['read'], days: 90 });
    const { token, summary } = await createPersonalToken(
      env,
      { userId: owner.id, request },
      () => T0,
    );
    expect(await revokeUserToken(env, { userId: other.id, tokenId: summary.id }, () => T0)).toBe(
      false,
    );
    expect(await verifyUserToken(env, token, () => T0)).not.toBeNull();
  });

  it('rejects bad requests: no scopes, unknown scopes, expiry not offered', () => {
    expect(PersonalTokenInput.safeParse({ name: 'x', scopes: [], days: 30 }).success).toBe(false);
    expect(PersonalTokenInput.safeParse({ name: 'x', scopes: ['admin'], days: 30 }).success).toBe(
      false,
    );
    expect(PersonalTokenInput.safeParse({ name: 'x', scopes: ['read'], days: 3650 }).success).toBe(
      false,
    );
  });

  it('lists tokens newest first and audits create and revoke', async () => {
    const { user } = await signUp('lister');
    const first = PersonalTokenInput.parse({ name: 'first', scopes: ['read'], days: 7 });
    const second = PersonalTokenInput.parse({ name: 'second', scopes: ['collaborate'], days: 7 });
    const a = await createPersonalToken(env, { userId: user.id, request: first }, () => T0);
    await createPersonalToken(env, { userId: user.id, request: second }, () => T0 + 1);
    await revokeUserToken(env, { userId: user.id, tokenId: a.summary.id }, () => T0 + 2);
    const listed = await listUserTokens(env, user.id, () => T0 + 3);
    expect(listed.map((token) => [token.name, token.revokedAt])).toEqual([
      ['second', null],
      ['first', T0 + 2],
    ]);
    const actions = (await listAudit(env, user.id)).map((event) => event.action).toSorted();
    expect(actions).toEqual(['token.create', 'token.create', 'token.revoke', 'user.signup']);
  });
});

describe('session tokens for agent sessions', () => {
  it('lasts at most an hour and dies with the grant of its client', async () => {
    const { user } = await signUp('agent');
    const { token, summary } = await mintSessionToken(
      env,
      {
        userId: user.id,
        label: 'Claude Code',
        scopes: ['read'],
        ttlSeconds: 86_400,
        clientId: 'client-1',
      },
      () => T0,
    );
    expect(token).toMatch(/^bss_/);
    expect(summary.expiresAt).toBe(T0 + 3600 * 1000);
    expect((await verifyUserToken(env, token, () => T0 + 1))?.scopes).toEqual(['read']);
    expect(await verifyUserToken(env, token, () => T0 + 3600 * 1000)).toBeNull();
    expect(await revokeClientTokens(env, { userId: user.id, clientId: 'client-1' }, T0)).toBe(1);
    expect(await verifyUserToken(env, token, () => T0 + 1)).toBeNull();
  });

  it('carries the one repository it was minted for (MCP git_credentials)', async () => {
    const { user } = await signUp('bound');
    const bound = await mintSessionToken(
      env,
      {
        userId: user.id,
        label: 'git',
        scopes: ['read', 'write'],
        repository: 'r0123456789abcdef012',
      },
      () => T0,
    );
    const free = await mintSessionToken(
      env,
      { userId: user.id, label: 'git', scopes: ['read'] },
      () => T0,
    );
    expect((await verifyUserToken(env, bound.token, () => T0 + 1))?.token.repository).toBe(
      'r0123456789abcdef012',
    );
    expect((await verifyUserToken(env, free.token, () => T0 + 1))?.token.repository).toBeNull();
  });
});
