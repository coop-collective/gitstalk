import { describe, expect, it } from 'vitest';

import { isBusyAnswer, retryWhileBusy } from './busy-retry';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An attempt that answers `answers` in turn, and the waits the retries asked for. */
function scripted(answers: readonly string[]) {
  const waits: number[] = [];
  let calls = 0;
  const attempt = async (): Promise<string> => {
    const answer = answers[Math.min(calls, answers.length - 1)] ?? 'none';
    calls += 1;
    return answer;
  };
  const policy = {
    wait: async (ms: number) => {
      waits.push(ms);
    },
    random: () => 0.5,
  };
  return { attempt, policy, waits, calls: () => calls };
}

const busy = (answer: string): boolean => answer === 'busy';
const failing = async (): Promise<string> => {
  throw new Error('timed out');
};

describe('retryWhileBusy', () => {
  it('returns the first answer that is not busy, after backing off once per busy answer', async () => {
    const run = scripted(['busy', 'busy', 'ok']);

    const retried = await retryWhileBusy(run.attempt, busy, run.policy);

    expect(retried).toEqual({ result: 'ok', busy: false, attempts: 3 });
    expect(run.waits).toEqual([200, 500]);
  });

  it('never retries an answer that is not busy', async () => {
    const run = scripted(['refused']);

    const retried = await retryWhileBusy(run.attempt, busy, run.policy);

    expect(retried).toEqual({ result: 'refused', busy: false, attempts: 1 });
    expect(run.waits).toEqual([]);
  });

  it('gives up busy after one retry per backoff step', async () => {
    const run = scripted(['busy']);

    const retried = await retryWhileBusy(run.attempt, busy, run.policy);

    expect(retried).toEqual({ result: 'busy', busy: true, attempts: 5 });
    expect(run.waits).toEqual([200, 500, 1000, 2000]);
    expect(run.calls()).toBe(5);
  });

  it('spreads the waits by jitter, within a quarter of each step', async () => {
    const low = scripted(['busy', 'ok']);
    const high = scripted(['busy', 'ok']);

    await retryWhileBusy(low.attempt, busy, { ...low.policy, random: () => 0 });
    await retryWhileBusy(high.attempt, busy, { ...high.policy, random: () => 0.999 });

    expect(low.waits).toEqual([150]);
    expect(high.waits).toEqual([250]);
  });

  it('does not retry when an attempt throws', async () => {
    const run = scripted(['busy']);
    await expect(retryWhileBusy(failing, busy, run.policy)).rejects.toThrow('timed out');
    expect(run.waits).toEqual([]);
  });
});

describe('isBusyAnswer', () => {
  it('reads a busy or rate-limited status as busy', () => {
    for (const status of [409, 429, 503])
      expect(isBusyAnswer({ status, bytes: new Uint8Array(0) })).toBe(true);
  });

  it('reads the Artifacts busy code in the body as busy, whatever the status', () => {
    expect(isBusyAnswer({ status: 500, bytes: encode('artifacts_git_receive_pack_busy\n') })).toBe(
      true,
    );
    expect(isBusyAnswer({ status: 200, bytes: encode('{"code":"REPO_BUSY"}') })).toBe(true);
  });

  it('reads other failures and reports as not busy', () => {
    expect(isBusyAnswer({ status: 401, bytes: encode('bad token') })).toBe(false);
    expect(isBusyAnswer({ status: 500, bytes: encode('internal error') })).toBe(false);
    expect(isBusyAnswer({ status: 200, bytes: encode('000eunpack ok\n0000') })).toBe(false);
  });
});
