import { env } from 'cloudflare:workers';
import { z } from 'zod';

import { CHALLENGE_COOKIE, readCookie } from '@gitstalk/shared-identity/cookies';
import type { CeremonyContext, CeremonyFailure } from '@gitstalk/shared-identity/passkeys';
import {
  finishAddPasskey,
  finishPasskeySignin,
  finishPasskeySignup,
  startAddPasskey,
  startPasskeySignin,
  startPasskeySignup,
} from '@gitstalk/shared-identity/passkeys';
import { isWithinLimits } from '@gitstalk/shared-identity/rate-limit';
import { clientIp, userAgent } from '@gitstalk/shared-identity/request-context';
import { getWebSession, isValidCsrf } from '@gitstalk/shared-identity/sessions';
import { logIdentity, recordProductEvent } from '@gitstalk/shared-identity/product-events';
import { Handle } from '@gitstalk/shared-identity/users';
import {
  parseAuthenticationResponse,
  parseRegistrationResponse,
} from '@gitstalk/shared-identity/webauthn-json';

import {
  NextPath,
  challengeCookie,
  clearChallengeCookie,
  crossSiteRefusal,
  problem,
  relyingParty,
  sessionCookie,
} from '../../../../../src/auth/http';
import { turnstileProblem, turnstileRefusal } from '../../../../../src/auth/turnstile';
import { log } from '../../../../../src/log';

type Context = { readonly params: Promise<{ readonly ceremony: string }> };

const Ceremony = z.enum(['signup', 'signin', 'add']);
const Body = z.discriminatedUnion('step', [
  z.object({
    step: z.literal('options'),
    handle: z.string().max(64).optional(),
    /** The Turnstile token (sign-up and sign-in, when Turnstile is on). */
    turnstile: z.string().max(2048).optional(),
  }),
  z.object({
    step: z.literal('verify'),
    response: z.unknown(),
    next: z.string().max(300).optional(),
  }),
]);
type Body = z.infer<typeof Body>;

const MESSAGES: Readonly<Record<CeremonyFailure['reason'], string>> = {
  expired: 'That took too long. Try again.',
  handle_taken: 'That handle is taken. Pick another.',
  not_verified: 'The passkey could not be verified. Try again.',
  unknown_passkey: 'This site does not know that passkey. Sign up, or use another passkey.',
  passkey_exists: 'That passkey is already on your account.',
};

