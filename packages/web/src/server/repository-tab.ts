/**
 * The start of every repository tab (Code, Changes, History): who is looking, the repository
 * (a 404 when they may not read it), and its engine's reads for this request: one set per
 * request, so every component that asks shares the reads already made. Server-only.
 */
import { env } from 'cloudflare:workers';
import { redirect } from 'next/navigation';

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

/** A tab whose engine answers: Changes and History, which have nothing to show without one. */
export type EngineTab = RepositoryTab & { readonly reads: EngineReads };

const tabs = keyedForRequest<RepositoryTab>();

export async function repositoryTab(params: RepositoryParams): Promise<RepositoryTab> {
  const { owner, repo } = await params;
  return tabs(`${owner}/${repo}`, () => openTab(params));
}

/**
 * The repository's tab with its engine's reads, or a redirect to its home when the record's
 * engine id is unusable. `app/[owner]/[repo]/changes/layout.tsx` and `history/layout.tsx` ask
 * above their `loading.tsx`, so the redirect is the response's status; the page asks again
 * (memoised, no second read).
 */
export async function engineTab(params: RepositoryParams): Promise<EngineTab> {
  const tab = await repositoryTab(params);
  const { reads } = tab;
  if (reads === null) redirect(tab.base);
  return { ...tab, reads };
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
