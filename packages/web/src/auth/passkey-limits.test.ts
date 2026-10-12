import { describe, expect, it } from 'vitest';

import type { Limiter } from '@gitstalk/shared-identity/rate-limit';
import { isWithinLimits } from '@gitstalk/shared-identity/rate-limit';

import type { PasskeyStep } from './passkey-limits';
import { passkeyLimitKeys } from './passkey-limits';

/** The binding's shape in wrangler.jsonc: ten per key per window, one window for the test. */
function fixedWindowLimiter(limit: number): Limiter {
  const used = new Map<string, number>();
  return {
    limit: ({ key }) => {
      const count = (used.get(key) ?? 0) + 1;
      used.set(key, count);
      return Promise.resolve({ success: count <= limit });
    },
  };
}

const IP = '203.0.113.7';

function attempt(limiter: Limiter, step: PasskeyStep, handle?: string): Promise<boolean> {
  return isWithinLimits(limiter, passkeyLimitKeys({ step, ip: IP, handle }));
}

/** `times` requests of one step from the same IP; whether each was let through. */
function attempts(limiter: Limiter, step: PasskeyStep, times: number): Promise<boolean[]> {
  return Promise.all(Array.from({ length: times }, () => attempt(limiter, step)));
}

describe('passkey rate limits', () => {
  it('leaves verification attempts after the login page asked for options on every load', async () => {
    const limiter = fixedWindowLimiter(10);
    expect(await attempts(limiter, 'options', 10)).not.toContain(false);
    expect(await attempt(limiter, 'verify')).toBe(true);
  });

  it('still limits verification per IP', async () => {
    const limiter = fixedWindowLimiter(10);
    expect(await attempts(limiter, 'verify', 10)).not.toContain(false);
    expect(await attempt(limiter, 'verify')).toBe(false);
  });

  it('still limits option requests per IP, on their own budget', async () => {
    const limiter = fixedWindowLimiter(10);
    await attempts(limiter, 'options', 10);
    expect(await attempt(limiter, 'options')).toBe(false);
  });

  it('counts sign-up options against the handle as well, whatever its case', () => {
    expect(passkeyLimitKeys({ step: 'options', ip: IP, handle: 'Ada' })).toContain('handle:ada');
    expect(passkeyLimitKeys({ step: 'verify', ip: IP, handle: 'Ada' })).not.toContain('handle:ada');
  });
});
