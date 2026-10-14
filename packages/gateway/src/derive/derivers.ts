/**
 * The derivers (`deriver.ts`): `bean_blame`, each file's lines by the sprout commit (and so
 * the bean) that last changed them, and `path_history`, how each commit changed each path.
 * Both are eager: a landing advances them, so a read seldom computes anything.
 */
import { z } from 'zod';

import { PathChange } from '@gitstalk/shared-race/derived';

import { countLines, lineHunks } from '../git/diff-text';
import type { BlameSpan } from './blame-spans';
import {
  applyHunks,
  carryOwners,
  ownersOf,
  restoreOwners,
  spanLines,
  spansOf,
  wholeFile,
} from './blame-spans';
import type { ChangedPath, Changeset, DerivedRow, Deriver, ParentState } from './deriver';

/** The chain position of the derivation's base: lines older than it are owned by it. */
export const BASE_SEQ = 0;

/** Spans as stored: `[start, end, owner]`. */
const StoredSpan = z.tuple([z.number().int(), z.number().int(), z.number().int()]);

export const BlameRow = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lines'), spans: z.array(StoredSpan) }),
  /** Not read as text (binary, oversized, or past the per-commit read limit): one owner. */
  z.object({ kind: z.literal('opaque'), owner: z.number().int() }),
  z.object({ kind: z.literal('deleted') }),
]);
export type BlameRow = z.infer<typeof BlameRow>;

export const HistoryRow = z.object({ change: PathChange });
export type HistoryRow = z.infer<typeof HistoryRow>;

export const beanBlame: Deriver<BlameRow> = {
  name: 'bean_blame',
  version: 1,
  eager: true,
  needs: 'contents',
  schema: BlameRow,
  compute: (changeset, parent) =>
    changeset.paths.map((path) => ({ path: path.path, row: blameRow(changeset, path, parent) })),
};

export const pathHistory: Deriver<HistoryRow> = {
  name: 'path_history',
  version: 1,
  eager: true,
  needs: 'paths',
  schema: HistoryRow,
  compute: (changeset) =>
    changeset.paths.map((path): DerivedRow<HistoryRow> => ({
      path: path.path,
      row: { change: path.change },
    })),
};

/** The spans a stored row holds for a text of `text`'s lines (absent text: none). */
export function spansFor(row: BlameRow | null, text: string | null): BlameSpan[] {
  if (text === null) return [];
  const lines = countLines(text);
  if (row?.kind === 'opaque') return wholeFile(lines, row.owner);
  if (row?.kind === 'lines') {
    const spans = row.spans.map(([start, end, owner]) => ({ start, end, owner }));
    // A row that does not fit the text (it never should) is not trusted: the lines go to the base.
    if (spanLines(spans) === lines) return spans;
  }
  return wholeFile(lines, BASE_SEQ);
}

function blameRow(
  changeset: Changeset,
  path: ChangedPath,
  parent: ParentState<BlameRow>,
): BlameRow {
  if (path.change === 'deleted') return { kind: 'deleted' };
  if (path.text === null) return { kind: 'opaque', owner: changeset.seq };
  const before = spansFor(parent.at(path.path, changeset.seq - 1), path.text.before);
  const { after } = path.text;
  const spans =
    changeset.restores === null || path.restored === undefined
      ? applyHunks(before, lineHunks(path.text.before, after), changeset.seq)
      : restoredSpans({ changeset, path, parent, before });
  return { kind: 'lines', spans: spans.map((span) => [span.start, span.end, span.owner]) };
}

/**
 * A revert or reset: lines it left keep their owners, lines it put back get the owners they
 * had at the restored commit, so reverting a bean gives its lines back to whoever had them.
 */
function restoredSpans(input: {
  readonly changeset: Changeset;
  readonly path: ChangedPath;
  readonly parent: ParentState<BlameRow>;
  readonly before: readonly BlameSpan[];
}): BlameSpan[] {
  const { changeset, path, parent } = input;
  const before = path.text?.before ?? null;
  const after = path.text?.after ?? null;
  const restoredText = path.restored ?? null;
  const lines = countLines(after);
  const restoredAt = parent.at(path.path, changeset.restores ?? BASE_SEQ);
  const current = carryOwners(ownersOf(input.before), lineHunks(before, after), lines);
  const restored = carryOwners(
    ownersOf(spansFor(restoredAt, restoredText)),
    lineHunks(restoredText, after),
    lines,
  );
  return spansOf(restoreOwners({ current, restored, owner: changeset.seq }));
}

/** Every deriver, in the order a changeset feeds them. */
export const DERIVERS = [beanBlame, pathHistory] as const;
