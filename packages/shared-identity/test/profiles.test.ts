import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { deleteUser, deletionPlan, isDeletionConfirmed } from '../src/account-deletion';
import { listPasskeys, renamePasskey, startPasskeySignup } from '../src/passkeys';
import {
  HANDLE_CHANGE_COOLDOWN_MS,
  changeHandle,
  findProfileByHandle,
  getProfile,
  resolveRetiredHandle,
  retiredHandles,
  revertHandleChange,
  setAvatarKey,
  updateProfile,
} from '../src/profiles';
import {
  createSession,
  getSessionUser,
  getWebSession,
  listBrowserSessions,
  revokeBrowserSession,
} from '../src/sessions';
import { createPersonalToken, verifyUserToken } from '../src/user-tokens';
import { RP, T0, signUp, withSession } from './helpers';

const DAY = 24 * 3600 * 1000;
const at = (now: number) => ({ ip: '203.0.113.7', now });

describe('profile', () => {
  it('saves a display name, bio and website, adding https:// to a bare domain', async () => {
    const { user } = await signUp('prof-a');
    const saved = await updateProfile(env, {
      userId: user.id,
      ...at(T0),
      profile: {
        displayName: '  Coop  ',
        bio: 'Builds forges.\r\nLikes beans.',
        website: 'beanstalk.dev',
      },
    });
    expect(saved).toMatchObject({
      ok: true,
      profile: {
        displayName: 'Coop',
        bio: 'Builds forges.\nLikes beans.',
        website: 'https://beanstalk.dev',
      },
    });
    expect((await findProfileByHandle(env, 'PROF-A'))?.id).toBe(user.id);
  });

  it('refuses scripts as websites, long names and control characters, naming the field', async () => {
    const { user } = await signUp('prof-b');
    const save = (profile: { displayName: string; bio: string; website: string }) =>
      updateProfile(env, { userId: user.id, ...at(T0), profile });
    expect(await save({ displayName: '', bio: '', website: 'javascript:alert(1)' })).toMatchObject({
      ok: false,
      field: 'website',
    });
    expect(await save({ displayName: 'x'.repeat(65), bio: '', website: '' })).toMatchObject({
      ok: false,
      field: 'displayName',
    });
    expect(await save({ displayName: 'a\u0007b', bio: '', website: '' })).toMatchObject({
      ok: false,
      field: 'displayName',
    });
    expect(await save({ displayName: '', bio: 'y'.repeat(161), website: '' })).toMatchObject({
      ok: false,
      field: 'bio',
    });
    expect((await getProfile(env, user.id))?.website).toBe('');
  });

  it('answers the previous picture so the caller can delete it', async () => {
    const { user } = await signUp('prof-c');
    const first = `users/${user.id}/avatar/${'a'.repeat(32)}`;
    const second = `users/${user.id}/avatar/${'b'.repeat(32)}`;
    expect(await setAvatarKey(env, { userId: user.id, key: first, ...at(T0) })).toEqual({
      previous: null,
    });
    expect(await setAvatarKey(env, { userId: user.id, key: second, ...at(T0) })).toEqual({
      previous: first,
    });
    expect(await setAvatarKey(env, { userId: user.id, key: null, ...at(T0) })).toEqual({
      previous: second,
    });
    expect((await getProfile(env, user.id))?.avatarKey).toBeNull();
  });

  it('comes with the session, for the header', async () => {
    const { user } = await signUp('prof-session');
    const { secret } = await createSession(env, { userId: user.id, userAgent: null }, T0);
    const cookie = `__Host-bs_session=${secret}`;
    expect((await getWebSession(cookie, env, () => T0))?.profile).toEqual({
      displayName: '',
      avatarKey: null,
    });
    const key = `users/${user.id}/avatar/${'c'.repeat(32)}`;
    await setAvatarKey(env, { userId: user.id, key, ...at(T0) });
    await updateProfile(env, {
      userId: user.id,
      ...at(T0),
      profile: { displayName: 'Ada', bio: '', website: '' },
    });
    expect((await getWebSession(cookie, env, () => T0))?.profile).toEqual({
      displayName: 'Ada',
      avatarKey: key,
    });
  });
});

