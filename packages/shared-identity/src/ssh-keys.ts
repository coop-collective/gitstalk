/**
 * People's SSH public keys, for git over SSH (`ssh://git@<ssh host>/<owner>/<repo>.git`).
 * A person registers a key once: `/gitstalk:setup` finds or makes one and asks, and the
 * browser approves (./ssh-key-requests.ts), or they paste it in Settings → SSH keys. The SSH
 * endpoint authenticates a connection's offered key with `findUserByKey` and records the
 * use with `touchKey`. Only public keys are stored; nothing here is a secret.
 */
import { auditStatement, recordAudit } from './audit';
import type { Clock, IdentityEnv } from './identity-env';
import { systemClock } from './identity-env';
import type { Scope } from './scopes';
import { randomId } from './secrets';
import { decodeBase64, encodeBase64, fingerprintOf, parsePublicKeyLine } from './ssh-wire';
import { revokeClientTokens } from './user-tokens';
import type { SessionUser } from './users';

/** The client id of the HTTPS token setup issued alongside a key: revoked with the key. */
export function keyTokenClient(keyId: string): string {
  return `ssh-key:${keyId}`;
}

/** The id of a person's live key with this fingerprint, if any. */
export async function activeKeyId(
  env: IdentityEnv,
  input: { readonly userId: string; readonly fingerprint: string },
): Promise<string | null> {
  const row = await env.IDENTITY_DB.prepare(
    'SELECT id FROM ssh_keys WHERE user_id = ? AND fingerprint = ? AND removed_at IS NULL',
  )
    .bind(input.userId, input.fingerprint)
    .first<{ readonly id: string }>();
  return row?.id ?? null;
}

/** What a key may do over SSH: read and push beans, as a person's git always could. */
export const SSH_KEY_SCOPES: readonly Scope[] = ['read', 'write'];
/** A key approved with "may create repositories" (setup ticks it): push-to-create as well. */
export const SSH_KEY_CREATE_SCOPES: readonly Scope[] = [...SSH_KEY_SCOPES, 'create'];
const TOUCH_AFTER_MS = 60_000;
const MAX_KEYS_PER_PERSON = 50;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export type SshKeySummary = {
  readonly id: string;
  readonly name: string;
  readonly keyType: string;
  readonly fingerprint: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
};

/** What the SSH endpoint learns about an offered key. */
export type KeyOwner = {
  readonly user: SessionUser;
  readonly scopes: readonly Scope[];
  readonly key: {
    readonly id: string;
    readonly fingerprint: string;
    readonly keyType: string;
    /** The wire-format key blob, to compare with the one the client proved it holds. */
    readonly blob: Uint8Array;
    readonly lastUsedAt: number | null;
  };
};

/** An offered key: its fingerprint (`SHA256:…`), its wire blob, or an `authorized_keys` line. */
export type KeyLookup =
  | { readonly fingerprint: string }
  | { readonly blob: Uint8Array }
  | { readonly publicKey: string };

export type AddKeyResult =
  | { readonly ok: true; readonly key: SshKeySummary }
  | { readonly ok: false; readonly reason: string };

/**
 * Who owns a registered, unremoved key, or null. The SSH endpoint calls this after the
 * client proves possession of the private key (the SSH userauth signature); this only maps
 * a public key to its person. Never throws for bad input.
 */
export async function findUserByKey(env: IdentityEnv, lookup: KeyLookup): Promise<KeyOwner | null> {
  const fingerprint = await lookupFingerprint(lookup);
  if (fingerprint === null) return null;
  const row = await env.IDENTITY_DB.prepare(
    `SELECT k.id, k.key_type, k.public_key, k.fingerprint, k.last_used_at, k.may_create,
            u.id AS user_id, u.handle, u.email
       FROM ssh_keys k JOIN users u ON u.id = k.user_id
      WHERE k.fingerprint = ? AND k.removed_at IS NULL AND u.disabled_at IS NULL`,
  )
    .bind(fingerprint)
    .first<KeyUserRow>();
  const blob = row === null ? null : decodeBase64(row.public_key);
  if (row === null || blob === null) return null;
  return {
    user: { id: row.user_id, handle: row.handle, email: row.email },
    scopes: row.may_create === 1 ? SSH_KEY_CREATE_SCOPES : SSH_KEY_SCOPES,
    key: {
      id: row.id,
      fingerprint: row.fingerprint,
      keyType: row.key_type,
      blob,
      lastUsedAt: row.last_used_at,
    },
  };
}

/**
 * Sets whether a person's live key with this fingerprint may create repositories by pushing
 * (the `create` scope); the person chooses when approving it through setup.
 */
export async function setKeyMayCreate(
  env: IdentityEnv,
  input: { readonly userId: string; readonly fingerprint: string; readonly mayCreate: boolean },
): Promise<void> {
  await env.IDENTITY_DB.prepare(
    'UPDATE ssh_keys SET may_create = ? WHERE user_id = ? AND fingerprint = ? AND removed_at IS NULL',
  )
    .bind(input.mayCreate ? 1 : 0, input.userId, input.fingerprint)
    .run();
}

/** Whether a key may create repositories (`setKeyMayCreate`); false for an unknown key. */
export async function keyMayCreate(env: IdentityEnv, keyId: string): Promise<boolean> {
  const row = await env.IDENTITY_DB.prepare('SELECT may_create FROM ssh_keys WHERE id = ?')
    .bind(keyId)
    .first<{ readonly may_create: number }>();
  return row?.may_create === 1;
}

