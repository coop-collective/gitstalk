/**
 * Six-digit email codes: the proof that someone reads an address, for signing in (or up) by
 * email and for adding an address in Settings.
 *
 * A code is random, ten minutes, single use and good for five tries. The browser that asked
 * holds a random ticket (a cookie); the row is keyed by the ticket's SHA-256 and the code is
 * stored only as an HMAC under a server secret (`EMAIL_SIGNIN_KEY`), so a database read alone
 * cannot recover a live code. An address gets at most five codes an hour, which with five
 * tries each bounds guessing at 25 in a million per hour. Asking never says whether the
 * address has an account: everyone gets the same mail and the same answer.
 */
import { auditStatement } from './audit';
import type { EmailPort } from './email';
import type { IdentityEnv } from './identity-env';
import { hashSecret, hmacHex, isSameSecret, randomDigits, randomSecret } from './secrets';

export const EMAIL_CODE_SECONDS = 10 * 60;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 5;
const HOUR_MS = 3600 * 1000;
const CODE_LENGTH = 6;
const MAX_TICKET_LENGTH = 64;

export type CodePurpose = 'signin' | 'add_email';

/** Email codes, when a deployment has a sender and a key; null otherwise (email is off). */
export type EmailCodeConfig = {
  readonly port: EmailPort;
  /** The HMAC key for code hashes and pending sign-ups. */
  readonly key: string;
};

export type IssuedCode =
  | { readonly ok: true; readonly ticket: string }
  | { readonly ok: false; readonly reason: 'too_many_codes' | 'expired' };

type CodeRequest = {
  readonly email: string;
  readonly purpose: CodePurpose;
  readonly userId: string | null;
  readonly ip: string | null;
  readonly now: number;
  /** Stable for one rendered form, including concurrent submissions and retries. */
  readonly requestId?: string;
};

export type VerifiedCode =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly reason: 'wrong_code'; readonly attemptsLeft: number }
  | { readonly ok: false; readonly reason: 'expired' };

/** The config, or null unless all three are present (sender domain, binding port, key). */
export function emailCodeConfig(input: {
  readonly port: EmailPort | null;
  readonly key: string | undefined;
}): EmailCodeConfig | null {
  const key = input.key?.trim() ?? '';
  if (input.port === null || key === '') return null;
  return { port: input.port, key };
}

/**
 * Sends a new code to `email` and answers the ticket the browser keeps. `userId` is the
 * signed-in person adding an address (`add_email`), null for sign-in.
 */
export async function issueEmailCode(
  env: IdentityEnv,
  config: EmailCodeConfig,
  input: CodeRequest,
): Promise<IssuedCode> {
  const ticket = await requestTicket(config.key, input);
  const ticketHash = await hashSecret(ticket);
  const code = randomDigits(CODE_LENGTH);
  const claimed = await reserveCode(env, input, {
    ticketHash,
    codeHash: await codeHash(config.key, ticketHash, code),
  });
  if (!claimed) return repeatedRequest(env, input, { ticket, ticketHash });
  try {
    const audit = await auditStatement(
      env,
      {
        action: 'email_code.send',
        actorUserId: input.userId,
        ip: input.ip,
        detail: { purpose: input.purpose },
      },
      input.now,
    );
    await audit.run();
    await config.port.send({ to: input.email, ...codeEmail(code, input.purpose) });
  } catch (error: unknown) {
    // Keep failed sends in the hourly budget, but never replay them as a usable ticket.
    await env.IDENTITY_DB.prepare('UPDATE email_codes SET expires_at = ? WHERE ticket_hash = ?')
      .bind(input.now, ticketHash)
      .run();
    throw error;
  }
  return { ok: true, ticket };
}

/**
 * Checks a code against the ticket's row. Every check spends one of the five tries first, so
 * parallel guesses cannot exceed them; the right code is then claimed once.
 */
export async function verifyEmailCode(
  env: IdentityEnv,
  key: string,
  input: {
    readonly ticket: string;
    readonly code: string;
    readonly purpose: CodePurpose;
    readonly userId: string | null;
    readonly now: number;
  },
): Promise<VerifiedCode> {
  if (input.ticket.length > MAX_TICKET_LENGTH) return { ok: false, reason: 'expired' };
  const ticketHash = await hashSecret(input.ticket);
  const row = await env.IDENTITY_DB.prepare(
    `UPDATE email_codes SET attempts = attempts + 1
      WHERE ticket_hash = ? AND purpose = ? AND user_id IS ? AND used_at IS NULL
        AND expires_at > ? AND attempts < ?
      RETURNING email, code_hash, attempts`,
  )
    .bind(ticketHash, input.purpose, input.userId, input.now, MAX_CODE_ATTEMPTS)
    .first<{ email: string; code_hash: string; attempts: number }>();
  if (row === null) return { ok: false, reason: 'expired' };
  const presented = await codeHash(key, ticketHash, normalizeCode(input.code));
  if (!(await isSameSecret(presented, row.code_hash)))
    return { ok: false, reason: 'wrong_code', attemptsLeft: MAX_CODE_ATTEMPTS - row.attempts };
  const claimed = await env.IDENTITY_DB.prepare(
    'UPDATE email_codes SET used_at = ? WHERE ticket_hash = ? AND used_at IS NULL',
  )
    .bind(input.now, ticketHash)
    .run();
  return claimed.meta.changes === 0
    ? { ok: false, reason: 'expired' }
    : { ok: true, email: row.email };
}

