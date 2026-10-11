/**
 * What the app header reads for the signed-in viewer. Server-only. `cache()` shares one read per
 * request, so the header and any page that needs the same profile do not each query D1.
 */
import { env } from 'cloudflare:workers';
import { cache } from 'react';

import type { Profile } from '@gitstalk/shared-identity/profiles';
import { getProfile } from '@gitstalk/shared-identity/profiles';

/** A person's profile, read once per request however many server components ask. */
export const cachedProfile = cache((userId: string): Promise<Profile | null> =>
  getProfile(env, userId),
);
