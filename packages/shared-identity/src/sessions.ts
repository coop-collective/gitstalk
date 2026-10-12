/**
 * Web sessions: an opaque 32-byte id in the `__Host-bs_session` cookie, its SHA-256 in D1,
 * 30 days sliding. Revocation is a row update; "sign out everywhere" revokes every row.
 */
import { auditStatement } from './audit';
import { SESSION_COOKIE, readCookie } from './cookies';
import type { Clock, IdentityEnv } from './identity-env';
import { systemClock } from './identity-env';
import { hashSecret, isSameSecret, randomSecret } from './secrets';
import type { SessionUser } from './users';

export const SESSION_SECONDS = 30 * 24 * 3600;
/** A session's expiry slides forward at most once a day (one write per day per session). */
const SLIDE_AFTER_MS = 24 * 3600 * 1000;
const MAX_COOKIE_LENGTH = 128;

export type WebSession = {
  readonly user: SessionUser;
  /** The session's at-rest id, for revoking this one session. */
  readonly sessionHash: string;
  /** A CSRF token for this session's forms (see `csrfTokenFor`). */
  readonly csrfToken: string;
};

export type NewSession = { readonly secret: string; readonly expiresAt: number };

/** How a person proved who they are; recorded on the audit row. */
export type SignInMethod = 'passkey' | 'email';

/**
 * The statements that open a session and audit it, for the caller to batch with its own
 * (a passkey's counter, a new user's row). Every sign-in method opens sessions this way.
 * `signup` audits `user.signup` (target: the handle), `signin` audits `session.signin`.
 */
export async function openSessionStatements(
  env: IdentityEnv,
  input: {
    readonly user: { readonly id: string; readonly handle: string };
    readonly kind: 'signin' | 'signup';
    readonly method: SignInMethod;
    readonly userAgent: string | null;
    readonly ip: string | null;
    readonly now: number;
  },
): Promise<{ readonly session: NewSession; readonly statements: D1PreparedStatement[] }> {
  const session = { secret: randomSecret(), expiresAt: input.now + SESSION_SECONDS * 1000 };
  const audit = await auditStatement(
    env,
    input.kind === 'signup'
      ? {
          action: 'user.signup',
          actorUserId: input.user.id,
          target: input.user.handle,
          ip: input.ip,
          detail: { method: input.method },
        }
      : {
          action: 'session.signin',
          actorUserId: input.user.id,
          ip: input.ip,
          detail: { method: input.method },
        },
    input.now,
  );
  const insert = await sessionInsert(
    env,
    { userId: input.user.id, userAgent: input.userAgent, ...session },
    input.now,
  );
  return { session, statements: [insert, audit] };
}

/** Opens a session for a user; the caller sets `secret` as the session cookie. */
export async function createSession(
  env: IdentityEnv,
  input: { readonly userId: string; readonly userAgent: string | null },
  now: number,
): Promise<NewSession> {
  const secret = randomSecret();
  const expiresAt = now + SESSION_SECONDS * 1000;
  await (await sessionInsert(env, { ...input, secret, expiresAt }, now)).run();
  return { secret, expiresAt };
}

/** The insert alone, for callers that batch it with the user's creation. */
export async function sessionInsert(
  env: IdentityEnv,
  input: {
    readonly userId: string;
    readonly userAgent: string | null;
    readonly secret: string;
    readonly expiresAt: number;
  },
  now: number,
): Promise<D1PreparedStatement> {
  return env.IDENTITY_DB.prepare(
    'INSERT INTO web_sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(
    await hashSecret(input.secret),
    input.userId,
    now,
    input.expiresAt,
    now,
    input.userAgent?.slice(0, 200) ?? null,
  );
}

/**
 * The signed-in person behind a request's session cookie, or null. The web app's
 * `requireUser` adapter is built on this; any Worker with the IDENTITY_DB binding can call it.
 */
export async function getSessionUser(
  request: Request,
  env: IdentityEnv,
  clock: Clock = systemClock,
): Promise<SessionUser | null> {
  const session = await getWebSession(request.headers.get('cookie'), env, clock);
  return session?.user ?? null;
}

