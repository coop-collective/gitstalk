/**
 * The email steps of sign-in and of Settings → Emails, behind `POST /api/auth/email/<step>`.
 * Plain form posts answered with a 303 to the next page, so they work without JavaScript:
 *
 *   start    address (+ Turnstile)   → code page, ticket cookie       (signed out)
 *   verify   code                    → signed in at `next`, or the handle page
 *   handle   handle                  → account created → passkey offer
 *   add      address                 → Settings code page             (signed in, CSRF)
 *   confirm  code                    → address saved
 *
 * Same origin only; rate limited per IP and per address; the answer to `start` is the same
 * whether or not the address has an account.
 */
import { env } from 'cloudflare:workers';

import {
  EMAIL_TICKET_COOKIE,
  PENDING_SIGNUP_COOKIE,
  clearCookie,
  readCookie,
  setCookie,
} from '@gitstalk/shared-identity/cookies';
import type { CodePurpose, EmailCodeConfig } from '@gitstalk/shared-identity/email-codes';
import {
  EMAIL_CODE_SECONDS,
  issueEmailCode,
  verifyEmailCode,
} from '@gitstalk/shared-identity/email-codes';
import {
  PENDING_SIGNUP_SECONDS,
  addVerifiedEmail,
  completeEmailSignup,
  readPendingSignup,
  signInWithVerifiedEmail,
} from '@gitstalk/shared-identity/email-sign-in';
import type { EmailSignedIn } from '@gitstalk/shared-identity/email-sign-in';
import { logIdentity, recordProductEvent } from '@gitstalk/shared-identity/product-events';
import { isWithinLimits } from '@gitstalk/shared-identity/rate-limit';
import { clientIp, userAgent } from '@gitstalk/shared-identity/request-context';
import { getWebSession } from '@gitstalk/shared-identity/sessions';
import { Email, Handle } from '@gitstalk/shared-identity/users';

import { log } from '../log';
import { NextPath, crossSiteRefusal, problem, seeOther, sessionCookie, signedInForm } from './http';
import { emailSignIn } from './services';
import type { SignInMode, StepError } from './sign-in-steps';
import { modeOf, stepPath } from './sign-in-steps';
import { TURNSTILE_FIELD, turnstileRefusal } from './turnstile';

export type EmailStep = 'start' | 'verify' | 'handle' | 'add' | 'confirm';

const STEPS: Readonly<
  Record<EmailStep, (request: Request, config: EmailCodeConfig) => Promise<Response>>
> = { start, verify, handle, add, confirm };

/** Runs one step; 404 while this deployment cannot send email. */
export async function emailStep(request: Request, step: EmailStep): Promise<Response> {
  const config = emailSignIn();
  if (config === null) return problem(404, 'not_found', 'email sign-in is not available');
  const refused = crossSiteRefusal(request);
  if (refused !== null) return refused;
  return STEPS[step](request, config);
}

