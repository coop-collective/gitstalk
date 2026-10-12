/**
 * What a verified email address does (`email-codes.ts` proves it): signs its account in, or,
 * with no account yet, hands back a short-lived signed "pending sign-up" that the handle step
 * turns into an account with that address already verified. Also adds a verified address to
 * a signed-in person (Settings → Emails). Sessions open exactly as for passkeys
 * (`openSessionStatements`).
 */
import { auditStatement } from './audit';
import type { IdentityEnv } from './identity-env';
import { base64UrlDecode, base64UrlEncode, hmacHex, isSameSecret, randomId } from './secrets';
import type { NewSession } from './sessions';
import { openSessionStatements } from './sessions';
import type { SessionUser } from './users';
import { findUserByEmail, insertUser, isHandleTaken, isUniqueViolation } from './users';

/** How long the handle step may take after the code. */
export const PENDING_SIGNUP_SECONDS = 15 * 60;

export type RequestFacts = {
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly now: number;
};

export type EmailSignedIn = {
  readonly kind: 'signed_in';
  readonly user: SessionUser;
  readonly session: NewSession;
  readonly created: boolean;
};

export type EmailSignInOutcome =
  | EmailSignedIn
  /** No account has this address: `pending` goes in a cookie until a handle is chosen. */
  | { readonly kind: 'choose_handle'; readonly pending: string };

/** Signs the address's account in, or starts a sign-up for it. */
export async function signInWithVerifiedEmail(
  env: IdentityEnv,
  key: string,
  input: RequestFacts & { readonly email: string },
): Promise<EmailSignInOutcome> {
  const user = await findUserByEmail(env, input.email);
  if (user === null)
    return { kind: 'choose_handle', pending: await pendingSignup(key, input.email, input.now) };
  return signIn(env, { ...input, user: { id: user.id, handle: user.handle, email: user.email } });
}

/** The verified address a pending sign-up is for, or null when forged, garbled or expired. */
export async function readPendingSignup(
  key: string,
  token: string | null,
  now: number,
): Promise<string | null> {
  const [payload, signature] = (token ?? '').split('.');
  if (payload === undefined || signature === undefined || payload.length > 512) return null;
  if (!(await isSameSecret(signature, await pendingSignature(key, payload)))) return null;
  const bytes = base64UrlDecode(payload);
  if (bytes === null) return null;
  const [email, expiresAt] = new TextDecoder().decode(bytes).split('\n');
  if (email === undefined || Number(expiresAt) <= now) return null;
  return email;
}

/**
 * The handle step: creates the account with the verified address and signs it in. If the
 * address got an account meanwhile (another tab), that account is signed in instead.
 */
export async function completeEmailSignup(
  env: IdentityEnv,
  input: RequestFacts & { readonly email: string; readonly handle: string },
): Promise<EmailSignedIn | { readonly kind: 'handle_taken' }> {
  if (await isHandleTaken(env, input.handle)) return { kind: 'handle_taken' };
  const user = { id: randomId('u'), handle: input.handle, email: input.email };
  const { session, statements } = await openSessionStatements(env, {
    user,
    kind: 'signup',
    method: 'email',
    userAgent: input.userAgent,
    ip: input.ip,
    now: input.now,
  });
  try {
    await env.IDENTITY_DB.batch([insertUser(env, user, input.now), ...statements]);
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await findUserByEmail(env, input.email);
    if (existing === null) return { kind: 'handle_taken' };
    return signIn(env, { ...input, user: existing });
  }
  return { kind: 'signed_in', user, session, created: true };
}

/** Settings: sets a signed-in person's verified address. */
export async function addVerifiedEmail(
  env: IdentityEnv,
  input: {
    readonly userId: string;
    readonly email: string;
    readonly ip: string | null;
    readonly now: number;
  },
): Promise<'added' | 'email_taken'> {
  try {
    await env.IDENTITY_DB.batch([
      env.IDENTITY_DB.prepare(
        'UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?',
      ).bind(input.email, input.now, input.userId),
      await auditStatement(
        env,
        { action: 'email.add', actorUserId: input.userId, ip: input.ip },
        input.now,
      ),
    ]);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return 'email_taken';
    throw error;
  }
  return 'added';
}

async function signIn(
  env: IdentityEnv,
  input: RequestFacts & { readonly user: SessionUser },
): Promise<EmailSignedIn> {
  const { session, statements } = await openSessionStatements(env, {
    user: input.user,
    kind: 'signin',
    method: 'email',
    userAgent: input.userAgent,
    ip: input.ip,
    now: input.now,
  });
  await env.IDENTITY_DB.batch(statements);
  const user = { id: input.user.id, handle: input.user.handle, email: input.user.email };
  return { kind: 'signed_in', user, session, created: false };
}

/** `base64url(email \n expiresAt) . HMAC`: tamper-evident, and useless after 15 minutes. */
async function pendingSignup(key: string, email: string, now: number): Promise<string> {
  const expiresAt = now + PENDING_SIGNUP_SECONDS * 1000;
  const payload = base64UrlEncode(new TextEncoder().encode(`${email}\n${expiresAt}`));
  return `${payload}.${await pendingSignature(key, payload)}`;
}

function pendingSignature(key: string, payload: string): Promise<string> {
  return hmacHex(key, `pending-signup:${payload}`);
}
