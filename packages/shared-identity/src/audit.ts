/**
 * Audit events: who did what to which credential or grant. Never carries a secret; IPs are
 * stored as a 16-character SHA-256 prefix, enough to correlate, not to read back.
 */
import type { IdentityEnv } from './identity-env';
import { hashSecret, randomId } from './secrets';

export type AuditAction =
  | 'user.signup'
  | 'session.signin'
  | 'session.signout'
  | 'session.signout_all'
  | 'passkey.add'
  | 'passkey.remove'
  | 'email_code.send'
  | 'email.add'
  | 'token.create'
  | 'token.revoke'
  | 'session_token.mint'
  | 'oauth.grant'
  | 'oauth.deny'
  | 'oauth.revoke'
  | 'ssh_key.add'
  | 'ssh_key.remove'
  | 'ssh_key.deny'
  | 'profile.update'
  | 'avatar.set'
  | 'handle.change'
  | 'passkey.rename'
  | 'session.revoke'
  | 'user.delete';

export type AuditEvent = {
  readonly action: AuditAction;
  readonly actorUserId: string | null;
  readonly target?: string;
  readonly ip?: string | null;
  readonly detail?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
};

export type AuditRecord = {
  readonly id: string;
  readonly at: number;
  readonly action: string;
  readonly target: string | null;
  readonly detail: string;
};

/** The statement recording one event; batch it with the change it describes. */
export async function auditStatement(
  env: IdentityEnv,
  event: AuditEvent,
  now: number,
): Promise<D1PreparedStatement> {
  const ipHash =
    event.ip === undefined || event.ip === null ? null : (await hashSecret(event.ip)).slice(0, 16);
  return env.IDENTITY_DB.prepare(
    'INSERT INTO audit_events (id, at, actor_user_id, action, target, ip_hash, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    randomId('ev'),
    now,
    event.actorUserId,
    event.action,
    event.target ?? null,
    ipHash,
    JSON.stringify(event.detail ?? {}),
  );
}

export async function recordAudit(env: IdentityEnv, event: AuditEvent, now: number): Promise<void> {
  await (await auditStatement(env, event, now)).run();
}

/** A person's recent events, newest first (the settings page and tests). */
export async function listAudit(
  env: IdentityEnv,
  userId: string,
  limit = 50,
): Promise<readonly AuditRecord[]> {
  const { results } = await env.IDENTITY_DB.prepare(
    'SELECT id, at, action, target, detail FROM audit_events WHERE actor_user_id = ? ORDER BY at DESC, id LIMIT ?',
  )
    .bind(userId, limit)
    .all<AuditRecord>();
  return results;
}
