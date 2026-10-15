import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { listAudit } from '../src/audit';
import {
  decideKeyRequest,
  describeKeyRequest,
  pollKeyRequest,
  startKeyRequest,
} from '../src/ssh-key-requests';
import { addSshKey, findUserByKey, listSshKeys, removeSshKey, touchKey } from '../src/ssh-keys';
import { decodeBase64, parsePublicKeyLine } from '../src/ssh-wire';
import { verifyUserToken } from '../src/user-tokens';
import { SSH_KEYS } from './fixtures/ssh-fixtures';
import { T0, signUp } from './helpers';

const KEY_NAMES = ['ed25519', 'ecdsa256', 'ecdsa384', 'ecdsa521', 'rsa'] as const;
const now = () => T0;
const later = () => T0 + 601_000;

function blobOf(line: string): Uint8Array {
  const blob = decodeBase64(line.split(' ')[1] ?? '');
  if (blob === null) throw new Error('fixture key is not base64');
  return blob;
}

describe('SSH public keys', () => {
  it.each(KEY_NAMES)('reads a %s key with the fingerprint ssh-keygen prints', async (name) => {
    const parsed = await parsePublicKeyLine(SSH_KEYS[name].publicKey);
    expect(parsed).toMatchObject({
      ok: true,
      fingerprint: SSH_KEYS[name].fingerprint,
      comment: `fixture-${name}`,
    });
  });

  it('refuses security-key, unknown, mismatched and malformed key lines', async () => {
    expect(await parsePublicKeyLine('sk-ssh-ed25519@openssh.com AAAA x')).toMatchObject({
      ok: false,
    });
    expect(await parsePublicKeyLine('ssh-dss AAAA x')).toMatchObject({ ok: false });
    const ed = SSH_KEYS.ed25519.publicKey.split(' ')[1] ?? '';
    expect(await parsePublicKeyLine(`ssh-rsa ${ed}`)).toMatchObject({ ok: false });
    expect(await parsePublicKeyLine('ssh-ed25519 not-base64!')).toMatchObject({ ok: false });
    expect(await parsePublicKeyLine(`ssh-ed25519 ${ed.slice(0, -8)}`)).toMatchObject({ ok: false });
  });
});

