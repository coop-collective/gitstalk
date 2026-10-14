/**
 * `bean_commit` (docs/claude-opus/33): a contributor writes files to its own bean branch without a
 * checkout. The gateway builds the commit from the changed paths only and moves the branch
 * with compare-and-swap on `expected_head`.
 */
import { z } from 'zod';

import { Sha, TaskId } from './ids';
import { isSafeRepoPath } from './task';

/** At most this many paths change in one commit. */
export const MAX_COMMIT_CHANGES = 64;
/** At most this many UTF-8 bytes of one file's new text. */
export const MAX_COMMIT_FILE_BYTES = 128 * 1024;
/** At most this many UTF-8 bytes of new text across the whole commit. */
export const MAX_COMMIT_BYTES = 192 * 1024;

/** A writer's key for one attempt: the same key with the same input replays the first result. */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** A relative path inside the repository that names no `.git` directory at any depth. */
export const CommitPath = z
  .string()
  .refine(isSafeRepoPath, 'must be a relative path inside the repository (no "..", no leading /)')
  .refine(
    (path) => !path.split('/').some((segment) => segment.toLowerCase() === '.git'),
    'must not touch a .git directory',
  );

/** One path's new text, or its deletion. */
export const BeanCommitChange = z.union([
  z.strictObject({
    path: CommitPath,
    content: z
      .string()
      .refine(
        (text) => utf8Length(text) <= MAX_COMMIT_FILE_BYTES,
        `a file's content is at most ${MAX_COMMIT_FILE_BYTES} bytes`,
      ),
  }),
  z.strictObject({ path: CommitPath, delete: z.literal(true) }),
]);
export type BeanCommitChange = z.infer<typeof BeanCommitChange>;

const CommitChangeList = z.array(BeanCommitChange).min(1).max(MAX_COMMIT_CHANGES);

/**
 * The changes of one server-side commit, as every writer sends them (`bean_commit`, the
 * automation builder, Settings → Approval rules): safe paths, each once, within the caps.
 */
export const CommitChanges = CommitChangeList.superRefine((changes, context) => {
  const problem = changesProblem(changes);
  if (problem !== null) context.addIssue({ code: 'custom', message: problem });
});

export const CommitMessage = z.string().trim().min(1).max(10_000);

export const BeanCommitInput = z
  .strictObject({
    bean: TaskId,
    /** The branch head the changes were made against; null creates the branch from the sprout. */
    expected_head: Sha.nullable(),
    changes: CommitChangeList,
    message: CommitMessage,
    idempotency_key: IdempotencyKey,
  })
  .superRefine((input, context) => {
    const problem = changesProblem(input.changes);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  });
export type BeanCommitInput = z.infer<typeof BeanCommitInput>;

/** The branch moved: what it points at now. */
export const BeanCommitted = z.strictObject({
  kind: z.literal('committed'),
  bean: TaskId,
  branch: z.string(),
  commit: Sha,
  parent: Sha,
  tree: Sha,
  /** Paths written or deleted. */
  files: z.number().int().min(1),
  /** New objects in the pushed pack (blobs, trees and the commit). */
  objects: z.number().int().min(1),
  /** Trees read to build it: the cost scales with the change, not the repository. */
  trees_read: z.number().int().min(0),
});
export type BeanCommitted = z.infer<typeof BeanCommitted>;

/** The branch was not at `expected_head`: read it at `current_head` and try again. */
export const BeanCommitConflict = z.strictObject({
  kind: z.literal('conflict'),
  bean: TaskId,
  branch: z.string(),
  expected_head: Sha.nullable(),
  current_head: Sha.nullable(),
});
export type BeanCommitConflict = z.infer<typeof BeanCommitConflict>;

export const BeanCommitResult = z.discriminatedUnion('kind', [BeanCommitted, BeanCommitConflict]);
export type BeanCommitResult = z.infer<typeof BeanCommitResult>;

/** Why a set of changes cannot be one commit (a path twice, or a file under another), or null. */
export function changesProblem(changes: readonly { readonly path: string }[]): string | null {
  const paths = new Set<string>();
  let total = 0;
  for (const change of changes) {
    if (paths.has(change.path)) return `${change.path} is changed twice`;
    paths.add(change.path);
    if ('content' in change && typeof change.content === 'string')
      total += utf8Length(change.content);
  }
  if (total > MAX_COMMIT_BYTES)
    return `the changes are ${total} bytes; one commit carries at most ${MAX_COMMIT_BYTES} (use git for more)`;
  for (const path of paths) {
    const parent = parentsOf(path).find((directory) => paths.has(directory));
    if (parent !== undefined) return `${path} is inside ${parent}, which is also changed as a file`;
  }
  return null;
}

/** `a/b/c` → `a`, `a/b`. */
function parentsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** The length of `text` in UTF-8 (a lone surrogate counts as the 3-byte replacement). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x80) bytes += 1;
    else if (point < 0x800) bytes += 2;
    else if (point < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
