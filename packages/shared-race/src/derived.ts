/**
 * Derived history (docs/claude-18-lessons-from-scion.md §4): what the gateway computes from
 * each change on a repository's sprout, through one mechanism, and serves without a clone.
 * `whyLines` is line-level blame by bean ("which bean last changed these lines, and why");
 * `pathHistory` is the landings and reverts that touched one path. Schemas, because the web
 * app and the MCP server validate what the gateway answers.
 */
import { z } from 'zod';

import type { RpcResult } from './rpc';

/** How a commit on the sprout came to be. `base`: where derivation began (older lines). */
export const DerivedCommitKind = z.enum(['base', 'landing', 'revert', 'reset', 'commit']);
export type DerivedCommitKind = z.infer<typeof DerivedCommitKind>;

/** A sprout commit as derived history names it. */
export const DerivedCommit = z.object({
  sha: z.string(),
  kind: DerivedCommitKind,
  /** The bean that landed it (a landing), or whose landing it took back (a revert). */
  bean: z.string().nullable(),
  /** The commit's first line. */
  title: z.string(),
  /** ISO 8601, from the commit. */
  at: z.string(),
  /** Whether the stalk carries it; null when the stalk's head is not known here. */
  on_stalk: z.boolean().nullable(),
});
export type DerivedCommit = z.infer<typeof DerivedCommit>;

/** A bean as blame and history describe it. */
export const DerivedBean = z.object({
  bean: z.string(),
  /** The bean's title (its intent), as pushed. */
  title: z.string(),
  actor: z.string().nullable(),
  /** Decision cards that named this bean, as the bean or as the one it was weighed against. */
  decisions: z.array(z.string()),
  /** Whether a later revert took this bean off the sprout. */
  reverted: z.boolean(),
});
export type DerivedBean = z.infer<typeof DerivedBean>;

/** Lines `start`..`end` (1-based, inclusive) were last changed by `commit`. */
export const BlameRange = z.object({
  start: z.number().int().min(1),
  end: z.number().int().min(1),
  commit: z.string(),
});
export type BlameRange = z.infer<typeof BlameRange>;

/** Who last changed each line range of a file at a commit of the sprout. */
export const WhyLines = z.object({
  path: z.string(),
  ref: z.string(),
  /** The commit the ref named. */
  commit: z.string(),
  /** Lines in the file; null for a file read as binary (one range covers it). */
  lines: z.number().int().nullable(),
  ranges: z.array(BlameRange),
  /** The commits the ranges name, by sha. */
  commits: z.record(z.string(), DerivedCommit),
  /** The beans those commits belong to, by bean. */
  beans: z.record(z.string(), DerivedBean),
});
export type WhyLines = z.infer<typeof WhyLines>;

/** How a commit changed the path. */
export const PathChange = z.enum(['added', 'modified', 'deleted']);
export type PathChange = z.infer<typeof PathChange>;

/** The commits of the sprout that touched one path, newest first. */
export const PathHistory = z.object({
  path: z.string(),
  ref: z.string(),
  commit: z.string(),
  entries: z.array(DerivedCommit.extend({ change: PathChange })),
  beans: z.record(z.string(), DerivedBean),
  /** More entries exist than `limit` allowed. */
  truncated: z.boolean(),
});
export type PathHistory = z.infer<typeof PathHistory>;

/** `ref`: `sprout` (default), `stalk` or a commit sha of the sprout; bean branches are not derived. */
export type WhyLinesInput = {
  readonly path: string;
  readonly ref?: string | undefined;
  /** 1-based, inclusive; the whole file when both are absent. */
  readonly start?: number | undefined;
  readonly end?: number | undefined;
};

export type PathHistoryInput = {
  readonly path: string;
  readonly ref?: string | undefined;
  /** Entries returned, newest first (default 20, at most 100). */
  readonly limit?: number | undefined;
};

/**
 * The derived-history RPC on the gateway's default entrypoint, by engine id (as the run reads
 * take it). Only registered repositories derive history; a benchmark run answers `not_found`.
 * `deriving` (503) means the history is still being computed: ask again shortly.
 */
export type DerivedRpc = {
  whyLines(run: string, input: WhyLinesInput): Promise<RpcResult<WhyLines>>;
  pathHistory(run: string, input: PathHistoryInput): Promise<RpcResult<PathHistory>>;
};
