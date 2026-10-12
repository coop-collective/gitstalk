/**
 * The shared start of every `/<owner>/<repo>` page: who is looking, and the repository if
 * they may read it (a 404 otherwise, the same for private and missing). An old address (the
 * repository was renamed or transferred, or its owner changed handle) redirects to the
 * repository's home at its current address, the same way for both.
 *
 * `app/[owner]/[repo]/layout.tsx` runs this check above the route's `loading.tsx`, so the 404
 * or redirect is the response itself and not a skeleton followed by a not-found page; the
 * page under it reads the same answer (once per request). Server-only.
 */
import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { cacheForRequest } from 'vinext/cache';

import { resolveRetiredHandle } from '@gitstalk/shared-identity/profiles';

import { currentSession } from '../auth/user';
import type { User as SessionUser } from '../auth/user';
import { lookupRepository } from '../repositories/flows';
import type { StartConfig } from '../repositories/paths';
import { isOldAddress, repositoryPath, sshEndpoint } from '../repositories/paths';
import type { RepositoryRecord, ViewerRole } from '../repositories/registry-client';
import { registryClient } from '../repositories/registry-client';
import { keyedForRequest } from './request-memo';

export type RepositoryParams = Promise<{ readonly owner: string; readonly repo: string }>;

export type RepositoryPage = {
  readonly user: SessionUser | null;
  readonly record: RepositoryRecord;
  readonly isOwner: boolean;
  /** The viewer's role: owner, maintain, write, read, or null (reading a public one). */
  readonly role: ViewerRole | null;
  /** `/<owner>/<repo>` as the record names it now. */
  readonly base: string;
};

/**
 * The viewer's session, read once per request: the access check needs the person, and the
 * owner's forms on the same page need its CSRF token.
 */
export const requestSession = cacheForRequest(currentSession);

const accessChecks = keyedForRequest<RepositoryPage>();

/**
 * The viewer's access to the repository at `params`, checked once per request (the layout
 * and the page share it). Throws Next's not-found or redirect, as `notFound()` does.
 */
export async function repositoryPage(params: RepositoryParams): Promise<RepositoryPage> {
  const { owner, repo } = await params;
  const address = { owner: decodeURIComponent(owner), repo: decodeURIComponent(repo) };
  return accessChecks(`${address.owner}/${address.repo}`, () => checkAccess(address));
}

async function checkAccess(address: {
  readonly owner: string;
  readonly repo: string;
}): Promise<RepositoryPage> {
  const session = await requestSession();
  const user = session?.user ?? null;
  const found = await lookupRepository(
    address.owner,
    address.repo,
    user,
    registryClient(env.GATEWAY),
  );
  if (found.kind === 'not-found') {
    // An owner who changed handle: their old address keeps working (docs/claude-opus/29).
    const moved = await resolveRetiredHandle(env, address.owner);
    if (moved !== null) redirect(repositoryPath(moved, address.repo));
    notFound();
  }
  // The gateway resolved an old address (a rename or a transfer, docs/claude-opus/28 §6.3):
  // send the browser to the current one, as a handle change does.
  if (isOldAddress(address.owner, address.repo, found.record))
    redirect(repositoryPath(found.record.owner.handle, found.record.name));
  return {
    user,
    record: found.record,
    isOwner: found.isOwner,
    role: found.role,
    base: repositoryPath(found.record.owner.handle, found.record.name),
  };
}

/** The start page's addresses: the vars, and this site's own origin (from the request). */
export async function startConfig(): Promise<StartConfig> {
  const host = (await headers()).get('host') ?? 'localhost';
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  const ssh = sshEndpoint(env);
  const base = { gitOrigin: env.GIT_ORIGIN, mcpUrl: env.MCP_URL, webOrigin: `${scheme}://${host}` };
  return ssh === undefined ? base : { ...base, ssh };
}
