/**
 * How the runner client reaches a runner instance: the wire-contract version check before an
 * instance's first job, waits while Cloudflare has no container to start, and the mapping of a
 * failed response to a typed error. Request bodies carry Artifacts tokens and are never logged.
 */
import { z } from 'zod';

import { UpstreamError } from '../errors';
import type { Logger } from '../log';

/**
 * The runner wire contract this gateway speaks: `API_VERSION` in packages/gateway/container/src/app.rs.
 * Bump both together whenever a request or response body changes.
 */
export const RUNNER_API_VERSION = 5;
/** Response header in which the runner states its contract version. */
export const RUNNER_API_HEADER = 'x-gitstalk-runner-api';

/** Longest runner call: a suite has a 300 s timeout in the runner; fetches come on top. */
const RUNNER_TIMEOUT_MS = 10 * 60 * 1000;
/** Characters of a failed runner response kept in the error message. */
const ERROR_EXCERPT_CHARS = 500;
/** Total time spent waiting for container capacity before the failure reaches the engine. */
const CAPACITY_BUDGET_MS = 4 * 60 * 1000;
const CAPACITY_MIN_WAIT_MS = 5_000;
const CAPACITY_MAX_WAIT_MS = 20_000;
/** Spread of each wait around its base step (±20 %), so instances do not retry in lockstep. */
const CAPACITY_JITTER = 0.2;
/** Calls that are safe to repeat when the runner cannot see their commit yet. */
const IDEMPOTENT_PATHS: ReadonlySet<string> = new Set(['/v1/check', '/v1/update-ref']);
/** What Cloudflare answers when an instance cannot start for lack of capacity. */
const CAPACITY_MESSAGES = [
  /maximum number of running container instances exceeded/i,
  /no container instance available/i,
];

/** Something with a `fetch`: a container stub, or a fake in tests. */
export type RunnerStub = { fetch(request: Request): Promise<Response> };

export type TransportOptions = {
  readonly log: Logger;
  /** Waits `ms` milliseconds (tests pass one that returns at once). */
  readonly sleep: (ms: number) => Promise<void>;
};

export type RunnerTransport = {
  /** POSTs `body` as JSON to `path` on `instance`; resolves only to a 2xx response. */
  post(instance: string, path: string, body: unknown): Promise<Response>;
};

/**
 * The runner image speaks another wire contract than this gateway (one was deployed without the
 * other). Retrying cannot help, so the error is final and its message says what to deploy.
 */
export class RunnerVersionMismatchError extends UpstreamError {
  override readonly code = 'runner_version_mismatch';

  constructor(instance: string, runnerVersion: string, detail: string) {
    super(
      `runner_version_mismatch: runner instance ${instance} speaks runner API ${runnerVersion}, ` +
        `this gateway speaks ${RUNNER_API_VERSION} (${detail}); deploy the gateway and the ` +
        `runner image from the same commit`,
      false,
    );
  }
}

const VersionResponse = z.object({
  api_version: z.number().int().min(1).optional(),
  git_sha: z.string().optional(),
});