/** The session behind a Cookie header, sliding its expiry; null when absent or invalid. */
export async function getWebSession(
  cookieHeader: string | null,
  env: IdentityEnv,
  clock: Clock = systemClock,
): Promise<WebSession | null> {
  const secret = readCookie(cookieHeader, SESSION_COOKIE);
  if (secret === null || secret.length > MAX_COOKIE_LENGTH) return null;
  const sessionHash = await hashSecret(secret);
  const now = clock();
  const row = await env.IDENTITY_DB.prepare(
    `SELECT s.expires_at, s.last_seen_at, u.id, u.handle, u.email
       FROM web_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled_at IS NULL`,
  )
    .bind(sessionHash, now)
    .first<{
      expires_at: number;
      last_seen_at: number;
      id: string;
      handle: string;
      email: string | null;
    }>();
  if (row === null) return null;
  if (now - row.last_seen_at > SLIDE_AFTER_MS) await slide(env, sessionHash, now);
  return {
    user: { id: row.id, handle: row.handle, email: row.email },
    sessionHash,
    csrfToken: await csrfTokenFor(secret),
  };
}

/**
 * The CSRF token for a session's forms: a hash of the session secret, which only this
 * browser's HttpOnly cookie holds, so another site can neither read nor forge it.
 */
export async function csrfTokenFor(sessionSecret: string): Promise<string> {
  return (await hashSecret(`csrf:${sessionSecret}`)).slice(0, 43);
}

/** Whether a submitted form's CSRF token belongs to the session (constant time). */
export async function isValidCsrf(session: WebSession, presented: unknown): Promise<boolean> {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return isSameSecret(presented, session.csrfToken);
}

export async function revokeSession(
  env: IdentityEnv,
  sessionHash: string,
  now: number,
): Promise<void> {
  await env.IDENTITY_DB.prepare(
    'UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL',
  )
    .bind(now, sessionHash)
    .run();
}

/** Signs a person out of every browser; returns how many sessions ended. */
export async function revokeAllSessions(
  env: IdentityEnv,
  userId: string,
  now: number,
): Promise<number> {
  const result = await env.IDENTITY_DB.prepare(
    'UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
  )
    .bind(now, userId)
    .run();
  return result.meta.changes;
}

/** A signed-in browser, as Settings lists it. */
export type BrowserSession = {
  /** The first 16 characters of the stored hash: names the row, opens nothing. */
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly isCurrent: boolean;
};

const BROWSER_ID_LENGTH = 16;

/** The person's live browser sessions, most recently used first. */
export async function listBrowserSessions(
  env: IdentityEnv,
  current: WebSession,
  now: number,
): Promise<readonly BrowserSession[]> {
  const { results } = await env.IDENTITY_DB.prepare(
    `SELECT id_hash, user_agent, created_at, last_seen_at FROM web_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_seen_at DESC LIMIT 50`,
  )
    .bind(current.user.id, now)
    .all<{
      id_hash: string;
      user_agent: string | null;
      created_at: number;
      last_seen_at: number;
    }>();
  return results.map((row) => ({
    id: row.id_hash.slice(0, BROWSER_ID_LENGTH),
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    isCurrent: row.id_hash === current.sessionHash,
  }));
}

/** Signs one of the person's other browsers out; false when it is not theirs or not live. */
export async function revokeBrowserSession(
  env: IdentityEnv,
  input: { readonly userId: string; readonly id: string; readonly now: number },
): Promise<boolean> {
  if (!/^[0-9a-f]{16}$/.test(input.id)) return false;
  const result = await env.IDENTITY_DB.prepare(
    `UPDATE web_sessions SET revoked_at = ?
      WHERE user_id = ? AND substr(id_hash, 1, ${BROWSER_ID_LENGTH}) = ? AND revoked_at IS NULL`,
  )
    .bind(input.now, input.userId, input.id)
    .run();
  return result.meta.changes > 0;
}

async function slide(env: IdentityEnv, sessionHash: string, now: number): Promise<void> {
  await env.IDENTITY_DB.prepare(
    'UPDATE web_sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?',
  )
    .bind(now, now + SESSION_SECONDS * 1000, sessionHash)
    .run();
}