describe('keys for the SSH endpoint', () => {
  it('finds the owner by fingerprint, key blob or key line, and records use once a minute', async () => {
    const { user } = await signUp('sshfind');
    const added = await addSshKey(
      env,
      { userId: user.id, publicKey: SSH_KEYS.ed25519.publicKey, name: 'coop-mbp', ip: null },
      now,
    );
    if (!added.ok) throw new Error(added.reason);
    expect(added.key).toMatchObject({
      name: 'coop-mbp',
      keyType: 'ssh-ed25519',
      fingerprint: SSH_KEYS.ed25519.fingerprint,
    });
    const byFingerprint = await findUserByKey(env, { fingerprint: SSH_KEYS.ed25519.fingerprint });
    expect(byFingerprint).toMatchObject({
      user,
      scopes: ['read', 'write'],
      key: { id: added.key.id, lastUsedAt: null },
    });
    expect(byFingerprint?.key.blob).toEqual(blobOf(SSH_KEYS.ed25519.publicKey));
    expect(await findUserByKey(env, { blob: blobOf(SSH_KEYS.ed25519.publicKey) })).toMatchObject({
      user,
    });
    expect(await findUserByKey(env, { publicKey: SSH_KEYS.ed25519.publicKey })).toMatchObject({
      user,
    });
    if (byFingerprint === null) throw new Error('not found');
    await touchKey(env, byFingerprint.key, () => T0 + 1000);
    const touched = await findUserByKey(env, { fingerprint: SSH_KEYS.ed25519.fingerprint });
    expect(touched?.key.lastUsedAt).toBe(T0 + 1000);
    if (touched === null) throw new Error('not found');
    await touchKey(env, touched.key, () => T0 + 30_000);
    expect((await listSshKeys(env, user.id))[0]?.lastUsedAt).toBe(T0 + 1000);
  });

  it('knows nothing of unregistered keys or bad input', async () => {
    expect(await findUserByKey(env, { fingerprint: SSH_KEYS.other.fingerprint })).toBeNull();
    expect(await findUserByKey(env, { fingerprint: 'SHA256:nope' })).toBeNull();
    expect(await findUserByKey(env, { publicKey: 'ssh-dss AAAA' })).toBeNull();
  });

  it('stops finding a removed key at once, and lets it be added again later', async () => {
    const { user } = await signUp('sshremoved');
    const added = await addSshKey(
      env,
      { userId: user.id, publicKey: SSH_KEYS.rsa.publicKey, name: 'laptop', ip: '203.0.113.7' },
      now,
    );
    if (!added.ok) throw new Error(added.reason);
    expect(await removeSshKey(env, { userId: user.id, keyId: added.key.id, ip: null }, now)).toBe(
      true,
    );
    expect(await removeSshKey(env, { userId: user.id, keyId: added.key.id, ip: null }, now)).toBe(
      false,
    );
    expect(await findUserByKey(env, { fingerprint: SSH_KEYS.rsa.fingerprint })).toBeNull();
    expect(await listSshKeys(env, user.id)).toEqual([]);
    expect((await listAudit(env, user.id)).map((event) => event.action)).toEqual(
      expect.arrayContaining(['ssh_key.add', 'ssh_key.remove']),
    );
    expect(
      await addSshKey(
        env,
        { userId: user.id, publicKey: SSH_KEYS.rsa.publicKey, name: 'again', ip: null },
        now,
      ),
    ).toMatchObject({ ok: true });
  });

  it('keeps a key on one account only, and only its owner removes it', async () => {
    const first = await signUp('sshfirst');
    const second = await signUp('sshsecond');
    const added = await addSshKey(
      env,
      { userId: first.user.id, publicKey: SSH_KEYS.ecdsa384.publicKey, name: '', ip: null },
      now,
    );
    if (!added.ok) throw new Error(added.reason);
    expect(added.key.name).toBe('fixture-ecdsa384');
    expect(
      await addSshKey(
        env,
        { userId: second.user.id, publicKey: SSH_KEYS.ecdsa384.publicKey, name: '', ip: null },
        now,
      ),
    ).toEqual({
      ok: false,
      reason: 'This key is registered to another account.',
    });
    expect(
      await removeSshKey(env, { userId: second.user.id, keyId: added.key.id, ip: null }, now),
    ).toBe(false);
  });
});

