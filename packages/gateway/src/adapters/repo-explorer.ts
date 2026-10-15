/**
 * Read-only views of a run repo for the web app's explorer (`docs/claude-opus/13` §4),
 * through the ARTIFACTS binding: one directory, one file, a diff, history and a grep at a
 * ref. Every answer is bounded and says when a bound was hit (`truncated`). The runner has
 * no read endpoints, so diffs and grep walk trees and blobs here as well.
 */
import type {
  RepoCommit,
  RepoDiff,
  RepoFile,
  RepoGrep,
  RepoGrepMatch,
  RepoLog,
  RepoTree,
  RepoTreeEntry,
} from '@gitstalk/shared-race/rpc';
import { Sha } from '@gitstalk/shared-race/ids';

import { GatewayError, UpstreamError } from '../errors';
import { diffReport } from '../git/diff-text';
import { compileGrep, lineMatches } from '../repo/grep-pattern';
import type { RepoReader } from '../repo/object-cache';
import { artifactsCode, changedFilesIn, isUnder } from './artifacts';

/** Entries of one directory listing, and of a recursive one. */
const MAX_TREE_ENTRIES = 1000;
const MAX_RECURSIVE_ENTRIES = 5000;
/** Bytes of a file returned (or searched). */
const MAX_FILE_BYTES = 256 * 1024;
/** Characters of a diff's patch text. */
const MAX_PATCH_CHARS = 100_000;
/** Files a diff covers (the adapter reads at most this many). */
const MAX_DIFF_FILES = 200;
/** Commits a log returns, and commits it looks at when filtering by path. */
const MAX_LOG = 100;
const MAX_LOG_SCAN = 200;
/** Files a grep reads, matches it returns, and characters of a matching line. */
const MAX_GREP_FILES = 300;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_LINE = 300;
/** Characters of a commit message. */
const MAX_MESSAGE = 2000;
/** Files of a whole-tree listing (the import closure of tests). */
const MAX_LISTED_FILES = 5000;
/** Blob reads in flight at once. */
const READ_CONCURRENCY = 8;

export type ResolvedRef = { readonly commit: string; readonly tree: string };

export type RepoExplorer = {
  /** The commit and root tree a ref names; null when it names nothing. */
  resolve(ref: string): Promise<ResolvedRef | null>;
  tree(ref: string, path: string, recursive?: boolean): Promise<RepoTree>;
  file(ref: string, path: string): Promise<RepoFile>;
  diff(from: string, to: string, paths: readonly string[] | null): Promise<RepoDiff>;
  log(ref: string, paths: readonly string[] | null, limit: number): Promise<RepoLog>;
  /** A literal search, or with `options.regex` a safe-subset regular expression. */
  grep(
    ref: string,
    pattern: string,
    paths: readonly string[] | null,
    options?: { readonly regex?: boolean },
  ): Promise<RepoGrep>;
  /** Every file path at a commit (up to 5,000), for resolving imports. */
  listFiles(commit: string): Promise<{ files: string[]; truncated: boolean }>;
  /** Text of files at a commit; null for a missing, binary or oversized file. */
  readTexts(commit: string, paths: readonly string[]): Promise<(string | null)[]>;
  /** Reads every tree and blob at a ref (filling a cache, when the reader has one). */
  warm(ref: string): Promise<{ readonly commit: string; readonly files: number }>;
};

/**
 * The explorer over a run repo. `through` wraps each opened handle, for instance in the
 * RunDO's object cache; without it every read goes to Artifacts.
 */