/** The address a live ticket's code went to (the code page shows it), or null. */
export async function emailForTicket(
  env: IdentityEnv,
  input: { readonly ticket: string; readonly purpose: CodePurpose; readonly now: number },
): Promise<string | null> {
  if (input.ticket.length > MAX_TICKET_LENGTH) return null;
  const row = await env.IDENTITY_DB.prepare(
    `SELECT email FROM email_codes
      WHERE ticket_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?`,
  )
    .bind(await hashSecret(input.ticket), input.purpose, input.now, MAX_CODE_ATTEMPTS)
    .first<{ email: string }>();
  return row?.email ?? null;
}

/** What a person types: digits, perhaps with spaces or a hyphen between them. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '');
}

/** The mail: the code in the subject (so a notification shows it), plain text and HTML. */
export function codeEmail(
  code: string,
  purpose: CodePurpose,
): { readonly subject: string; readonly text: string; readonly html: string } {
  const what = purpose === 'signin' ? 'sign-in' : 'verification';
  const text = `Your Gitstalk ${what} code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1c1c1c"><p>Your Gitstalk ${what} code is</p><p style="font-family:ui-monospace,monospace;font-size:28px;font-weight:700;letter-spacing:4px;margin:8px 0">${code}</p><p>It expires in 10 minutes. If you didn't ask for it, ignore this email.</p></body></html>`;
  return { subject: `${code} is your Gitstalk ${what} code`, text, html };
}

/** The cap and the claim are one write: only the inserting request may send mail. */
async function reserveCode(
  env: IdentityEnv,
  input: CodeRequest,
  hashes: { readonly ticketHash: string; readonly codeHash: string },
): Promise<boolean> {
  const results = await env.IDENTITY_DB.batch([
    env.IDENTITY_DB.prepare('DELETE FROM email_codes WHERE created_at <= ?').bind(
      input.now - HOUR_MS,
    ),
    env.IDENTITY_DB.prepare(
      `INSERT INTO email_codes (ticket_hash, email, purpose, user_id, code_hash, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM email_codes WHERE email = ? AND created_at > ?) < ?
       ON CONFLICT(ticket_hash) DO NOTHING`,
    ).bind(
      hashes.ticketHash,
      input.email,
      input.purpose,
      input.userId,
      hashes.codeHash,
      input.now,
      input.now + EMAIL_CODE_SECONDS * 1000,
      input.email,
      input.now - HOUR_MS,
      MAX_CODES_PER_HOUR,
    ),
  ]);
  return results[1]?.meta.changes === 1;
}

async function repeatedRequest(
  env: IdentityEnv,
  input: CodeRequest,
  ticket: { readonly ticket: string; readonly ticketHash: string },
): Promise<IssuedCode> {
  const row = await env.IDENTITY_DB.prepare(
    'SELECT expires_at, used_at, attempts FROM email_codes WHERE ticket_hash = ?',
  )
    .bind(ticket.ticketHash)
    .first<{ expires_at: number; used_at: number | null; attempts: number }>();
  if (row === null) return { ok: false, reason: 'too_many_codes' };
  if (row.expires_at <= input.now || row.used_at !== null || row.attempts >= MAX_CODE_ATTEMPTS)
    return { ok: false, reason: 'expired' };
  return { ok: true, ticket: ticket.ticket };
}

/** A form ID alone cannot reveal a ticket; bind it to its address, purpose and account. */
function requestTicket(key: string, input: CodeRequest): Promise<string> {
  if (input.requestId === undefined) return Promise.resolve(randomSecret());
  return hmacHex(
    key,
    JSON.stringify([
      'email-code-ticket',
      input.requestId,
      input.email.toLowerCase(),
      input.purpose,
      input.userId,
    ]),
  );
}

/** Bound to the ticket, so one row's code is no use against another's. */
function codeHash(key: string, ticketHash: string, code: string): Promise<string> {
  return hmacHex(key, `email-code:${ticketHash}:${code}`);
}
