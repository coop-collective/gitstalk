import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { listAudit } from '../src/audit';
import type { CodePurpose, EmailCodeConfig } from '../src/email-codes';
import {
  EMAIL_CODE_SECONDS,
  MAX_CODES_PER_HOUR,
  emailCodeConfig,
  emailForTicket,
  issueEmailCode,
  verifyEmailCode,
} from '../src/email-codes';
import { emailServicePort, signInSender } from '../src/email';
import {
  PENDING_SIGNUP_SECONDS,
  addVerifiedEmail,
  completeEmailSignup,
  readPendingSignup,
  signInWithVerifiedEmail,
} from '../src/email-sign-in';
import { getSessionUser } from '../src/sessions';
import { capturingEmailPort } from '../src/testing/capturing-email';
import { T0, signUp, withSession } from './helpers';

const KEY = 'test-email-signin-key';
const FACTS = { userAgent: 'Mozilla/5.0 (Macintosh)', ip: '198.51.100.1', now: T0 };

function setup() {
  const mail = capturingEmailPort();
  return { mail, config: { port: mail, key: KEY } };
}

async function issue(
  config: EmailCodeConfig,
  email: string,
  options: {
    readonly purpose?: CodePurpose;
    readonly userId?: string;
    readonly now?: number;
    readonly requestId?: string;
  } = {},
): Promise<string> {
  const issued = await issueEmailCode(env, config, {
    email,
    purpose: options.purpose ?? 'signin',
    userId: options.userId ?? null,
    ip: FACTS.ip,
    now: options.now ?? T0,
    requestId: options.requestId ?? crypto.randomUUID(),
  });
  if (!issued.ok) throw new Error(issued.reason);
  return issued.ticket;
}

function verify(
  ticket: string,
  code: string,
  options: { readonly purpose?: CodePurpose; readonly userId?: string; readonly now?: number } = {},
) {
  return verifyEmailCode(env, KEY, {
    ticket,
    code,
    purpose: options.purpose ?? 'signin',
    userId: options.userId ?? null,
    now: options.now ?? T0 + 1,
  });
}

/** A code that is certainly not the one sent. */
function otherCode(code: string): string {
  return code === '000000' ? '000001' : '000000';
}

describe('email configuration', () => {
  it('is off without a sender or without a key', () => {
    const { mail } = setup();
    expect(emailCodeConfig({ port: null, key: KEY })).toBeNull();
    expect(emailCodeConfig({ port: mail, key: undefined })).toBeNull();
    expect(emailCodeConfig({ port: mail, key: '  ' })).toBeNull();
    expect(emailCodeConfig({ port: mail, key: KEY })?.key).toBe(KEY);
  });

  it('sends through the Email Service binding from Gitstalk <signin@domain>', async () => {
    const calls: unknown[] = [];
    const port = emailServicePort(
      {
        async send(message: unknown) {
          calls.push(message);
          return { messageId: 'm1' };
        },
      },
      signInSender('gitstalk.test'),
    );
    await port.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>' });
    expect(calls).toEqual([
      {
        from: { email: 'signin@gitstalk.test', name: 'Gitstalk' },
        to: 'a@example.com',
        subject: 's',
        text: 't',
        html: '<p>t</p>',
      },
    ]);
  });
});