/**
 * Passkey ceremonies, two steps each (`options`, then `verify`): sign up (a new person with a
 * handle), sign in (any passkey of this site) and add (another passkey, signed in). JSON only,
 * same origin only, rate limited per IP (and per handle on sign-up).
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused !== null) return refused;
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json'))
    return problem(415, 'unsupported_media_type', 'send JSON');
  const ceremony = Ceremony.safeParse((await context.params).ceremony);
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!ceremony.success || !body.success)
    return problem(400, 'invalid_request', 'not a passkey request');
  const ip = clientIp(request);
  const keys = [
    `ip:${ip ?? 'unknown'}`,
    ...(body.data.step === 'options' && body.data.handle !== undefined
      ? [`handle:${body.data.handle.toLowerCase()}`]
      : []),
  ];
  if (!(await isWithinLimits(env.SIGNIN_RATE_LIMIT, keys)))
    return problem(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
  const challenged = await humanCheck(request, ceremony.data, body.data);
  if (challenged !== null) return challenged;
  try {
    return await CEREMONIES[ceremony.data](request, body.data);
  } catch (error: unknown) {
    log.error('passkey ceremony failed', { ceremony: ceremony.data, step: body.data.step, error });
    return problem(500, 'internal', 'Something went wrong. Try again.');
  }
}

async function signup(request: Request, body: Body): Promise<Response> {
  const now = Date.now();
  if (body.step === 'options') {
    const handle = Handle.safeParse(body.handle ?? '');
    if (!handle.success)
      return problem(400, 'invalid_handle', handle.error.issues[0]?.message ?? 'not a handle');
    const started = await startPasskeySignup(env, {
      handle: handle.data,
      rp: relyingParty(request),
      now,
    });
    if (!('options' in started)) return problem(409, started.reason, MESSAGES[started.reason]);
    return withChallenge(started.options, started.handle);
  }
  const response = parseRegistrationResponse(body.response);
  if (response === null) return problem(400, 'invalid_request', 'not a passkey response');
  const finished = await finishPasskeySignup(env, {
    handle: challengeOf(request),
    response,
    context: ceremonyContext(request, now),
  });
  if (!finished.ok) return problem(400, finished.reason, MESSAGES[finished.reason]);
  log.info('signed up', {
    method: 'passkey',
    ...(await logIdentity({ userId: finished.user.id })),
  });
  await recordProductEvent(env.PRODUCT_EVENTS, 'signup', {
    userId: finished.user.id,
    detail: 'passkey',
  });
  return signedIn(NextPath.parse(body.next ?? '/'), finished.session, now);
}

async function signin(request: Request, body: Body): Promise<Response> {
  const now = Date.now();
  if (body.step === 'options') {
    const started = await startPasskeySignin(env, { rp: relyingParty(request), now });
    return withChallenge(started.options, started.handle);
  }
  const response = parseAuthenticationResponse(body.response);
  if (response === null) return problem(400, 'invalid_request', 'not a passkey response');
  const finished = await finishPasskeySignin(env, {
    handle: challengeOf(request),
    response,
    context: ceremonyContext(request, now),
  });
  if (!finished.ok) return problem(400, finished.reason, MESSAGES[finished.reason]);
  log.info('signed in', {
    method: 'passkey',
    ...(await logIdentity({ userId: finished.user.id })),
  });
  return signedIn(NextPath.parse(body.next ?? '/'), finished.session, now);
}

async function add(request: Request, body: Body): Promise<Response> {
  const now = Date.now();
  const session = await getWebSession(request.headers.get('cookie'), env);
  if (session === null) return problem(401, 'unauthorized', 'Sign in first.');
  if (!(await isValidCsrf(session, request.headers.get('x-csrf-token'))))
    return problem(403, 'forbidden', 'Reload the page and try again.');
  if (body.step === 'options') {
    const started = await startAddPasskey(env, {
      user: session.user,
      rp: relyingParty(request),
      now,
    });
    return withChallenge(started.options, started.handle);
  }
  const response = parseRegistrationResponse(body.response);
  if (response === null) return problem(400, 'invalid_request', 'not a passkey response');
  const finished = await finishAddPasskey(env, {
    user: session.user,
    handle: challengeOf(request),
    response,
    context: ceremonyContext(request, now),
  });
  if (!finished.ok) return problem(400, finished.reason, MESSAGES[finished.reason]);
  // From Settings: back to the list. From the offer after an email sign-up: on to `next`.
  const redirect =
    body.next === undefined ? '/settings/passkeys?passkey=added' : NextPath.parse(body.next);
  return noStore(Response.json({ redirect }), [clearChallengeCookie()]);
}

/**
 * Turnstile guards the start of sign-up and sign-in (the options step; the verify step is
 * bound to that step's challenge). Adding a passkey is already signed in.
 */
async function humanCheck(
  request: Request,
  ceremony: z.infer<typeof Ceremony>,
  body: Body,
): Promise<Response | null> {
  if (ceremony === 'add' || body.step !== 'options') return null;
  const refusal = await turnstileRefusal(request, body.turnstile, ceremony);
  return refusal === null ? null : turnstileProblem(refusal);
}

const CEREMONIES: Readonly<
  Record<z.infer<typeof Ceremony>, (request: Request, body: Body) => Promise<Response>>
> = {
  signup,
  signin,
  add,
};

function withChallenge(options: unknown, handle: string): Response {
  return noStore(Response.json({ options }), [challengeCookie(handle)]);
}

function signedIn(
  next: string,
  session: { readonly secret: string; readonly expiresAt: number },
  now: number,
): Response {
  return noStore(Response.json({ redirect: next }), [
    sessionCookie(session, now),
    clearChallengeCookie(),
  ]);
}

function challengeOf(request: Request): string {
  return readCookie(request.headers.get('cookie'), CHALLENGE_COOKIE) ?? '';
}

function ceremonyContext(request: Request, now: number): CeremonyContext {
  return { rp: relyingParty(request), userAgent: userAgent(request), ip: clientIp(request), now };
}

function noStore(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  response.headers.set('cache-control', 'no-store');
  return response;
}
