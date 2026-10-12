import { parsePatch } from 'diff';
import { describe, expect, it } from 'vitest';

import { toHunk } from '../repo/file-diff';
import { BeanStreamSocketMessage, beanStreamView, currentStreams, toFileDiff } from './bean-stream';

const SUMMARY = {
  type: 'bean.streaming',
  task: 't001',
  inv: 'inv0001-initial',
  agent: 'a0',
  seq: 2,
  t: 12.5,
  files: [{ path: 'src/cart.ts', status: 'modified', additions: 1, deletions: 1 }],
  additions: 1,
  deletions: 1,
  truncated: false,
  redacted: 0,
};

function binding(answer: unknown) {
  return {
    beanStreams: () => Promise.resolve({ ok: true, value: [SUMMARY] }),
    beanStream: () => Promise.resolve({ ok: true, value: answer }),
  };
}

describe('streamed bean changes', () => {
  it('turns a snapshot’s hunk text into numbered diff lines', async () => {
    const view = await beanStreamView(
      binding({
        summary: SUMMARY,
        files: [
          {
            path: 'src/cart.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            binary: false,
            patch:
              '@@ -1,2 +1,2 @@\n export const a = 1;\n-export const b = 2;\n+export const b = 3;\n',
          },
          {
            path: 'logo.png',
            status: 'added',
            additions: 0,
            deletions: 0,
            binary: true,
            patch: null,
          },
        ],
      }),
      'r1',
      't001',
    );

    const lines = view?.files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((line) => [line.kind, line.text, line.newNo])).toEqual([
      ['context', 'export const a = 1;', 1],
      ['del', 'export const b = 2;', null],
      ['add', 'export const b = 3;', 2],
    ]);
    expect(view?.files[1]?.hunks).toEqual([]);
  });

  it('reads nothing from a gateway that predates streaming', async () => {
    expect(await currentStreams({}, 'r1')).toEqual([]);
    expect(await beanStreamView({}, 'r1', 't001')).toBeNull();
    expect(await currentStreams(binding(null), 'r1')).toHaveLength(1);
  });

  it('reads every message of the stream socket and nothing else', () => {
    const file = { ...SUMMARY.files[0], binary: false, patch: '@@ -1 +1 @@\n-a\n+b\n' };
    const messages = [
      SUMMARY,
      { type: 'bean.streaming.end', task: 't001', inv: SUMMARY.inv, t: 13 },
      { type: 'bean.snapshot', task: 't001', inv: SUMMARY.inv, seq: 2, files: [file] },
      {
        type: 'bean.patch',
        task: 't001',
        inv: SUMMARY.inv,
        seq: 3,
        base_seq: 2,
        files: [file],
        removed: ['src/old.ts'],
      },
    ];

    const types = messages.map((message) => BeanStreamSocketMessage.parse(message).type);

    expect(types).toEqual(['bean.streaming', 'bean.streaming.end', 'bean.snapshot', 'bean.patch']);
    expect(BeanStreamSocketMessage.safeParse({ type: 'bean.patch', task: 't001' }).success).toBe(
      false,
    );
  });
});

describe('toFileDiff', () => {
  const patches = [
    '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    '@@ -0,0 +1,2 @@\n+one\n+two\n',
    '@@ -4,2 +3,0 @@\n-x\n-y\n',
    '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
    '@@ -1,4 +1,5 @@\n a\n \n-b\n+B\n+C\n d\n@@ -20,2 +21,2 @@\n x\n-y\n+z\n',
  ];

  it.each(patches)('reads the hunks the diff package reads', (patch) => {
    const path = 'src/a.ts';
    const expected = parsePatch(`--- a/${path}\n+++ b/${path}\n${patch}`)[0]?.hunks.map(toHunk);

    const { hunks } = toFileDiff({
      path,
      status: 'modified',
      additions: 0,
      deletions: 0,
      binary: false,
      patch,
    });

    expect(hunks).toEqual(expected);
  });
});