describe('email codes', () => {
  it('sends only one email when the same form is submitted concurrently', async () => {
    const { mail, config } = setup();
    const request = {
      email: 'duplicate@example.com',
      purpose: 'signin',
      userId: null,
      ip: FACTS.ip,
      now: T0,
      requestId: crypto.randomUUID(),
    } satisfies Parameters<typeof issueEmailCode>[2];

    const issued = await Promise.all([
      issueEmailCode(env, config, request),
      issueEmailCode(env, config, request),
    ]);

    expect(mail.sent).toHaveLength(1);
    expect(issued[0]).toEqual(issued[1]);
    const first = issued[0];
    if (!first?.ok) throw new Error('expected an email ticket');
    expect(await verify(first.ticket, mail.latestCode(request.email))).toEqual({
      ok: true,
      email: request.email,
    });
  });

  it('replays the same form at the hourly cap without sending or resetting its tries', async () => {
    const { mail, config } = setup();
    const requestId = crypto.randomUUID();
    const ticket = await issue(config, 'replayed@example.com', { requestId });
    const wrong = otherCode(mail.latestCode('replayed@example.com'));
    expect(await verify(ticket, wrong)).toMatchObject({ attemptsLeft: 4 });
    for (let sent = 1; sent < MAX_CODES_PER_HOUR; sent += 1)
      // oxlint-disable-next-line no-await-in-loop -- fill the hourly budget before replaying
      await issue(config, 'replayed@example.com');

    expect(await issue(config, 'replayed@example.com', { requestId })).toBe(ticket);
    expect(mail.sent).toHaveLength(MAX_CODES_PER_HOUR);
    expect(await verify(ticket, wrong)).toMatchObject({ attemptsLeft: 3 });
  });

  it('does not revive a used or expired code when its form is replayed', async () => {
    const { mail, config } = setup();
    const requestId = crypto.randomUUID();
    const ticket = await issue(config, 'used-form@example.com', { requestId });
    await verify(ticket, mail.latestCode('used-form@example.com'));
    await expect(issue(config, 'used-form@example.com', { requestId })).rejects.toThrow('expired');

    await issue(config, 'expired-form@example.com', { requestId });
    await expect(
      issue(config, 'expired-form@example.com', {
        requestId,
        now: T0 + EMAIL_CODE_SECONDS * 1000,
      }),
    ).rejects.toThrow('expired');
    expect(mail.sent).toHaveLength(2);
  });

  it('does not replay a failed delivery as a usable code', async () => {
    const { mail, config } = setup();
    const requestId = crypto.randomUUID();
    const unavailable = {
      ...config,
      port: {
        async send() {
          throw new Error('mail unavailable');
        },
      },
    };
    await expect(issue(unavailable, 'failed@example.com', { requestId })).rejects.toThrow(
      'mail unavailable',
    );
    await expect(issue(config, 'failed@example.com', { requestId })).rejects.toThrow('expired');
    await issue(config, 'failed@example.com');
    expect(mail.sent).toHaveLength(1);
  });

  it('binds a form request to its address, purpose and signed-in account', async () => {
    const { mail, config } = setup();
    const requestId = crypto.randomUUID();
    const one = await signUp('request-owner');
    const two = await signUp('request-other');
    const tickets = await Promise.all([
      issue(config, 'request@example.com', { requestId }),
      issue(config, 'other@example.com', { requestId }),
      issue(config, 'request@example.com', {
        requestId,
        purpose: 'add_email',
        userId: one.user.id,
      }),
      issue(config, 'request@example.com', {
        requestId,
        purpose: 'add_email',
        userId: two.user.id,
      }),
    ]);
    expect(new Set(tickets).size).toBe(4);
    expect(mail.sent).toHaveLength(4);
  });

  it('enforces the hourly cap when different forms arrive concurrently', async () => {
    const { mail, config } = setup();
    const outcomes = await Promise.allSettled(
      Array.from({ length: MAX_CODES_PER_HOUR + 2 }, () => issue(config, 'burst@example.com')),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(
      MAX_CODES_PER_HOUR,
    );
    expect(mail.sent).toHaveLength(MAX_CODES_PER_HOUR);
  });

  it('mails a six-digit code with the agreed text, stored only as an HMAC', async () => {
    const { mail, config } = setup();
    const ticket = await issue(config, 'code@example.com');
    const code = mail.latestCode('code@example.com');
    expect(code).toMatch(/^\d{6}$/);
    expect(mail.sent[0]?.text).toBe(
      `Your Gitstalk sign-in code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    );
    expect(mail.sent[0]?.html).toContain(code);
    expect(mail.sent[0]?.subject).toBe(`${code} is your Gitstalk sign-in code`);
    const stored = await env.IDENTITY_DB.prepare('SELECT * FROM email_codes').all();
    expect(JSON.stringify(stored.results)).not.toContain(code);
    expect(JSON.stringify(stored.results)).not.toContain(ticket);
    expect(await emailForTicket(env, { ticket, purpose: 'signin', now: T0 })).toBe(
      'code@example.com',
    );
  });

  it('accepts the right code once, with spaces typed in it', async () => {
    const { mail, config } = setup();
    const ticket = await issue(config, 'once@example.com');
    const code = mail.latestCode('once@example.com');
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(await verify(ticket, spaced)).toEqual({ ok: true, email: 'once@example.com' });
    expect(await verify(ticket, code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is useless without the ticket of the browser that asked', async () => {
    const { mail, config } = setup();
    await issue(config, 'ticket@example.com');
    const code = mail.latestCode('ticket@example.com');
    const other = await issue(config, 'attacker@example.com');
    expect((await verify(other, code)).ok).toBe(false);
    expect((await verify('not-a-ticket', code)).ok).toBe(false);
  });

  it('expires after ten minutes', async () => {
    const { mail, config } = setup();
    const ticket = await issue(config, 'late@example.com');
    const code = mail.latestCode('late@example.com');
    expect(await verify(ticket, code, { now: T0 + EMAIL_CODE_SECONDS * 1000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('allows five tries, then refuses even the right code', async () => {
    const { mail, config } = setup();
    const ticket = await issue(config, 'guess@example.com');
    const code = mail.latestCode('guess@example.com');
    const left: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tries are counted in order
      const outcome = await verify(ticket, otherCode(code));
      if (outcome.ok || outcome.reason !== 'wrong_code') throw new Error('expected wrong_code');
      left.push(outcome.attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect(await verify(ticket, code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('sends an address at most five codes an hour', async () => {
    const { config } = setup();
    for (let sent = 0; sent < MAX_CODES_PER_HOUR; sent += 1)
      // oxlint-disable-next-line no-await-in-loop -- the cap counts rows in order
      await issue(config, 'flood@example.com', { now: T0 + sent });
    const refused = await issueEmailCode(env, config, {
      email: 'flood@example.com',
      purpose: 'signin',
      userId: null,
      ip: null,
      now: T0 + 10,
    });
    expect(refused).toEqual({ ok: false, reason: 'too_many_codes' });
    await issue(config, 'flood@example.com', { now: T0 + 3600 * 1000 + 1 });
  });

  it('keeps sign-in codes and Settings codes apart', async () => {
    const { mail, config } = setup();
    const person = await signUp('codes-apart');
    const ticket = await issue(config, 'apart@example.com', {
      purpose: 'add_email',
      userId: person.user.id,
    });
    const code = mail.latestCode('apart@example.com');
    expect(mail.sent[0]?.text).toContain('verification code');
    expect((await verify(ticket, code)).ok).toBe(false);
    expect((await verify(ticket, code, { purpose: 'add_email', userId: 'u_someoneelse' })).ok).toBe(
      false,
    );
  });
});

describe('signing in by email', () => {
  it('answers an address with an account exactly as one without', async () => {
    const { mail, config } = setup();
    const person = await signUp('has-email');
    await addVerifiedEmail(env, {
      userId: person.user.id,
      email: 'known@example.com',
      ip: null,
      now: T0,
    });
    const known = await issueEmailCode(env, config, {
      email: 'known@example.com',
      purpose: 'signin',
      userId: null,
      ip: null,
      now: T0,
    });
    const unknown = await issueEmailCode(env, config, {
      email: 'unknown@example.com',
      purpose: 'signin',
      userId: null,
      ip: null,
      now: T0,
    });
    expect(Object.keys(known)).toEqual(Object.keys(unknown));
    expect(known.ok && unknown.ok).toBe(true);
    const [toKnown, toUnknown] = mail.sent;
    expect(toKnown?.text.replace(/\d{6}/, 'CODE')).toBe(toUnknown?.text.replace(/\d{6}/, 'CODE'));
    expect(toKnown?.subject.replace(/\d{6}/, 'CODE')).toBe(
      toUnknown?.subject.replace(/\d{6}/, 'CODE'),
    );
  });

  it('signs an existing account in with a session like a passkey sign-in', async () => {
    const person = await signUp('email-returns');
    await addVerifiedEmail(env, {
      userId: person.user.id,
      email: 'returns@example.com',
      ip: null,
      now: T0,
    });
    const outcome = await signInWithVerifiedEmail(env, KEY, {
      ...FACTS,
      email: 'returns@example.com',
    });
    if (outcome.kind !== 'signed_in') throw new Error('expected a sign-in');
    expect(outcome.created).toBe(false);
    expect(outcome.user).toEqual({
      id: person.user.id,
      handle: 'email-returns',
      email: 'returns@example.com',
    });
    expect(outcome.session.expiresAt - T0).toBe(person.session.expiresAt - T0);
    expect(await getSessionUser(withSession(outcome.session.secret), env, () => T0)).toEqual(
      outcome.user,
    );
    const audit = await listAudit(env, person.user.id);
    expect(audit.map((event) => [event.action, event.detail])).toContainEqual([
      'session.signin',
      '{"method":"email"}',
    ]);
  });

  it('asks a new address for a handle, then creates the account with it verified', async () => {
    const outcome = await signInWithVerifiedEmail(env, KEY, { ...FACTS, email: 'new@example.com' });
    if (outcome.kind !== 'choose_handle') throw new Error('expected the handle step');
    expect(await readPendingSignup(KEY, outcome.pending, T0 + 1)).toBe('new@example.com');
    const created = await completeEmailSignup(env, {
      ...FACTS,
      email: 'new@example.com',
      handle: 'newcomer',
    });
    if (created.kind !== 'signed_in') throw new Error('expected an account');
    expect(created.created).toBe(true);
    expect(created.user).toMatchObject({ handle: 'newcomer', email: 'new@example.com' });
    const row = await env.IDENTITY_DB.prepare(
      'SELECT email_verified_at FROM users WHERE handle = ?',
    )
      .bind('newcomer')
      .first<{ email_verified_at: number }>();
    expect(row?.email_verified_at).toBe(T0);
    expect((await listAudit(env, created.user.id)).map((event) => event.action)).toEqual([
      'user.signup',
    ]);
  });

  it('refuses a pending sign-up that is forged, for another key, or expired', async () => {
    const outcome = await signInWithVerifiedEmail(env, KEY, {
      ...FACTS,
      email: 'pending@example.com',
    });
    if (outcome.kind !== 'choose_handle') throw new Error('expected the handle step');
    const [payload, signature] = outcome.pending.split('.');
    const forged = `${btoa('victim@example.com\n9999999999999').replace(/=+$/, '')}.${signature}`;
    expect(await readPendingSignup(KEY, forged, T0)).toBeNull();
    expect(await readPendingSignup('another-key', outcome.pending, T0)).toBeNull();
    expect(await readPendingSignup(KEY, `${payload}.`, T0)).toBeNull();
    expect(await readPendingSignup(KEY, null, T0)).toBeNull();
    expect(
      await readPendingSignup(KEY, outcome.pending, T0 + PENDING_SIGNUP_SECONDS * 1000),
    ).toBeNull();
  });

  it('refuses a taken, retired or reserved handle at the handle step', async () => {
    await signUp('taken-one');
    expect(
      await completeEmailSignup(env, { ...FACTS, email: 'late@example.com', handle: 'taken-one' }),
    ).toEqual({ kind: 'handle_taken' });
    await env.IDENTITY_DB.prepare(
      'INSERT INTO retired_handles (handle, user_id, retired_at) SELECT ?, id, ? FROM users WHERE handle = ?',
    )
      .bind('old-name', T0, 'taken-one')
      .run();
    expect(
      await completeEmailSignup(env, { ...FACTS, email: 'late@example.com', handle: 'old-name' }),
    ).toEqual({ kind: 'handle_taken' });
  });

  it('signs in the account another tab created for the same address meanwhile', async () => {
    const first = await completeEmailSignup(env, {
      ...FACTS,
      email: 'twice@example.com',
      handle: 'twice-a',
    });
    const second = await completeEmailSignup(env, {
      ...FACTS,
      email: 'twice@example.com',
      handle: 'twice-b',
    });
    if (first.kind !== 'signed_in' || second.kind !== 'signed_in') throw new Error('both sign in');
    expect(second.user.id).toBe(first.user.id);
    expect(second.created).toBe(false);
  });
});

describe('adding an address in Settings', () => {
  it('verifies by code, then the address signs the passkey account in', async () => {
    const { mail, config } = setup();
    const person = await signUp('adds-email');
    const ticket = await issue(config, 'added@example.com', {
      purpose: 'add_email',
      userId: person.user.id,
    });
    const verified = await verify(ticket, mail.latestCode('added@example.com'), {
      purpose: 'add_email',
      userId: person.user.id,
    });
    if (!verified.ok) throw new Error(verified.reason);
    expect(
      await addVerifiedEmail(env, {
        userId: person.user.id,
        email: verified.email,
        ip: null,
        now: T0,
      }),
    ).toBe('added');
    const outcome = await signInWithVerifiedEmail(env, KEY, {
      ...FACTS,
      email: 'added@example.com',
    });
    expect(outcome.kind === 'signed_in' && outcome.user.id).toBe(person.user.id);
  });

  it('refuses an address another account has', async () => {
    const one = await signUp('email-owner');
    const two = await signUp('email-wanter');
    await addVerifiedEmail(env, {
      userId: one.user.id,
      email: 'mine@example.com',
      ip: null,
      now: T0,
    });
    expect(
      await addVerifiedEmail(env, {
        userId: two.user.id,
        email: 'MINE@example.com',
        ip: null,
        now: T0,
      }),
    ).toBe('email_taken');
  });
});