describe('handle changes', () => {
  it('changes the handle, keeps the old one redirecting, and signs in as the new one', async () => {
    const { user, session } = await signUp('old-name');
    const changed = await changeHandle(env, { userId: user.id, handle: 'New-Name', ...at(T0) });
    expect(changed).toEqual({ ok: true, from: 'old-name', to: 'new-name' });
    expect(await resolveRetiredHandle(env, 'OLD-NAME')).toBe('new-name');
    expect(await retiredHandles(env, user.id)).toEqual(['old-name']);
    expect((await getSessionUser(withSession(session.secret), env, () => T0))?.handle).toBe(
      'new-name',
    );
  });

  it('refuses reserved, malformed, current and taken handles', async () => {
    const { user } = await signUp('hc-one');
    await signUp('hc-two');
    const change = (handle: string) => changeHandle(env, { userId: user.id, handle, ...at(T0) });
    expect(await change('settings')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await change('-bad-')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await change('HC-ONE')).toMatchObject({ ok: false, reason: 'unchanged' });
    expect(await change('hc-two')).toMatchObject({ ok: false, reason: 'taken' });
  });

  it('keeps a retired handle from everyone else, at sign-up and on change', async () => {
    const { user } = await signUp('squat-me');
    await changeHandle(env, { userId: user.id, handle: 'moved-on', ...at(T0) });
    const other = await signUp('squatter');
    expect(
      await changeHandle(env, { userId: other.user.id, handle: 'squat-me', ...at(T0) }),
    ).toMatchObject({ ok: false, reason: 'taken' });
    expect(await startPasskeySignup(env, { handle: 'squat-me', rp: RP, now: T0 })).toMatchObject({
      ok: false,
      reason: 'handle_taken',
    });
  });

  it('allows one change a day, and taking one’s own old handle back', async () => {
    const { user } = await signUp('daily');
    await changeHandle(env, { userId: user.id, handle: 'daily-two', ...at(T0) });
    expect(
      await changeHandle(env, { userId: user.id, handle: 'daily-three', ...at(T0 + DAY - 1) }),
    ).toMatchObject({ ok: false, reason: 'too_soon' });
    const back = await changeHandle(env, {
      userId: user.id,
      handle: 'daily',
      ...at(T0 + HANDLE_CHANGE_COOLDOWN_MS),
    });
    expect(back).toEqual({ ok: true, from: 'daily-two', to: 'daily' });
    expect(await retiredHandles(env, user.id)).toEqual(['daily-two']);
    expect(await resolveRetiredHandle(env, 'daily')).toBeNull();
  });

  it('reverts a change whose repositories could not move', async () => {
    const { user } = await signUp('revert-me');
    await changeHandle(env, { userId: user.id, handle: 'reverted', ...at(T0) });
    await revertHandleChange(env, {
      userId: user.id,
      from: 'revert-me',
      to: 'reverted',
      changedAt: null,
      ...at(T0),
    });
    expect((await getProfile(env, user.id))?.handle).toBe('revert-me');
    expect(await resolveRetiredHandle(env, 'revert-me')).toBeNull();
    // The cooldown is as it was: another change goes through at once.
    expect(
      await changeHandle(env, { userId: user.id, handle: 'reverted-2', ...at(T0 + 1) }),
    ).toMatchObject({ ok: true });
  });
});

