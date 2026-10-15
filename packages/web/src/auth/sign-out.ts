/**
 * Signing out (`POST /auth/signout`): a same-origin form from a live session with its CSRF
 * token; this browser's session row is revoked (or every one, `everywhere=1`), the session
 * cookie is cleared, the browser's HTTP cache for this origin is emptied (`Clear-Site-Data`, so
 * no answer kept while signed in is reused after) and the browser lands on the sign-in page.
 * The ports keep it testable.
 */
import { SESSION_COOKIE, clearCookie } from '@gitstalk/shared-identity/cookies';
import type { WebSession } from '@gitstalk/shared-identity/sessions';

import { SIGNED_OUT_PATH, seeOther, signedInForm } from './http';

export type SignOutPorts = {
  readonly session: (cookieHeader: string | null) => Promise<WebSession | null>;
  readonly revoke: (sessionHash: string, now: number) => Promise<void>;
  readonly revokeAll: (userId: string, now: number) => Promise<void>;
  readonly audit: (
    event: { readonly action: 'session.signout' | 'session.signout_all'; readonly userId: string },
    now: number,
  ) => Promise<void>;
};

/**
 * Only the HTTP cache (and the back/forward cache): `"cookies"` would also drop other sign-ins
 * on this site, and `"storage"` the per-tab conveniences; the session cookie is cleared on its own.
 */
const CLEAR_CACHE = '"cache"';

export async function signOut(
  request: Request,
  ports: SignOutPorts,
  now: number,
): Promise<Response> {
  const checked = await signedInForm(request, ports.session);
  if (checked instanceof Response) return checked;
  const { session, form } = checked;
  const everywhere = form.get('everywhere') === '1';
  if (everywhere) await ports.revokeAll(session.user.id, now);
  else await ports.revoke(session.sessionHash, now);
  await ports.audit(
    { action: everywhere ? 'session.signout_all' : 'session.signout', userId: session.user.id },
    now,
  );
  const response = seeOther(request, SIGNED_OUT_PATH, [clearCookie(SESSION_COOKIE)]);
  response.headers.set('clear-site-data', CLEAR_CACHE);
  return response;
}
