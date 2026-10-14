import { describe, expect, it } from 'vitest';

import type { LineHunk } from '../git/diff-text';
import { lineHunks } from '../git/diff-text';
import type { BlameSpan } from './blame-spans';
import { applyHunks, clipSpans, ownersOf, spansOf, wholeFile } from './blame-spans';

/** A small seeded generator (mulberry32), so every run checks the same cases. */
function random(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}

type Edit = { readonly at: number; readonly remove: number; readonly insert: number };

/** Insert, delete or replace somewhere in a file of `lines` lines. */
function randomEdit(next: (below: number) => number, lines: number): Edit {
  const at = next(lines + 1);
  const room = lines - at;
  switch (next(3)) {
    case 0:
      return { at, remove: 0, insert: 1 + next(4) };
    case 1:
      return { at, remove: Math.min(room, 1 + next(4)), insert: 0 };
    default:
      return { at, remove: Math.min(room, 1 + next(4)), insert: 1 + next(4) };
  }
}

/** The naive oracle: one owner per line, spliced. */
function splice<T>(items: readonly T[], edit: Edit, inserted: readonly T[]): T[] {
  return [...items.slice(0, edit.at), ...inserted, ...items.slice(edit.at + edit.remove)];
}

function isWellFormed(spans: readonly BlameSpan[]): boolean {
  return spans.every((span, index) => {
    const previous = spans[index - 1];
    const startsRight = span.start === (previous?.end ?? 0);
    return span.end > span.start && startsRight && previous?.owner !== span.owner;
  });
}

function text(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}

describe('blame spans against a per-line oracle', () => {
  it('applyHunks matches splicing owners for random insert, delete and replace sequences', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      let owners: number[] = Array.from({ length: next(20) }, () => 0);
      let spans = wholeFile(owners.length, 0);
      for (let owner = 1; owner <= 25; owner += 1) {
        const edit = randomEdit(next, owners.length);
        const hunk: LineHunk = {
          oldStart: edit.at,
          oldEnd: edit.at + edit.remove,
          newStart: edit.at,
          newEnd: edit.at + edit.insert,
        };
        owners = splice(
          owners,
          edit,
          Array.from({ length: edit.insert }, () => owner),
        );
        spans = applyHunks(spans, edit.remove + edit.insert === 0 ? [] : [hunk], owner);
        expect(ownersOf(spans), `seed ${seed}, step ${owner}`).toEqual(owners);
        expect(isWellFormed(spans)).toBe(true);
      }
    }
  });

  it('applyHunks over the real line diff matches the oracle when lines are distinct', () => {
    let fresh = 0;
    const lines = (count: number): string[] =>
      Array.from({ length: count }, () => `line ${(fresh += 1)}`);
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed * 7919);
      let content = lines(next(30));
      let owners: number[] = content.map(() => 0);
      let spans = wholeFile(content.length, 0);
      for (let owner = 1; owner <= 15; owner += 1) {
        // Several edits per landing, applied back to front so positions stay valid.
        const edits = Array.from({ length: 1 + next(3) }, () => randomEdit(next, content.length))
          .toSorted((a, b) => b.at - a.at)
          .filter(
            (edit, index, all) => index === 0 || edit.at + edit.remove <= (all[index - 1]?.at ?? 0),
          );
        let after = content;
        for (const edit of edits) {
          const inserted = lines(edit.insert);
          after = splice(after, edit, inserted);
          owners = splice(
            owners,
            edit,
            inserted.map(() => owner),
          );
        }
        spans = applyHunks(spans, lineHunks(text(content), text(after)), owner);
        content = after;
        expect(ownersOf(spans), `seed ${seed}, landing ${owner}`).toEqual(owners);
        expect(isWellFormed(spans)).toBe(true);
      }
    }
  });

  it('spansOf and ownersOf round-trip and merge neighbours', () => {
    const owners = [0, 0, 3, 3, 3, 1, 0, 0];
    const spans = spansOf(owners);
    expect(spans).toEqual([
      { start: 0, end: 2, owner: 0 },
      { start: 2, end: 5, owner: 3 },
      { start: 5, end: 6, owner: 1 },
      { start: 6, end: 8, owner: 0 },
    ]);
    expect(ownersOf(spans)).toEqual(owners);
  });

  it('clipSpans cuts the spans to a window', () => {
    const spans = spansOf([0, 0, 3, 3, 3, 1]);
    expect(clipSpans(spans, 1, 4)).toEqual([
      { start: 1, end: 2, owner: 0 },
      { start: 2, end: 4, owner: 3 },
    ]);
  });
});
