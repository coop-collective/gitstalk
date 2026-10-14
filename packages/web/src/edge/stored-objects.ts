/**
 * How each kind of edge-cached object is checked (`EdgeCodec`): a value read back from the
 * Cache API or KV is stored JSON, so it passes the full schema before anything uses it; a value
 * this isolate already validated and holds in memory gets a cheap envelope check only.
 */
import { z } from 'zod';

import { Sha } from '@gitstalk/shared-race/ids';

import type { RepoDiff, RepoTree } from '@gitstalk/shared-ask/repo/repo-types';
import type { FileBlob } from '../repo-pages/engine-reads';
import type { EdgeObjectKind } from './cache-keys';

export type EdgeCodec<T> = {
  readonly kind: EdgeObjectKind;
  /** Full validation of stored JSON; null when it does not pass (read as a miss). */
  readonly parse: (value: unknown) => T | null;
  /** Envelope check of a value this isolate validated before holding it. */
  readonly holds: (value: unknown) => value is T;
};

const RefName = z.union([z.enum(['sprout', 'stalk', 'base']), Sha]);

const StoredTree = z.object({
  ref: RefName,
  sha: Sha,
  files: z.array(z.object({ path: z.string(), size: z.number() })),
});

const StoredFile = z.object({
  path: z.string(),
  size: z.number(),
  binary: z.boolean(),
  content: z.string().nullable(),
  truncated: z.boolean(),
});

const StoredDiff = z.object({
  from: Sha,
  to: Sha,
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['added', 'modified', 'deleted']),
      additions: z.number(),
      deletions: z.number(),
      hunks: z.array(
        z.object({
          oldStart: z.number(),
          oldLines: z.number(),
          newStart: z.number(),
          newLines: z.number(),
          lines: z.array(
            z.object({
              kind: z.enum(['context', 'add', 'del']),
              text: z.string(),
              oldNo: z.number().nullable(),
              newNo: z.number().nullable(),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const TREE_CODEC: EdgeCodec<RepoTree> = {
  kind: 'tree',
  parse: (value) => StoredTree.safeParse(value).data ?? null,
  holds: (value): value is RepoTree =>
    isRecord(value) && typeof value['sha'] === 'string' && Array.isArray(value['files']),
};

export const FILE_CODEC: EdgeCodec<FileBlob> = {
  kind: 'file',
  parse: (value) => StoredFile.safeParse(value).data ?? null,
  holds: (value): value is FileBlob =>
    isRecord(value) && typeof value['path'] === 'string' && typeof value['binary'] === 'boolean',
};

export const DIFF_CODEC: EdgeCodec<RepoDiff> = {
  kind: 'diff',
  parse: (value) => StoredDiff.safeParse(value).data ?? null,
  holds: (value): value is RepoDiff =>
    isRecord(value) && typeof value['from'] === 'string' && Array.isArray(value['files']),
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
