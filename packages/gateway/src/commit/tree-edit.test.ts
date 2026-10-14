import { describe, expect, it } from 'vitest';

import { commitObject, gitObject } from '../git/pack-writer';
import type { CommitPlan, PathChange, TreeEntry, TreeReader } from './tree-edit';
import { buildTreeCommit, treeBody } from './tree-edit';

/**
 * The tree ids below are real git's (`git write-tree` in a fixture repository after the same
 * changes): matching them shows the Worker writes byte-identical trees (modes, entry order with
 * `foo.txt` before the directory `foo`, empty directories dropped).
 */
const BASE_TREE = '696ea965378ddbe8402069ae5991be599427f813';
const AFTER_EDITS_TREE = '9e3bef33a3898219cf571285ac49413e9dd87079';
const AFTER_DELETE_TREE = '530d1ee200c02fd2321cd0f0cdedb58dace06963';
const AUTHOR = { name: 'harness-a', email: 'harness-a@contributors.x', atMs: 1_700_000_000_000 };

type Repo = {
  readonly reader: TreeReader;
  readonly treesRead: string[];
  /** Stores a commit of `files` and returns its id. */
  commitOf(
    files: Readonly<Record<string, string>>,
    executables?: ReadonlySet<string>,
  ): Promise<string>;
  /** Stores the new objects of a built commit. */
  take(objects: readonly { type: string; id: string; body: Uint8Array }[]): void;
  files(commit: string): Promise<Record<string, string>>;
};

describe('a commit built from the changed paths only', () => {
  it('writes the trees git writes, for edits, an add in new directories and a delete', async () => {
    const repo = await memoryRepo();
    const base = await repo.commitOf({ 'foo.txt': 'a\n', 'foo/bar': 'b\n' });
    const built = await build(repo, base, [
      { path: 'foo/bar', content: 'c\n' },
      { path: 'docs/deep/new.md', content: 'x\n' },
      { path: 'foo.txt', content: null },
    ]);
    expect(built.tree).toBe(AFTER_EDITS_TREE);
    expect(built.objects.map((object) => object.type)).toEqual([
      'blob',
      'blob',
      'tree',
      'tree',
      'tree',
      'tree',
      'commit',
    ]);
    repo.take(built.objects);
    expect(await repo.files(built.commit)).toEqual({ 'foo/bar': 'c\n', 'docs/deep/new.md': 'x\n' });
  });

  it('drops a directory its last file leaves', async () => {
    const repo = await memoryRepo();
    const base = await repo.commitOf({ 'foo/bar': 'c\n', 'docs/deep/new.md': 'x\n' });
    const built = await build(repo, base, [{ path: 'foo/bar', content: null }]);
    expect(built.tree).toBe(AFTER_DELETE_TREE);
    expect(built.objects.map((object) => object.type)).toEqual(['tree', 'commit']);
  });

  it('reads only the trees on the changed path, not its siblings', async () => {
    const repo = await memoryRepo();
    const base = await repo.commitOf({
      'a/b/c/d.txt': '1\n',
      'a/b/other.txt': '2\n',
      'big/one.txt': '3\n',
      'big/two/three.txt': '4\n',
    });
    repo.treesRead.length = 0;
    const built = await build(repo, base, [{ path: 'a/b/c/d.txt', content: 'changed\n' }]);
    expect(built.treesRead).toBe(4);
    expect(repo.treesRead).toHaveLength(4);
    expect(built.objects).toHaveLength(6);
    repo.take(built.objects);
    expect(await repo.files(built.commit)).toMatchObject({
      'a/b/c/d.txt': 'changed\n',
      'big/two/three.txt': '4\n',
    });
  });

  it('keeps the executable bit of a file whose text changes', async () => {
    const repo = await memoryRepo();
    const base = await repo.commitOf({ 'run.sh': 'echo 1\n' }, new Set(['run.sh']));
    const built = await build(repo, base, [{ path: 'run.sh', content: 'echo 2\n' }]);
    const root = built.objects.find((object) => object.type === 'tree');
    expect(new TextDecoder().decode(root?.body).startsWith('100755 run.sh\0')).toBe(true);
  });

  it('refuses changes that do not fit the base', async () => {
    const repo = await memoryRepo();
    const base = await repo.commitOf({ 'foo.txt': 'a\n', 'foo/bar': 'b\n' });
    const plan = (changes: PathChange[]): CommitPlan => ({
      base,
      changes,
      author: AUTHOR,
      message: 'm',
    });
    const problem = async (changes: PathChange[]) => {
      const result = await buildTreeCommit(repo.reader, plan(changes));
      return result.ok ? null : result.problem;
    };
    expect(await problem([{ path: 'foo.txt/x', content: '1' }])).toEqual({
      kind: 'not_a_directory',
      path: 'foo.txt',
    });
    expect(await problem([{ path: 'foo', content: '1' }])).toEqual({
      kind: 'is_a_directory',
      path: 'foo',
    });
    expect(await problem([{ path: 'gone.txt', content: null }])).toEqual({
      kind: 'missing_file',
      path: 'gone.txt',
    });
    expect(await problem([{ path: 'foo.txt', content: 'a\n' }])).toEqual({ kind: 'no_change' });
    const missing = await buildTreeCommit(repo.reader, { ...plan([]), base: 'f'.repeat(40) });
    expect(missing.ok ? null : missing.problem.kind).toBe('base_missing');
  });
});

