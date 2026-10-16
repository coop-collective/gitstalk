/**
 * A request body read into memory so it can be sent more than once (a push retried while the
 * repository is busy), up to a limit. A larger body cannot be replayed and is handed back as
 * a stream that yields the bytes read so far, then the rest, so it can still be sent once.
 */
import { concatBytes } from './pkt-line';

export type ReplayableBody =
  | { readonly kind: 'buffered'; readonly bytes: Uint8Array }
  | { readonly kind: 'streamed'; readonly stream: ReadableStream<Uint8Array> };

/** Reads `body` whole when it is at most `limitBytes`; otherwise stops and streams it on. */
export async function bufferBody(
  body: ReadableStream<Uint8Array>,
  limitBytes: number,
): Promise<ReplayableBody> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
    const { done, value } = await reader.read();
    if (done) return { kind: 'buffered', bytes: concatBytes(chunks) };
    chunks.push(value);
    size += value.length;
    if (size > limitBytes) return { kind: 'streamed', stream: replayThenRest(chunks, reader) };
  }
}

/** A fresh stream over buffered bytes, one per attempt. */
export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function replayThenRest(
  read: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of read) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
