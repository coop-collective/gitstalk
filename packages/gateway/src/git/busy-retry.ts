/**
 * Retrying a call while the other side says it is busy: Artifacts answers a receive-pack that
 * arrives while another push to the same repository is being applied with
 * `artifacts_git_receive_pack_busy`, and the same push succeeds a moment later. Only a busy
 * answer is retried, after a short, jittered backoff; every other answer is final.
 */

/** Waits before each retry (about 3.7 s in all): pushes to one repository clear in well under a second. */
export const BUSY_BACKOFF_MS: readonly number[] = [200, 500, 1000, 2000];

/** HTTP statuses a busy or rate-limited remote answers with. */
const BUSY_STATUSES: ReadonlySet<number> = new Set([409, 429, 503]);
/** `artifacts_git_receive_pack_busy`, or an error code such as `REPO_BUSY`. */
const BUSY_TEXT = /receive_pack_busy|\b[A-Z_]*BUSY\b/;
/** Busy text is looked for in the head of the answer only (a report or an error is short). */
const BUSY_SCAN_BYTES = 4096;

export type RetryPolicy = {
  /** One wait per retry; their count is the number of retries. */
  readonly delaysMs?: readonly number[];
  readonly wait?: (ms: number) => Promise<void>;
  /** In [0, 1): spreads retries of pushes that were busy together. */
  readonly random?: () => number;
  readonly onRetry?: (retry: { readonly retry: number; readonly delayMs: number }) => void;
};

export type Retried<T> = {
  readonly result: T;
  /** True when the last attempt was still busy (every retry was spent). */
  readonly busy: boolean;
  readonly attempts: number;
};

/** Runs `attempt` until `isBusy` says its result is not busy, or the retries run out. */
export async function retryWhileBusy<T>(
  attempt: () => Promise<T>,
  isBusy: (result: T) => boolean,
  policy: RetryPolicy = {},
): Promise<Retried<T>> {
  const delays = policy.delaysMs ?? BUSY_BACKOFF_MS;
  const wait = policy.wait ?? ((ms: number) => scheduler.wait(ms));
  const random = policy.random ?? Math.random;
  let result = await attempt();
  for (const [index, delay] of delays.entries()) {
    if (!isBusy(result)) return { result, busy: false, attempts: index + 1 };
    const delayMs = jittered(delay, random());
    policy.onRetry?.({ retry: index + 1, delayMs });
    // oxlint-disable-next-line no-await-in-loop -- each retry waits for the one before it
    await wait(delayMs);
    // oxlint-disable-next-line no-await-in-loop -- retries are sequential by design
    result = await attempt();
  }
  return { result, busy: isBusy(result), attempts: delays.length + 1 };
}

/** Whether an upstream git answer says the repository is busy (status, or busy text in its body). */
export function isBusyAnswer(answer: {
  readonly status: number;
  readonly bytes: Uint8Array;
}): boolean {
  if (BUSY_STATUSES.has(answer.status)) return true;
  const head = new TextDecoder().decode(answer.bytes.subarray(0, BUSY_SCAN_BYTES));
  return BUSY_TEXT.test(head);
}

/** `delay` scaled into [0.75, 1.25) of itself, so pushes busy together do not retry together. */
function jittered(delay: number, random: number): number {
  return Math.round(delay * (0.75 + random * 0.5));
}
