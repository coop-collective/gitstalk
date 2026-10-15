/**
 * "Add this SSH key to my account", asked from a terminal and approved in a browser: the
 * device-authorization pattern of RFC 8628 applied to key registration. The setup script
 * sends the public key and the machine's name and gets a short user code (typed, or carried
 * in the link it opens) and a poll secret; the signed-in person sees the key's fingerprint
 * beside the code and approves with their session (a passkey only when signed out); the
 * script polls the outcome.
 *
 * Until the SSH endpoint is live the script also asks for an HTTPS token: the first poll
 * after approval mints a personal token (`git on <machine>`, read and write, 90 days) and
 * hands it over once; after that the request can never yield another.
 *
 * The person also chooses whether the key (and its token) may create repositories by pushing
 * to a new address (the `create` scope); the approval page ticks it by default.
 *
 * Only public keys travel. Requests live ten minutes in D1 and are decided once.
 */
import { recordAudit } from './audit';
import type { Clock, IdentityEnv } from './identity-env';
import { systemClock } from './identity-env';
import { hashSecret, randomId, randomSecret } from './secrets';
import {
  KEY_ALREADY_YOURS,
  activeKeyId,
  addSshKey,
  keyMayCreate,
  keyTokenClient,
  setKeyMayCreate,
} from './ssh-keys';
import { parsePublicKeyLine } from './ssh-wire';
import { PersonalTokenInput, createPersonalToken } from './user-tokens';

export const KEY_REQUEST_SECONDS = 600;
export const KEY_REQUEST_POLL_SECONDS = 3;
const HTTPS_TOKEN_DAYS = 90;
/** RFC 8628 §6.1: no vowels (no words), no lookalikes; 20^8 codes, shown with a hyphen. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export type StartedKeyRequest = {
  readonly userCode: string;
  readonly pollToken: string;
  readonly fingerprint: string;
  readonly expiresIn: number;
};

export type KeyRequestView = {
  readonly name: string;
  readonly keyType: string;
  readonly fingerprint: string;
  readonly wantsHttpsToken: boolean;
  /** The terminal asked for the `create` scope: the page offers it, ticked by default. */
  readonly wantsCreate: boolean;
  readonly expiresAt: number;
};

export type KeyRequestPoll =
  | { readonly status: 'pending' | 'denied' | 'expired' }
  | {
      readonly status: 'approved';
      readonly handle: string;
      /** Set once, on the first poll after approval, when the terminal asked for one. */
      readonly httpsToken: { readonly token: string; readonly expiresAt: number } | null;
    };

export type KeyDecision =
  | { readonly ok: true; readonly approved: boolean }
  | { readonly ok: false; readonly reason: string };

/** Starts a request for a public key; refused when the key line is not one Gitstalk takes. */
export async function startKeyRequest(
  env: IdentityEnv,
  input: {
    readonly publicKey: string;
    readonly machine: string;
    readonly httpsToken: boolean;
    /** The setup script asks for `create` so the key and its token may create repositories. */
    readonly create?: boolean;
  },
  clock: Clock = systemClock,
): Promise<
  ({ readonly ok: true } & StartedKeyRequest) | { readonly ok: false; readonly reason: string }
