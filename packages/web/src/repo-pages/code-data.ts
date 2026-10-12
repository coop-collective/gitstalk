/**
 * What the Code tab reads for one request: the beans (for the ref switcher, the side column
 * and the Changes count), the tree at the chosen ref, the line's newest commit, and the README
 * or the file. Independent reads start together, and the number of gateway calls is fixed,
 * whatever the folder holds. The tree and the file are read at a commit sha whenever one is
 * known (a line's newest commit, a bean's head), which a public repository's reads share
 * across requests.
 */
import { Sha } from '@gitstalk/shared-race/ids';

import type { RefName, RepoTree } from '@gitstalk/shared-ask/repo/repo-types';

import type { Change } from '../changes/changes';
import { changesOf } from '../changes/changes';
import type { CodeView, RefChoice, TreeEntry } from '../code/tree';
import { listing, readmeOf } from '../code/tree';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { PushedBean } from '../changes/pushed-beans';
import type { HistoryRow, LogCommit } from '../history/history';
import { historyOf, landingsOf } from '../history/history';
import type { EngineReads, FileBlob } from './engine-reads';

/** What last happened on the browsed ref: the line's newest commit, or the bean itself. */
export type CodeHead =
  | { readonly kind: 'commit'; readonly row: HistoryRow; readonly line: 'stalk' | 'sprout' }
  | { readonly kind: 'bean'; readonly change: Change }
  | null;

export type CodeBody =
  | {
      readonly kind: 'folder';
      readonly entries: readonly TreeEntry[];
      readonly readme: { readonly path: string; readonly text: string } | null;
    }
  | { readonly kind: 'file'; readonly file: FileBlob }
  | { readonly kind: 'missing'; readonly what: string };

export type CodeData = {
  readonly changes: readonly Change[];
  /** The commit the tree was read at ('' when nothing could be read). */
  readonly sha: string;
  readonly head: CodeHead;
  readonly body: CodeBody;
};

export type CodeInput = {
  readonly ref: RefChoice;
  readonly path: string;
  readonly view: CodeView;
};

export async function codeData(reads: EngineReads, input: CodeInput): Promise<CodeData> {
  const line = input.ref.kind === 'stalk' || input.ref.kind === 'sprout' ? input.ref.kind : null;
  const [events, pushed, located] = await Promise.all([
    reads.events(),
    reads.pushed(),
    locate(reads, input.ref, line),
  ]);
  const changes = changesOf(events, pushed);
  if (located === null)
    return {
      changes,
      sha: '',
      head: null,
      body: missing(`There is no bean ${refText(input.ref)}.`),
    };
  const { tree, log } = located;
  const head =
    input.ref.kind === 'bean'
      ? beanHead(changes, input.ref.name)
      : lineHead({ line, newest: log[0], pushed, events });
  return { changes, sha: tree.sha, head, body: await bodyOf(reads, tree.sha, tree.files, input) };
}

/**
 * The tree the ref browses and, for a line, its history. A line's tree is read at its newest
 * commit (the log names it), so every tree is read by sha once one is known.
 */
async function locate(
  reads: EngineReads,
  ref: RefChoice,
  line: 'stalk' | 'sprout' | null,
): Promise<{ readonly tree: RepoTree; readonly log: readonly LogCommit[] } | null> {
  if (line === null) {
    const refName = await reads.resolve(ref);
    return refName === null ? null : { tree: await reads.tree(refName), log: [] };
  }
  const log = await reads.log(line);
  const newest = Sha.safeParse(log[0]?.sha);
  return { tree: await reads.tree(newest.success ? newest.data : line), log };
}

async function bodyOf(
  reads: EngineReads,
  ref: RefName,
  files: readonly { readonly path: string; readonly size: number }[],
  input: CodeInput,
): Promise<CodeBody> {
  if (input.view === 'blob') {
    const file = await reads.file(ref, input.path);
    return file === null ? missing(`There is no file ${input.path} here.`) : { kind: 'file', file };
  }
  const entries = listing(files, input.path);
  if (entries === null) return missing(`There is no folder ${input.path} here.`);
  const readme = readmeOf(entries);
  const text = readme === null ? null : ((await reads.file(ref, readme.path))?.content ?? null);
  return {
    kind: 'folder',
    entries,
    readme: readme === null || text === null ? null : { path: readme.path, text },
  };
}

function lineHead(input: {
  readonly line: 'stalk' | 'sprout' | null;
  readonly newest: LogCommit | undefined;
  readonly pushed: readonly PushedBean[];
  readonly events: readonly RaceEvent[];
}): CodeHead {
  if (input.line === null || input.newest === undefined) return null;
  const [row] = historyOf({
    stalk: [input.newest],
    sprout: [],
    pushed: input.pushed,
    landings: landingsOf(input.events),
  }).stalk;
  return row === undefined ? null : { kind: 'commit', row, line: input.line };
}

function beanHead(changes: readonly Change[], name: string): CodeHead {
  const change = changes.find((candidate) => candidate.bean === name);
  return change === undefined ? null : { kind: 'bean', change };
}

function missing(what: string): CodeBody {
  return { kind: 'missing', what };
}

function refText(ref: RefChoice): string {
  return ref.kind === 'bean' ? `named ${ref.name}` : 'at that ref';
}
