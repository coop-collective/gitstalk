/**
 * What the Ask tab reads before it renders: the engine's events, titles, files and pushers,
 * or null before anything has grown (the page then sends people to the start page). Read
 * once per request, so `app/[owner]/[repo]/ask/layout.tsx` can redirect above the tab's
 * `loading.tsx` (a real redirect, not a skeleton followed by one) and the page reuses the
 * read. Server-only.
 */
import { env } from 'cloudflare:workers';
import { redirect } from 'next/navigation';

import type { ForgeSource } from '@gitstalk/shared-ask/forge/forge-source';
import { RunId } from '@gitstalk/shared-race/ids';

import { forgeForRun } from '../forge/sources';
import { hasGrown } from '../repositories/flows';
import { pushersOf } from '../repositories/pushers';
import type { RepositoryRecord } from '../repositories/registry-client';
import type { HomePageData } from './home-page-data';
import { homePageData } from './home-page-data';
import type { RepositoryPage, RepositoryParams } from './repository-page';
import { repositoryPage } from './repository-page';
import { keyedForRequest } from './request-memo';

/** The grown engine the Ask view explores, the source that read it, and what it has done so far. */
export type AskData = {
  readonly run: RunId;
  readonly source: ForgeSource;
  readonly data: HomePageData;
};

export type AskPage = RepositoryPage & { readonly ask: AskData };

const askReads = keyedForRequest<AskData | null>();

/** The Ask view's data for `record`, or null when the engine has nothing to show yet. */
export function askData(
  record: Pick<RepositoryRecord, 'id' | 'engine_id' | 'owner'>,
): Promise<AskData | null> {
  return askReads(record.id, () => readAskData(record));
}

/**
 * The repository at `params` with its Ask data: a 404 as every repository page, and a
 * redirect to its start page before anything has grown.
 */
export async function askPage(params: RepositoryParams): Promise<AskPage> {
  const page = await repositoryPage(params);
  const ask = await askData(page.record);
  if (ask === null) redirect(page.base);
  return { ...page, ask };
}

async function readAskData(
  record: Pick<RepositoryRecord, 'engine_id' | 'owner'>,
): Promise<AskData | null> {
  const engine = RunId.safeParse(record.engine_id);
  if (!engine.success) return null;
  const run = engine.data;
  const source = forgeForRun(env.GATEWAY, run);
  const data = await Promise.all([
    homePageData(source, run, record.owner.handle),
    pushersOf(env.GATEWAY, run),
  ]).then(
    ([home, pushers]): HomePageData => ({ ...home, pushers }),
    (): HomePageData | null => null,
  );
  return data === null || !hasGrown(data.events) ? null : { run, source, data };
}
