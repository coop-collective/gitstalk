/**
 * Go to file: a fuzzy finder over every path of a tree, as GitHub's `t` does. The letters typed
 * must appear in the path in order; a path ranks higher when they fall in the file's name, run
 * together, or start a word (after `/`, `-`, `_`, `.` or at a capital), and when it is short.
 */

/** A path that matched, with the indices of the characters that matched (for highlighting). */
export type PathMatch = {
  readonly path: string;
  readonly score: number;
  readonly marks: readonly number[];
};

/** The paths matching `query`, best first, at most `limit`; an empty query lists the first ones. */
export function findFiles(
  paths: readonly string[],
  query: string,
  limit: number,
): readonly PathMatch[] {
  const needle = query.replaceAll(/\s+/g, '').toLowerCase();
  if (needle === '') return paths.slice(0, limit).map((path) => ({ path, score: 0, marks: [] }));
  const found: PathMatch[] = [];
  for (const path of paths) {
    const match = matchPath(path, needle);
    if (match !== null) found.push(match);
  }
  return found
    .toSorted((a, b) => b.score - a.score || a.path.length - b.path.length || compare(a, b))
    .slice(0, limit);
}

/** How `path` matches a lower-case `needle`, or null when the letters are not all there in order. */
export function matchPath(path: string, needle: string): PathMatch | null {
  const nameStart = path.lastIndexOf('/') + 1;
  // Prefer the file's name: match the tail of the needle there first, then the rest before it.
  const inName = matchFrom(path, needle, nameStart);
  const marks = inName ?? matchFrom(path, needle, 0);
  if (marks === null) return null;
  return { path, score: scoreOf(path, marks, nameStart), marks };
}

/** Greedy left-to-right indices of `needle` in `path` from `start`, or null. */
function matchFrom(path: string, needle: string, start: number): number[] | null {
  const lower = path.toLowerCase();
  const marks: number[] = [];
  let at = start;
  for (const char of needle) {
    const found = lower.indexOf(char, at);
    if (found === -1) return null;
    marks.push(found);
    at = found + 1;
  }
  return marks;
}

function scoreOf(path: string, marks: readonly number[], nameStart: number): number {
  let score = 0;
  marks.forEach((index, position) => {
    score += 1;
    if (index >= nameStart) score += 2;
    if (isWordStart(path, index)) score += 3;
    if (position > 0 && marks[position - 1] === index - 1) score += 4;
  });
  if (marks[0] === nameStart) score += 6;
  return score - path.length / 100;
}

function isWordStart(path: string, index: number): boolean {
  if (index === 0) return true;
  const before = path[index - 1] ?? '';
  const char = path[index] ?? '';
  if ('/-_. '.includes(before)) return true;
  return char !== char.toLowerCase() && before === before.toLowerCase();
}

function compare(a: PathMatch, b: PathMatch): number {
  return Number(a.path > b.path) - Number(a.path < b.path);
}
