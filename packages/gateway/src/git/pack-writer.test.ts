import { describe, expect, it } from 'vitest';

import { EMPTY_TREE_ID, buildPack, gitObject } from './pack-writer';
import { FLUSH_PKT, concatBytes, pktLine } from './pkt-line';
import { parseReportStatus } from './receive-pack-report';

/** Object ids from real git: `git hash-object` of the same bytes. */
const EMPTY_BLOB_ID = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const HELLO_BLOB_ID = 'ce013625030ba8dba906f756967f9e9ca394464a';

describe('git objects', () => {
  it('hashes blobs and trees as git does', async () => {
    expect((await gitObject('blob', '')).id).toBe(EMPTY_BLOB_ID);
    expect((await gitObject('blob', 'hello\n')).id).toBe(HELLO_BLOB_ID);
    expect((await gitObject('tree', new Uint8Array(0))).id).toBe(EMPTY_TREE_ID);
    expect(EMPTY_TREE_ID).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });
});

describe('a pack', () => {
  it('has a v2 header, one zlib entry per object with its type and size, and a SHA-1 trailer', async () => {
    const small = await gitObject('blob', 'hello\n');
    const large = await gitObject('blob', 'x'.repeat(300));
    const pack = await buildPack([small, large]);
    const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe('PACK');
    expect(view.getUint32(4)).toBe(2);
    expect(view.getUint32(8)).toBe(2);
    // blob (3) of 6 bytes: one header byte, no continuation.
    expect(pack[12]).toBe((3 << 4) | 6);
    const first = await inflatedEntry(pack, 13);
    expect(new TextDecoder().decode(first.body)).toBe('hello\n');
    // 300 = 0b1_0010_1100: low 4 bits 0xc with the continuation bit, then 300 >> 4 = 18.
    expect([pack[first.end], pack[first.end + 1]]).toEqual([0x80 | (3 << 4) | 0x0c, 18]);
    const second = await inflatedEntry(pack, first.end + 2);
    expect(second.body).toHaveLength(300);
    const body = pack.subarray(0, pack.length - 20);
    const trailer = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
    expect(pack.subarray(pack.length - 20)).toEqual(trailer);
  });
});

describe('report-status', () => {
  it('reads unpack and per-ref outcomes, with the reason of a refused ref', () => {
    const response = concatBytes([
      pktLine('unpack ok\n'),
      pktLine('ok refs/heads/beans/t001\n'),
      pktLine('ng refs/heads/beans/t002 fetch first\n'),
      FLUSH_PKT,
    ]);
    expect(parseReportStatus(response, { sideband: false, reportStatus: true })).toEqual({
      unpackOk: true,
      refs: [
        { ref: 'refs/heads/beans/t001', ok: true, reason: null },
        { ref: 'refs/heads/beans/t002', ok: false, reason: 'fetch first' },
      ],
    });
  });

  it('reports a failed unpack', () => {
    const response = concatBytes([
      pktLine('unpack index-pack abnormal exit\n'),
      pktLine('ng refs/heads/beans/t001 unpacker error\n'),
      FLUSH_PKT,
    ]);
    expect(parseReportStatus(response, { sideband: false, reportStatus: true })?.unpackOk).toBe(
      false,
    );
  });
});

/**
 * One entry's body, inflated, and where the next entry starts. The zlib stream's end is found
 * by inflating growing prefixes: a stream cut short does not inflate.
 */
async function inflatedEntry(
  pack: Uint8Array,
  start: number,
): Promise<{ readonly body: Uint8Array; readonly end: number }> {
  for (let end = start + 8; end <= pack.length - 20; end += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a test pack of a few bytes
    const body = await inflate(pack.subarray(start, end));
    if (body !== null) return { body, end };
  }
  throw new Error('no complete zlib stream');
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    // A prefix that is not a whole zlib stream: try a longer one.
    return null;
  }
}
