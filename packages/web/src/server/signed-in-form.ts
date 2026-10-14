/**
 * The checks every signed-in form action makes before it asks the gateway: same origin, a web
 * session, and the session's CSRF token. Server-only.
 */
import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';

import type { WebSession } from '@gitstalk/shared-identity/sessions';
import { getWebSession, isValidCsrf } from '@gitstalk/shared-identity/sessions';

export type FormRefusal = { readonly kind: 'refused'; readonly message: string };

export async function signedInForm(
  form: FormData,
): Promise<{ readonly session: WebSession } | FormRefusal> {
  const requestHeaders = await headers();
  const origin = requestHeaders.get('origin');
  const host = requestHeaders.get('host');
  if (origin === null || host === null || new URL(origin).host !== host)
    return { kind: 'refused', message: 'Cross-site requests are refused.' };
  const session = await getWebSession(requestHeaders.get('cookie'), env);
  if (session === null) return { kind: 'refused', message: 'Sign in again.' };
  if (!(await isValidCsrf(session, form.get('csrf'))))
    return { kind: 'refused', message: 'Reload the page and try again.' };
  return { session };
}

/** A form field as a string ('' when absent). */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** The form's key for a save attempt (an editor makes one per attempt), when it sent one. */
export function idempotencyOf(form: FormData): { readonly idempotencyKey?: string } {
  const key = field(form, 'idempotencyKey');
  return key === '' ? {} : { idempotencyKey: key };
}
