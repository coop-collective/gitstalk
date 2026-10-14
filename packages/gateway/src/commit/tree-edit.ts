/**
 * Builds a commit from a base commit and a set of path changes, reading only the trees on the
 * changed paths (doc 33): the root, then each directory down to every changed file, each read
 * once however many changes share it. Every other entry keeps its id, so the new objects are
 * the changed blobs, one tree per touched directory and the commit: the cost scales with the
 * change, not with the repository. Directories a deletion leaves empty are dropped, as git
 * does; a file keeps its executable bit when its text changes.
 *
 * Every server-side commit (`server-commit.ts`: `bean_commit` and the web editors) reads trees
 * by id through `buildTreeCommit`.
 */
import type { GitObject, Signature } from '../git/pack-writer';
import { EMPTY_TREE_ID, commitObject, gitObject } from '../git/pack-writer';

/** The two reads a commit needs, as an Artifacts repo handle (or its cache) answers them. */
export type TreeReader = {
  readCommit(id: string): Promise<{ readonly treeHash: string } | null>;
  readTree(id: string): Promise<readonly TreeEntry[] | null>;
};

export type TreeEntry = {
  readonly name: string;
  readonly hash: string;
  readonly type: 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink';
};

/** One path's new text, or null to delete it. */
export type PathChange = { readonly path: string; readonly content: string | null };

export type CommitPlan = {
  readonly base: string;
  readonly changes: readonly PathChange[];
  readonly author: Signature;
  readonly message: string;
};

export type BuiltCommit = {
  readonly commit: string;
  readonly tree: string;
  /** The objects the repository does not hold yet: the pack's contents, blobs first. */
  readonly objects: readonly GitObject[];
  readonly treesRead: number;
};

/** An expected refusal: the change does not fit the base it was made against. */
export type TreeEditProblem =
  | { readonly kind: 'base_missing'; readonly base: string }
  | { readonly kind: 'not_a_directory'; readonly path: string }
  | { readonly kind: 'is_a_directory'; readonly path: string }
  | { readonly kind: 'missing_file'; readonly path: string }
  | { readonly kind: 'no_change' };

export type TreeEditResult =
  | { readonly ok: true; readonly value: BuiltCommit }
  | { readonly ok: false; readonly problem: TreeEditProblem };

/** A base's directories read by path, each once (concurrent reads share it). */
type DirectoryListings = {
  read(path: string): Promise<Listing>;
  /** Trees read so far. */
  count(): number;
};

type Listing =
  | { readonly kind: 'tree'; readonly path: string; readonly entries: readonly TreeEntry[] }
  | { readonly kind: 'absent'; readonly path: string }
  | { readonly kind: 'not_a_directory'; readonly path: string };

/** Git's modes by entry type, as written in tree objects. */
const MODES: Readonly<Record<TreeEntry['type'], string>> = {
  tree: '40000',
  blob: '100644',
  exec: '100755',
  symlink: '120000',
  gitlink: '160000',
};
const encoder = new TextEncoder();

/** The commit that applies `plan.changes` on top of `plan.base`, reading trees by id. */
export async function buildTreeCommit(
  reader: TreeReader,
  plan: CommitPlan,
): Promise<TreeEditResult> {
  const base = await reader.readCommit(plan.base);
  if (base === null) return refuse({ kind: 'base_missing', base: plan.base });
  return buildCommitFromListings(treeListings(reader, base.treeHash), plan);
}

