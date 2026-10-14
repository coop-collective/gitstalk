/**
 * The sprout's first-parent chain and the derivers' progress along it. `extendChain` walks
 * back from a commit to the nearest one already on the chain and appends what it passed;
 * `advance` feeds the changesets after each deriver's head to it, a bounded number per call,
 * one transaction per changeset. The first commit ever derived starts the chain at its
 * parent (the base, position 0): lines older than that are owned by the base.
 */
import type { PathChange } from '@gitstalk/shared-race/derived';

import type { ChangedBlob } from '../adapters/artifacts';
import type { CommitTrailers } from './commit-trailers';
import { commitTitle, commitTrailers } from './commit-trailers';
import type { ChainReader, CommitMeta } from './chain-reader';
import type { ChangedPath, Changeset, Deriver, ParentState } from './deriver';
import type { StoredCommit } from './derived-store';
import {
  appendCommits,
  chainTip,
  clearChain,
  commitBySha,
  commitsAt,
  deriverHead,
  rowAt,
  setDeriverHead,
  writeRows,
} from './derived-store';

/** Commits one walk passes before giving up (a landing adds one or two). */
const MAX_WALK = 256;
/** Restored texts read at once for a revert. */
const READ_CONCURRENCY = 8;

/** An expected failure of a derivation, answered to the caller as an RPC error. */
export class DeriveError extends Error {
  override readonly name = 'DeriveError';
  readonly code: string;
  readonly status: 400 | 404 | 409 | 503;

