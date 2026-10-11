'use server';

/**
 * Server actions for account settings: profile, handle, picture removal, passkey names and
 * deleting the account. Each checks the origin, the session and its CSRF token
 * (`signedInForm`), then runs the flow; uploads go through route handlers instead
 * (`app/settings/profile/avatar`), because they carry a file.
 */
import { env } from 'cloudflare:workers';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { renamePasskey } from '@gitstalk/shared-identity/passkeys';
import type { ProfileInput } from '@gitstalk/shared-identity/profiles';
import { updateProfile } from '@gitstalk/shared-identity/profiles';
import { clientIp } from '@gitstalk/shared-identity/request-context';

import type { FormState } from '../account/form-state';
import { changeHandleFlow, deleteAccountFlow, removePictureFlow } from '../account/account-flows';
import { avatarPorts, deletionPorts, handlePorts } from '../account/account-services';
import { log } from '../log';
import { field, signedInForm } from './signed-in-form';

/** The profile form's state: the shared one plus which field an error is about. */
export type ProfileFormState = FormState & { readonly field: keyof ProfileInput | null };

export async function saveProfile(
  _previous: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const checked = await signedInForm(form);
  if ('kind' in checked) return { saved: null, error: checked.message, field: null };
  const saved = await updateProfile(env, {
    userId: checked.session.user.id,
    ip: await requestIp(),
    now: Date.now(),
    profile: {
      displayName: field(form, 'displayName'),
      bio: field(form, 'bio'),
      website: field(form, 'website'),
    },
  });
  if (!saved.ok) return { saved: null, error: saved.message, field: saved.field };
  // Pages the client router kept (staleTimes) would otherwise show the old profile.
  revalidatePath('/', 'layout');
  return { saved: 'Profile saved.', error: null, field: null };
}

export async function changeHandleAction(_previous: FormState, form: FormData): Promise<FormState> {
  const checked = await signedInForm(form);
  if ('kind' in checked) return { saved: null, error: checked.message };
  const { user } = checked.session;
  const result = await changeHandleFlow(
    { id: user.id, handle: user.handle, ip: await requestIp(), now: Date.now() },
    field(form, 'handle'),
    handlePorts(),
  );
  if (result.handle === null) return { saved: null, error: result.error };
  log.info('handle changed');
  // The form then reloads the page (HandleForm), so the header and every link show it.
  return { saved: result.saved, error: null };
}

export async function removeAvatarAction(_previous: FormState, form: FormData): Promise<FormState> {
  const checked = await signedInForm(form);
  if ('kind' in checked) return { saved: null, error: checked.message };
  const { user } = checked.session;
  const ip = await requestIp();
  const removed = await removePictureFlow(
    { kind: 'user', ownerId: user.id },
    avatarPorts({ id: user.id, ip }),
  );
  // The form then reloads the page (AvatarForm), so the header shows the generated picture.
  return removed;
}

export async function renamePasskeyAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const checked = await signedInForm(form);
  if ('kind' in checked) return { saved: null, error: checked.message };
  const outcome = await renamePasskey(env, {
    userId: checked.session.user.id,
    passkeyId: field(form, 'passkey'),
    name: field(form, 'name'),
    ip: await requestIp(),
    now: Date.now(),
  });
  switch (outcome) {
    case 'renamed':
      revalidatePath('/settings', 'layout');
      return { saved: 'Renamed.', error: null };
    case 'invalid_name':
      return { saved: null, error: 'Give it a name of up to 60 characters.' };
    case 'not_found':
      return { saved: null, error: 'That passkey is gone. Reload the page.' };
    default:
      return assertNever(outcome);
  }
}

export async function deleteAccountAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const checked = await signedInForm(form);
  if ('kind' in checked) return { saved: null, error: checked.message };
  const { user } = checked.session;
  const actor = { id: user.id, handle: user.handle, ip: await requestIp(), now: Date.now() };
  const outcome = await deleteAccountFlow(actor, field(form, 'confirm'), deletionPorts());
  if (outcome.kind === 'refused') return outcome.state;
  log.info('account deleted');
  // The form then loads the sign-in page whole, saying so (DeleteAccountForm): the header must
  // lose the account too.
  return { saved: 'Your account is deleted.', error: null };
}

async function requestIp(): Promise<string | null> {
  return clientIp(new Request('https://web.internal/', { headers: await headers() }));
}

function assertNever(value: never): never {
  throw new Error(`unexpected outcome: ${String(value)}`);
}
