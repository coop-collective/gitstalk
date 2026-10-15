/**
 * The git proxy's own answers to a push: a refusal git prints as `! [remote rejected]` with
 * `remote:` lines, a receive-pack result, or a plain-text error git shows as `remote:` lines.
 */
import type { PushRequest } from '../git/push-request';
import type { ReportMode } from '../git/receive-pack-report';
import { refusalResponse } from '../git/receive-pack-report';

const RESULT_TYPE = 'application/x-git-receive-pack-result';

/** Refuses every ref of the push, with `reason` as a `gitstalk: push refused:` line. */
export function refused(request: PushRequest, mode: ReportMode, reason: string): Response {
  const refs = request.commands.map((command) => command.ref);
  const lines = [`gitstalk: push refused: ${reason}`];
  return bytesResponse(refusalResponse(refs, reason, { mode, lines }), new Headers());
}

/** A receive-pack result's headers, from the upstream's. */
export function resultHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  headers.delete('content-length');
  headers.set('content-type', RESULT_TYPE);
  headers.set('cache-control', 'no-cache');
  return headers;
}

export function bytesResponse(bytes: Uint8Array, upstream: Headers, status = 200): Response {
  return new Response(bytes, { status, headers: resultHeaders(upstream) });
}

/** A plain-text answer; git prints its lines as `remote:` lines. */
export function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain' } });
}
