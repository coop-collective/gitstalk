/**
 * Same-origin JSON reads for query functions. The answer is checked with a type guard, so
 * client bundles carry no schema library unless a caller brings one (`schemaGuard` adapts a
 * `zod/mini` schema). Failures are `FetchJsonError`s with a `reason` to switch on.
 *
 * ```ts
 * useQuery({
 *   queryKey: qk.home(uid).activity(),
 *   queryFn: ({ signal }) => fetchJson('/api/home/activity', isActivity, { signal }),
 * });
 * ```
 */

/** Why a read failed. */
export type FetchJsonFailure =
  /** The request never got an answer (offline, aborted, DNS). */
  | { readonly reason: 'network' }
  /** The server answered with a non-2xx status; `message` is its `{ error: { message } }`. */
  | { readonly reason: 'http'; readonly status: number; readonly message: string | null }
  /** The body was not JSON. */
  | { readonly reason: 'invalid-json'; readonly status: number }
  /** The JSON did not pass the caller's guard. */
  | { readonly reason: 'unexpected-shape'; readonly status: number };

export class FetchJsonError extends Error {
  readonly failure: FetchJsonFailure;
  readonly path: string;

  constructor(path: string, failure: FetchJsonFailure, options?: ErrorOptions) {
    super(describe(path, failure), options);
    this.name = 'FetchJsonError';
    this.path = path;
    this.failure = failure;
  }
}

export type FetchJsonInit = {
  readonly signal?: AbortSignal;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as JSON with `content-type: application/json`. */
  readonly body?: unknown;
};

/**
 * Fetches `path` (an absolute path on this origin, such as `/api/repos/a/b/events`) and
 * returns its JSON once `accept` recognises it. Cookies go along; nothing is cached by the
 * browser (TanStack Query is the cache). Throws `FetchJsonError`.
 */
export async function fetchJson<T>(
  path: string,
  accept: (value: unknown) => value is T,
  init: FetchJsonInit = {},
): Promise<T> {
  assertSameOrigin(path);
  const response = await send(path, init);
  const value = await readJson(path, response);
  if (!response.ok) throw new FetchJsonError(path, httpFailure(response.status, value));
  if (!accept(value))
    throw new FetchJsonError(path, { reason: 'unexpected-shape', status: response.status });
  return value;
}

/** Whether `error` is a `FetchJsonError` for an HTTP status (to skip retrying a 404, say). */
export function isHttpStatus(error: unknown, status: number): boolean {
  return (
    error instanceof FetchJsonError &&
    error.failure.reason === 'http' &&
    error.failure.status === status
  );
}

function assertSameOrigin(path: string): void {
  // `//host/x` is protocol-relative, so it would leave the origin.
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new TypeError(`fetchJson reads same-origin paths only, not ${path}`);
}

async function send(path: string, init: FetchJsonInit): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  try {
    return await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error: unknown) {
    throw new FetchJsonError(path, { reason: 'network' }, { cause: error });
  }
}

/** The body as JSON; an error status with a non-JSON body reads as null (its status says it). */
async function readJson(path: string, response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch (error: unknown) {
    if (!response.ok) return null;
    throw new FetchJsonError(
      path,
      { reason: 'invalid-json', status: response.status },
      { cause: error },
    );
  }
}

function httpFailure(status: number, body: unknown): FetchJsonFailure {
  return { reason: 'http', status, message: errorMessage(body) };
}

/** The `{ error: { message } }` this app's routes answer with, when present. */
function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error: unknown = Reflect.get(body, 'error');
  if (typeof error !== 'object' || error === null) return null;
  const message: unknown = Reflect.get(error, 'message');
  return typeof message === 'string' ? message : null;
}

function describe(path: string, failure: FetchJsonFailure): string {
  switch (failure.reason) {
    case 'network':
      return `${path}: no answer`;
    case 'http':
      return `${path}: HTTP ${failure.status}${failure.message === null ? '' : ` (${failure.message})`}`;
    case 'invalid-json':
      return `${path}: the answer was not JSON (HTTP ${failure.status})`;
    case 'unexpected-shape':
      return `${path}: the answer had an unexpected shape (HTTP ${failure.status})`;
    default:
      return assertNever(failure);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected fetch failure ${JSON.stringify(value)}`);
}
