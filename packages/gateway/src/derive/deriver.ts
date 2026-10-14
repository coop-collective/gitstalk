/**
 * One derived-data mechanism (docs/claude-18-lessons-from-scion.md §4): every derived type
 * is a `Deriver` that turns one change on the sprout (a `Changeset`) and the state its parent
 * left into rows keyed by path. The store (`derived-store.ts`) keeps each deriver's rows by
 * chain position, so the state at any commit is the newest row at or before it; the chain
 * (`derive-chain.ts`) feeds changesets in first-parent order. An eager deriver advances on
 * every landing; a lazy one on the first read that needs it. Bumping `version` drops a
 * deriver's rows, and it is recomputed lazily. Adding one is a new `Deriver` in `DERIVERS`;
 * readers never see how rows are computed.
 */
import type { z } from 'zod';

import type { DerivedCommitKind, PathChange } from '@gitstalk/shared-race/derived';

/** One changed path of a changeset. Contents are absent beyond the per-commit read limit. */
export type ChangedPath = {
  readonly path: string;
  readonly change: PathChange;
  /** Both sides as text; null when the change was not read as text (binary, oversized, too many files). */
  readonly text: { readonly before: string | null; readonly after: string | null } | null;
  /** For a revert or reset, the path's text at the restored commit (null: absent there). */
  readonly restored?: string | null;
};

/** One commit of the sprout's first-parent chain, as derivers see it. */
export type Changeset = {
  readonly sha: string;
  /** Its position on the chain: the derivation's base is 0, each child one more. */
  readonly seq: number;
  readonly kind: DerivedCommitKind;
  readonly bean: string | null;
  /** For a revert or reset: the chain position whose state it puts back. */
  readonly restores: number | null;
  readonly paths: readonly ChangedPath[];
};

/** A deriver's state before the changeset: its newest row for a path at or before a position. */
export type ParentState<Row> = {
  at(path: string, seq: number): Row | null;
};

export type DerivedRow<Row> = { readonly path: string; readonly row: Row };

export type Deriver<Row> = {
  readonly name: string;
  readonly version: number;
  /** Advanced on each landing; otherwise on the first read that needs it. */
  readonly eager: boolean;
  /** Whether it reads file contents (and, for reverts, the restored side). */
  readonly needs: 'paths' | 'contents';
  /** Rows are stored as JSON and parsed back with this schema. */
  readonly schema: z.ZodType<Row>;
  compute(changeset: Changeset, parent: ParentState<Row>): readonly DerivedRow<Row>[];
};
