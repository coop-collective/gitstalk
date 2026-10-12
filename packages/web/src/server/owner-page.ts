/**
 * The owner a `/<handle>` page shows: a person or an org, or the answer that ends the request
 * (a 404 for an unknown or reserved handle, a redirect for a handle its person retired,
 * docs/claude-opus/29-settings.md). `app/[owner]/(profile)/layout.tsx` asks above the page's
 * `loading.tsx`, so that answer is the response's status; the page reads the same owner
 * (memoised per request). Server-only.
 */
import { env } from 'cloudflare:workers';
import { notFound, redirect } from 'next/navigation';

import type { RepositoryOwnerRef } from '@gitstalk/shared-identity/orgs';
import { ownerByHandle } from '@gitstalk/shared-identity/orgs';
import type { Profile } from '@gitstalk/shared-identity/profiles';
import { getProfile, resolveRetiredHandle } from '@gitstalk/shared-identity/profiles';

import { isReservedOwner } from '../repositories/paths';
import { keyedForRequest } from './request-memo';

export type OwnerParams = Promise<{ readonly owner: string }>;

const owners = keyedForRequest<RepositoryOwnerRef>();
const profiles = keyedForRequest<Profile | null>();

/** The person or org at `params`, read once per request; throws Next's not-found or redirect. */
export async function pageOwner(params: OwnerParams): Promise<RepositoryOwnerRef> {
  const handle = decodeURIComponent((await params).owner);
  return owners(handle, () => resolveOwner(handle));
}

/** A person's profile for their page, read once per request. */
export function ownerProfile(userId: string): Promise<Profile | null> {
  return profiles(userId, () => getProfile(env, userId));
}

async function resolveOwner(handle: string): Promise<RepositoryOwnerRef> {
  if (isReservedOwner(handle)) notFound();
  const owner = await ownerByHandle(env, handle);
  if (owner !== null) return owner;
  const moved = await resolveRetiredHandle(env, handle);
  if (moved !== null) redirect(`/${encodeURIComponent(moved)}`);
  return notFound();
}