describe('passkeys and browsers', () => {
  it('renames only the person’s own passkey, to a sensible name', async () => {
    const { user } = await signUp('pk-name');
    const other = await signUp('pk-other');
    const [passkey] = await listPasskeys(env, user.id);
    if (passkey === undefined) throw new Error('sign-up makes a passkey');
    const rename = (userId: string, name: string) =>
      renamePasskey(env, { userId, passkeyId: passkey.id, name, ...at(T0) });
    expect(await rename(user.id, '  1Password\n')).toBe('renamed');
    expect((await listPasskeys(env, user.id))[0]?.name).toBe('1Password');
    expect(await rename(user.id, '   ')).toBe('invalid_name');
    expect(await rename(user.id, 'x'.repeat(61))).toBe('invalid_name');
    expect(await rename(other.user.id, 'stolen')).toBe('not_found');
  });

  it('lists browsers with the current one marked, and signs another one out', async () => {
    const { user, session } = await signUp('browsers');
    const laptop = await createSession(env, { userId: user.id, userAgent: 'Laptop' }, T0 + 1000);
    const current = await getWebSession(`__Host-bs_session=${session.secret}`, env, () => T0);
    if (current === null) throw new Error('signed in');
    const listed = await listBrowserSessions(env, current, T0 + 2000);
    expect(listed).toHaveLength(2);
    expect(listed.filter((browser) => browser.isCurrent)).toHaveLength(1);
    const other = listed.find((browser) => !browser.isCurrent);
    if (other === undefined) throw new Error('two browsers');
    const stranger = await signUp('browser-thief');
    expect(
      await revokeBrowserSession(env, { userId: stranger.user.id, id: other.id, now: T0 }),
    ).toBe(false);
    expect(await revokeBrowserSession(env, { userId: user.id, id: other.id, now: T0 })).toBe(true);
    expect(await getSessionUser(withSession(laptop.secret), env, () => T0)).toBeNull();
    expect(await revokeBrowserSession(env, { userId: user.id, id: "' OR 1=1 --", now: T0 })).toBe(
      false,
    );
  });
});

describe('account deletion', () => {
  it('blocks the sole owner of an organisation and names it', () => {
    expect(
      deletionPlan({
        handle: 'coop',
        organizations: [
          { handle: 'acme', otherOwners: 0 },
          { handle: 'shared-co', otherOwners: 2 },
        ],
        repositories: ['greeter'],
      }),
    ).toEqual({ kind: 'blocked', soleOwnerOf: ['acme'] });
    expect(
      deletionPlan({
        handle: 'coop',
        organizations: [{ handle: 'shared-co', otherOwners: 1 }],
        repositories: ['greeter', 'old-thing'],
      }),
    ).toEqual({ kind: 'allowed', repositories: ['greeter', 'old-thing'] });
  });

  it('wants the handle typed, with or without the @', () => {
    expect(isDeletionConfirmed('@Coop ', 'coop')).toBe(true);
    expect(isDeletionConfirmed('coop2', 'coop')).toBe(false);
    expect(isDeletionConfirmed('', 'coop')).toBe(false);
  });

  it('removes the person, their passkeys, sessions, tokens and retired handles', async () => {
    const { user, session } = await signUp('leaving');
    const { token } = await createPersonalToken(
      env,
      { userId: user.id, request: { name: 'laptop', scopes: ['read'], days: 30 } },
      () => T0,
    );
    await changeHandle(env, { userId: user.id, handle: 'leaving-now', ...at(T0) });
    expect(await deleteUser(env, { userId: user.id, ...at(T0) })).toBe(true);
    expect(await getProfile(env, user.id)).toBeNull();
    expect(await listPasskeys(env, user.id)).toEqual([]);
    expect(await getSessionUser(withSession(session.secret), env, () => T0)).toBeNull();
    expect(await verifyUserToken(env, token, () => T0)).toBeNull();
    expect(await resolveRetiredHandle(env, 'leaving')).toBeNull();
    expect(await deleteUser(env, { userId: user.id, ...at(T0) })).toBe(false);
    // The handle is free again.
    expect(
      await startPasskeySignup(env, { handle: 'leaving-now', rp: RP, now: T0 }),
    ).toHaveProperty('options');
  });
});
