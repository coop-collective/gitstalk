/**
 * User tokens for git and APIs. Two kinds, one table, one verifier:
 * - personal access tokens, `bsu_…`: made by a person in Settings, named, scoped, expiring
 *   (at most a year), revocable, listed;
 * - session tokens, `bss_…`: minted for an agent's MCP (OAuth) session, at most an hour.
 * Only the SHA-256 of a token is stored; the plain token is returned once, at creation.
 */
import { z } from 'zod';

import { auditStatement, recordAudit } from './audit';
import type { Clock, IdentityEnv } from './identity-env';
import { systemClock } from './identity-env';
import type { Scope } from './scopes';
import { SCOPES, parseScopes } from './scopes';
import { hashSecret, isSameSecret, randomId, randomSecret } from './secrets';
import type { SessionUser } from './users';

export const PERSONAL_TOKEN_PREFIX = 'bsu_';
export const SESSION_TOKEN_PREFIX = 'bss_';

export type TokenKind = 'personal' | 'session';

/** Expiry choices offered for personal tokens; there is no "never". */
export const PERSONAL_TOKEN_DAYS = [7, 30, 90, 365] as const;
export const MAX_SESSION_TOKEN_SECONDS = 3600;

/** What `verifyUserToken` answers for a valid token. */
export type VerifiedUserToken = {
  readonly user: SessionUser;
  readonly scopes: readonly Scope[];
  readonly token: {
    readonly id: string;
    readonly kind: TokenKind;
    readonly expiresAt: number;
    /** The one repository (engine id) a bound session token opens; null: not bound. */
    readonly repository: string | null;
    /** The OAuth client a session token was minted for (MCP `git_credentials`); else null. */
    readonly clientId: string | null;
  };
};

export type TokenSummary = {
  readonly id: string;
  readonly kind: TokenKind;
  readonly name: string;
  readonly scopes: readonly Scope[];
  readonly hint: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
};

export type IssuedUserToken = { readonly token: string; readonly summary: TokenSummary };

export const PersonalTokenInput = z.strictObject({
  name: z.string().trim().min(1, 'name the token').max(60),
  scopes: z.array(z.enum(SCOPES)).min(1, 'pick at least one scope'),
  days: z.coerce
    .number()
    .int()
    .refine((days) => PERSONAL_TOKEN_DAYS.some((allowed) => allowed === days), 'pick an expiry'),
});
export type PersonalTokenInput = z.infer<typeof PersonalTokenInput>;

/** A token is the prefix and 43 base64url characters; anything else is not one of ours. */
const TOKEN_SHAPE = /^(bsu|bss)_[A-Za-z0-9_-]{43}$/;
/** `last_used_at` is written at most once a minute per token. */
const TOUCH_AFTER_MS = 60_000;

/** Creates a personal access token for a person (Settings → Tokens). Audited. */
export async function createPersonalToken(
  env: IdentityEnv,
  input: {
    readonly userId: string;
    readonly request: PersonalTokenInput;
    readonly ip?: string | null;
    /** What the token belongs to, so revoking that revokes it (`ssh-key:<id>` for setup's token). */
    readonly clientId?: string;
  },
  clock: Clock = systemClock,
): Promise<IssuedUserToken> {
  const now = clock();
  const expiresAt = now + input.request.days * 24 * 3600 * 1000;
  return issue(env, {
    userId: input.userId,
    kind: 'personal',
    name: input.request.name,
    scopes: parseScopes(input.request.scopes),
    expiresAt,
    clientId: input.clientId ?? null,
    repository: null,
    ip: input.ip ?? null,
    now,
  });
}

/**
 * Mints a short-lived token for an agent's MCP session (an OAuth grant), at most an hour,
 * never wider than the grant. Audited.
 */
export async function mintSessionToken(
  env: IdentityEnv,
  input: {
    readonly userId: string;
    readonly label: string;
    readonly scopes: readonly Scope[];
    readonly ttlSeconds?: number;
    /** The OAuth client of the agent session, so revoking its grant revokes these too. */
    readonly clientId?: string;
    /** Binds the token to one repository (its engine id): git opens only that one. */
    readonly repository?: string;
  },
  clock: Clock = systemClock,
): Promise<IssuedUserToken> {
  const now = clock();
  const ttl = Math.min(input.ttlSeconds ?? MAX_SESSION_TOKEN_SECONDS, MAX_SESSION_TOKEN_SECONDS);
  if (ttl <= 0 || input.scopes.length === 0)
    throw new Error('a session token needs a ttl and a scope');
  return issue(env, {
    userId: input.userId,
    kind: 'session',
    name: input.label.slice(0, 60),
    scopes: input.scopes,
    expiresAt: now + ttl * 1000,
    clientId: input.clientId ?? null,
    repository: input.repository ?? null,
    ip: null,
    now,
  });
}

/**
 * Who a `bsu_` or `bss_` token belongs to and what it may do, or null when it is malformed,
 * unknown, expired, revoked, or its owner is disabled. Never throws for bad input; never
 * logs the token. Gateway git credentials and MCP both call this.
 */