export function repoExplorer(
  binding: Artifacts,
  repo: string,
  through: (handle: RepoReader) => RepoReader = (handle) => handle,
): RepoExplorer {
  const open = async <T>(use: (handle: RepoReader) => Promise<T>): Promise<T> => {
    // The repo is opened on the first read that reaches it: a read the cache answers whole
    // never calls Artifacts at all.
    const repoHandle: { opened: Promise<ArtifactsRepo> | null } = { opened: null };
    const handle = (): Promise<ArtifactsRepo> => {
      repoHandle.opened ??= call(() => binding.get(repo));
      return repoHandle.opened;
    };
    try {
      return await call(() => use(through(lazyReader(handle))));
    } finally {
      // A repo that failed to open has nothing to release; the read already threw its error.
      await repoHandle.opened?.then(
        (opened) => opened[Symbol.dispose](),
        () => undefined,
      );
    }
  };
  return {
    resolve: (ref) => open((handle) => resolveRef(handle, ref)),
    tree: (ref, path, recursive = false) =>
      open((handle) =>
        recursive ? readRecursive(handle, ref, path) : readDirectory(handle, ref, path),
      ),
    file: (ref, path) => open((handle) => readOne(handle, ref, path)),
    diff: (from, to, paths) =>
      open(async (handle) => {
        const [base, head] = await Promise.all([required(handle, from), required(handle, to)]);
        const changes = await changedFilesIn(handle, {
          from: Sha.parse(base.commit),
          to: Sha.parse(head.commit),
          ...(paths === null ? {} : { paths }),
        });
        if (changes === null) throw new GatewayError('a commit is missing', 'not_found', 404);
        const report = diffReport(changes, MAX_PATCH_CHARS);
        return {
          from: { ref: from, commit: base.commit },
          to: { ref: to, commit: head.commit },
          files: report.files,
          patch: report.text,
          truncated: changes.length >= MAX_DIFF_FILES || report.truncated,
        };
      }),
    log: (ref, paths, limit) => open((handle) => readLog(handle, { ref, paths, limit })),
    grep: (ref, pattern, paths, options) =>
      open((handle) => search(handle, { ref, pattern, paths, regex: options?.regex === true })),
    listFiles: (commit) =>
      open(async (handle) => {
        const resolved = await required(handle, commit);
        const files: string[] = [];
        const truncated = await walkFiles(handle, resolved.tree, {
          prefix: '',
          limit: MAX_LISTED_FILES,
          visit: (path) => files.push(path),
        });
        return { files, truncated };
      }),
    readTexts: (commit, paths) =>
      open(async (handle) => {
        const texts: (string | null)[] = [];
        for (let start = 0; start < paths.length; start += READ_CONCURRENCY) {
          const batch = paths.slice(start, start + READ_CONCURRENCY);
          const reads = batch.map(async (path) => {
            const blob = await handle.readFile({ ref: commit, path });
            return blob === null ? null : textOf(await blob.arrayBuffer());
          });
          // oxlint-disable-next-line no-await-in-loop -- batches bound the reads in flight
          texts.push(...(await Promise.all(reads)));
        }
        return texts;
      }),
    warm: (ref) => open((handle) => warmLine(handle, ref)),
  };
}

/**
 * Reads every tree and blob at `ref` through `handle` (filling its cache, when it has one).
 * Blobs go through `prefetchBlob` when the reader has it, so a blob already held is skipped
 * without loading its body.
 */
export async function warmLine(
  handle: RepoReader,
  ref: string,
): Promise<{ readonly commit: string; readonly files: number }> {
  const resolved = await required(handle, ref);
  const blobs: string[] = [];
  await walkFiles(handle, resolved.tree, {
    prefix: '',
    limit: MAX_LISTED_FILES,
    visit: (_path, hash) => blobs.push(hash),
  });
  for (let start = 0; start < blobs.length; start += READ_CONCURRENCY) {
    const batch = blobs.slice(start, start + READ_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- batches bound the reads in flight
    await Promise.all(
      batch.map(async (hash) => {
        if (handle.prefetchBlob === undefined) await handle.readBlob(hash);
        else await handle.prefetchBlob(hash);
      }),
    );
  }
  return { commit: resolved.commit, files: blobs.length };
}

/** A reader whose calls open the repo first (once). */
function lazyReader(handle: () => Promise<ArtifactsRepo>): RepoReader {
  return {
    readTree: async (hash) => (await handle()).readTree(hash),
    readBlob: async (hash) => (await handle()).readBlob(hash),
    readCommit: async (hash) => (await handle()).readCommit(hash),
    readFile: async (args) => (await handle()).readFile(args),
    log: async (options) => (await handle()).log(options),
  };
}

async function resolveRef(handle: RepoReader, ref: string): Promise<ResolvedRef | null> {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const commit = await handle.readCommit(ref);
    return commit === null ? null : { commit: commit.hash, tree: commit.treeHash };
  }
  const [head] = await handle.log({ ref, limit: 1 });
  return head === undefined ? null : { commit: head.hash, tree: head.treeHash };
}

