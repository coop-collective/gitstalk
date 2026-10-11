/**
 * Passkeys (WebAuthn), the primary way to sign up and sign in. Ceremonies are verified in
 * the Worker with @simplewebauthn/server (a library on WebCrypto, not a service). Each
 * options request stores a single-use challenge for five minutes; the browser holds only a
 * random handle to it in the `__Host-bs_challenge` cookie.
 */
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import { auditStatement } from './audit';
import type { IdentityEnv } from './identity-env';
import { base64UrlDecode, base64UrlEncode, hashSecret, randomId, randomSecret } from './secrets';
import type { NewSession } from './sessions';
import { openSessionStatements } from './sessions';
import type { SessionUser } from './users';
import { findUserById, insertUser, isHandleTaken, isUniqueViolation } from './users';

/** The relying party: this site. `id` is the host name, `origin` the full origin. */
export type RelyingParty = { readonly id: string; readonly name: string; readonly origin: string };

export type Ceremony<Options> = {
  readonly options: Options;
  /** Goes in the challenge cookie; the server keeps only its hash. */
  readonly handle: string;
};

export type CeremonyContext = {
  readonly rp: RelyingParty;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly now: number;
};

export type SignedIn = {
  readonly ok: true;
  readonly user: SessionUser;
  readonly session: NewSession;
};

export type CeremonyFailure = {
  readonly ok: false;
  readonly reason:
    | 'expired'
    | 'handle_taken'
    | 'not_verified'
    | 'unknown_passkey'
    | 'passkey_exists';
};

export type PasskeySummary = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
};

const CHALLENGE_SECONDS = 300;
const TIMEOUT_MS = CHALLENGE_SECONDS * 1000;