export async function verifyUserToken(
  env: IdentityEnv,
  token: string,
  clock: Clock = systemClock,
): Promise<VerifiedUserToken | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const tokenHash = await hashSecret(token);
  const now = clock();
  const row = await env.IDENTITY_DB.prepare(
    `SELECT t.id, t.kind, t.token_hash, t.scopes, t.expires_at, t.last_used_at, t.repository,
            t.oauth_client_id, u.id AS user_id, u.handle, u.email
       FROM user_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND u.disabled_at IS NULL`,
  )
    .bind(tokenHash, now)
    .first<TokenRow>();
  if (row === null || !(await isSameSecret(row.token_hash, tokenHash))) return null;
  if (row.kind !== kindOfPrefix(token)) return null;
  if (row.last_used_at === null || now - row.last_used_at > TOUCH_AFTER_MS)
    await touch(env, row.id, now);
  return {
    user: { id: row.user_id, handle: row.handle, email: row.email },
    scopes: parseScopes(row.scopes),
    token: {
      id: row.id,
      kind: row.kind,
      expiresAt: row.expires_at,
      repository: row.repository,
      clientId: row.oauth_client_id,
    },
  };
}

/** A person's tokens, newest first; revoked and expired ones stay listed for a week. */
export async function listUserTokens(
  env: IdentityEnv,
  userId: string,
  clock: Clock = systemClock,
): Promise<readonly TokenSummary[]> {
  const weekAgo = clock() - 7 * 24 * 3600 * 1000;
  const { results } = await env.IDENTITY_DB.prepare(
    `SELECT id, kind, name, scopes, hint, created_at, expires_at, last_used_at, revoked_at
       FROM user_tokens
      WHERE user_id = ? AND COALESCE(revoked_at, expires_at) > ?
      ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(userId, weekAgo)
    .all<SummaryRow>();
  return results.map(toSummary);
}

/** Revokes one of a person's tokens; false when it is not theirs or already revoked. Audited. */
export async function revokeUserToken(
  env: IdentityEnv,
  input: { readonly userId: string; readonly tokenId: string; readonly ip?: string | null },
  clock: Clock = systemClock,
): Promise<boolean> {
  const now = clock();
  const result = await env.IDENTITY_DB.prepare(
    'UPDATE user_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
  )
    .bind(now, input.tokenId, input.userId)
    .run();
  if (result.meta.changes === 0) return false;
  await recordAudit(
    env,
    {
      action: 'token.revoke',
      actorUserId: input.userId,
      target: input.tokenId,
      ip: input.ip ?? null,
    },
    now,
  );
  return true;
}

/** Revokes every session token minted for a person's OAuth client (when its grant is revoked). */
export async function revokeClientTokens(
  env: IdentityEnv,
  input: { readonly userId: string; readonly clientId: string },
  now: number,
): Promise<number> {
  const result = await env.IDENTITY_DB.prepare(
    'UPDATE user_tokens SET revoked_at = ? WHERE user_id = ? AND oauth_client_id = ? AND revoked_at IS NULL',
  )
    .bind(now, input.userId, input.clientId)
    .run();
  return result.meta.changes;
}

type TokenRow = {
  readonly id: string;
  readonly kind: TokenKind;
  readonly token_hash: string;
  readonly scopes: string;
  readonly expires_at: number;
  readonly last_used_at: number | null;
  readonly repository: string | null;
  readonly oauth_client_id: string | null;
  readonly user_id: string;
  readonly handle: string;
  readonly email: string | null;
};

type SummaryRow = {
  readonly id: string;
  readonly kind: TokenKind;
  readonly name: string;
  readonly scopes: string;
  readonly hint: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly last_used_at: number | null;
  readonly revoked_at: number | null;
};

async function issue(
  env: IdentityEnv,
  input: {
    readonly userId: string;
    readonly kind: TokenKind;
    readonly name: string;
    readonly scopes: readonly Scope[];
    readonly expiresAt: number;
    readonly clientId: string | null;
    readonly repository: string | null;
    readonly ip: string | null;
    readonly now: number;
  },
): Promise<IssuedUserToken> {
  const prefix = input.kind === 'personal' ? PERSONAL_TOKEN_PREFIX : SESSION_TOKEN_PREFIX;
  const token = `${prefix}${randomSecret()}`;
  const id = randomId('tok');
  const hint = `${prefix}…${token.slice(-4)}`;
  const scopes = input.scopes.join(' ');
  const insert = env.IDENTITY_DB.prepare(
    `INSERT INTO user_tokens (id, token_hash, user_id, kind, name, scopes, hint, created_at, expires_at, oauth_client_id, repository)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    await hashSecret(token),
    input.userId,
    input.kind,
    input.name,
    scopes,
    hint,
    input.now,
    input.expiresAt,
    input.clientId,
    input.repository,
  );
  const audit = await auditStatement(
    env,
    {
      action: input.kind === 'personal' ? 'token.create' : 'session_token.mint',
      actorUserId: input.userId,
      target: id,
      ip: input.ip,
      detail: {
        scopes: [...input.scopes],
        expires_at: input.expiresAt,
        ...(input.clientId === null ? {} : { client: input.clientId }),
        ...(input.repository === null ? {} : { repository: input.repository }),
      },
    },
    input.now,
  );
  await env.IDENTITY_DB.batch([insert, audit]);
  return {
    token,
    summary: {
      id,
      kind: input.kind,
      name: input.name,
      scopes: input.scopes,
      hint,
      createdAt: input.now,
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

function kindOfPrefix(token: string): TokenKind {
  return token.startsWith(PERSONAL_TOKEN_PREFIX) ? 'personal' : 'session';
}

async function touch(env: IdentityEnv, tokenId: string, now: number): Promise<void> {
  await env.IDENTITY_DB.prepare('UPDATE user_tokens SET last_used_at = ? WHERE id = ?')
    .bind(now, tokenId)
    .run();
}

function toSummary(row: SummaryRow): TokenSummary {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    scopes: parseScopes(row.scopes),
    hint: row.hint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
