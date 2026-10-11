/**
 * The web app's one adapter onto accounts: who is signed in. Every page, route handler and
 * server action that needs a person goes through here, so the repository and settings code
 * never touches cookies or the identity database directly.
 *
 * - `requireUser(request)`: route handlers; throws `SignInRequired` (its `response()` is a 401).
 * - `getUser(request)`: route handlers; null when signed out.
 * - `currentUser()` / `currentSession()`: server components and actions (reads the request's
 *   cookies through next/headers). Memoised per request with vinext's `cacheForRequest`, so a
 *   page whose layout, header and body each ask costs one D1 read. A server action that
 *   changes who is signed in and then reads the session again in the same request uses
 *   `freshSession()`.
 */
import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import { cacheForRequest } from 'vinext/cache';

import type { WebSession } from '@gitstalk/shared-identity/sessions';
import { getSessionUser, getWebSession } from '@gitstalk/shared-identity/sessions';
import type { SessionUser } from '@gitstalk/shared-identity/users';

/** A signed-in person: `{ id, handle, email }` (email null until one is verified). */
export type User = SessionUser;

export class SignInRequired extends Error {
  constructor() {
    super('sign in first');
    this.name = 'SignInRequired';
  }

  response(): Response {
    return Response.json(
      { error: { code: 'unauthorized', message: 'sign in first' } },
      { status: 401 },
    );
  }
}

export async function requireUser(request: Request): Promise<User> {
  const user = await getUser(request);
  if (user === null) throw new SignInRequired();
  return user;
}

export function getUser(request: Request): Promise<User | null> {
  return getSessionUser(request, env);
}

/** The session behind this request's cookie, read once per request. */
export const currentSession: () => Promise<WebSession | null> = cacheForRequest(freshSession);

export async function currentUser(): Promise<User | null> {
  return (await currentSession())?.user ?? null;
}

/** The session read now, bypassing the per-request memo. */
export async function freshSession(): Promise<WebSession | null> {
  const requestHeaders = await headers();
  return getWebSession(requestHeaders.get('cookie'), env);
}