describe('tree serialisation', () => {
  it('orders a directory as if its name ended in a slash', async () => {
    const blob = await gitObject('blob', 'x\n');
    const entries: TreeEntry[] = [
      { name: 'foo', hash: blob.id, type: 'tree' },
      { name: 'foo.txt', hash: blob.id, type: 'blob' },
      { name: 'foo-bar', hash: blob.id, type: 'blob' },
    ];
    const names = [...new TextDecoder('latin1').decode(treeBody(entries)).matchAll(/ ([^\0]+)\0/g)];
    expect(names.map((match) => match[1])).toEqual(['foo-bar', 'foo.txt', 'foo']);
  });

  it('matches the real fixture tree', async () => {
    const repo = await memoryRepo();
    const base = await repo.commitOf({ 'foo.txt': 'a\n', 'foo/bar': 'b\n' });
    const commit = await repo.reader.readCommit(base);
    expect(commit?.treeHash).toBe(BASE_TREE);
  });
});

async function build(repo: Repo, base: string, changes: PathChange[]) {
  const result = await buildTreeCommit(repo.reader, {
    base,
    changes,
    author: AUTHOR,
    message: 'Change files',
  });
  if (!result.ok) throw new Error(result.problem.kind);
  return result.value;
}

/** An object store in memory, read the way an Artifacts repo handle is. */
async function memoryRepo(): Promise<Repo> {
  const trees = new Map<string, readonly TreeEntry[]>();
  const blobs = new Map<string, string>();
  const commits = new Map<string, string>();
  const treesRead: string[] = [];
  const reader: TreeReader = {
    readCommit: async (id) => {
      const tree = commits.get(id);
      return tree === undefined ? null : { treeHash: tree };
    },
    readTree: async (id) => {
      treesRead.push(id);
      return trees.get(id) ?? null;
    },
  };
  const storeTree = async (
    files: ReadonlyMap<string, string>,
    executables: ReadonlySet<string>,
    prefix: string,
  ): Promise<string> => {
    const entries: TreeEntry[] = [];
    const children = new Map<string, Map<string, string>>();
    for (const [path, text] of files) {
      const [head = '', ...rest] = path.split('/');
      if (rest.length === 0) {
        // oxlint-disable-next-line no-await-in-loop -- a fixture of a few files
        const blob = await gitObject('blob', text);
        blobs.set(blob.id, text);
        const type = executables.has(`${prefix}${head}`) ? 'exec' : 'blob';
        entries.push({ name: head, hash: blob.id, type });
      } else {
        const child = children.get(head) ?? new Map<string, string>();
        child.set(rest.join('/'), text);
        children.set(head, child);
      }
    }
    for (const [name, child] of children) {
      // oxlint-disable-next-line no-await-in-loop -- a parent needs its children's ids
      const id = await storeTree(child, executables, `${prefix}${name}/`);
      entries.push({ name, hash: id, type: 'tree' });
    }
    const tree = await gitObject('tree', treeBody(entries));
    trees.set(tree.id, entries);
    return tree.id;
  };
  const files = async (commit: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const walk = async (tree: string, prefix: string): Promise<void> => {
      for (const entry of trees.get(tree) ?? []) {
        // oxlint-disable-next-line no-await-in-loop -- a fixture of a few files
        if (entry.type === 'tree') await walk(entry.hash, `${prefix}${entry.name}/`);
        else out[`${prefix}${entry.name}`] = blobs.get(entry.hash) ?? '';
      }
    };
    await walk(commits.get(commit) ?? '', '');
    return out;
  };
  return {
    reader,
    treesRead,
    files,
    commitOf: async (fileMap, executables = new Set()) => {
      const tree = await storeTree(new Map(Object.entries(fileMap)), executables, '');
      const commit = await commitObject({ tree, parents: [], author: AUTHOR, message: 'base' });
      commits.set(commit.id, tree);
      return commit.id;
    },
    take: (objects) => {
      for (const object of objects) {
        const text = new TextDecoder().decode(object.body);
        if (object.type === 'blob') blobs.set(object.id, text);
        if (object.type === 'tree') trees.set(object.id, parseTree(object.body));
        if (object.type === 'commit') commits.set(object.id, text.slice(5, 45));
      }
    },
  };
}

const TYPES_BY_MODE: Readonly<Record<string, TreeEntry['type']>> = {
  '40000': 'tree',
  '100755': 'exec',
};

function parseTree(body: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const nul = body.indexOf(0, offset);
    const [mode = '', name = ''] = new TextDecoder().decode(body.subarray(offset, nul)).split(' ');
    const hash = Array.from(body.subarray(nul + 1, nul + 21), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    entries.push({ name, hash, type: TYPES_BY_MODE[mode] ?? 'blob' });
    offset = nul + 21;
  }
  return entries;
}
