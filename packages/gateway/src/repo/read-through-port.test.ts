import { describe, expect, it } from 'vitest';

import type { ArtifactsPort } from '../adapters/artifacts';
import type { RepoReader } from './object-cache';
import { readThroughPort } from './read-through-port';

const COMMIT = 'd'.repeat(40);

/** A port whose reads say they came from the port, and a reader whose reads say so too. */
function ports() {
  const routed: string[] = [];
  const port: Pick<ArtifactsPort, 'readFile' | 'commitMessage'> = {
    readFile: (_repo, ref) => {
      routed.push(`port ${ref}`);
      return Promise.resolve('from the port');
    },
    commitMessage: (_repo, sha) => {
      routed.push(`port ${sha}`);
      return Promise.resolve('from the port');
    },
  };
  const reader: Pick<RepoReader, 'readFile' | 'readCommit'> = {
    readFile: () => Promise.resolve(new Blob(['from the index'])),
    readCommit: (hash) =>
      Promise.resolve({
        hash,
        treeHash: hash,
        message: 'from the index',
        author: { name: 'a', email: 'a@b' },
        committer: { name: 'a', email: 'a@b' },
        parents: [],
        authoredAt: 0,
        committedAt: 0,
      }),
  };
  return { routed, port, reader };
}

describe('readThroughPort', () => {
  it('reads by commit id through the index and by branch from Artifacts', async () => {
    const { routed, port, reader } = ports();
    const indexed = readThroughPort({ ...unusedPort(), ...port }, (repo, use) => {
      routed.push(`index ${repo}`);
      return use({ ...unusedReader(), ...reader });
    });

    expect(await indexed.readFile('r', COMMIT, 'a.txt')).toBe('from the index');
    expect(await indexed.readFile('r', 'stalk', 'a.txt')).toBe('from the port');
    expect(await indexed.commitMessage('r', COMMIT)).toBe('from the index');
    expect(routed).toEqual(['index r', 'port stalk', 'index r']);
  });
});

function unused(): Promise<never> {
  return Promise.reject(new Error('not used here'));
}

function unusedPort(): ArtifactsPort {
  return {
    createRepo: unused,
    mintToken: unused,
    branchHead: unused,
    readFile: unused,
    changedFiles: unused,
    changedPaths: unused,
    listRepos: unused,
    deleteRepo: unused,
    describeRepo: unused,
    commitMessage: unused,
    history: unused,
  };
}

function unusedReader(): RepoReader {
  return { readTree: unused, readBlob: unused, readCommit: unused, readFile: unused, log: unused };
}