/** Sign-up, step 1: registration options for a new person with this (free) handle. */
export async function startPasskeySignup(
  env: IdentityEnv,
  input: { readonly handle: string; readonly rp: RelyingParty; readonly now: number },
): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON> | CeremonyFailure> {
  if (await isHandleTaken(env, input.handle)) return { ok: false, reason: 'handle_taken' };
  const userId = randomId('u');
  const options = await generateRegistrationOptions({
    rpName: input.rp.name,
    rpID: input.rp.id,
    userName: input.handle,
    userID: utf8(userId),
    attestationType: 'none',
    timeout: TIMEOUT_MS,
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const handle = await storeChallenge(env, {
    purpose: 'signup',
    challenge: options.challenge,
    userId,
    handle: input.handle,
    now: input.now,
  });
  return { options, handle };
}

/** Sign-up, step 2: verifies the new passkey, creates the person and signs them in. */
export async function finishPasskeySignup(
  env: IdentityEnv,
  input: {
    readonly handle: string;
    readonly response: RegistrationResponseJSON;
    readonly context: CeremonyContext;
  },
): Promise<SignedIn | CeremonyFailure> {
  const { context } = input;
  const challenge = await takeChallenge(env, input.handle, 'signup', context.now);
  if (challenge === null || challenge.user_id === null || challenge.handle === null)
    return { ok: false, reason: 'expired' };
  const credential = await verifyNewPasskey(input.response, challenge.challenge, context.rp);
  if (credential === null) return { ok: false, reason: 'not_verified' };
  const user = { id: challenge.user_id, handle: challenge.handle, email: null };
  const { session, statements } = await openSessionStatements(env, {
    user,
    kind: 'signup',
    method: 'passkey',
    userAgent: context.userAgent,
    ip: context.ip,
    now: context.now,
  });
  try {
    await env.IDENTITY_DB.batch([
      insertUser(env, user, context.now),
      insertPasskey(env, {
        userId: user.id,
        credential,
        name: passkeyName(context.userAgent),
        now: context.now,
      }),
      ...statements,
    ]);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'handle_taken' };
    throw error;
  }
  return { ok: true, user, session };
}

/** Sign-in, step 1: options for any of this site's passkeys (discoverable credentials). */
export async function startPasskeySignin(
  env: IdentityEnv,
  input: { readonly rp: RelyingParty; readonly now: number },
): Promise<Ceremony<PublicKeyCredentialRequestOptionsJSON>> {
  const options = await generateAuthenticationOptions({
    rpID: input.rp.id,
    timeout: TIMEOUT_MS,
    userVerification: 'preferred',
  });
  const handle = await storeChallenge(env, {
    purpose: 'signin',
    challenge: options.challenge,
    userId: null,
    handle: null,
    now: input.now,
  });
  return { options, handle };
}

/** Sign-in, step 2: verifies the assertion against the stored passkey and opens a session. */
export async function finishPasskeySignin(
  env: IdentityEnv,
  input: {
    readonly handle: string;
    readonly response: AuthenticationResponseJSON;
    readonly context: CeremonyContext;
  },
): Promise<SignedIn | CeremonyFailure> {
  const { context } = input;
  const challenge = await takeChallenge(env, input.handle, 'signin', context.now);
  if (challenge === null) return { ok: false, reason: 'expired' };
  const stored = await findPasskey(env, input.response.id);
  if (stored === null) return { ok: false, reason: 'unknown_passkey' };
  const user = await findUserById(env, stored.user_id);
  if (user === null) return { ok: false, reason: 'unknown_passkey' };
  const verified = await verifyAssertion(input.response, challenge.challenge, {
    rp: context.rp,
    stored,
  });
  if (verified === null) return { ok: false, reason: 'not_verified' };
  const { session, statements } = await openSessionStatements(env, {
    user,
    kind: 'signin',
    method: 'passkey',
    userAgent: context.userAgent,
    ip: context.ip,
    now: context.now,
  });
  await env.IDENTITY_DB.batch([
    env.IDENTITY_DB.prepare(
      'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?',
    ).bind(verified.newCounter, context.now, stored.credential_id),
    ...statements,
  ]);
  return { ok: true, user: { id: user.id, handle: user.handle, email: user.email }, session };
}

/** Settings, step 1: options to add another passkey to a signed-in person. */
export async function startAddPasskey(
  env: IdentityEnv,
  input: { readonly user: SessionUser; readonly rp: RelyingParty; readonly now: number },
): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON>> {
  const existing = await listPasskeys(env, input.user.id);
  const options = await generateRegistrationOptions({
    rpName: input.rp.name,
    rpID: input.rp.id,
    userName: input.user.handle,
    userID: utf8(input.user.id),
    attestationType: 'none',
    timeout: TIMEOUT_MS,
    excludeCredentials: existing.map((passkey) => ({ id: passkey.id })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const handle = await storeChallenge(env, {
    purpose: 'add_passkey',
    challenge: options.challenge,
    userId: input.user.id,
    handle: null,
    now: input.now,
  });
  return { options, handle };
}

/** Settings, step 2: stores the verified passkey for the person who started the ceremony. */
export async function finishAddPasskey(
  env: IdentityEnv,
  input: {
    readonly user: SessionUser;
    readonly handle: string;
    readonly response: RegistrationResponseJSON;
    readonly context: CeremonyContext;
  },
): Promise<{ readonly ok: true } | CeremonyFailure> {
  const { context } = input;
  const challenge = await takeChallenge(env, input.handle, 'add_passkey', context.now);
  if (challenge === null || challenge.user_id !== input.user.id)
    return { ok: false, reason: 'expired' };
  const credential = await verifyNewPasskey(input.response, challenge.challenge, context.rp);
  if (credential === null) return { ok: false, reason: 'not_verified' };
  try {
    await env.IDENTITY_DB.batch([
      insertPasskey(env, {
        userId: input.user.id,
        credential,
        name: passkeyName(context.userAgent),
        now: context.now,
      }),
      await auditStatement(
        env,
        {
          action: 'passkey.add',
          actorUserId: input.user.id,
          target: credential.id,
          ip: context.ip,
        },
        context.now,
      ),
    ]);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'passkey_exists' };
    throw error;
  }
  return { ok: true };
}

export async function listPasskeys(
  env: IdentityEnv,
  userId: string,
): Promise<readonly PasskeySummary[]> {
  const { results } = await env.IDENTITY_DB.prepare(
    'SELECT credential_id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at',
  )
    .bind(userId)
    .all<{
      credential_id: string;
      name: string;
      created_at: number;
      last_used_at: number | null;
    }>();
  return results.map((row) => ({
    id: row.credential_id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Removes one of a person's passkeys. Refused for the last one when the person has no
 * verified email: it would lock them out.
 */
export async function removePasskey(
  env: IdentityEnv,
  input: {
    readonly user: SessionUser;
    readonly passkeyId: string;
    readonly ip: string | null;
    readonly now: number;
  },
): Promise<'removed' | 'not_found' | 'last_sign_in_method'> {
  const passkeys = await listPasskeys(env, input.user.id);
  if (!passkeys.some((passkey) => passkey.id === input.passkeyId)) return 'not_found';
  if (passkeys.length === 1 && input.user.email === null) return 'last_sign_in_method';
  await env.IDENTITY_DB.batch([
    env.IDENTITY_DB.prepare('DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?').bind(
      input.passkeyId,
      input.user.id,
    ),
    await auditStatement(
      env,
      {
        action: 'passkey.remove',
        actorUserId: input.user.id,
        target: input.passkeyId,
        ip: input.ip,
      },
      input.now,
    ),
  ]);
  return 'removed';
}

/** Longest passkey name, as people type it ("1Password", "MacBook Touch ID"). */
export const MAX_PASSKEY_NAME = 60;

/** Renames one of a person's passkeys; control characters become spaces. */
export async function renamePasskey(
  env: IdentityEnv,
  input: {
    readonly userId: string;
    readonly passkeyId: string;
    readonly name: string;
    readonly ip: string | null;
    readonly now: number;
  },
): Promise<'renamed' | 'not_found' | 'invalid_name'> {
  const name = input.name.replace(/\p{Cc}/gu, ' ').trim();
  if (name === '' || name.length > MAX_PASSKEY_NAME) return 'invalid_name';
  const passkeys = await listPasskeys(env, input.userId);
  if (!passkeys.some((passkey) => passkey.id === input.passkeyId)) return 'not_found';
  await env.IDENTITY_DB.batch([
    env.IDENTITY_DB.prepare(
      'UPDATE passkeys SET name = ? WHERE credential_id = ? AND user_id = ?',
    ).bind(name, input.passkeyId, input.userId),
    await auditStatement(
      env,
      {
        action: 'passkey.rename',
        actorUserId: input.userId,
        target: input.passkeyId,
        ip: input.ip,
      },
      input.now,
    ),
  ]);
  return 'renamed';
}

type ChallengeRow = {
  readonly challenge: string;
  readonly user_id: string | null;
  readonly handle: string | null;
};

type PasskeyRow = {
  readonly credential_id: string;
  readonly user_id: string;
  readonly public_key: string;
  readonly counter: number;
  readonly transports: string;
};

type NewPasskey = {
  readonly id: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[];
};

async function storeChallenge(
  env: IdentityEnv,
  input: {
    readonly purpose: 'signup' | 'signin' | 'add_passkey';
    readonly challenge: string;
    readonly userId: string | null;
    readonly handle: string | null;
    readonly now: number;
  },
): Promise<string> {
  const handle = randomSecret();
  await env.IDENTITY_DB.batch([
    // Housekeeping: ceremonies nobody finished.
    env.IDENTITY_DB.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').bind(input.now),
    env.IDENTITY_DB.prepare(
      'INSERT INTO auth_challenges (id_hash, purpose, challenge, user_id, handle, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      await hashSecret(handle),
      input.purpose,
      input.challenge,
      input.userId,
      input.handle,
      input.now + CHALLENGE_SECONDS * 1000,
    ),
  ]);
  return handle;
}

/** Deletes and returns a live challenge: each one is good for one verification. */
async function takeChallenge(
  env: IdentityEnv,
  handle: string,
  purpose: 'signup' | 'signin' | 'add_passkey',
  now: number,
): Promise<ChallengeRow | null> {
  if (handle.length > 64) return null;
  return env.IDENTITY_DB.prepare(
    'DELETE FROM auth_challenges WHERE id_hash = ? AND purpose = ? AND expires_at > ? RETURNING challenge, user_id, handle',
  )
    .bind(await hashSecret(handle), purpose, now)
    .first<ChallengeRow>();
}

async function verifyNewPasskey(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  rp: RelyingParty,
): Promise<NewPasskey | null> {
  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
    if (!verification.verified) return null;
    const { credential } = verification.registrationInfo;
    return {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? response.response.transports ?? [],
    };
  } catch {
    // The library throws for malformed or mismatched responses: not verified.
    return null;
  }
}

async function verifyAssertion(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  input: { readonly rp: RelyingParty; readonly stored: PasskeyRow },
): Promise<{ readonly newCounter: number } | null> {
  const publicKey = base64UrlDecode(input.stored.public_key);
  if (publicKey === null) return null;
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      requireUserVerification: false,
      credential: {
        id: input.stored.credential_id,
        publicKey,
        counter: input.stored.counter,
        transports: parseTransports(input.stored.transports),
      },
    });
    return verification.verified
      ? { newCounter: verification.authenticationInfo.newCounter }
      : null;
  } catch {
    // Bad signature, wrong origin or RP, or a counter that went backwards: not verified.
    return null;
  }
}

function insertPasskey(
  env: IdentityEnv,
  input: {
    readonly userId: string;
    readonly credential: NewPasskey;
    readonly name: string;
    readonly now: number;
  },
): D1PreparedStatement {
  const { credential } = input;
  return env.IDENTITY_DB.prepare(
    'INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    credential.id,
    input.userId,
    base64UrlEncode(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports),
    input.name,
    input.now,
  );
}

async function findPasskey(env: IdentityEnv, credentialId: string): Promise<PasskeyRow | null> {
  if (credentialId.length > 1400) return null;
  return env.IDENTITY_DB.prepare(
    'SELECT credential_id, user_id, public_key, counter, transports FROM passkeys WHERE credential_id = ?',
  )
    .bind(credentialId)
    .first<PasskeyRow>();
}

const TRANSPORTS: ReadonlySet<string> = new Set([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

function parseTransports(json: string): AuthenticatorTransport[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is AuthenticatorTransport =>
        typeof value === 'string' && TRANSPORTS.has(value),
    );
  } catch {
    // A row written by an older shape: no transport hints, which only affects the UI.
    return [];
  }
}

/** A readable default name for a new passkey, from the browser that made it. */
function passkeyName(userAgent: string | null): string {
  const agent = userAgent ?? '';
  const platform = [
    ['iPhone', 'iPhone'],
    ['iPad', 'iPad'],
    ['Android', 'Android'],
    ['Mac OS X', 'Mac'],
    ['Windows', 'Windows'],
    ['Linux', 'Linux'],
  ].find(([needle]) => needle !== undefined && agent.includes(needle));
  return platform?.[1] === undefined ? 'Passkey' : `Passkey on ${platform[1]}`;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}
