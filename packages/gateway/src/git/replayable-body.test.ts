import { describe, expect, it } from 'vitest';

import { bufferBody, bytesStream } from './replayable-body';

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('bufferBody', () => {
  it('reads a body within the limit whole, so it can be sent again and again', async () => {
    const body = await bufferBody(streamOf(['0000', 'PACK', 'data']), 64);

    expect(body.kind).toBe('buffered');
    if (body.kind !== 'buffered') return;
    expect(await textOf(bytesStream(body.bytes))).toBe('0000PACKdata');
    expect(await textOf(bytesStream(body.bytes))).toBe('0000PACKdata');
  });

  it('streams a body over the limit on, the chunks read so far first, then the rest', async () => {
    const body = await bufferBody(streamOf(['aaaa', 'bbbb', 'cccc', 'dddd']), 6);

    expect(body.kind).toBe('streamed');
    if (body.kind !== 'streamed') return;
    expect(await textOf(body.stream)).toBe('aaaabbbbccccdddd');
  });

  it('buffers an empty body as no bytes', async () => {
    const body = await bufferBody(streamOf([]), 6);

    expect(body).toEqual({ kind: 'buffered', bytes: new Uint8Array(0) });
  });
});
