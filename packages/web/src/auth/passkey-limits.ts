/**
 * Which rate-limit budgets a passkey request spends (`SIGNIN_RATE_LIMIT`, per key). Asking for
 * options and verifying a passkey count separately: `/login` asks for sign-in options on every
 * load (the autofill ceremony waits in the background), so with one shared budget a few loads
 * of the page used up the attempts a person then needed to sign up or sign in. Verification
 * stays limited per IP on its own budget; options keep a budget too (each one stores a
 * challenge), plus one per handle on sign-up.
 */

export type PasskeyStep = 'options' | 'verify';

export function passkeyLimitKeys(input: {
  readonly step: PasskeyStep;
  readonly ip: string | null;
  /** The handle a sign-up asks options for. */
  readonly handle?: string | undefined;
}): readonly string[] {
  const ip = input.ip ?? 'unknown';
  if (input.step === 'verify') return [`passkey-verify-ip:${ip}`];
  const perHandle = input.handle === undefined ? [] : [`handle:${input.handle.toLowerCase()}`];
  return [`passkey-options-ip:${ip}`, ...perHandle];
}
