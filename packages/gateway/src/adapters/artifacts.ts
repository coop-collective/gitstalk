/**
 * The only module that touches the ARTIFACTS binding: the run repo, tokens, file reads,
 * the tree walk behind a diff, and the namespace listing that reaping uses, with Artifacts
 * errors turned into `UpstreamError` (retryable or not).
 */
import { Sha } from '@gitstalk/shared-race/ids';

import { UpstreamError } from '../errors';
import type { FileChange } from '../git/diff-text';
import type { RepoReader } from '../repo/object-cache';

export type RepoRemote = { readonly name: string; readonly remote: string };
export type CommitRange = {
  readonly from: Sha;
  readonly to: Sha;
  readonly paths?: readonly string[];
};
export type MintedToken = { readonly token: string; readonly expiresAtMs: number };
export type TokenScope = 'read' | 'write';

export type ArtifactsPort = {
  createRepo(name: string, description: string): Promise<RepoRemote>;
  mintToken(repo: string, scope: TokenScope, ttlSeconds: number): Promise<MintedToken>;
  /** The commit a branch points at, or null when the branch does not exist. */
  branchHead(repo: string, branch: string): Promise<Sha | null>;
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  /**
   * The files that differ between two commits, with both contents (at most 200, by path),
   * optionally only under `paths` (files or directories); null when a commit is missing.
   */
  changedFiles(repo: string, range: CommitRange): Promise<FileChange[] | null>;
  /** The paths that differ between two commits, by path, without contents; null when a commit is missing. */
  changedPaths(repo: string, range: CommitRange): Promise<string[] | null>;
  /** The names of the namespace's repos that `matches` accepts, sorted. */
  listRepos(matches: (name: string) => boolean): Promise<string[]>;
  /** Deletes a repo and its tokens; false when it was already gone. */
  deleteRepo(name: string): Promise<boolean>;
  /** An existing repo's name and git remote (a repository engine's repo, made elsewhere). */
  describeRepo(name: string): Promise<RepoRemote>;
  /** A commit's message, or null when the repo has no such commit (yet). */
  commitMessage(repo: string, sha: string): Promise<string | null>;
  /** The ids of a ref's history, newest first, at most `limit`. */
  history(repo: string, ref: string, limit: number): Promise<string[]>;
};

/** The run repo's default branch: a clone gets the stable line. */
const DEFAULT_BRANCH = 'stalk';
/** Changed files a diff reads (a landed bean touches a handful; the text is cut at 5000 chars). */
const MAX_DIFF_FILES = 200;
/** Blob and tree reads in flight at once. */
const READ_CONCURRENCY = 8;
/** Bytes of a blob a diff reads; a larger one is shown as a binary file. */
const MAX_DIFF_BLOB_BYTES = 256 * 1024;
/** Repos per page of the namespace listing (the binding's maximum). */
const LIST_PAGE_SIZE = 200;
/** Pages a listing follows at most (40,000 repos), so a cursor that loops cannot hang a request. */
const MAX_LIST_PAGES = 200;

/**
 * Error codes worth retrying: the repo is still being created, the service hiccuped, or a
 * repo written moments ago is not visible yet (`NOT_FOUND`: Artifacts is eventually
 * consistent here, and treating it as final aborted races).
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'CREATE_IN_PROGRESS',
  'FORK_IN_PROGRESS',
  'IMPORT_IN_PROGRESS',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
  'NOT_FOUND',
]);

export function artifactsPort(binding: Artifacts): ArtifactsPort {
  return {
    async createRepo(name, description) {
      const created = await call(`create ${name}`, () =>
        binding.create(name, { description, setDefaultBranch: DEFAULT_BRANCH }),
      );
      return { name: created.name, remote: created.remote };
    },
    mintToken(repo, scope, ttlSeconds) {
      return withRepo(binding, repo, async (handle) => {
        const minted = await handle.createToken(scope, ttlSeconds);
        return { token: minted.plaintext, expiresAtMs: Date.parse(minted.expiresAt) };
      });
    },
    branchHead(repo, branch) {
      return withRepo(binding, repo, async (handle) => {
        const [head] = await handle.log({ ref: branch, limit: 1 });
        return head === undefined ? null : Sha.parse(head.hash);
      });
    },
    readFile(repo, ref, path) {
      return withRepo(binding, repo, async (handle) => {
        const file = await handle.readFile({ ref, path });
        return file === null ? null : file.text();
      });
    },
    changedFiles(repo, range) {
      return withRepo(binding, repo, (handle) => changedFilesIn(handle, range));
    },
    changedPaths(repo, range) {
      return withRepo(binding, repo, (handle) => changedPathsIn(handle, range));
    },
    listRepos(matches) {
      return listMatching(binding, matches);
    },
    deleteRepo(name) {
      return call(`delete ${name}`, () => binding.delete(name));
    },
    describeRepo(name) {
      return withRepo(binding, name, async (handle) => {
        const info = await handle.info();
        return { name: info.name, remote: info.remote };
      });
    },
    history(repo, ref, limit) {
      return withRepo(binding, repo, async (handle) => {
        const commits = await handle.log({ ref, limit });
        return commits.map((commit) => commit.hash);
      });
    },
    commitMessage(repo, sha) {
      return withRepo(binding, repo, async (handle) => {
        const commit = await handle.readCommit(sha);
        return commit === null ? null : commit.message;
      });
    },
  };
}

/**
 * A port that asks `pick` for the namespace's port on every call. A run's Durable Object
 * learns whether it drives a race or a person's repository only once it is opened, and the
 * two live in different namespaces (ARTIFACTS and REPOS).
 */
