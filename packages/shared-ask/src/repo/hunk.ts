/** A jsdiff-shaped hunk with line numbers on every line; no diffing, so it is cheap to load. */
import type { DiffHunk, DiffLine } from './repo-types';

export type RawHunk = {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
};

/** A jsdiff hunk with old and new line numbers on every line. */
export function toHunk(hunk: RawHunk): DiffHunk {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const lines: DiffLine[] = [];
  for (const raw of hunk.lines) {
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ });
    } else if (marker === '-') {
      lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null });
    } else if (marker === ' ') {
      lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return { ...hunk, lines };
}
