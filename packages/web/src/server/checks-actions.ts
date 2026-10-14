'use server';

/**
 * Settings → Checks' one write from the browser: convert the repository's `checks.toml` to
 * `.gitstalk/checks.yml` (a bean through the editors' commit path, never a push to a line).
 * Checks the form (same origin, session, CSRF) and that the person can see the repository; the
 * gateway decides who may convert (owner or maintainer) and converts with the engine's parser.
 */
import { env } from 'cloudflare:workers';

import { lookupRepository } from '../repositories/flows';
import { registryClient } from '../repositories/registry-client';
import { checksClient } from '../checks/checks-client';
import { field, idempotencyOf, signedInForm } from './signed-in-form';

export type ChecksConvertState =
  | { readonly kind: 'converted'; readonly bean: string; readonly commit: string }
  | { readonly kind: 'refused'; readonly message: string };

/** Converts the checks the page showed as `yaml` (refused when the file changed since). */
export async function convertChecksAction(form: FormData): Promise<ChecksConvertState> {
  const checked = await signedInForm(form);
  if ('kind' in checked) return checked;
  const user = checked.session.user;
  const found = await lookupRepository(
    field(form, 'owner'),
    field(form, 'name'),
    user,
    registryClient(env.GATEWAY),
  );
  if (found.kind === 'not-found') return refused('No such repository.');
  const client = checksClient(env.GATEWAY, user.id);
  if (client === null) return refused('Converting the checks is not available on this deployment.');
  const converted = await client.convert(found.record.id, {
    yaml: field(form, 'yaml'),
    ...idempotencyOf(form),
  });
  if (!converted.ok) return refused(converted.message);
  if (converted.value.kind === 'stale')
    return refused('The checks changed since this page opened. Reload to see them.');
  return { kind: 'converted', bean: converted.value.bean, commit: converted.value.commit };
}

function refused(message: string): ChecksConvertState {
  return { kind: 'refused', message };
}