> {
  const parsed = await parsePublicKeyLine(input.publicKey);
  if (!parsed.ok) return parsed;
  const userCode = newUserCode();
  const pollToken = randomSecret();
  const now = clock();
  await env.IDENTITY_DB.prepare(
    `INSERT INTO ssh_key_requests (id, user_code_hash, poll_hash, public_key, key_type, fingerprint,
       name, status, wants_https_token, wants_create, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  )
    .bind(
      randomId('kreq'),
      await hashSecret(normalUserCode(userCode)),
      await hashSecret(pollToken),
      input.publicKey.trim().slice(0, 16_384),
      parsed.key.type,
      parsed.fingerprint,
      machineName(input.machine),
      input.httpsToken ? 1 : 0,
      input.create === true ? 1 : 0,
      now,
      now + KEY_REQUEST_SECONDS * 1000,
    )
    .run();
  return {
    ok: true,
    userCode,
    pollToken,
    fingerprint: parsed.fingerprint,
    expiresIn: KEY_REQUEST_SECONDS,
  };
}

/**
 * The pending request behind a user code, claimed by the person looking (so a code seen over
 * a shoulder cannot be approved by another account first); null when it is unknown, decided,
 * expired or claimed by someone else.
 */
export async function describeKeyRequest(
  env: IdentityEnv,
  input: { readonly userCode: string; readonly userId: string },
  clock: Clock = systemClock,
): Promise<KeyRequestView | null> {
  const row = await pendingRequest(env, input.userCode, clock());
  if (row === null || (row.user_id !== null && row.user_id !== input.userId)) return null;
  if (row.user_id === null)
    await env.IDENTITY_DB.prepare(
      'UPDATE ssh_key_requests SET user_id = ? WHERE id = ? AND user_id IS NULL',
    )
      .bind(input.userId, row.id)
      .run();
  return {
    name: row.name,
    keyType: row.key_type,
    fingerprint: row.fingerprint,
    wantsHttpsToken: row.wants_https_token === 1,
    wantsCreate: row.wants_create === 1,
    expiresAt: row.expires_at,
  };
}

/** Approves (registers the key) or denies a pending request for the person deciding. */
export async function decideKeyRequest(
  env: IdentityEnv,
  input: {
    readonly userCode: string;
    readonly userId: string;
    readonly decision: 'approve' | 'deny';
    readonly ip: string | null;
    /**
     * The person left "may create repositories" ticked: the key (and its HTTPS token) get the
     * `create` scope, when the terminal asked for it.
     */
    readonly mayCreate?: boolean;
  },
  clock: Clock = systemClock,
): Promise<KeyDecision> {
  const now = clock();
  const row = await pendingRequest(env, input.userCode, now);
  if (row === null || (row.user_id !== null && row.user_id !== input.userId))
    return { ok: false, reason: 'This request expired or was already answered. Run setup again.' };
  const approved = input.decision === 'approve';
  if (approved) {
    const added = await addSshKey(
      env,
      { userId: input.userId, publicKey: row.public_key, name: row.name, ip: input.ip },
      clock,
    );
    if (!added.ok && added.reason !== KEY_ALREADY_YOURS) return added;
    await setKeyMayCreate(env, {
      userId: input.userId,
      fingerprint: row.fingerprint,
      mayCreate: input.mayCreate === true && row.wants_create === 1,
    });
  } else
    await recordAudit(
      env,
      {
        action: 'ssh_key.deny',
        actorUserId: input.userId,
        target: row.id,
        ip: input.ip,
        detail: { fingerprint: row.fingerprint },
      },
      now,
    );
  await env.IDENTITY_DB.prepare(
    "UPDATE ssh_key_requests SET status = ?, user_id = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(approved ? 'approved' : 'denied', input.userId, row.id)
    .run();
  return { ok: true, approved };
}

/** What the terminal polling with its secret learns: the outcome, and its HTTPS token once. */
export async function pollKeyRequest(
  env: IdentityEnv,
  pollToken: string,
  clock: Clock = systemClock,
): Promise<KeyRequestPoll> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(pollToken)) return { status: 'expired' };
  const row = await env.IDENTITY_DB.prepare(
    `SELECT r.id, r.status, r.expires_at, r.name, r.fingerprint, r.wants_https_token, r.token_delivered_at, r.user_id, u.handle
       FROM ssh_key_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.poll_hash = ?`,
  )
    .bind(await hashSecret(pollToken))
    .first<PollRow>();
  const now = clock();
  if (row === null) return { status: 'expired' };
  if (row.status === 'pending') return { status: row.expires_at <= now ? 'expired' : 'pending' };
  if (row.status === 'denied' || row.user_id === null || row.handle === null)
    return { status: 'denied' };
  return {
    status: 'approved',
    handle: row.handle,
    httpsToken: await deliverToken(env, { ...row, user_id: row.user_id }, clock),
  };
}

/** User codes are compared without case, spaces or hyphens: `bcdf-ghjk` is `BCDFGHJK`. */
export function normalUserCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z]/g, '');
}

type RequestRow = {
  readonly id: string;
  readonly public_key: string;
  readonly key_type: string;
  readonly fingerprint: string;
  readonly name: string;
  readonly user_id: string | null;
  readonly wants_https_token: number;
  readonly wants_create: number;
  readonly expires_at: number;
};

type PollRow = {
  readonly id: string;
  readonly status: 'pending' | 'approved' | 'denied';
  readonly expires_at: number;
  readonly name: string;
  readonly fingerprint: string;
  readonly wants_https_token: number;
  readonly token_delivered_at: number | null;
  readonly user_id: string | null;
  readonly handle: string | null;
};

/** Mints the HTTPS token at most once per request (the guarded UPDATE decides who mints). */
async function deliverToken(
  env: IdentityEnv,
  row: PollRow & { readonly user_id: string },
  clock: Clock,
): Promise<{ readonly token: string; readonly expiresAt: number } | null> {
  if (row.wants_https_token !== 1 || row.token_delivered_at !== null) return null;
  const now = clock();
  const claimed = await env.IDENTITY_DB.prepare(
    'UPDATE ssh_key_requests SET token_delivered_at = ? WHERE id = ? AND token_delivered_at IS NULL',
  )
    .bind(now, row.id)
    .run();
  if (claimed.meta.changes === 0) return null;
  const keyId = await activeKeyId(env, { userId: row.user_id, fingerprint: row.fingerprint });
  if (keyId === null) return null;
  const request = PersonalTokenInput.parse({
    name: `git on ${row.name}`.slice(0, 60),
    scopes: (await keyMayCreate(env, keyId)) ? ['read', 'write', 'create'] : ['read', 'write'],
    days: HTTPS_TOKEN_DAYS,
  });
  const issued = await createPersonalToken(
    env,
    { userId: row.user_id, request, ip: null, clientId: keyTokenClient(keyId) },
    clock,
  );
  return { token: issued.token, expiresAt: issued.summary.expiresAt };
}

async function pendingRequest(
  env: IdentityEnv,
  userCode: string,
  now: number,
): Promise<RequestRow | null> {
  const code = normalUserCode(userCode);
  if (code.length !== 8) return null;
  return env.IDENTITY_DB.prepare(
    `SELECT id, public_key, key_type, fingerprint, name, user_id, wants_https_token, wants_create,
       expires_at FROM ssh_key_requests WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?`,
  )
    .bind(await hashSecret(code), now)
    .first<RequestRow>();
}

function machineName(machine: string): string {
  const host = machine
    .trim()
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .slice(0, 48);
  return host === '' ? 'a terminal' : host;
}

function newUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const letters = [...bytes].map(
    (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length] ?? 'B',
  );
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`;
}