/** The commit that applies `plan.changes`, with `listings` answering each touched directory. */
async function buildCommitFromListings(
  listings: DirectoryListings,
  plan: CommitPlan,
): Promise<TreeEditResult> {
  const directories = touchedDirectories(plan.changes);
  const read = await Promise.all(directories.map((path) => listings.read(path)));
  const notDirectory = read.find((listing) => listing.kind === 'not_a_directory');
  if (notDirectory !== undefined)
    return refuse({ kind: 'not_a_directory', path: notDirectory.path });
  const existing = new Map(directories.map((path, index) => [path, entriesOf(read[index])]));
  const edits = await fileEdits(existing, plan.changes);
  if (!edits.ok) return edits;
  const tree = await writeTrees(existing, edits.value);
  if (!tree.changed) return refuse({ kind: 'no_change' });
  const commit = await commitObject({
    tree: tree.root,
    parents: [plan.base],
    author: plan.author,
    message: plan.message,
  });
  return {
    ok: true,
    value: {
      commit: commit.id,
      tree: tree.root,
      objects: [...edits.blobs, ...tree.objects, commit],
      treesRead: listings.count(),
    },
  };
}

/** Git sorts tree entries by name bytes, comparing a directory as if its name ended in `/`. */
export function treeBody(entries: readonly TreeEntry[]): Uint8Array {
  const key = (entry: TreeEntry): Uint8Array =>
    encoder.encode(entry.type === 'tree' ? `${entry.name}/` : entry.name);
  const sorted = entries.toSorted((a, b) => compareBytes(key(a), key(b)));
  const parts = sorted.flatMap((entry) => [
    encoder.encode(`${MODES[entry.type]} ${entry.name}\0`),
    unhex(entry.hash),
  ]);
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Listings of one root tree by id: a directory's tree is found in its parent's entries. */
function treeListings(reader: TreeReader, rootTree: string): DirectoryListings {
  const memo = new Map<string, Promise<Listing>>();
  let reads = 0;
  const readTree = async (path: string, id: string): Promise<Listing> => {
    // An empty start's tree: every repository names it, but it may hold no object for it.
    if (id === EMPTY_TREE_ID) return { kind: 'tree', path, entries: [] };
    reads += 1;
    const entries = await reader.readTree(id);
    if (entries === null) throw new Error(`tree ${id} (${path || 'root'}) is missing`);
    return { kind: 'tree', path, entries };
  };
  const read = (path: string): Promise<Listing> => {
    const known = memo.get(path);
    if (known !== undefined) return known;
    const listing = path === '' ? readTree('', rootTree) : readChild(path);
    memo.set(path, listing);
    return listing;
  };
  const readChild = async (path: string): Promise<Listing> => {
    const { directory, name } = splitPath(path);
    const parent = await read(directory);
    if (parent.kind === 'absent') return { kind: 'absent', path };
    if (parent.kind === 'not_a_directory') return parent;
    const entry = parent.entries.find((candidate) => candidate.name === name);
    if (entry === undefined) return { kind: 'absent', path };
    if (entry.type !== 'tree') return { kind: 'not_a_directory', path };
    return readTree(path, entry.hash);
  };
  return { read, count: () => reads };
}

/** Every directory containing a changed path, the root first and deepest last. */
function touchedDirectories(changes: readonly PathChange[]): string[] {
  const directories = new Set<string>(['']);
  for (const change of changes) {
    const parts = change.path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1)
      directories.add(parts.slice(0, depth).join('/'));
  }
  return [...directories].toSorted((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : 1));
}

function entriesOf(listing: Listing | undefined): readonly TreeEntry[] {
  return listing?.kind === 'tree' ? listing.entries : [];
}

type Edits = ReadonlyMap<string, ReadonlyMap<string, TreeEntry | null>>;

/** Each directory's changed entries (null: removed), and the new blobs. */
async function fileEdits(
  existing: ReadonlyMap<string, readonly TreeEntry[]>,
  changes: readonly PathChange[],
): Promise<
  | { readonly ok: true; readonly value: Edits; readonly blobs: readonly GitObject[] }
  | { readonly ok: false; readonly problem: TreeEditProblem }
