/**
 * `git diff --no-color --stat -p a b` rendered from file contents, as the harness's
 * `Git.diff_text` shows a landed change to the next author (v2's informed rework). The
 * gateway has no git binary: the diff job reads both trees through the Artifacts binding
 * and renders here. Myers line diff, three lines of context, git's hunk headers.
 */

/**
 * One changed path: contents before and after (null: absent) and blob ids when known.
 * `binary` marks a side the reader did not load (too large to diff), and the byte counts
 * are those of the blobs, when the reader knows them.
 */
export type FileChange = {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly beforeId: string | null;
  readonly afterId: string | null;
  readonly binary?: boolean;
  readonly beforeBytes?: number;
  readonly afterBytes?: number;
};

/** Lines of context around each change (git's default `-U3`). */
const CONTEXT = 3;
/** Columns of a `--stat` line when git writes to a pipe. */
const STAT_COLUMNS = 80;
/** Characters of a hunk header's function context (git's `funcname` buffer). */
const FUNCNAME_CHARS = 80;
/** Cells of the Myers trace (edit distance × diagonals); beyond it a file shows as replaced. */
const TRACE_CELLS = 2_000_000;
const ABBREV = 7;

/** A changed file's status and line counts, as `git diff --numstat` reports them. */
export type ChangeStats = {
  readonly status: 'added' | 'deleted' | 'modified';
  readonly additions: number;
  readonly deletions: number;
};

/** The per-file counts and the (possibly cut) patch text of a set of changes. */
export type DiffReport = {
  readonly files: readonly ({ readonly path: string } & ChangeStats)[];
  readonly text: string;
  readonly truncated: boolean;
};

/**
 * The diff of `changes` cut at about `limit` characters. Files are rendered one by one and
 * rendering stops at the file that crosses the limit, so a huge diff costs its stat lines
 * and one file past `limit`, not its whole patch.
 */
export function diffText(changes: readonly FileChange[], limit: number): string {
  return diffReport(changes, limit).text;
}

/** One pass over `changes`: every file's counts and the patch text, from the same line diffs. */
export function diffReport(changes: readonly FileChange[], limit: number): DiffReport {
  const analyzed = changes.map(analyze);
  const files = analyzed.map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.added,
    deletions: file.deleted,
  }));
  const changed = analyzed
    .filter((file) => file.isChanged)
    .toSorted((a, b) => (a.path < b.path ? -1 : 1));
  if (changed.length === 0) return { files, text: '', truncated: false };
  const stat = `${statBlock(changed)}\n`;
  const patches: string[] = [];
  let length = stat.length;
  for (const file of changed) {
    if (length > limit) break;
    const patch = file.render();
    patches.push(patch);
    length += patch.length;
  }
  const text = `${stat}${patches.join('')}`;
  if (length <= limit) return { files, text, truncated: false };
  const unseen = patches.length < changed.length;
  const rest = `${unseen ? 'at least ' : ''}${text.length - limit}`;
  return {
    files,
    text: `${text.slice(0, limit)}\n... [diff truncated, ${rest} more chars]\n`,
    truncated: true,
  };
}

/** The whole `--stat -p` output, files in path order. */
export function renderDiff(changes: readonly FileChange[]): string {
  return diffReport(changes, Number.POSITIVE_INFINITY).text;
}

/**
 * The lines that `after` changed in `before`, as `[start, end)` ranges of `before`'s lines,
 * read from `git diff -U0` hunk headers the way the harness reads them (`hunks`): a hunk
 * `-start,len` is `[start, start + max(len, 1))`, so an insertion after line `start` is
 * `[start, start + 1)`.
 */
export function changedRanges(before: string | null, after: string | null): [number, number][] {
  const ops = diffLines(splitLines(before ?? ''), splitLines(after ?? ''));
  const ranges: [number, number][] = [];
  let oldLines = 0;
  let index = 0;
  while (index < ops.length) {
    if (ops[index]?.kind === ' ') {
      oldLines += 1;
      index += 1;
      continue;
    }
    let deleted = 0;
    while (index < ops.length && ops[index]?.kind !== ' ') {
      if (ops[index]?.kind === '-') deleted += 1;
      index += 1;
    }
    const start = deleted === 0 ? oldLines : oldLines + 1;
    ranges.push([start, start + Math.max(deleted, 1)]);
    oldLines += deleted;
  }
  return ranges;
}