async function required(handle: RepoReader, ref: string): Promise<ResolvedRef> {
  const resolved = await resolveRef(handle, ref);
  if (resolved === null) throw new GatewayError(`no ref ${ref} in the run repo`, 'not_found', 404);
  return resolved;
}

async function readDirectory(handle: RepoReader, ref: string, path: string): Promise<RepoTree> {
  const resolved = await required(handle, ref);
  const tree = await subtree(handle, resolved.tree, path);
  if (tree === null) throw new GatewayError(`no directory ${path} at ${ref}`, 'not_found', 404);
  const entries = (await handle.readTree(tree)) ?? [];
  const listed: RepoTreeEntry[] = entries
    .map((entry) => ({
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      type: entry.type,
      sha: entry.hash,
    }))
    .toSorted(
      (a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || (a.name < b.name ? -1 : 1),
    );
  return {
    ref,
    commit: resolved.commit,
    path,
    entries: listed.slice(0, MAX_TREE_ENTRIES),
    truncated: listed.length > MAX_TREE_ENTRIES,
  };
}

/**
 * Every entry under `path` at a ref in one answer, sorted by path: each level's directories
 * are read in parallel batches, so the whole tree costs one call per level, not per directory.
 */
async function readRecursive(handle: RepoReader, ref: string, path: string): Promise<RepoTree> {
  const resolved = await required(handle, ref);
  const root = await subtree(handle, resolved.tree, path);
  if (root === null) throw new GatewayError(`no directory ${path} at ${ref}`, 'not_found', 404);
  const listed: RepoTreeEntry[] = [];
  let level = [{ tree: root, prefix: path === '' ? '' : `${path}/` }];
  while (level.length > 0 && listed.length <= MAX_RECURSIVE_ENTRIES) {
    const next: { tree: string; prefix: string }[] = [];
    for (let start = 0; start < level.length; start += READ_CONCURRENCY) {
      const batch = level.slice(start, start + READ_CONCURRENCY);
      // oxlint-disable-next-line no-await-in-loop -- batches bound the reads in flight
      const read = await Promise.all(
        batch.map(async (dir) => (await handle.readTree(dir.tree)) ?? []),
      );
      batch.forEach((dir, index) => {
        for (const entry of read[index] ?? []) {
          const entryPath = `${dir.prefix}${entry.name}`;
          listed.push({ name: entry.name, path: entryPath, type: entry.type, sha: entry.hash });
          if (entry.type === 'tree') next.push({ tree: entry.hash, prefix: `${entryPath}/` });
        }
      });
    }
    level = next;
  }
  return {
    ref,
    commit: resolved.commit,
    path,
    entries: listed.toSorted((a, b) => (a.path < b.path ? -1 : 1)).slice(0, MAX_RECURSIVE_ENTRIES),
    truncated: listed.length > MAX_RECURSIVE_ENTRIES || level.length > 0,
  };
}

/** The tree at `path` under a root tree (`''`: the root), or null. */
async function subtree(handle: RepoReader, root: string, path: string): Promise<string | null> {
  let current = root;
  for (const segment of path === '' ? [] : path.split('/')) {
    // oxlint-disable-next-line no-await-in-loop -- each level is read from the one above
    const entries = (await handle.readTree(current)) ?? [];
    const next = entries.find((entry) => entry.name === segment && entry.type === 'tree');
    if (next === undefined) return null;
    current = next.hash;
  }
  return current;
}

/** The object a path names under a tree (a blob or a subtree), or null. */
async function entryAt(
  handle: RepoReader,
  root: string | null,
  path: string,
  cache: Map<string, ArtifactsTreeEntry[]>,
): Promise<string | null> {
  let current = root;
  for (const segment of path.split('/')) {
    if (current === null) return null;
    const cached = cache.get(current);
    // oxlint-disable-next-line no-await-in-loop -- each level is read from the one above
    const entries = cached ?? (await handle.readTree(current)) ?? [];
    cache.set(current, entries);
    current = entries.find((entry) => entry.name === segment)?.hash ?? null;
  }
  return current;
}

async function readOne(handle: RepoReader, ref: string, path: string): Promise<RepoFile> {
  const resolved = await required(handle, ref);
  const blob = await handle.readFile({ ref: resolved.commit, path });
  if (blob === null) throw new GatewayError(`no file ${path} at ${ref}`, 'not_found', 404);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const isBinary = bytes.subarray(0, MAX_FILE_BYTES).includes(0);
  return {
    ref,
    commit: resolved.commit,
    path,
    size: bytes.length,
    binary: isBinary,
    content: isBinary ? null : new TextDecoder().decode(bytes.subarray(0, MAX_FILE_BYTES)),
    truncated: bytes.length > MAX_FILE_BYTES,
  };
}

async function readLog(
  handle: RepoReader,
  query: { ref: string; paths: readonly string[] | null; limit: number },
): Promise<RepoLog> {
  const limit = Math.max(1, Math.min(MAX_LOG, Math.trunc(query.limit)));
  const paths = query.paths;
  if (paths === null || paths.length === 0) {
    const commits = await handle.log({ ref: query.ref, limit });
    return {
      ref: query.ref,
      commits: commits.map(toCommit),
      scanned: commits.length,
      truncated: false,
    };
  }
  const commits = await handle.log({ ref: query.ref, limit: MAX_LOG_SCAN });
  const cache = new Map<string, ArtifactsTreeEntry[]>();
  const touching: RepoCommit[] = [];
  let scanned = 0;
  for (const [index, commit] of commits.entries()) {
    if (touching.length >= limit) break;
    scanned += 1;
    // oxlint-disable-next-line no-await-in-loop -- commits are compared with their parents in order
    const parentTree = await parentTreeOf(handle, commit, commits[index + 1]);
    // oxlint-disable-next-line no-await-in-loop -- the tree cache is shared from commit to commit
    if (await touches(handle, { commit, parentTree, paths, cache }))
      touching.push(toCommit(commit));
  }
  return {
    ref: query.ref,
    commits: touching,
    scanned,
    truncated: touching.length < limit && commits.length >= MAX_LOG_SCAN,
  };
}

async function parentTreeOf(
  handle: RepoReader,
  commit: ArtifactsCommitMetadata,
  next: ArtifactsCommitMetadata | undefined,
): Promise<string | null> {
  const parent = commit.parents[0];
  if (parent === undefined) return null;
  if (next?.hash === parent) return next.treeHash;
  return (await handle.readCommit(parent))?.treeHash ?? null;
}

async function touches(
  handle: RepoReader,
  compare: {
    commit: ArtifactsCommitMetadata;
    parentTree: string | null;
    paths: readonly string[];
    cache: Map<string, ArtifactsTreeEntry[]>;
  },
): Promise<boolean> {
  for (const path of compare.paths) {
    const trimmed = path.replace(/\/+$/, '');
    // oxlint-disable-next-line no-await-in-loop -- stop at the first path that changed
    const [now, before] = await Promise.all([
      entryAt(handle, compare.commit.treeHash, trimmed, compare.cache),
      entryAt(handle, compare.parentTree, trimmed, compare.cache),
    ]);
    if (now !== before) return true;
  }
  return false;
}

function toCommit(commit: ArtifactsCommitMetadata): RepoCommit {
  return {
    sha: commit.hash,
    parents: [...commit.parents],
    message: commit.message.slice(0, MAX_MESSAGE),
    author: { name: commit.author.name, email: commit.author.email },
    committed_at: new Date(commit.committedAt * 1000).toISOString(),
  };
}

async function search(
  handle: RepoReader,
  query: { ref: string; pattern: string; paths: readonly string[] | null; regex: boolean },
): Promise<RepoGrep> {
  const matcher = compileGrep(query.pattern, { regex: query.regex });
  const resolved = await required(handle, query.ref);
  const blobs: { path: string; hash: string }[] = [];
  const isFull = await walkFiles(handle, resolved.tree, {
    prefix: '',
    limit: MAX_GREP_FILES,
    visit: (path, hash) => {
      if (query.paths === null || isUnder(path, query.paths)) blobs.push({ path, hash });
    },
    filter: query.paths,
  });
  const matches: RepoGrepMatch[] = [];
  let scanned = 0;
  for (
    let start = 0;
    start < blobs.length && matches.length < MAX_GREP_MATCHES;
    start += READ_CONCURRENCY
  ) {
    const batch = blobs.slice(start, start + READ_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- batches bound the reads in flight
    const texts = await Promise.all(batch.map(async (blob) => blobText(handle, blob.hash)));
    batch.forEach((blob, index) => {
      scanned += 1;
      const text = texts[index];
      if (text !== null && text !== undefined)
        collectMatches(text, { path: blob.path, matcher, matches });
    });
  }
  return {
    ref: query.ref,
    commit: resolved.commit,
    pattern: query.pattern,
    matches: matches.slice(0, MAX_GREP_MATCHES),
    files_scanned: scanned,
    truncated: isFull || matches.length >= MAX_GREP_MATCHES,
  };
}

function collectMatches(
  text: string,
  target: { path: string; matcher: RegExp; matches: RepoGrepMatch[] },
): void {
  text.split('\n').forEach((line, index) => {
    if (target.matches.length >= MAX_GREP_MATCHES || !lineMatches(target.matcher, line)) return;
    target.matches.push({ path: target.path, line: index + 1, text: line.slice(0, MAX_GREP_LINE) });
  });
}

/**
 * Visits every file under a tree (paths relative to the repo root), at most `limit`; with
 * `filter`, only directories on the way to or under a filtered path are opened. True when
 * the limit cut the walk short.
 */
async function walkFiles(
  handle: RepoReader,
  root: string,
  walk: {
    prefix: string;
    limit: number;
    visit: (path: string, hash: string) => void;
    filter?: readonly string[] | null;
  },
): Promise<boolean> {
  const pending: { tree: string; prefix: string }[] = [{ tree: root, prefix: walk.prefix }];
  let visited = 0;
  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined) break;
    // oxlint-disable-next-line no-await-in-loop -- a breadth-first walk, one directory at a time
    const entries = (await handle.readTree(next.tree)) ?? [];
    for (const entry of entries) {
      const path = `${next.prefix}${entry.name}`;
      if (entry.type === 'tree') {
        if (isOnTheWay(path, walk.filter)) pending.push({ tree: entry.hash, prefix: `${path}/` });
        continue;
      }
      if (entry.type === 'gitlink') continue;
      if (walk.filter !== undefined && walk.filter !== null && !isUnder(path, walk.filter))
        continue;
      if (visited >= walk.limit) return true;
      visited += 1;
      walk.visit(path, entry.hash);
    }
  }
  return false;
}

/** A directory worth opening: no filter, or it holds or lies under a filtered path. */
function isOnTheWay(directory: string, filter: readonly string[] | null | undefined): boolean {
  if (filter === undefined || filter === null) return true;
  return filter.some((path) => {
    const wanted = path.replace(/\/+$/, '');
    return wanted.startsWith(`${directory}/`) || isUnder(directory, [wanted]);
  });
}

async function blobText(handle: RepoReader, hash: string): Promise<string | null> {
  const blob = await handle.readBlob(hash);
  if (blob === null || blob.size > MAX_FILE_BYTES) return null;
  return textOf(await blob.arrayBuffer());
}

/** Text of a file, unless it is binary or oversized. */
function textOf(buffer: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return null;
  return new TextDecoder().decode(bytes);
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof GatewayError || error instanceof UpstreamError) throw error;
    if (artifactsCode(error) === 'NOT_FOUND') {
      throw new GatewayError('no such run repo', 'not_found', 404, { cause: error });
    }
    throw new UpstreamError('the run repo could not be read', true, { cause: error });
  }
}