export function selectedArtifactsPort(pick: () => ArtifactsPort): ArtifactsPort {
  return {
    createRepo: (name, description) => pick().createRepo(name, description),
    mintToken: (repo, scope, ttlSeconds) => pick().mintToken(repo, scope, ttlSeconds),
    branchHead: (repo, branch) => pick().branchHead(repo, branch),
    readFile: (repo, ref, path) => pick().readFile(repo, ref, path),
    changedFiles: (repo, range) => pick().changedFiles(repo, range),
    changedPaths: (repo, range) => pick().changedPaths(repo, range),
    listRepos: (matches) => pick().listRepos(matches),
    deleteRepo: (name) => pick().deleteRepo(name),
    describeRepo: (name) => pick().describeRepo(name),
    commitMessage: (repo, sha) => pick().commitMessage(repo, sha),
    history: (repo, ref, limit) => pick().history(repo, ref, limit),
  };
}

/**
 * The files that differ between two commits of an open repo, with both contents (at most
 * 200, by path), optionally only under `paths`; null when a commit is missing.
 */
export async function changedFilesIn(
  handle: RepoReader,
  range: CommitRange,
): Promise<FileChange[] | null> {
  const selected = await changedBlobsIn(handle, range);
  return selected === null ? null : readContents(handle, selected.slice(0, MAX_DIFF_FILES));
}

/** The paths that differ between two commits of an open repo, by path; null when a commit is missing. */
export async function changedPathsIn(
  handle: RepoReader,
  range: CommitRange,
): Promise<string[] | null> {
  const selected = await changedBlobsIn(handle, range);
  return selected === null ? null : selected.map((blob) => blob.path);
}

/** Every changed path of a range (with blob ids), and the contents of the first 200. */
export type RangeChanges = {
  readonly blobs: readonly ChangedBlob[];
  readonly files: readonly FileChange[];
};

/**
 * One tree walk for both: every path that differs between two commits, and the contents of
 * the first 200 by path (the derived-data store reads both); null when a commit is missing.
 */
export async function changesIn(
  handle: RepoReader,
  range: CommitRange,
): Promise<RangeChanges | null> {
  const blobs = await changedBlobsIn(handle, range);
  if (blobs === null) return null;
  return { blobs, files: await readContents(handle, blobs.slice(0, MAX_DIFF_FILES)) };
}

async function changedBlobsIn(
  handle: RepoReader,
  range: CommitRange,
): Promise<ChangedBlob[] | null> {
  const [before, after] = await Promise.all([
    handle.readCommit(range.from),
    handle.readCommit(range.to),
  ]);
  if (before === null || after === null) return null;
  const changed: ChangedBlob[] = [];
  const trees = { before: before.treeHash, after: after.treeHash, prefix: '' };
  await collectChanges(handle, trees, changed);
  const wanted = range.paths;
  return changed
    .filter((blob) => wanted === undefined || isUnder(blob.path, wanted))
    .toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

/** Follows the namespace listing's cursor and keeps the names `matches` accepts. */
async function listMatching(
  binding: Artifacts,
  matches: (name: string) => boolean,
): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const options =
      cursor === undefined ? { limit: LIST_PAGE_SIZE } : { limit: LIST_PAGE_SIZE, cursor };
    // oxlint-disable-next-line no-await-in-loop -- each page follows the previous page's cursor
    const listed = await call('list repos', () => binding.list(options));
    names.push(...listed.repos.map((repo) => repo.name).filter(matches));
    cursor = listed.cursor;
    if (cursor === undefined || cursor === '') break;
  }
  return names.toSorted();
}

/** A path that differs between two trees, with its blob ids (null: absent on that side). */
export type ChangedBlob = { path: string; beforeId: string | null; afterId: string | null };
type TreePair = { before: string | null; after: string | null; prefix: string };

