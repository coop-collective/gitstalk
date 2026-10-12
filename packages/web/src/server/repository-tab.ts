/**
 * The start of every repository tab (Code, Changes, History): who is looking, the repository
 * (a 404 when they may not read it), and its engine's reads for this request: one set per
 * request, so every component that asks shares the reads already made. Server-only.
 */
import { env } from 'cloudflare:workers';

import { sharedReadsFor } from '../repo-pages/cached-reads';
import type { EngineReads } from '../repo-pages/engine-reads';
import { engineOf, engineReads } from '../repo-pages/engine-reads';
import type { RepositoryPage, RepositoryParams } from './repository-page';
import { repositoryPage } from './repository-page';
import { keyedForRequest } from './request-memo';

export type RepositoryTab = RepositoryPage & {
  /** Null when the record's engine id is unusable (the pages then show the stalk's files only). */
  readonly reads: EngineReads | null;
};

const tabs = keyedForRequest<RepositoryTab>();

export async function repositoryTab(params: RepositoryParams): Promise<RepositoryTab> {
  const { owner, repo } = await params;
  return tabs(`${owner}/${repo}`, () => openTab(params));
}

async function openTab(params: RepositoryParams): Promise<RepositoryTab> {
  // The access check comes first: `repositoryPage` answers 404 unless the viewer may read the
  // repository, and only its record (public or not) decides whether reads are shared.
  const page = await repositoryPage(params);
  const engine = engineOf(page.record.engine_id);
  if (engine === null) return { ...page, reads: null };
  const shared = sharedReadsFor(page.record, engine);
  return { ...page, reads: engineReads(env.GATEWAY, engine, shared) };
}