/** A transport over container stubs picked by instance name. */
export function runnerTransport(
  stubFor: (instance: string) => RunnerStub,
  options: TransportOptions,
): RunnerTransport {
  const versionChecks = new Map<string, Promise<void>>();
  const ensureVersion = async (instance: string): Promise<void> => {
    const pending =
      versionChecks.get(instance) ?? checkVersion(stubFor(instance), instance, options);
    versionChecks.set(instance, pending);
    try {
      await pending;
    } catch (error: unknown) {
      if (versionChecks.get(instance) === pending) versionChecks.delete(instance);
      throw error;
    }
  };
  return {
    async post(instance, path, body) {
      await ensureVersion(instance);
      const request = (): Request =>
        new Request(`http://runner${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
        });
      const response = await sendWithCapacityWaits(stubFor(instance), request, {
        instance,
        path,
        ...options,
      });
      if (response.ok) return response;
      throw await failureOf(response, instance, path);
    },
  };
}

/**
 * The waits between capacity retries for `instance`: steps of 5, 10, 15, then 20 s, each spread
 * by ±20 % (kept within 5 to 20 s), until about 4 minutes in all. Deterministic: the spread comes
 * from the instance name, so a run's retries replay identically and instances stay out of step.
 */
export function capacityWaitsMs(instance: string): readonly number[] {
  const next = seededRandom(fnv1a(instance));
  const waits: number[] = [];
  let total = 0;
  for (let step = 1; ; step += 1) {
    const base = Math.min(CAPACITY_MIN_WAIT_MS * step, CAPACITY_MAX_WAIT_MS);
    const spread = 1 + CAPACITY_JITTER * (2 * next() - 1);
    const wait = clamp(Math.round(base * spread), CAPACITY_MIN_WAIT_MS, CAPACITY_MAX_WAIT_MS);
    if (total + wait > CAPACITY_BUDGET_MS) return waits;
    waits.push(wait);
    total += wait;
  }
}

async function checkVersion(
  stub: RunnerStub,
  instance: string,
  options: TransportOptions,
): Promise<void> {
  const response = await sendWithCapacityWaits(stub, versionRequest, {
    instance,
    path: '/version',
    ...options,
  });
  if (!response.ok) throw await failureOf(response, instance, '/version');
  const parsed = VersionResponse.safeParse(await response.json());
  if (!parsed.success) throw new UpstreamError('runner /version answered an unexpected body', true);
  const { api_version: apiVersion, git_sha: gitSha } = parsed.data;
  if (apiVersion === RUNNER_API_VERSION) return;
  throw new RunnerVersionMismatchError(
    instance,
    apiVersion === undefined ? '1 (it reports no api_version)' : String(apiVersion),
    `image commit ${gitSha ?? 'unknown'}`,
  );
}

function versionRequest(): Request {
  return new Request('http://runner/version', { signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS) });
}

type Attempt = TransportOptions & { readonly instance: string; readonly path: string };

/**
 * Sends a request, and while Cloudflare cannot start the instance for lack of capacity, waits
 * and sends it again (a fresh request each time: a body is read once). These waits do not spend
 * the engine's per-job attempts; once the budget is gone the failure is retryable as before.
 */
async function sendWithCapacityWaits(
  stub: RunnerStub,
  request: () => Request,
  attempt: Attempt,
): Promise<Response> {
  const waits = capacityWaitsMs(attempt.instance);
  for (let index = 0; ; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt follows the previous one's refusal
    const sent = await sendOnce(stub, request(), attempt.path);
    const wait = waits[index];
    if (sent.kind === 'answered' || wait === undefined) return toResponse(sent, attempt.path);
    attempt.log.warn('runner capacity exhausted, waiting', {
      instance: attempt.instance,
      path: attempt.path,
      attempt: index + 1,
      wait_ms: wait,
      reason: sent.reason,
    });
    // oxlint-disable-next-line no-await-in-loop -- the wait is the point: capacity frees up over time
    await attempt.sleep(wait);
  }
}

type Sent =
  | { readonly kind: 'answered'; readonly response: Response }
  | { readonly kind: 'no-capacity'; readonly reason: string; readonly status: number | null };

async function sendOnce(stub: RunnerStub, request: Request, path: string): Promise<Sent> {
  let response: Response;
  try {
    response = await stub.fetch(request);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (isCapacityMessage(message)) return { kind: 'no-capacity', reason: message, status: null };
    throw new UpstreamError(`runner ${path} unreachable`, true, { cause: error });
  }
  if (response.ok || !isCapacityStatus(response.status)) return { kind: 'answered', response };
  const text = await response.text();
  if (response.status === 500 && !isCapacityMessage(text)) {
    return { kind: 'answered', response: new Response(text, response) };
  }
  return { kind: 'no-capacity', reason: excerpt(text), status: response.status };
}

function toResponse(sent: Sent, path: string): Response {
  if (sent.kind === 'answered') return sent.response;
  throw new UpstreamError(
    `runner ${path} could not start for lack of container capacity: ${sent.reason}`,
    true,
  );
}

/** The error for a non-2xx runner response. */
async function failureOf(
  response: Response,
  instance: string,
  path: string,
): Promise<UpstreamError> {
  const text = excerpt(await response.text());
  if (response.status === 400 && /unknown field/i.test(text)) {
    const runnerVersion = response.headers.get(RUNNER_API_HEADER) ?? '1 (no version header)';
    return new RunnerVersionMismatchError(instance, runnerVersion, `${path} refused: ${text}`);
  }
  const isRetryable =
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 422 && IDEMPOTENT_PATHS.has(path) && errorCode(text) === 'unknown_commit');
  return new UpstreamError(`runner ${path} answered ${response.status}: ${text}`, isRetryable);
}

function isCapacityStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 500;
}

function isCapacityMessage(text: string): boolean {
  return CAPACITY_MESSAGES.some((pattern) => pattern.test(text));
}

const ErrorBody = z.object({ code: z.string() });

function errorCode(text: string): string | null {
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.code : null;
  } catch {
    return null;
  }
}

function excerpt(text: string): string {
  return text.slice(0, ERROR_EXCERPT_CHARS);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 32-bit FNV-1a of a string. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

/** mulberry32: a small deterministic generator of numbers in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
