/**
 * An offline replay of the staging load test's reads of the read index
 * (`research/race/runs/stg-scion-*-fastify-16-s*`): the 38 fastify beans land one after
 * another on a tree of 407 files (their recorded paths, plus filler in the same
 * directories), each judged by the approval gate's diff read before it lands, and each landing
 * warmed after. It measures the Artifacts reads and the read index's counts with the gate
 * reading straight from Artifacts (as the staging runs did) and through the index.
 */
import { describe, expect, it } from 'vitest';

import { Sha } from '@gitstalk/shared-race/ids';

import landings from '../../test/fixtures/fastify-landings.json';
import { changedFilesIn } from '../adapters/artifacts';
import { warmLine } from '../adapters/repo-explorer';
import type { ReadPurpose } from './cache-stats';
import { cacheReport, countCacheRead, emptyCacheStats } from './cache-stats';
import type { RepoReader } from './object-cache';
import { cachedReader, memoryObjectStore } from './object-cache';

type Files = Readonly<Record<string, string>>;
type Landing = { readonly task: string; readonly files: readonly string[] };

const PERSON = { name: 'replay', email: 'replay@gitstalk.invalid' };
const LINE = 'stalk';

/** Filler files per directory: with the recorded paths, 407 files, about the fastify base. */
const FILLER: Readonly<Record<string, number>> = {
  lib: 30,
  test: 150,
  'test/types': 15,
  'test/internals': 12,
  'test/logger': 8,
  'test/http-methods': 8,
  'docs/Reference': 25,
  'docs/Guides': 20,
  types: 20,
  build: 4,
  examples: 12,
  '': 12,
};

describe('the read index over the fastify load test (offline replay)', () => {
  it('serves the gate’s diff reads from the warmed index and spares the warm-up their fetches', async () => {
    const direct = await replay('direct');
    const indexed = await replay('indexed');

    // The staging runs' shape: the warm-up alone fills the index, nobody else reads through
    // it, so there is no demand hit rate at all; the warm-up fetches each new object once.
    expect(direct.cache.objects.hit_rate).toBeNull();
    expect(direct.cache.prefetch?.tree).toMatchObject({ hits: 442, misses: 143 });
    expect(direct.cache.prefetch?.blob.misses).toBe(560);
    expect(direct.cache.prefetch?.ref_memo).toMatchObject({ hits: 0, misses: 39 });
    expect(direct.gateReads).toEqual({ commit: 76, tree: 256, blob: 306, log: 0 });
    // Through the index: the gate's before-sides were warmed (hits), its after-sides are
    // fetched once and the warm-up after the landing finds them held.
    expect(indexed.cache.objects).toEqual({ hits: 319, misses: 319, hit_rate: 0.5 });
    expect(indexed.cache.blob).toEqual({ hits: 153, misses: 153, hit_rate: 0.5 });
    expect(indexed.gateReads).toEqual({ commit: 38, tree: 128, blob: 153, log: 0 });
    expect(indexed.cache.prefetch?.objects.misses).toBe(422);
    expect(indexed.blobsFetched).toBe(direct.blobsFetched);
    expect({ direct: direct.artifactsReads, indexed: indexed.artifactsReads }).toEqual({
      direct: 1380,
      indexed: 780,
    });
  });
});

/** One pass over the 38 landings; `gate` says how the gate's diff reads reach Artifacts. */
async function replay(gate: 'direct' | 'indexed') {
  const git = memoryGit();
  let head = git.commit(null, baseFiles(landings));
  let stats = emptyCacheStats();
  const store = memoryObjectStore();
  const refs = new Map();
  const reader = (purpose: ReadPurpose): RepoReader =>
    cachedReader(git.reader, {
      store,
      refs,
      now: () => 0,
      count: (read) => (stats = countCacheRead(stats, read)),
      purpose,
    });
  await warmLine(reader('prefetch'), LINE);
  const gateReads = { commit: 0, tree: 0, blob: 0, log: 0 };
  for (const landing of landings) {
    const onto = head;
    const merged = git.commit(onto, edited(git.files(onto), landing));
    const before = { ...git.calls };
    // oxlint-disable-next-line no-await-in-loop -- each landing follows the last
    await changedFilesIn(gate === 'indexed' ? reader('demand') : git.reader, {
      from: Sha.parse(onto),
      to: Sha.parse(merged),
    });
    for (const kind of ['commit', 'tree', 'blob', 'log'] as const)
      gateReads[kind] += git.calls[kind] - before[kind];
    head = merged;
    git.moveLine(head);
    refs.clear();
    // oxlint-disable-next-line no-await-in-loop -- the warm-up follows its landing
    await warmLine(reader('prefetch'), LINE);
  }
  const { calls } = git;
  return {
    cache: cacheReport(stats),
    gateReads,
    artifactsReads: calls.commit + calls.tree + calls.blob + calls.log,
    blobsFetched: stats.prefetch.blob.misses + stats.blob.misses,
  };
}