describe('registering a key from a terminal', () => {
  it('approves with the code; the terminal sees approved and gets its HTTPS token once', async () => {
    const { user } = await signUp('sshrequest');
    const started = await startKeyRequest(
      env,
      { publicKey: SSH_KEYS.ecdsa521.publicKey, machine: 'coop-mbp', httpsToken: true },
      now,
    );
    if (!started.ok) throw new Error(started.reason);
    expect(started.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(started.fingerprint).toBe(SSH_KEYS.ecdsa521.fingerprint);
    expect(await pollKeyRequest(env, started.pollToken, now)).toEqual({ status: 'pending' });
    const view = await describeKeyRequest(
      env,
      { userCode: started.userCode.toLowerCase(), userId: user.id },
      now,
    );
    expect(view).toMatchObject({
      name: 'coop-mbp',
      keyType: 'ecdsa-sha2-nistp521',
      wantsHttpsToken: true,
    });
    expect(
      await decideKeyRequest(
        env,
        { userCode: started.userCode, userId: user.id, decision: 'approve', ip: null },
        now,
      ),
    ).toEqual({
      ok: true,
      approved: true,
    });
    const first = await pollKeyRequest(env, started.pollToken, now);
    if (first.status !== 'approved' || first.httpsToken === null)
      throw new Error('no token delivered');
    expect(first.handle).toBe('sshrequest');
    expect(await verifyUserToken(env, first.httpsToken.token, now)).toMatchObject({
      scopes: ['read', 'write'],
      token: { kind: 'personal' },
    });
    expect(await pollKeyRequest(env, started.pollToken, now)).toEqual({
      status: 'approved',
      handle: 'sshrequest',
      httpsToken: null,
    });
    expect(await findUserByKey(env, { fingerprint: SSH_KEYS.ecdsa521.fingerprint })).toMatchObject({
      user: { handle: 'sshrequest' },
    });
    expect(
      await decideKeyRequest(
        env,
        { userCode: started.userCode, userId: user.id, decision: 'approve', ip: null },
        now,
      ),
    ).toMatchObject({ ok: false });
    // Removing the key disconnects that machine: its HTTPS token goes too.
    const [key] = await listSshKeys(env, user.id);
    if (key === undefined) throw new Error('key not listed');
    await removeSshKey(env, { userId: user.id, keyId: key.id, ip: null }, now);
    expect(await verifyUserToken(env, first.httpsToken.token, now)).toBeNull();
  });

  it('gives the key and its HTTPS token the create scope when the person ticks it', async () => {
    const { user } = await signUp('sshcreate');
    const started = await startKeyRequest(
      env,
      {
        publicKey: SSH_KEYS.ecdsa521.publicKey,
        machine: 'agent-box',
        httpsToken: true,
        create: true,
      },
      now,
    );
    if (!started.ok) throw new Error(started.reason);
    expect(
      await describeKeyRequest(env, { userCode: started.userCode, userId: user.id }, now),
    ).toMatchObject({ wantsCreate: true });
    await decideKeyRequest(
      env,
      {
        userCode: started.userCode,
        userId: user.id,
        decision: 'approve',
        ip: null,
        mayCreate: true,
      },
      now,
    );
    const polled = await pollKeyRequest(env, started.pollToken, now);
    if (polled.status !== 'approved' || polled.httpsToken === null) throw new Error('no token');
    expect(await verifyUserToken(env, polled.httpsToken.token, now)).toMatchObject({
      scopes: ['read', 'write', 'create'],
    });
    expect(
      (await findUserByKey(env, { fingerprint: SSH_KEYS.ecdsa521.fingerprint }))?.scopes,
    ).toEqual(['read', 'write', 'create']);
  });

  it('is claimed by the first person to open it, can be denied, and expires', async () => {
    const owner = await signUp('sshclaim');
    const other = await signUp('sshother');
    const started = await startKeyRequest(
      env,
      { publicKey: SSH_KEYS.other.publicKey, machine: 'box', httpsToken: false },
      now,
    );
    if (!started.ok) throw new Error(started.reason);
    expect(
      await describeKeyRequest(env, { userCode: started.userCode, userId: owner.user.id }, now),
    ).not.toBeNull();
    expect(
      await describeKeyRequest(env, { userCode: started.userCode, userId: other.user.id }, now),
    ).toBeNull();
    expect(
      await decideKeyRequest(
        env,
        { userCode: started.userCode, userId: other.user.id, decision: 'approve', ip: null },
        now,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await decideKeyRequest(
        env,
        { userCode: started.userCode, userId: owner.user.id, decision: 'deny', ip: null },
        now,
      ),
    ).toEqual({ ok: true, approved: false });
    expect(await pollKeyRequest(env, started.pollToken, now)).toEqual({ status: 'denied' });
    expect(await listSshKeys(env, owner.user.id)).toEqual([]);

    const late = await startKeyRequest(
      env,
      { publicKey: SSH_KEYS.other.publicKey, machine: 'box', httpsToken: false },
      now,
    );
    if (!late.ok) throw new Error(late.reason);
    expect(await pollKeyRequest(env, late.pollToken, later)).toEqual({ status: 'expired' });
    expect(
      await describeKeyRequest(env, { userCode: late.userCode, userId: owner.user.id }, later),
    ).toBeNull();
    expect(await pollKeyRequest(env, 'x'.repeat(43), later)).toEqual({ status: 'expired' });
  });

  it('approves without a token when none was asked for', async () => {
    const { user } = await signUp('sshnotoken');
    const started = await startKeyRequest(
      env,
      { publicKey: SSH_KEYS.ecdsa256.publicKey, machine: 'ci', httpsToken: false },
      now,
    );
    if (!started.ok) throw new Error(started.reason);
    await decideKeyRequest(
      env,
      { userCode: started.userCode, userId: user.id, decision: 'approve', ip: null },
      now,
    );
    expect(await pollKeyRequest(env, started.pollToken, now)).toEqual({
      status: 'approved',
      handle: 'sshnotoken',
      httpsToken: null,
    });
  });

  it('refuses a request for a key Gitstalk cannot use', async () => {
    expect(
      await startKeyRequest(
        env,
        { publicKey: 'ssh-dss AAAA', machine: 'm', httpsToken: false },
        now,
      ),
    ).toMatchObject({ ok: false });
  });
});