/** Walks two trees together, descending only where they differ. */
async function collectChanges(
  repo: RepoReader,
  trees: TreePair,
  out: ChangedBlob[],
): Promise<void> {
  if (trees.before === trees.after) return;
  const [before, after] = await Promise.all([
    entriesOf(repo, trees.before),
    entriesOf(repo, trees.after),
  ]);
  const names = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  const subtrees: TreePair[] = [];
  for (const name of names) {
    const old = before.get(name);
    const next = after.get(name);
    if (old?.hash === next?.hash && old?.type === next?.type) continue;
    const path = `${trees.prefix}${name}`;
    const oldTree = old?.type === 'tree' ? old.hash : null;
    const nextTree = next?.type === 'tree' ? next.hash : null;
    if (oldTree !== null || nextTree !== null) {
      subtrees.push({ before: oldTree, after: nextTree, prefix: `${path}/` });
    }
    const oldBlob = isFile(old) ? old.hash : null;
    const nextBlob = isFile(next) ? next.hash : null;
    if (oldBlob !== null || nextBlob !== null) {
      out.push({ path, beforeId: oldBlob, afterId: nextBlob });
    }
  }
  await Promise.all(subtrees.map((pair) => collectChanges(repo, pair, out)));
}

/** Whether a path is one of `paths` or lies in a directory among them. */
export function isUnder(path: string, paths: readonly string[]): boolean {
  return paths.some((prefix) => {
    const directory = prefix.replace(/\/+$/, '');
    return path === directory || path.startsWith(`${directory}/`);
  });
}

function isFile(entry: ArtifactsTreeEntry | undefined): entry is ArtifactsTreeEntry {
  return entry !== undefined && entry.type !== 'tree' && entry.type !== 'gitlink';
}

async function entriesOf(
  repo: RepoReader,
  tree: string | null,
): Promise<Map<string, ArtifactsTreeEntry>> {
  if (tree === null) return new Map();
  const entries = (await repo.readTree(tree)) ?? [];
  return new Map(entries.map((entry) => [entry.name, entry]));
}

async function readContents(
  repo: RepoReader,
  changed: readonly ChangedBlob[],
): Promise<FileChange[]> {
  const files: FileChange[] = [];
  for (let start = 0; start < changed.length; start += READ_CONCURRENCY) {
    const batch = changed.slice(start, start + READ_CONCURRENCY);
    const reads = batch.map(async (blob): Promise<FileChange> => {
      const [before, after] = await Promise.all([
        blobText(repo, blob.beforeId),
        blobText(repo, blob.afterId),
      ]);
      return Object.assign(
        {
          path: blob.path,
          before: before?.text ?? null,
          after: after?.text ?? null,
          beforeId: blob.beforeId,
          afterId: blob.afterId,
        },
        before?.oversized === true || after?.oversized === true
          ? { binary: true, beforeBytes: before?.bytes ?? 0, afterBytes: after?.bytes ?? 0 }
          : {},
      );
    });
    // oxlint-disable-next-line no-await-in-loop -- batches bound the reads in flight
    files.push(...(await Promise.all(reads)));
  }
  return files;
}

/**
 * A blob's text. One over `MAX_DIFF_BLOB_BYTES` is not read (its text is empty and it is
 * flagged `oversized`), so it shows as binary, as `textOf` treats it in the explorer.
 */
async function blobText(
  repo: RepoReader,
  hash: string | null,
): Promise<{ text: string; bytes: number; oversized: boolean } | null> {
  if (hash === null) return null;
  const blob = await repo.readBlob(hash);
  if (blob === null) return null;
  if (blob.size > MAX_DIFF_BLOB_BYTES) return { text: '', bytes: blob.size, oversized: true };
  return { text: await blob.text(), bytes: blob.size, oversized: false };
}

/** Runs `use` with a repo capability and always releases it. */
export async function withRepo<T>(
  binding: Artifacts,
  name: string,
  use: (repo: ArtifactsRepo) => Promise<T>,
): Promise<T> {
  const repo = await call(`open ${name}`, () => binding.get(name));
  try {
    return await call(`use ${name}`, () => use(repo));
  } finally {
    repo[Symbol.dispose]();
  }
}

export async function call<T>(what: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof UpstreamError) throw error;
    const code = artifactsCode(error);
    throw new UpstreamError(
      `artifacts ${what} failed (${code ?? 'unknown'})`,
      code !== null && RETRYABLE_CODES.has(code),
      { cause: error },
    );
  }
}

/** The `ArtifactsError.code` of an error, if it carries one. */
export function artifactsCode(error: unknown): string | null {
  if (error instanceof UpstreamError) return artifactsCode(error.cause);
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}
