/**
 * Blame as line spans: a file's lines split into runs, each owned by the sprout commit (by
 * its sequence number on the chain) that last changed them. Pure arithmetic over a line diff's
 * hunks, so a landing costs O(spans + hunks), not O(lines); a revert, which restores older
 * owners, works line by line (`restoreOwners`). Spans are 0-based and half-open, sorted,
 * contiguous from line 0, and neighbours never share an owner.
 */
import type { LineHunk } from '../git/diff-text';

/** Lines `[start, end)` were last changed by the commit at chain position `owner`. */
export type BlameSpan = { readonly start: number; readonly end: number; readonly owner: number };

/** A file of `lines` lines owned whole by `owner` (none for an empty file). */
export function wholeFile(lines: number, owner: number): BlameSpan[] {
  return lines === 0 ? [] : [{ start: 0, end: lines, owner }];
}

/** Lines the spans cover. */
export function spanLines(spans: readonly BlameSpan[]): number {
  return spans.at(-1)?.end ?? 0;
}

/**
 * The spans after a change: lines outside the hunks keep their owners (shifted), lines a
 * hunk inserted belong to `owner`, lines it removed are gone.
 */
export function applyHunks(
  spans: readonly BlameSpan[],
  hunks: readonly LineHunk[],
  owner: number,
): BlameSpan[] {
  const runs = new RunBuilder();
  const reader = new SpanReader(spans);
  let oldLine = 0;
  for (const hunk of hunks) {
    reader.copyTo(runs, oldLine, hunk.oldStart);
    runs.push(hunk.newEnd - hunk.newStart, owner);
    oldLine = hunk.oldEnd;
  }
  reader.copyTo(runs, oldLine, spanLines(spans));
  return runs.spans();
}

/** One owner per line (the spans expanded). */
export function ownersOf(spans: readonly BlameSpan[]): number[] {
  return spans.flatMap((span) => Array.from({ length: span.end - span.start }, () => span.owner));
}

/** The spans of one owner per line (neighbours with the same owner merged). */
export function spansOf(owners: readonly number[]): BlameSpan[] {
  const runs = new RunBuilder();
  for (const owner of owners) runs.push(1, owner);
  return runs.spans();
}

/**
 * Each new line's owner carried through a diff from `owners` (one per old line); lines the
 * diff inserted are null.
 */
export function carryOwners(
  owners: readonly number[],
  hunks: readonly LineHunk[],
  newLines: number,
): (number | null)[] {
  const carried: (number | null)[] = Array.from({ length: newLines }, () => null);
  let oldLine = 0;
  let newLine = 0;
  const keep = (until: number): void => {
    for (; oldLine < until; oldLine += 1, newLine += 1) carried[newLine] = owners[oldLine] ?? null;
  };
  for (const hunk of hunks) {
    keep(hunk.oldStart);
    oldLine = hunk.oldEnd;
    newLine = hunk.newEnd;
  }
  keep(owners.length);
  return carried;
}

/**
 * The owners after a revert or reset: a line the revert left as it was keeps its owner; a
 * line it put back takes the owner it had at the restored commit; anything else (a line
 * neither side had, as when later beans edited around the reverted one) belongs to `owner`,
 * the revert itself.
 */
export function restoreOwners(input: {
  readonly current: readonly (number | null)[];
  readonly restored: readonly (number | null)[];
  readonly owner: number;
}): number[] {
  return input.current.map((line, index) => line ?? input.restored[index] ?? input.owner);
}

/** The spans that overlap lines `[start, end)`, cut to it. */
export function clipSpans(spans: readonly BlameSpan[], start: number, end: number): BlameSpan[] {
  return spans
    .filter((span) => span.end > start && span.start < end)
    .map((span) => ({
      start: Math.max(span.start, start),
      end: Math.min(span.end, end),
      owner: span.owner,
    }));
}

/** Appends runs of lines, merging a run into the last when they share an owner. */
class RunBuilder {
  readonly #spans: BlameSpan[] = [];

  push(length: number, owner: number): void {
    if (length <= 0) return;
    const last = this.#spans.at(-1);
    const start = last?.end ?? 0;
    if (last !== undefined && last.owner === owner)
      this.#spans[this.#spans.length - 1] = { ...last, end: start + length };
    else this.#spans.push({ start, end: start + length, owner });
  }

  spans(): BlameSpan[] {
    return [...this.#spans];
  }
}

/** Reads spans front to back: `copyTo` appends old lines `[from, to)` with their owners. */
class SpanReader {
  readonly #spans: readonly BlameSpan[];
  #index = 0;

  constructor(spans: readonly BlameSpan[]) {
    this.#spans = spans;
  }

  copyTo(runs: RunBuilder, from: number, to: number): void {
    while (this.#index < this.#spans.length && (this.#spans[this.#index]?.end ?? 0) <= from)
      this.#index += 1;
    let line = from;
    while (line < to) {
      const span = this.#spans[this.#index];
      if (span === undefined) return;
      const until = Math.min(span.end, to);
      runs.push(until - line, span.owner);
      line = until;
      if (until === span.end) this.#index += 1;
    }
  }
}
