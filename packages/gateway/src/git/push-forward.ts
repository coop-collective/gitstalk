/**
 * Forwards a checked push's receive-pack to Artifacts and reads the answer whole. When
 * Artifacts says the repository is busy with another push (many beans pushed to one repository
 * at once), the push is sent again after a short backoff, so git sees the push land instead of
 * a hang-up. A retry needs the body again: it is buffered up to `MAX_REPLAYABLE_PUSH_BYTES`;
 * a larger push is forwarded once, as it streams.
 */
import type { Logger } from '../log';
import type { RetryPolicy } from './busy-retry';
import { isBusyAnswer, retryWhileBusy } from './busy-retry';
import { forwardGit } from './forward';
import type { GitPath } from './git-path';
import type { ReportMode } from './receive-pack-report';
import { parseReportStatus } from './receive-pack-report';
import { bufferBody, bytesStream } from './replayable-body';

/** Bean pushes are a few KiB to a few MiB; buffering more would crowd the isolate's memory. */
export const MAX_REPLAYABLE_PUSH_BYTES = 16 * 1024 * 1024;

/** The upstream's answer, read whole. */
export type PushAnswer = {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
};

export type ForwardedPush =
  | { readonly kind: 'answered'; readonly answer: PushAnswer }
  /** Every attempt found the repository busy; the last answer is kept for the log. */
  | { readonly kind: 'busy'; readonly answer: PushAnswer };

export type PushTarget = {
  readonly upstream: string;
  readonly path: GitPath;
  readonly token: string;
  /** The commands-and-pack body (`PushRequest.upstreamBody`). */
  readonly body: ReadableStream<Uint8Array>;
  /** The ref the push updates: once the answer shows it moved, the push is never sent again. */
  readonly ref: string;
  readonly mode: ReportMode;
  readonly log: Logger;
  /** The backoff; tests pass a `wait` that resolves at once. */
  readonly retry?: RetryPolicy;
};

/** Sends the push, again while Artifacts answers busy and the ref has not moved. */
export async function forwardPush(request: Request, target: PushTarget): Promise<ForwardedPush> {
  const send = async (body: ReadableStream<Uint8Array>): Promise<PushAnswer> =>
    readAnswer(await forwardGit(request, { ...target, body }));
  const body = await bufferBody(target.body, MAX_REPLAYABLE_PUSH_BYTES);
  if (body.kind === 'streamed') return { kind: 'answered', answer: await send(body.stream) };
  const retried = await retryWhileBusy(
    () => send(bytesStream(body.bytes)),
    (answer) => !refMoved(answer, target.ref, target.mode) && isBusyAnswer(answer),
    {
      ...target.retry,
      onRetry: (retry) => {
        target.log.warn('push retried: the repository was busy', { ref: target.ref, ...retry });
        target.retry?.onRetry?.(retry);
      },
    },
  );
  if (!retried.busy) return { kind: 'answered', answer: retried.result };
  target.log.warn('push given up: the repository stayed busy', {
    ref: target.ref,
    attempts: retried.attempts,
    status: retried.result.status,
  });
  return { kind: 'busy', answer: retried.result };
}

/** Whether the answer's report-status shows `ref` updated. */
export function refMoved(answer: PushAnswer, ref: string, mode: ReportMode): boolean {
  if (answer.status < 200 || answer.status >= 300) return false;
  const report = parseReportStatus(answer.bytes, mode);
  return report?.unpackOk === true && report.refs.some((status) => status.ok && status.ref === ref);
}

async function readAnswer(response: Response): Promise<PushAnswer> {
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}
