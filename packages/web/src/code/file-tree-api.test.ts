import { describe, expect, it } from 'vitest';

import { RunId, Sha } from '@gitstalk/shared-race/ids';

import type { TreeAccess, TreeReads } from './file-tree-api';
import { answerFolder, answerPaths } from './file-tree-api';
import { isFolderAnswer, isPathsAnswer } from './file-tree-answers';

const SHA = Sha.parse('a'.repeat(40));
const FILES = [
  { path: 'README.md', size: 10 },
  { path: 'src/greet.ts', size: 20 },
  { path: 'src/util/slug.ts', size: 30 },
];

function reads(onTree: () => Promise<{ readonly files: typeof FILES }> = ok): TreeReads & {
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    engine: RunId.parse('rgreeter000001'),
    tree: async (ref) => {
      asked.push(ref);
      const { files } = await onTree();
      return { ref, sha: SHA, files };
    },
  };
}

function ok() {
  return Promise.resolve({ files: FILES });
}

function found(visibility: 'public' | 'private', treeReads: TreeReads = reads()): TreeAccess {
  return { kind: 'found', visibility, reads: treeReads };
}

const url = (route: string, query: string) =>
  new Request(`https://gitstalk.test/api/repos/coop/greeter/code/${route}?${query}`);

describe('the file tree’s folder route', () => {
  it('answers one folder’s entries at a commit, kept by a public repository’s browser', async () => {
    const treeReads = reads();
    const response = await answerFolder(
      url('folder', `sha=${SHA}&path=src`),
      found('public', treeReads),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    const body: unknown = await response.json();
    expect(isFolderAnswer(body)).toBe(true);
    expect(body).toEqual({
      entries: [
        { name: 'util', path: 'src/util', kind: 'dir', size: null },
        { name: 'greet.ts', path: 'src/greet.ts', kind: 'file', size: 20 },
      ],
    });
    expect(treeReads.asked).toEqual([SHA]);
  });

  it('never lets a private repository’s answer be kept', async () => {
    const response = await answerFolder(url('folder', `sha=${SHA}&path=`), found('private'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a ref that is not a commit sha, before any read', async () => {
    const treeReads = reads();
    const response = await answerFolder(
      url('folder', 'sha=stalk&path='),
      found('public', treeReads),
    );
    expect(response.status).toBe(400);
    expect(treeReads.asked).toEqual([]);
  });

  it('answers 404 for a repository the viewer may not read, and for a missing folder', async () => {
    expect((await answerFolder(url('folder', `sha=${SHA}`), { kind: 'not-found' })).status).toBe(
      404,
    );
    const missing = await answerFolder(url('folder', `sha=${SHA}&path=nope`), found('public'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 502 when the gateway fails, and 503 when the engine is unusable', async () => {
    const failing = reads(() => Promise.reject(new Error('down')));
    expect((await answerFolder(url('folder', `sha=${SHA}`), found('public', failing))).status).toBe(
      502,
    );
    const unusable: TreeAccess = { kind: 'found', visibility: 'public', reads: null };
    expect((await answerFolder(url('folder', `sha=${SHA}`), unusable)).status).toBe(503);
  });
});

describe('the file tree’s paths route', () => {
  it('answers every file’s path at a commit', async () => {
    const response = await answerPaths(url('paths', `sha=${SHA}`), found('public'));
    const body: unknown = await response.json();
    expect(isPathsAnswer(body)).toBe(true);
    expect(body).toEqual({ paths: ['README.md', 'src/greet.ts', 'src/util/slug.ts'] });
  });
});
