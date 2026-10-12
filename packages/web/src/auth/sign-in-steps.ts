/**
 * The sign-in flow's addresses. `/login` and `/signup` are one flow (the wording differs);
 * each step is a query on the entry page, and `next` (a path on this site, `NextPath`) rides
 * along on every step so a person who came from `/connect?request=…` goes back there.
 *
 *   start    passkey button, or an email address
 *   code     the six-digit code sent to that address
 *   handle   a new address chooses a handle
 *   passkey  just signed up: offer to add a passkey (skippable)
 *
 * Settings → Emails reuses the code step at `/settings/emails?step=code`.
 */
import { z } from 'zod';

import { NextPath } from './http';

export type SignInMode = 'signin' | 'signup';

export const SignInStep = z.enum(['start', 'code', 'handle', 'passkey']).catch('start');
export type SignInStep = z.infer<typeof SignInStep>;

/** Why a step was sent back: shown above its form. */
export const StepError = z
  .enum([
    'address',
    'rate',
    'too_many_codes',
    'check',
    'send',
    'wrong_code',
    'expired',
    'handle',
    'handle_taken',
    'email_taken',
  ])
  .nullable()
  .catch(null);
export type StepError = z.infer<typeof StepError>;

type Query = Readonly<Record<string, string | string[] | undefined>>;

/** Where to go afterwards, from a page's query (`/` when absent or unsafe). */
export function nextFromQuery(query: Query): string {
  return NextPath.parse(firstValue(query['next']) ?? '/');
}

/** The step, error and attempts-left a page's query asks for. */
export function stepFromQuery(query: Query): {
  readonly step: SignInStep;
  readonly error: StepError;
  readonly attemptsLeft: number | null;
} {
  const left = Number(firstValue(query['left']));
  return {
    step: SignInStep.parse(firstValue(query['step'])),
    error: StepError.parse(firstValue(query['error'])),
    attemptsLeft: Number.isInteger(left) && left >= 0 ? left : null,
  };
}

/** The entry page for a mode. */
export function entryPath(mode: SignInMode): '/login' | '/signup' {
  return mode === 'signup' ? '/signup' : '/login';
}

/** A step of the flow, keeping `next` (dropped when it is just `/`). */
export function stepPath(
  mode: SignInMode,
  step: SignInStep,
  options: {
    readonly next: string;
    readonly error?: StepError;
    readonly attemptsLeft?: number;
  },
): string {
  const params = new URLSearchParams();
  if (step !== 'start') params.set('step', step);
  if (options.error !== undefined && options.error !== null) params.set('error', options.error);
  if (options.attemptsLeft !== undefined) params.set('left', String(options.attemptsLeft));
  const next = NextPath.parse(options.next);
  if (next !== '/') params.set('next', next);
  const query = params.toString();
  return query === '' ? entryPath(mode) : `${entryPath(mode)}?${query}`;
}

/** A form's mode field: anything but `signup` is sign-in. */
export function modeOf(value: unknown): SignInMode {
  return value === 'signup' ? 'signup' : 'signin';
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
