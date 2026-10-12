/**
 * Streaming diffs (`stream_diffs`): a bean's working change while its agent writes, as the
 * run's stream socket sends it (`bean.streaming`, `bean.streaming.end` to every viewer;
 * `bean.snapshot` and `bean.patch` to the viewers of that bean, docs/claude-17-streaming-diffs.md)
 * and as the `beanStream` RPC serves it. The two RPC methods are optional on the binding, so an older
 * gateway without them still counts as a gateway (`asGatewayBinding` checks the rest).
 */
import { z } from 'zod';

import type { RpcResult } from '@gitstalk/shared-race/rpc';

import type { FileDiff } from '../repo/repo-types';
import { toHunk } from '../repo/hunk';
import type { RawHunk } from '../repo/hunk';
import { BeanStreamAnswer, BeanStreamSummary } from './bean-stream-schema';
import type { StreamFile } from './bean-stream-schema';
import { unwrap } from './gateway-rpc';

// The wire shapes live in their own module; every importer keeps using this path.
export * from './bean-stream-schema';

/** A bean's streamed change, ready to draw. */
export type BeanStreamView = {
  readonly summary: BeanStreamSummary;
  readonly files: readonly FileDiff[];
};

type StreamRpc = {
  beanStreams(run: string): Promise<RpcResult<unknown>>;
  beanStream(run: string, bean: string): Promise<RpcResult<unknown>>;
};

/** The binding's stream methods, or undefined for a gateway that predates them. */
export function streamRpcOf(binding: object): StreamRpc | undefined {
  const beanStreams: unknown = Reflect.get(binding, 'beanStreams');
  const beanStream: unknown = Reflect.get(binding, 'beanStream');
  if (typeof beanStreams !== 'function' || typeof beanStream !== 'function') return undefined;
  return {
    beanStreams: async (run) => Reflect.apply(beanStreams, binding, [run]),
    beanStream: async (run, bean) => Reflect.apply(beanStream, binding, [run, bean]),
  };
}

/** Every bean streaming now (none from an older gateway). */
export async function currentStreams(
  binding: object,
  run: string,
): Promise<readonly BeanStreamSummary[]> {
  const rpc = streamRpcOf(binding);
  if (rpc === undefined) return [];
  return unwrap(await rpc.beanStreams(run), z.array(BeanStreamSummary));
}

/** A bean's latest snapshot as file diffs; null while nothing streams. */
export async function beanStreamView(
  binding: object,
  run: string,
  bean: string,
): Promise<BeanStreamView | null> {
  const rpc = streamRpcOf(binding);
  if (rpc === undefined) return null;
  const answer = unwrap(await rpc.beanStream(run, bean), BeanStreamAnswer);
  if (answer === null) return null;
  return { summary: answer.summary, files: answer.files.map(toFileDiff) };
}

/** One streamed file as a file diff: its hunk text parsed into numbered lines. */
export function toFileDiff(file: StreamFile): FileDiff {
  const { path, status, additions, deletions } = file;
  if (file.patch === null || file.patch === '')
    return { path, status, additions, deletions, hunks: [] };
  return { path, status, additions, deletions, hunks: parseHunks(file.patch).map(toHunk) };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of a streamed patch (hunk text only, no file header). A small reader instead of the
 * `diff` package's `parsePatch`, so the browser does not download that library to show a stream.
 */
function parseHunks(patch: string): RawHunk[] {
  const lines = patch.split('\n');
  const hunks: RawHunk[] = [];
  let at = 0;
  while (at < lines.length) {
    const header = HUNK_HEADER.exec(lines[at] ?? '');
    at += 1;
    if (header === null) continue;
    const oldLines = Number(header[2] ?? 1);
    const newLines = Number(header[4] ?? 1);
    // A zero-length side counts from the line before: the unified format's quirk.
    const oldStart = Number(header[1]) + (oldLines === 0 ? 1 : 0);
    const newStart = Number(header[3]) + (newLines === 0 ? 1 : 0);
    const body: string[] = [];
    let oldSeen = 0;
    let newSeen = 0;
    while (
      at < lines.length &&
      (oldSeen < oldLines || newSeen < newLines || lines[at]?.[0] === '\\')
    ) {
      const raw = lines[at] === '' ? ' ' : (lines[at] ?? '');
      at += 1;
      if (raw[0] === '+') newSeen += 1;
      else if (raw[0] === '-') oldSeen += 1;
      else if (raw[0] === ' ') {
        oldSeen += 1;
        newSeen += 1;
      } else continue;
      body.push(raw);
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: body });
  }
  return hunks;
}