  constructor(message: string, code: string, status: 400 | 404 | 409 | 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type ChainStore = {
  readonly sql: SqlStorage;
  /** Runs writes atomically (the Durable Object's `transactionSync`). */
  readonly transact: (write: () => void) => void;
};

/**
 * What to do when `sha` does not descend from the chain's tip: a line's head (`sprout`, a
 * landing) means the line was rewritten, so derivation starts over; a commit named by sha is
 * refused as not on the sprout.
 */
export type Detached = 'restart' | 'refuse';

/** The chain's commit for `sha`, appending it and the commits between it and the chain's tip. */
export async function extendChain(
  store: ChainStore,
  reader: ChainReader,
  input: { readonly sha: string; readonly detached: Detached },
): Promise<StoredCommit> {
  const { sha } = input;
  const known = commitBySha(store.sql, sha);
  if (known !== null) return known;
  const tip = chainTip(store.sql);
  const walked = tip === null ? await startOf(reader, sha) : await walkTo(store.sql, reader, input);
  const restarting = tip !== null && walked[0]?.isBase === true;
  const first = tip === null || restarting ? 0 : tip.seq + 1;
  const commits = classify(store.sql, walked, first);
  store.transact(() => {
    if (restarting) clearChain(store.sql);
    appendCommits(store.sql, commits);
  });
  const appended = commits.at(-1);
  if (appended === undefined) throw new Error(`derive: walking to ${sha} appended nothing`);
  return appended;
}

/**
 * Feeds the changesets after each deriver's head, up to position `to`, at most `budget` of
 * them. Answers whether every deriver reached `to`.
 */
export async function advance(
  store: ChainStore,
  reader: ChainReader,
  input: {
    readonly derivers: readonly Deriver<unknown>[];
    readonly to: number;
    readonly budget: number;
  },
): Promise<boolean> {
  const heads = new Map(
    input.derivers.map((deriver) => [
      deriver,
      deriverHead(store.sql, deriver.name, deriver.version).seq,
    ]),
  );
  const from = Math.min(...heads.values()) + 1;
  const last = Math.min(input.to, from + input.budget - 1);
  for (let seq = from; seq <= last; seq += 1) {
    const behind = input.derivers.filter((deriver) => (heads.get(deriver) ?? 0) < seq);
    const needsContents = behind.some((deriver) => deriver.needs === 'contents');
    // oxlint-disable-next-line no-await-in-loop -- changesets apply in chain order
    const changeset = await loadChangeset(store.sql, reader, { seq, needsContents });
    store.transact(() => {
      for (const deriver of behind) applyDeriver(store.sql, deriver, changeset);
    });
    for (const deriver of behind) heads.set(deriver, seq);
  }
  return [...heads.values()].every((seq) => seq >= input.to);
}

/** A deriver's state as `ParentState` (rows parsed with its schema). */
export function parentState<Row>(sql: SqlStorage, deriver: Deriver<Row>): ParentState<Row> {
  return {
    at: (path, seq) => {
      const text = rowAt(sql, deriver.name, { path, seq });
      return text === null ? null : deriver.schema.parse(JSON.parse(text));
    },
  };
}

function applyDeriver(sql: SqlStorage, deriver: Deriver<unknown>, changeset: Changeset): void {
  const rows = deriver.compute(changeset, parentState(sql, deriver));
  writeRows(
    sql,
    { deriver: deriver.name, seq: changeset.seq },
    rows.map((row) => ({ path: row.path, row: JSON.stringify(row.row) })),
  );
  setDeriverHead(sql, deriver.name, { version: deriver.version, seq: changeset.seq });
}

/**
 * The first chain: `sha`'s first-parent history back to the root, or to `MAX_WALK` commits,
 * read in one call. The oldest commit reached is the base.
 */
async function startOf(reader: ChainReader, sha: string): Promise<readonly WalkedCommit[]> {
  const listed = new Map(
    (await reader.history(sha, MAX_WALK)).map((commit) => [commit.sha, commit]),
  );
  const walked: CommitMeta[] = [];
  let next: CommitMeta | undefined = listed.get(sha) ?? (await readOrFail(reader, sha));
  while (next !== undefined && walked.length < MAX_WALK) {
    walked.push(next);
    next = next.parent === null ? undefined : listed.get(next.parent);
  }
  return walked.toReversed().map((meta, index) => ({ meta, isBase: index === 0 }));
}

/**
 * The commits from the tip's child to `sha`, oldest first; for a line rewritten under the
 * chain (`restart`), a new chain from its root instead.
 */
async function walkTo(
  sql: SqlStorage,
  reader: ChainReader,
  input: { readonly sha: string; readonly detached: Detached },
): Promise<readonly WalkedCommit[]> {
  const { sha } = input;
  const tip = chainTip(sql);
  const walked: WalkedCommit[] = [];
  let next = sha;
  for (;;) {
    if (walked.length >= MAX_WALK)
      throw new DeriveError(
        `${sha} is more than ${MAX_WALK} commits past derived history`,
        'not_derivable',
        409,
      );
    // oxlint-disable-next-line no-await-in-loop -- each step follows the previous commit's parent
    const commit = await readOrFail(reader, next);
    walked.push({ meta: commit, isBase: false });
    if (commit.parent === tip?.sha) return walked.toReversed();
    if (commit.parent === null || commitBySha(sql, commit.parent) !== null) {
      if (input.detached === 'refuse')
        throw new DeriveError(`${sha} is not on the sprout's line`, 'not_on_sprout', 400);
      return startOf(reader, sha);
    }
    next = commit.parent;
  }
}

type WalkedCommit = { readonly meta: CommitMeta; readonly isBase: boolean };

/** Stored rows for walked commits, numbered from `first`; reverts find what they restore. */
function classify(sql: SqlStorage, walked: readonly WalkedCommit[], first: number): StoredCommit[] {
  const commits: StoredCommit[] = [];
  const find = (sha: string): StoredCommit | null =>
    commits.find((commit) => commit.sha === sha) ?? commitBySha(sql, sha);
  for (const [index, { meta, isBase }] of walked.entries()) {
    const seq = first + index;
    const base = { seq, sha: meta.sha, title: commitTitle(meta.message), at_ms: meta.atMs };
    if (isBase) commits.push({ ...base, kind: 'base', bean: null, restores: null });
    else commits.push({ ...base, ...kindOf(commitTrailers(meta.message), find) });
  }
  return commits;
}

function kindOf(
  trailers: CommitTrailers,
  find: (sha: string) => StoredCommit | null,
): Pick<StoredCommit, 'kind' | 'bean' | 'restores'> {
  switch (trailers.kind) {
    case 'landing':
      return { kind: 'landing', bean: trailers.bean, restores: null };
    case 'revert': {
      const reverted = find(trailers.reverted);
      // A revert of a commit derivation never saw is an ordinary change.
      if (reverted === null) return { kind: 'commit', bean: null, restores: null };
      return { kind: 'revert', bean: reverted.bean, restores: reverted.seq - 1 };
    }
    case 'reset': {
      const restored = find(trailers.restored);
      return { kind: 'reset', bean: null, restores: restored?.seq ?? null };
    }
    case 'commit':
      return { kind: 'commit', bean: null, restores: null };
  }
}

async function loadChangeset(
  sql: SqlStorage,
  reader: ChainReader,
  input: { readonly seq: number; readonly needsContents: boolean },
): Promise<Changeset> {
  const { seq } = input;
  const byPosition = new Map(commitsAt(sql, [seq - 1, seq]).map((commit) => [commit.seq, commit]));
  const commit = byPosition.get(seq);
  const parent = byPosition.get(seq - 1);
  if (commit === undefined || parent === undefined)
    throw new Error(`derive: the chain has no commit ${seq} or no parent for it`);
  const changes = await reader.changes(parent.sha, commit.sha);
  if (changes === null)
    throw new DeriveError(`commit ${commit.sha} is not readable yet`, 'deriving', 503);
  const texts = new Map(changes.files.map((file) => [file.path, file]));
  const paths = changes.blobs.map((blob): ChangedPath => {
    const file = texts.get(blob.path);
    const isText =
      file !== undefined && file.binary !== true && !hasNul(file.before) && !hasNul(file.after);
    return {
      path: blob.path,
      change: changeOf(blob),
      text: isText ? { before: file.before, after: file.after } : null,
    };
  });
  const restoredAt =
    input.needsContents && commit.restores !== null
      ? commitsAt(sql, [commit.restores])[0]
      : undefined;
  return {
    sha: commit.sha,
    seq,
    kind: commit.kind,
    bean: commit.bean,
    restores: restoredAt === undefined ? null : restoredAt.seq,
    paths: restoredAt === undefined ? paths : await withRestored(reader, restoredAt.sha, paths),
  };
}

/** The paths, each text one with its text at the restored commit. */
async function withRestored(
  reader: ChainReader,
  sha: string,
  paths: readonly ChangedPath[],
): Promise<ChangedPath[]> {
  const out: ChangedPath[] = [];
  for (let start = 0; start < paths.length; start += READ_CONCURRENCY) {
    const batch = paths.slice(start, start + READ_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- batches bound the reads in flight
    const read = await Promise.all(
      batch.map(async (path) =>
        path.text === null ? path : { ...path, restored: await reader.readText(sha, path.path) },
      ),
    );
    out.push(...read);
  }
  return out;
}

async function readOrFail(reader: ChainReader, sha: string): Promise<CommitMeta> {
  const commit = await reader.readCommit(sha);
  if (commit === null)
    throw new DeriveError(`no commit ${sha} in the repository`, 'not_found', 404);
  return commit;
}

function changeOf(blob: ChangedBlob): PathChange {
  if (blob.beforeId === null) return 'added';
  return blob.afterId === null ? 'deleted' : 'modified';
}

function hasNul(text: string | null): boolean {
  return text !== null && text.includes('\0');
}