/**
 * One changed region of a line diff: `before`'s lines `[oldStart, oldEnd)` became `after`'s
 * lines `[newStart, newEnd)` (0-based, half-open; either side may be empty). Lines between
 * hunks are equal on both sides.
 */
export type LineHunk = {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
};

/** The changed regions between two texts (null: absent), in order, from the same Myers diff. */
export function lineHunks(before: string | null, after: string | null): LineHunk[] {
  const ops = diffLines(splitLines(before ?? ''), splitLines(after ?? ''));
  const hunks: LineHunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let index = 0;
  while (index < ops.length) {
    if (ops[index]?.kind === ' ') {
      oldLine += 1;
      newLine += 1;
      index += 1;
      continue;
    }
    const start = { oldStart: oldLine, newStart: newLine };
    while (index < ops.length && ops[index]?.kind !== ' ') {
      if (ops[index]?.kind === '-') oldLine += 1;
      else newLine += 1;
      index += 1;
    }
    hunks.push({ ...start, oldEnd: oldLine, newEnd: newLine });
  }
  return hunks;
}

/** Lines of a text as the diff counts them (a last line without a newline counts). */
export function countLines(content: string | null): number {
  return splitLines(content ?? '').length;
}

function statusOf(change: FileChange): 'added' | 'deleted' | 'modified' {
  if (change.before === null) return 'added';
  return change.after === null ? 'deleted' : 'modified';
}

type FileDiff = {
  readonly path: string;
  readonly status: ChangeStats['status'];
  readonly isChanged: boolean;
  readonly isBinary: boolean;
  readonly added: number;
  readonly deleted: number;
  readonly sizes: readonly [number, number];
  /** The file's patch text; built on demand, from the ops computed once in `analyze`. */
  readonly render: () => string;
};

type Line = { readonly text: string; readonly hasNewline: boolean };
type Op = { readonly kind: ' ' | '-' | '+'; readonly line: Line };

function analyze(change: FileChange): FileDiff {
  const before = change.before ?? '';
  const after = change.after ?? '';
  const status = statusOf(change);
  const isChanged = change.before !== change.after;
  if (change.binary === true || isBinary(before) || isBinary(after)) {
    return {
      path: change.path,
      status,
      isChanged,
      isBinary: true,
      added: 0,
      deleted: 0,
      sizes: [change.beforeBytes ?? byteLength(before), change.afterBytes ?? byteLength(after)],
      render: () =>
        `${fileHeader(change)}Binary files ${oldName(change)} and ${newName(change)} differ\n`,
    };
  }
  const ops = diffLines(splitLines(before), splitLines(after));
  return {
    path: change.path,
    status,
    isChanged,
    isBinary: false,
    added: ops.filter((op) => op.kind === '+').length,
    deleted: ops.filter((op) => op.kind === '-').length,
    sizes: [0, 0],
    render: () => {
      const header = fileHeader(change);
      const hunks = renderHunks(ops);
      const names = `--- ${oldName(change)}\n+++ ${newName(change)}\n`;
      return hunks === '' ? header : `${header}${names}${hunks}`;
    },
  };
}

