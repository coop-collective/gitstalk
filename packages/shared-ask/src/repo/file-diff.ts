/**
 * Line diffs between two versions of a file, as unified hunks with line numbers. Used for
 * ranges the recorded runs did not precompute; the per-commit numbers come from git.
 */
import { structuredPatch } from 'diff';

import { toHunk } from './hunk';
import type { FileDiff, FileStatus } from './repo-types';

// Hunk numbering lives in its own module so a reader that never diffs does not load `diff`.
export { toHunk } from './hunk';
export type { RawHunk } from './hunk';

/** Lines of context around each change, as `git diff` prints by default. */
const CONTEXT_LINES = 3;

/** The diff of one path from `before` to `after` (undefined: the file does not exist there). */
export function diffFile(
  path: string,
  before: string | undefined,
  after: string | undefined,
): FileDiff | undefined {
  if (before === after) return undefined;
  const patch = structuredPatch(path, path, before ?? '', after ?? '', undefined, undefined, {
    context: CONTEXT_LINES,
  });
  const hunks = patch.hunks.map(toHunk);
  const lines = hunks.flatMap((hunk) => hunk.lines);
  return {
    path,
    status: fileStatus(before, after),
    additions: lines.filter((line) => line.kind === 'add').length,
    deletions: lines.filter((line) => line.kind === 'del').length,
    hunks,
  };
}

function fileStatus(before: string | undefined, after: string | undefined): FileStatus {
  if (before === undefined) return 'added';
  if (after === undefined) return 'deleted';
  return 'modified';
}

/** New-side line numbers a diff adds or changes (for highlighting a file view). */
export function changedLines(diff: FileDiff | undefined): ReadonlySet<number> {
  const numbers = (diff?.hunks ?? []).flatMap((hunk) =>
    hunk.lines.flatMap((line) => (line.kind === 'add' && line.newNo !== null ? [line.newNo] : [])),
  );
  return new Set(numbers);
}

/** A file's lines; a trailing newline ends the last line rather than starting another. */
export function textLines(text: string): readonly string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}