/** Records that a key was used (at most one write a minute per key). */
export async function touchKey(
  env: IdentityEnv,
  key: { readonly id: string; readonly lastUsedAt: number | null },
  clock: Clock = systemClock,
): Promise<void> {
  const now = clock();
  if (key.lastUsedAt !== null && now - key.lastUsedAt <= TOUCH_AFTER_MS) return;
  await env.IDENTITY_DB.prepare('UPDATE ssh_keys SET last_used_at = ? WHERE id = ?')
    .bind(now, key.id)
    .run();
}

/** Registers a public key for a person. Audited. Refuses a key another account has. */
export async function addSshKey(
  env: IdentityEnv,
  input: {
    readonly userId: string;
    readonly publicKey: string;
    readonly name: string;
    readonly ip: string | null;
  },
  clock: Clock = systemClock,
): Promise<AddKeyResult> {
  const parsed = await parsePublicKeyLine(input.publicKey);
  if (!parsed.ok) return parsed;
  const refusal = await refusalFor(env, input.userId, parsed.fingerprint);
  if (refusal !== null) return { ok: false, reason: refusal };
  const now = clock();
  const key: SshKeySummary = {
    id: randomId('key'),
    name: keyName(input.name, parsed.comment),
    keyType: parsed.key.type,
    fingerprint: parsed.fingerprint,
    createdAt: now,
    lastUsedAt: null,
  };
  const insert = env.IDENTITY_DB.prepare(
    `INSERT INTO ssh_keys (id, user_id, name, key_type, public_key, fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    key.id,
    input.userId,
    key.name,
    key.keyType,
    encodeBase64(parsed.key.blob),
    key.fingerprint,
    now,
  );
  const audit = await auditStatement(
    env,
    {
      action: 'ssh_key.add',
      actorUserId: input.userId,
      target: key.id,
      ip: input.ip,
      detail: { fingerprint: key.fingerprint, type: key.keyType, name: key.name },
    },
    now,
  );
  await env.IDENTITY_DB.batch([insert, audit]);
  return { ok: true, key };
}

/** A person's keys, newest first. */
export async function listSshKeys(
  env: IdentityEnv,
  userId: string,
): Promise<readonly SshKeySummary[]> {
  const { results } = await env.IDENTITY_DB.prepare(
    `SELECT id, name, key_type, fingerprint, created_at, last_used_at
       FROM ssh_keys WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all<SummaryRow>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    keyType: row.key_type,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** Removes one of a person's keys: it stops opening SSH at once. Audited. */
export async function removeSshKey(
  env: IdentityEnv,
  input: { readonly userId: string; readonly keyId: string; readonly ip: string | null },
  clock: Clock = systemClock,
): Promise<boolean> {
  const now = clock();
  const result = await env.IDENTITY_DB.prepare(
    'UPDATE ssh_keys SET removed_at = ? WHERE id = ? AND user_id = ? AND removed_at IS NULL',
  )
    .bind(now, input.keyId, input.userId)
    .run();
  if (result.meta.changes === 0) return false;
  // The HTTPS token setup handed the same machine with this key goes with it.
  await revokeClientTokens(
    env,
    { userId: input.userId, clientId: keyTokenClient(input.keyId) },
    now,
  );
  await recordAudit(
    env,
    { action: 'ssh_key.remove', actorUserId: input.userId, target: input.keyId, ip: input.ip },
    now,
  );
  return true;
}

export const KEY_ALREADY_YOURS = 'This key is already on your account.';

async function refusalFor(
  env: IdentityEnv,
  userId: string,
  fingerprint: string,
): Promise<string | null> {
  const existing = await env.IDENTITY_DB.prepare(
    'SELECT user_id FROM ssh_keys WHERE fingerprint = ? AND removed_at IS NULL',
  )
    .bind(fingerprint)
    .first<{ readonly user_id: string }>();
  if (existing !== null)
    return existing.user_id === userId
      ? KEY_ALREADY_YOURS
      : 'This key is registered to another account.';
  const count = await env.IDENTITY_DB.prepare(
    'SELECT COUNT(*) AS n FROM ssh_keys WHERE user_id = ? AND removed_at IS NULL',
  )
    .bind(userId)
    .first<{ readonly n: number }>();
  return (count?.n ?? 0) >= MAX_KEYS_PER_PERSON ? 'Remove a key first: 50 is the limit.' : null;
}

async function lookupFingerprint(lookup: KeyLookup): Promise<string | null> {
  if ('fingerprint' in lookup)
    return FINGERPRINT.test(lookup.fingerprint) ? lookup.fingerprint : null;
  if ('blob' in lookup) return fingerprintOf(lookup.blob);
  const parsed = await parsePublicKeyLine(lookup.publicKey);
  return parsed.ok ? parsed.fingerprint : null;
}

function keyName(name: string, comment: string): string {
  const chosen = name.trim() === '' ? comment.trim() : name.trim();
  // oxlint-disable-next-line no-control-regex -- control characters are what this strips
  return (chosen === '' ? 'SSH key' : chosen).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60);
}

type KeyUserRow = {
  readonly id: string;
  readonly key_type: string;
  readonly public_key: string;
  readonly fingerprint: string;
  readonly last_used_at: number | null;
  readonly may_create: number;
  readonly user_id: string;
  readonly handle: string;
  readonly email: string | null;
};

type SummaryRow = {
  readonly id: string;
  readonly name: string;
  readonly key_type: string;
  readonly fingerprint: string;
  readonly created_at: number;
  readonly last_used_at: number | null;
};
