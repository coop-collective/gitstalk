/**
 * A public repository's reads that outlive the request (`SharedReads`): its event log, kept by
 * the append-only `EventCache`, and its trees and files at a commit sha, which never change and
 * so are kept by `"use cache"` for as long as the cache handler holds them (in memory, per
 * isolate). The cache keys hold the engine, the sha and the path, nothing about the viewer:
 * that is why only a public repository's reads, after the viewer's access check, come here.
 * Server-only.
 */
import { env } from 'cloudflare:workers';
import { cacheLife, cacheTag } from 'next/cache';

import type { RunId, Sha } from '@gitstalk/shared-race/ids';

import type { RepoTree } from '@gitstalk/shared-ask/repo/repo-types';
import type { RepositoryRecord } from '../repositories/registry-client';
import type { FileBlob, SharedReads } from './engine-reads';
import { engineReads, readFile } from './engine-reads';
import { createEventCache, PublicEngine } from './event-cache';

/**
 * Engines and events one isolate keeps (about 250 bytes of JSON an event, so tens of MB at
 * most, beside the cache handler's own 50 MB). Module scope on purpose: it is the cache
 * across requests, and it holds only public repositories' logs.
 */
const PUBLIC_EVENT_LOGS = createEventCache({ maxEngines: 32, maxEvents: 40_000 });

/**
 * The shared reads of a repository whose record the viewer's access check returned: null for a
 * private or internal repository, which reads everything fresh on every request.
 */
export function sharedReadsFor(
  record: Pick<RepositoryRecord, 'visibility'>,
  engine: RunId,
): SharedReads | null {
  const shared = PublicEngine.of(record, engine);
  if (shared === null) return null;
  return {
    events: (readTail) => PUBLIC_EVENT_LOGS.events(shared, readTail),
    tree: (sha) => treeAtCommit(shared.engine, sha),
    file: (sha, path) => fileAtCommit(shared.engine, sha, path),
  };
}

/** Tags of a read at a commit: the engine (to drop all of it) and the commit. */
export function commitTags(engine: string, sha: string): readonly string[] {
  return [`engine:${engine}`, `commit:${engine}:${sha}`];
}

/** The whole tree of a commit. Its arguments are its cache key. */
export async function treeAtCommit(engine: RunId, sha: Sha): Promise<RepoTree> {
  'use cache';
  cacheLife('max');
  cacheTag(...commitTags(engine, sha));
  return engineReads(env.GATEWAY, engine).tree(sha);
}

/**
 * A file at a commit (null when the commit has none). A failed read throws, so it is not
 * kept. Its arguments are its cache key.
 */
export async function fileAtCommit(
  engine: RunId,
  sha: Sha,
  path: string,
): Promise<FileBlob | null> {
  'use cache';
  cacheLife('max');
  cacheTag(...commitTags(engine, sha));
  return readFile(env.GATEWAY, { engine, ref: sha, path });
}
