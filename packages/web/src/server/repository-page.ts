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

/**
 * What the access check decided: the repository, a 404 (missing, or not readable by this
 * viewer: the same answer), or its current address (an old one was asked for).
 */
type RepositoryAccess =
  | { readonly kind: 'readable'; readonly page: RepositoryPage }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'moved'; readonly location: string };

const accessChecks = keyedForRequest<RepositoryAccess>();

/**
 * The viewer's access to the repository at `params`, checked once per request (the layout
 * and the page share it). Throws Next's not-found or redirect, as `notFound()` does.
 */
export async function repositoryPage(params: RepositoryParams): Promise<RepositoryPage> {
  const access = await repositoryAccess(params);
  switch (access.kind) {
    case 'readable':
      return access.page;
    case 'moved':
      return redirect(access.location);
    case 'not-found':
      return notFound();
  }
}

/**
 * True when `app/[owner]/[repo]/layout.tsx` answers this request itself (a 404 or a redirect),
 * so a layout nested under it must render nothing and leave the answer to it.
 *
 * vinext 1.1 probes a route's layouts innermost first, and renders a layout's 404 inside the
 * layouts above it. If a nested layout (settings, changes, a run) threw for a repository the
 * viewer may not read, the repository layout would throw again inside that 404 page, and vinext
 * would answer a bare "Not Found" text instead of `app/not-found.tsx`. Returning instead lets
 * the probe reach the repository layout, whose 404 renders inside the root layout only. Nothing
 * streams either way: the probe finishes before rendering starts. Memoised with the check.
 */
export async function repositoryLayoutAnswers(params: RepositoryParams): Promise<boolean> {
  return (await repositoryAccess(params)).kind !== 'readable';
}

async function repositoryAccess(params: RepositoryParams): Promise<RepositoryAccess> {
  const { owner, repo } = await params;
  const address = { owner: decodeURIComponent(owner), repo: decodeURIComponent(repo) };
  return accessChecks(`${address.owner}/${address.repo}`, () => checkAccess(address));
}

async function checkAccess(address: {
  readonly owner: string;
  readonly repo: string;
}): Promise<RepositoryAccess> {
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
    return moved === null
      ? { kind: 'not-found' }
      : { kind: 'moved', location: repositoryPath(moved, address.repo) };
  }
  // The gateway resolved an old address (a rename or a transfer, docs/claude-opus/28 §6.3):
  // send the browser to the current one, as a handle change does.
  const base = repositoryPath(found.record.owner.handle, found.record.name);
  if (isOldAddress(address.owner, address.repo, found.record))
    return { kind: 'moved', location: base };
  const page = { user, record: found.record, isOwner: found.isOwner, role: found.role, base };
  return { kind: 'readable', page };
}

/** The start page's addresses: the vars, and this site's own origin (from the request). */
export async function startConfig(): Promise<StartConfig> {
  const host = (await headers()).get('host') ?? 'localhost';
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  const ssh = sshEndpoint(env);
  const base = { gitOrigin: env.GIT_ORIGIN, mcpUrl: env.MCP_URL, webOrigin: `${scheme}://${host}` };
  return ssh === undefined ? base : { ...base, ssh };
}