> {
  const edits = new Map<string, Map<string, TreeEntry | null>>();
  const blobs = new Map<string, GitObject>();
  for (const change of changes) {
    const { directory, name } = splitPath(change.path);
    const current = existing.get(directory)?.find((entry) => entry.name === name);
    if (current?.type === 'tree') return refuse({ kind: 'is_a_directory', path: change.path });
    if (change.content === null && current === undefined)
      return refuse({ kind: 'missing_file', path: change.path });
    const entry =
      change.content === null
        ? null
        : // oxlint-disable-next-line no-await-in-loop -- hashing is CPU work; order keeps the pack stable
          await blobEntry(name, change.content, current?.type === 'exec' ? 'exec' : 'blob');
    if (entry !== null) blobs.set(entry.blob.id, entry.blob);
    const directoryEdits = edits.get(directory) ?? new Map<string, TreeEntry | null>();
    directoryEdits.set(name, entry?.entry ?? null);
    edits.set(directory, directoryEdits);
  }
  return { ok: true, value: edits, blobs: [...blobs.values()] };
}

async function blobEntry(
  name: string,
  content: string,
  type: 'blob' | 'exec',
): Promise<{ readonly blob: GitObject; readonly entry: TreeEntry }> {
  const blob = await gitObject('blob', content);
  return { blob, entry: { name, hash: blob.id, type } };
}

/**
 * Writes each touched directory's new tree, deepest first, so a parent sees its children's new
 * ids. A directory left empty is removed from its parent; the root is always written. A tree
 * the repository already holds (nothing under it changed) is not sent again.
 */
async function writeTrees(
  existing: ReadonlyMap<string, readonly TreeEntry[]>,
  fileChanges: Edits,
): Promise<{
  readonly root: string;
  readonly changed: boolean;
  readonly objects: readonly GitObject[];
}> {
  const edits = new Map([...fileChanges].map(([path, changes]) => [path, new Map(changes)]));
  const objects: GitObject[] = [];
  const directories = [...existing.keys()].toSorted((a, b) => depthOf(b) - depthOf(a));
  let root = '';
  let changed = false;
  for (const path of directories) {
    const entries = applied(existing.get(path) ?? [], edits.get(path));
    const tree =
      entries.length === 0 && path !== ''
        ? null
        : // oxlint-disable-next-line no-await-in-loop -- a parent's tree needs its children's ids
          await gitObject('tree', treeBody(entries));
    const isNew = tree !== null && !sameEntries(existing.get(path) ?? [], entries);
    if (isNew) objects.push(tree);
    if (path === '') {
      root = tree?.id ?? '';
      changed = isNew;
      continue;
    }
    const { directory, name } = splitPath(path);
    const parentEdits = edits.get(directory) ?? new Map<string, TreeEntry | null>();
    parentEdits.set(name, tree === null ? null : { name, hash: tree.id, type: 'tree' });
    edits.set(directory, parentEdits);
  }
  return { root, changed, objects };
}

function applied(
  entries: readonly TreeEntry[],
  changes: ReadonlyMap<string, TreeEntry | null> | undefined,
): TreeEntry[] {
  if (changes === undefined) return [...entries];
  const kept = entries.filter((entry) => !changes.has(entry.name));
  const added = [...changes.values()].filter((entry): entry is TreeEntry => entry !== null);
  return [...kept, ...added];
}

/** Whether a directory's new entries are the ones it had (same names, ids and types). */
function sameEntries(original: readonly TreeEntry[], entries: readonly TreeEntry[]): boolean {
  if (original.length !== entries.length) return false;
  const byName = new Map(original.map((entry) => [entry.name, entry]));
  return entries.every((entry) => {
    const before = byName.get(entry.name);
    return before?.hash === entry.hash && before.type === entry.type;
  });
}

function splitPath(path: string): { readonly directory: string; readonly name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { directory: '', name: path }
    : { directory: path.slice(0, slash), name: path.slice(slash + 1) };
}

function depthOf(path: string): number {
  return path === '' ? 0 : path.split('/').length;
}

function refuse(problem: TreeEditProblem): {
  readonly ok: false;
  readonly problem: TreeEditProblem;
} {
  return { ok: false, problem };
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function unhex(id: string): Uint8Array {
  return Uint8Array.from(id.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}