/** The settings page's steps: `/settings/emails?step=code&error=…`. */
export function settingsEmailPath(
  options: { readonly step?: 'code'; readonly error?: StepError; readonly saved?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (options.step !== undefined) params.set('step', options.step);
  if (options.error !== undefined && options.error !== null) params.set('error', options.error);
  if (options.saved === true) params.set('email', 'added');
  const query = params.toString();
  return query === '' ? '/settings/emails' : `/settings/emails?${query}`;
}

async function start(request: Request, config: EmailCodeConfig): Promise<Response> {
  const form = await request.formData();
  const { mode, next } = flowOf(form);
  const back = (error: StepError) => seeOther(request, stepPath(mode, 'start', { next, error }));
  const email = Email.safeParse(form.get('email'));
  if (!email.success) return back('address');
  const ip = clientIp(request);
  if (!(await isWithinLimits(env.SIGNIN_RATE_LIMIT, [ipKey('send', ip), `email:${email.data}`])))
    return back('rate');
  if ((await turnstileRefusal(request, form.get(TURNSTILE_FIELD), mode)) !== null)
    return back('check');
  const issued = await sendCode(config, {
    email: email.data,
    purpose: 'signin',
    userId: null,
    ip,
  });
  if (!issued.ok) return back(issued.error);
  return seeOther(request, stepPath(mode, 'code', { next }), [ticketCookie(issued.ticket)]);
}

async function verify(request: Request, config: EmailCodeConfig): Promise<Response> {
  const form = await request.formData();
  const { mode, next } = flowOf(form);
  const ip = clientIp(request);
  if (!(await isWithinLimits(env.SIGNIN_RATE_LIMIT, [ipKey('code', ip)])))
    return seeOther(request, stepPath(mode, 'code', { next, error: 'rate' }));
  const now = Date.now();
  const checked = await verifyEmailCode(env, config.key, {
    ticket: readCookie(request.headers.get('cookie'), EMAIL_TICKET_COOKIE) ?? '',
    code: textField(form, 'code'),
    purpose: 'signin',
    userId: null,
    now,
  });
  if (!checked.ok)
    return checked.reason === 'expired'
      ? seeOther(request, stepPath(mode, 'start', { next, error: 'expired' }), [
          clearCookie(EMAIL_TICKET_COOKIE),
        ])
      : seeOther(
          request,
          stepPath(mode, 'code', { next, error: 'wrong_code', attemptsLeft: checked.attemptsLeft }),
        );
  const outcome = await signInWithVerifiedEmail(env, config.key, {
    email: checked.email,
    userAgent: userAgent(request),
    ip,
    now,
  });
  if (outcome.kind === 'signed_in') return signedIn(request, outcome, { mode, next, now });
  return seeOther(request, stepPath(mode, 'handle', { next }), [
    clearCookie(EMAIL_TICKET_COOKIE),
    setCookie(PENDING_SIGNUP_COOKIE, outcome.pending, PENDING_SIGNUP_SECONDS),
  ]);
}

async function handle(request: Request, config: EmailCodeConfig): Promise<Response> {
  const form = await request.formData();
  const { mode, next } = flowOf(form);
  const now = Date.now();
  const pending = readCookie(request.headers.get('cookie'), PENDING_SIGNUP_COOKIE);
  const email = await readPendingSignup(config.key, pending, now);
  if (email === null)
    return seeOther(request, stepPath(mode, 'start', { next, error: 'expired' }), [
      clearCookie(PENDING_SIGNUP_COOKIE),
    ]);
  const chosen = Handle.safeParse(form.get('handle'));
  if (!chosen.success)
    return seeOther(request, stepPath(mode, 'handle', { next, error: 'handle' }));
  const ip = clientIp(request);
  if (!(await isWithinLimits(env.SIGNIN_RATE_LIMIT, [ipKey('code', ip), `handle:${chosen.data}`])))
    return seeOther(request, stepPath(mode, 'handle', { next, error: 'rate' }));
  const created = await completeEmailSignup(env, {
    email,
    handle: chosen.data,
    userAgent: userAgent(request),
    ip,
    now,
  });
  if (created.kind === 'handle_taken')
    return seeOther(request, stepPath(mode, 'handle', { next, error: 'handle_taken' }));
  return signedIn(request, created, { mode, next, now });
}

async function add(request: Request, config: EmailCodeConfig): Promise<Response> {
  const checked = await signedInForm(request, (cookies) => getWebSession(cookies, env));
  if (checked instanceof Response) return checked;
  const { session, form } = checked;
  const back = (error: StepError) => seeOther(request, settingsEmailPath({ error }));
  const email = Email.safeParse(form.get('email'));
  if (!email.success) return back('address');
  const ip = clientIp(request);
  const keys = [ipKey('send', ip), `email:${email.data}`, `user:${session.user.id}`];
  if (!(await isWithinLimits(env.SIGNIN_RATE_LIMIT, keys))) return back('rate');
  const issued = await sendCode(config, {
    email: email.data,
    purpose: 'add_email',
    userId: session.user.id,
    ip,
  });
  if (!issued.ok) return back(issued.error);
  return seeOther(request, settingsEmailPath({ step: 'code' }), [ticketCookie(issued.ticket)]);
}

async function confirm(request: Request, config: EmailCodeConfig): Promise<Response> {
  const checked = await signedInForm(request, (cookies) => getWebSession(cookies, env));
  if (checked instanceof Response) return checked;
  const { session, form } = checked;
  const ip = clientIp(request);
  if (!(await isWithinLimits(env.SIGNIN_RATE_LIMIT, [ipKey('code', ip)])))
    return seeOther(request, settingsEmailPath({ step: 'code', error: 'rate' }));
  const now = Date.now();
  const verified = await verifyEmailCode(env, config.key, {
    ticket: readCookie(request.headers.get('cookie'), EMAIL_TICKET_COOKIE) ?? '',
    code: textField(form, 'code'),
    purpose: 'add_email',
    userId: session.user.id,
    now,
  });
  if (!verified.ok)
    return verified.reason === 'expired'
      ? seeOther(request, settingsEmailPath({ error: 'expired' }), [
          clearCookie(EMAIL_TICKET_COOKIE),
        ])
      : seeOther(request, settingsEmailPath({ step: 'code', error: 'wrong_code' }));
  const saved = await addVerifiedEmail(env, {
    userId: session.user.id,
    email: verified.email,
    ip,
    now,
  });
  return seeOther(
    request,
    saved === 'added'
      ? settingsEmailPath({ saved: true })
      : settingsEmailPath({ error: 'email_taken' }),
    [clearCookie(EMAIL_TICKET_COOKIE)],
  );
}

type Sent =
  | { readonly ok: true; readonly ticket: string }
  | { readonly ok: false; readonly error: 'too_many_codes' | 'send' };

/** Issues and sends a code; a sending failure is logged (never the address) and answered. */
async function sendCode(
  config: EmailCodeConfig,
  input: {
    readonly email: string;
    readonly purpose: CodePurpose;
    readonly userId: string | null;
    readonly ip: string | null;
  },
): Promise<Sent> {
  try {
    const issued = await issueEmailCode(env, config, { ...input, now: Date.now() });
    if (!issued.ok) return { ok: false, error: 'too_many_codes' };
    log.info('email code sent', { purpose: input.purpose });
    return { ok: true, ticket: issued.ticket };
  } catch (error: unknown) {
    log.error('email code not sent', { purpose: input.purpose, code: errorCode(error), error });
    return { ok: false, error: 'send' };
  }
}

async function signedIn(
  request: Request,
  outcome: EmailSignedIn,
  flow: { readonly mode: SignInMode; readonly next: string; readonly now: number },
): Promise<Response> {
  const who = await logIdentity({ userId: outcome.user.id });
  log.info(outcome.created ? 'signed up' : 'signed in', { method: 'email', ...who });
  if (outcome.created)
    await recordProductEvent(env.PRODUCT_EVENTS, 'signup', {
      userId: outcome.user.id,
      detail: 'email',
    });
  const destination = outcome.created
    ? stepPath(flow.mode, 'passkey', { next: flow.next })
    : flow.next;
  return seeOther(request, destination, [
    sessionCookie(outcome.session, flow.now),
    clearCookie(EMAIL_TICKET_COOKIE),
    clearCookie(PENDING_SIGNUP_COOKIE),
  ]);
}

function flowOf(form: FormData): { readonly mode: SignInMode; readonly next: string } {
  return { mode: modeOf(form.get('mode')), next: NextPath.parse(form.get('next') ?? '/') };
}

/** A text field's value; a missing field or a file reads as empty. */
function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function ticketCookie(ticket: string): string {
  return setCookie(EMAIL_TICKET_COOKIE, ticket, EMAIL_CODE_SECONDS);
}

/**
 * Per-IP budgets, separate from the passkey ceremonies' (whose autofill asks for options on
 * every sign-in page load): sending codes, and checking them (each code also has five tries).
 */
function ipKey(kind: 'send' | 'code', ip: string | null): string {
  return `email-${kind}-ip:${ip ?? 'unknown'}`;
}

/** The Email Service's error code (`E_…`), for the log. */
function errorCode(error: unknown): string {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : '';
  return typeof code === 'string' ? code : '';
}
