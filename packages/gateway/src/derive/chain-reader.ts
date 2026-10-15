/**
 * What derivation reads from a repository, over one opened Artifacts handle: a commit's
 * parent and message, the changes between two commits (one tree walk, contents of up to 200
 * files), a file's text at a commit, and a line's head. No per-line calls.
 */
import type { RangeChanges } from '../adapters/artifacts';
import { call, changesIn } from '../adapters/artifacts';
import type { RepoReader } from '../repo/object-cache';
import { Sha } from '@gitstalk/shared-race/ids';

/** A commit as the chain needs it. */
export type CommitMeta = {
  readonly sha: string;
  /** The first parent; null for a root commit. */
  readonly parent: string | null;
  readonly message: string;
  readonly atMs: number;
};

export type ChainReader = {
  readCommit(sha: string): Promise<CommitMeta | null>;
  /** Up to `limit` commits of `sha`'s history, newest first (one call). */
  history(sha: string, limit: number): Promise<CommitMeta[]>;
  changes(from: string, to: string): Promise<RangeChanges | null>;
  /** A file's text at a commit; null when absent. */
  readText(sha: string, path: string): Promise<string | null>;
  /** The commit a branch (`sprout`, `stalk`) points at, or null. */
  head(branch: string): Promise<string | null>;
};

/** The repository a chain reader opens, and what each opened handle is read through. */
export type ChainSource = {
  readonly binding: Artifacts;
  readonly repo: string;
  /** Wraps the handle, for instance in the object tier; without it reads go to Artifacts. */
  readonly through?: (handle: RepoReader) => RepoReader;
};

/**
 * Runs `use` with a reader over the repository `source.repo`, releasing it after. Only the
 * reader's Artifacts calls become `UpstreamError`s; what `use` throws passes unchanged.
 */
export async function withChainReader<T>(
  source: ChainSource,
  use: (reader: ChainReader) => Promise<T>,
): Promise<T> {
  const handle = await call(`open ${source.repo}`, () => source.binding.get(source.repo));
  try {
    return await use(chainReader(source.through?.(handle) ?? handle));
  } finally {
    handle[Symbol.dispose]();
  }
}

function chainReader(handle: RepoReader): ChainReader {
  return {
    readCommit: (sha) =>
      call('read commit', async () => {
        const commit = await handle.readCommit(sha);
        return commit === null ? null : toMeta(commit);
      }),
    history: (sha, limit) =>
      call('log', async () => (await handle.log({ ref: sha, limit })).map(toMeta)),
    changes: (from, to) =>
      call('diff', () => changesIn(handle, { from: Sha.parse(from), to: Sha.parse(to) })),
    readText: (sha, path) =>
      call('read file', async () => {
        const file = await handle.readFile({ ref: sha, path });
        return file === null ? null : file.text();
      }),
    head: (branch) =>
      call('log', async () => {
        const [head] = await handle.log({ ref: branch, limit: 1 });
        return head === undefined ? null : head.hash;
      }),
  };
}

function toMeta(commit: ArtifactsCommitMetadata): CommitMeta {
  return {
    sha: commit.hash,
    parent: commit.parents[0] ?? null,
    message: commit.message,
    atMs: commit.committedAt * 1000,
  };
}