function fileHeader(change: FileChange): string {
  const lines = [`diff --git a/${change.path} b/${change.path}`];
  const hasIds = change.beforeId !== null || change.afterId !== null;
  if (change.before === null) lines.push('new file mode 100644');
  if (change.after === null) lines.push('deleted file mode 100644');
  if (hasIds) {
    const mode = change.before !== null && change.after !== null ? ' 100644' : '';
    lines.push(`index ${abbreviate(change.beforeId)}..${abbreviate(change.afterId)}${mode}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A blob id as git abbreviates it in `index` lines; zeros for an absent side. */
function abbreviate(id: string | null): string {
  return (id ?? '0'.repeat(ABBREV)).slice(0, ABBREV);
}

function oldName(change: FileChange): string {
  return change.before === null ? '/dev/null' : `a/${change.path}`;
}

function newName(change: FileChange): string {
  return change.after === null ? '/dev/null' : `b/${change.path}`;
}

function isBinary(content: string): boolean {
  return content.includes('\0');
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

function splitLines(content: string): Line[] {
  if (content === '') return [];
  const parts = content.split('\n');
  const hasFinalNewline = parts.at(-1) === '';
  if (hasFinalNewline) parts.pop();
  return parts.map((text, index) => ({
    text,
    hasNewline: hasFinalNewline || index < parts.length - 1,
  }));
}

/** Myers' O(ND) diff over lines, after trimming the common prefix and suffix. */
function diffLines(before: readonly Line[], after: readonly Line[]): Op[] {
  const same = (a: Line | undefined, b: Line | undefined): boolean =>
    a !== undefined && b !== undefined && a.text === b.text && a.hasNewline === b.hasNewline;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && same(before[prefix], after[prefix])) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    same(before[before.length - 1 - suffix], after[after.length - 1 - suffix])
  ) {
    suffix += 1;
  }
  const middle = middleOps(
    before.slice(prefix, before.length - suffix),
    after.slice(prefix, after.length - suffix),
    same,
  );
  const keep = (lines: readonly Line[]): Op[] => lines.map((line) => ({ kind: ' ', line }));
  return [
    ...keep(before.slice(0, prefix)),
    ...middle,
    ...keep(before.slice(before.length - suffix)),
  ];
}

function middleOps(
  before: readonly Line[],
  after: readonly Line[],
  same: (a: Line | undefined, b: Line | undefined) => boolean,
): Op[] {
  const replaceAll = (): Op[] => [
    ...before.map((line): Op => ({ kind: '-', line })),
    ...after.map((line): Op => ({ kind: '+', line })),
  ];
  if (before.length === 0 || after.length === 0) return replaceAll();
  const depthLimit = Math.floor(TRACE_CELLS / (2 * (before.length + after.length) + 2));
  const trace = myersTrace(before, after, { same, depthLimit });
  return trace === null ? replaceAll() : backtrack(trace, before, after);
}

/** The furthest-reaching x per diagonal after each edit distance d (offset by `max`). */
function myersTrace(
  before: readonly Line[],
  after: readonly Line[],
  options: { same: (a: Line | undefined, b: Line | undefined) => boolean; depthLimit: number },
): Int32Array[] | null {
  const { same } = options;
  const n = before.length;
  const m = after.length;
  const max = n + m;
  const frontier = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, options.depthLimit); d += 1) {
    trace.push(frontier.slice());
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && (frontier[max + k - 1] ?? 0) < (frontier[max + k + 1] ?? 0));
      let x = down ? (frontier[max + k + 1] ?? 0) : (frontier[max + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && same(before[x], after[y])) {
        x += 1;
        y += 1;
      }
      frontier[max + k] = x;
      if (x >= n && y >= m) return trace;
    }
  }
  return null;
}

function backtrack(
  trace: readonly Int32Array[],
  before: readonly Line[],
  after: readonly Line[],
): Op[] {
  const max = before.length + after.length;
  const ops: Op[] = [];
  let x = before.length;
  let y = after.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const frontier = trace[d];
    if (frontier === undefined) break;
    const k = x - y;
    const down =
      k === -d || (k !== d && (frontier[max + k - 1] ?? 0) < (frontier[max + k + 1] ?? 0));
    const previousK = down ? k + 1 : k - 1;
    const previousX = frontier[max + previousK] ?? 0;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: ' ', line: requireLine(before, x) });
    }
    if (d > 0) {
      if (down) ops.push({ kind: '+', line: requireLine(after, previousY) });
      else ops.push({ kind: '-', line: requireLine(before, previousX) });
    }
    x = previousX;
    y = previousY;
  }
  return ops.toReversed();
}

function requireLine(lines: readonly Line[], index: number): Line {
  const line = lines[index];
  if (line === undefined) throw new Error(`diff: no line ${index}`);
  return line;
}

/** Hunks with three lines of context; changes closer than 2×context share a hunk. */
function renderHunks(ops: readonly Op[]): string {
  const changed = ops.flatMap((op, index) => (op.kind === ' ' ? [] : [index]));
  const groups: [number, number][] = [];
  for (const index of changed) {
    const last = groups.at(-1);
    if (last !== undefined && index - last[1] <= 2 * CONTEXT + 1) last[1] = index;
    else groups.push([index, index]);
  }
  return groups.map(([first, last]) => renderHunk(ops, first, last)).join('');
}

function renderHunk(ops: readonly Op[], first: number, last: number): string {
  const start = Math.max(0, first - CONTEXT);
  const end = Math.min(ops.length - 1, last + CONTEXT);
  const before = ops.slice(0, start);
  const oldStart = before.filter((op) => op.kind !== '+').length;
  const newStart = before.filter((op) => op.kind !== '-').length;
  const body = ops.slice(start, end + 1);
  const oldCount = body.filter((op) => op.kind !== '+').length;
  const newCount = body.filter((op) => op.kind !== '-').length;
  const funcname = functionContext(before);
  const header = `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${funcname}\n`;
  const lines = body.map(
    (op) =>
      `${op.kind}${op.line.text}\n${op.line.hasNewline ? '' : '\\ No newline at end of file\n'}`,
  );
  return header + lines.join('');
}

/** git's `-l,s` notation: `-3` for one line, `-2,0` for none (the line before). */
function range(start: number, count: number): string {
  if (count === 1) return `${start + 1}`;
  if (count === 0) return `${start},0`;
  return `${start + 1},${count}`;
}

/** The default funcname: the last old line before the hunk starting with a letter, `_` or `$`. */
function functionContext(before: readonly Op[]): string {
  const line = before.findLast((op) => op.kind !== '+' && /^[A-Za-z_$]/.test(op.line.text));
  return line === undefined ? '' : ` ${line.line.text.slice(0, FUNCNAME_CHARS).trimEnd()}`;
}

function statBlock(files: readonly FileDiff[]): string {
  const nameWidth = Math.max(...files.map((file) => file.path.length));
  const maxChange = Math.max(...files.map((file) => file.added + file.deleted));
  const numberWidth = Math.max(
    String(maxChange).length,
    files.some((file) => file.isBinary) ? 3 : 0,
  );
  const graphWidth = Math.max(6, STAT_COLUMNS - nameWidth - numberWidth - 6);
  const lines = files.map((file) => {
    const name = file.path.padEnd(nameWidth);
    if (file.isBinary) return ` ${name} | Bin ${file.sizes[0]} -> ${file.sizes[1]} bytes`;
    const total = file.added + file.deleted;
    const [plus, minus] = scaledBar(file, { maxChange, graphWidth });
    const bar = total === 0 ? '' : ` ${'+'.repeat(plus)}${'-'.repeat(minus)}`;
    return ` ${name} | ${String(total).padStart(numberWidth)}${bar}`;
  });
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const deleted = files.reduce((sum, file) => sum + file.deleted, 0);
  return `${[...lines, summaryLine(files.length, added, deleted)].join('\n')}\n`;
}

/** git's `scale_linear`: bars shrink only when the largest change does not fit. */
function scaledBar(
  file: FileDiff,
  scale: { maxChange: number; graphWidth: number },
): [number, number] {
  if (scale.maxChange <= scale.graphWidth) return [file.added, file.deleted];
  const linear = (count: number): number =>
    count === 0 ? 0 : 1 + Math.floor((count * (scale.graphWidth - 1)) / scale.maxChange);
  const total = linear(file.added + file.deleted);
  const plus = linear(file.added);
  return [Math.min(plus, total), Math.max(0, total - plus)];
}

function summaryLine(files: number, added: number, deleted: number): string {
  const parts = [` ${files} file${files === 1 ? '' : 's'} changed`];
  if (added > 0) parts.push(`${added} insertion${added === 1 ? '' : 's'}(+)`);
  if (deleted > 0) parts.push(`${deleted} deletion${deleted === 1 ? '' : 's'}(-)`);
  return parts.join(', ');
}
