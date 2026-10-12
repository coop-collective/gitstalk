/**
 * What the app header reads for the signed-in viewer. Server-only. One read per request,
 * however many server components ask: the header renders twice per request (vinext probes the
 * root layout's subtree before the render), and React's `cache()` does not span the probe.
 */
import { env } from 'cloudflare:workers';

import type { Profile } from '@gitstalk/shared-identity/profiles';
import { getProfile } from '@gitstalk/shared-identity/profiles';

import { cacheForRequest } from 'vinext/cache';

import { currentSession } from '../auth/user';
import { keyedForRequest } from './request-memo';

const profiles = keyedForRequest<Profile | null>();

/** A person's profile, read once per request however many server components ask. */
export function cachedProfile(userId: string): Promise<Profile | null> {
  return profiles(userId, () => getProfile(env, userId));
}

/**
 * The signed-in viewer's profile (null when signed out), read once per request as soon as the
 * session is known. A layout that does its own reads before streaming starts this beside them:
 * vinext probes the root layout (and so the header) only after the layouts below it.
 */
export const viewerProfile: () => Promise<Profile | null> = cacheForRequest(async () => {
  const session = await currentSession();
  return session === null ? null : cachedProfile(session.user.id);
});
