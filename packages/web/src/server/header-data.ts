/**
 * What the app header reads for the signed-in viewer. Server-only. One read per request,
 * however many server components ask: the header renders twice per request (vinext probes the
 * root layout's subtree before the render), and React's `cache()` does not span the probe.
 */
import { env } from 'cloudflare:workers';

import type { Profile } from '@gitstalk/shared-identity/profiles';
import { getProfile } from '@gitstalk/shared-identity/profiles';

import { keyedForRequest } from './request-memo';

const profiles = keyedForRequest<Profile | null>();

/** A person's profile, read once per request however many server components ask. */
export function cachedProfile(userId: string): Promise<Profile | null> {
  return profiles(userId, () => getProfile(env, userId));
}