/** The recorded paths of every landing, plus filler, each with its own text. */
function baseFiles(all: readonly Landing[]): Files {
  const files: Record<string, string> = {};
  for (const [directory, count] of Object.entries(FILLER)) {
    for (let index = 0; index < count; index += 1) {
      const path = `${directory === '' ? '' : `${directory}/`}file-${index}.js`;
      files[path] = `// ${path}\n`;
    }
  }
  for (const path of all.flatMap((landing) => landing.files)) files[path] = `// ${path}\n`;
  return files;
}

function edited(files: Files, landing: Landing): Files {
  const next: Record<string, string> = { ...files };
  for (const path of landing.files) next[path] = `${files[path] ?? ''}// ${landing.task}\n`;
  return next;
}

/** Git objects in memory, with a counting reader over them. */
function memoryGit() {
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const blobs = new Map<string, string>();
  const commits = new Map<string, ArtifactsCommitMetadata>();
  const snapshots = new Map<string, Files>();
  const line = { head: '' };
  const calls = { commit: 0, tree: 0, blob: 0, log: 0 };
  const writeTree = (entries: readonly (readonly [string, string])[]): string => {
    const directories = new Map<string, [string, string][]>();
    const tree: ArtifactsTreeEntry[] = [];
    for (const [path, text] of entries) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        const hash = objectId(`blob ${text}`);
        blobs.set(hash, text);
        tree.push({ name: path, mode: '100644', hash, type: 'blob' });
        continue;
      }
      const name = path.slice(0, slash);
      const inner = directories.get(name) ?? [];
      inner.push([path.slice(slash + 1), text]);
      directories.set(name, inner);
    }
    for (const [name, inner] of directories)
      tree.push({ name, mode: '40000', hash: writeTree(inner), type: 'tree' });
    tree.sort((a, b) => (a.name < b.name ? -1 : 1));
    const hash = objectId(`tree ${JSON.stringify(tree)}`);
    trees.set(hash, tree);
    return hash;
  };
  const commit = (parent: string | null, files: Files): string => {
    const treeHash = writeTree(Object.entries(files));
    const hash = objectId(`commit ${parent ?? ''} ${treeHash}`);
    commits.set(hash, {
      hash,
      treeHash,
      message: 'landing',
      author: PERSON,
      committer: PERSON,
      parents: parent === null ? [] : [parent],
      authoredAt: 0,
      committedAt: 0,
    });
    snapshots.set(hash, files);
    if (line.head === '') line.head = hash;
    return hash;
  };
  const reader: RepoReader = {
    readTree: (hash) => {
      calls.tree += 1;
      return Promise.resolve(trees.get(hash) ?? null);
    },
    readBlob: (hash) => {
      calls.blob += 1;
      const text = blobs.get(hash);
      return Promise.resolve(text === undefined ? null : new Blob([text]));
    },
    readCommit: (hash) => {
      calls.commit += 1;
      return Promise.resolve(commits.get(hash) ?? null);
    },
    readFile: () => Promise.reject(new Error('the replay reads files through trees')),
    log: () => {
      calls.log += 1;
      const head = commits.get(line.head);
      return Promise.resolve(head === undefined ? [] : [head]);
    },
  };
  return {
    reader,
    calls,
    commit,
    files: (hash: string): Files => snapshots.get(hash) ?? {},
    moveLine: (hash: string) => (line.head = hash),
  };
}

/** A 40-hex id from five FNV-1a passes with different seeds (collisions are not a concern here). */
function objectId(text: string): string {
  let id = '';
  for (let seed = 0; seed < 5; seed += 1) {
    let hash = (0x811c9dc5 ^ seed) >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    id += hash.toString(16).padStart(8, '0');
  }
  return id;
}
