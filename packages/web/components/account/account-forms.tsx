'use client';

/**
 * The account settings forms. Text forms are server actions with a save line under them;
 * the picture is a multipart POST (a file does not travel through an action), cropped in a
 * dialog first and checked here, so a too-large file never leaves the browser.
 */
import { useActionState, useEffect, useId } from 'react';
import type { ReactNode } from 'react';

import type { FormState } from '../../src/account/form-state';
import type { PictureNote } from '../../src/account/picture-notes';
import { EMPTY_FORM_STATE } from '../../src/account/form-state';
import type { ProfileFormState } from '../../src/server/account-actions';
import {
  changeHandleAction,
  deleteAccountAction,
  removeAvatarAction,
  renamePasskeyAction,
  saveProfile,
} from '../../src/server/account-actions';
import { PictureUpload } from '../settings/picture-upload';
import { SaveStatus } from '../settings/settings-shell';
import { useSavedForm } from '../settings/use-saved-form';
import styles from './account.module.css';

export function ProfileForm({
  csrf,
  profile,
}: {
  readonly csrf: string;
  readonly profile: {
    readonly displayName: string;
    readonly bio: string;
    readonly website: string;
  };
}) {
  const { state, action, pending, saved } = useSavedForm<ProfileFormState>(saveProfile, {
    ...EMPTY_FORM_STATE,
    field: null,
  });
  const invalid = (name: ProfileFormState['field']) => (state.field === name ? true : undefined);
  return (
    <form action={action} className={styles.tokenForm} noValidate>
      <input type="hidden" name="csrf" value={csrf} />
      <div className={styles.field}>
        <label htmlFor="profile-name" className={styles.label}>
          Name
        </label>
        <input
          id="profile-name"
          name="displayName"
          className={styles.input}
          defaultValue={saved('displayName', profile.displayName)}
          maxLength={64}
          autoComplete="name"
          aria-invalid={invalid('displayName')}
        />
        <span className={styles.hint}>
          Shown beside your handle. Leave empty to use the handle.
        </span>
      </div>
      <div className={styles.field}>
        <label htmlFor="profile-bio" className={styles.label}>
          Bio
        </label>
        <textarea
          id="profile-bio"
          name="bio"
          className={styles.input}
          defaultValue={saved('bio', profile.bio)}
          maxLength={160}
          rows={3}
          aria-invalid={invalid('bio')}
        />
        <span className={styles.hint}>Up to 160 characters.</span>
      </div>
      <div className={styles.field}>
        <label htmlFor="profile-website" className={styles.label}>
          Website
        </label>
        <input
          id="profile-website"
          name="website"
          className={styles.input}
          defaultValue={saved('website', profile.website)}
          inputMode="url"
          autoComplete="url"
          placeholder="https://"
          spellCheck={false}
          aria-invalid={invalid('website')}
        />
      </div>
      <div className={styles.inline}>
        <button type="submit" className={styles.primary} disabled={pending}>
          Save profile
        </button>
        <SaveStatus pending={pending} saved={state.saved} error={state.error} />
      </div>
    </form>
  );
}

/**
 * The picture: upload through the crop dialog (a multipart POST to the route handler, or the
 * plain form without scripts) and remove (an action, then a reload).
 */
export function AvatarForm({
  csrf,
  current,
  hasPicture,
  note,
}: {
  readonly csrf: string;
  /** The picture people see now (the uploaded one or the generated one). */
  readonly current: ReactNode;
  readonly hasPicture: boolean;
  /** What the last upload did (`?picture=` on the page). */
  readonly note: PictureNote | null;
}) {
  const [removeState, removeAction, removing] = useActionState<FormState, FormData>(
    removeAvatarAction,
    EMPTY_FORM_STATE,
  );
  useEffect(() => {
    if (removeState.saved !== null) window.location.assign('/settings?picture=removed');
  }, [removeState.saved]);
  const removeNote: PictureNote | null =
    removeState.error === null ? null : { kind: 'error', text: removeState.error };
  return (
    <PictureUpload
      shape="avatar"
      noun="picture"
      cropTitle="Crop your picture"
      action="/settings/profile/avatar"
      csrf={csrf}
      current={current}
      hasPicture={hasPicture}
      note={removeNote ?? note}
      buttonClassName={styles.secondary}
      hint="PNG, JPEG, WebP or GIF (first frame), up to 2 MB. You can move and zoom it to fit the circle, or drop a file on the picture."
      remove={
        hasPicture ? (
          <form action={removeAction}>
            <input type="hidden" name="csrf" value={csrf} />
            <button
              type="submit"
              className={`${styles.danger} ${styles.besideSecondary}`}
              disabled={removing}
            >
              Remove picture
            </button>
          </form>
        ) : null
      }
    />
  );
}

export function HandleForm({
  csrf,
  handle,
  isCoolingDown,
}: {
  readonly csrf: string;
  readonly handle: string;
  readonly isCoolingDown: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    changeHandleAction,
    EMPTY_FORM_STATE,
  );
  // A changed handle is in the header and every link: load the page again, not just this form.
  useEffect(() => {
    if (state.saved !== null) window.location.assign('/settings/account?saved=handle');
  }, [state.saved]);
  return (
    <form action={action} className={styles.tokenForm}>
      <input type="hidden" name="csrf" value={csrf} />
      <div className={styles.field}>
        <label htmlFor="new-handle" className={styles.label}>
          New handle
        </label>
        <div className={styles.handleField}>
          <span aria-hidden="true">@</span>
          <input
            id="new-handle"
            name="handle"
            defaultValue={handle}
            required
            minLength={2}
            maxLength={39}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="new-handle-hint"
          />
        </div>
        <span id="new-handle-hint" className={styles.hint}>
          2–39 lowercase letters, digits or single hyphens. Your page, repositories and clone URLs
          move; links and git remotes using @{handle} keep redirecting, and nobody else can take it.
          One change a day.
        </span>
      </div>
      <div className={styles.inline}>
        <button type="submit" className={styles.secondary} disabled={pending || isCoolingDown}>
          Change handle
        </button>
        <SaveStatus pending={pending} saved={state.saved} error={state.error} />
      </div>
    </form>
  );
}

export function DeleteAccountForm({
  csrf,
  handle,
  blocked,
}: {
  readonly csrf: string;
  readonly handle: string;
  /** Why deletion is refused now (sole owner of an organization), or null. */
  readonly blocked: string | null;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    deleteAccountAction,
    EMPTY_FORM_STATE,
  );
  useEffect(() => {
    if (state.saved !== null) window.location.assign('/login?account=deleted');
  }, [state.saved]);
  return (
    <form action={action} className={styles.tokenForm}>
      <input type="hidden" name="csrf" value={csrf} />
      <div className={styles.field}>
        <label htmlFor="confirm-account-delete" className={styles.label}>
          Type <code>{handle}</code> to confirm
        </label>
        <input
          id="confirm-account-delete"
          name="confirm"
          className={styles.input}
          autoComplete="off"
          spellCheck={false}
          disabled={blocked !== null}
        />
      </div>
      <div className={styles.inline}>
        <button type="submit" className={styles.danger} disabled={pending || blocked !== null}>
          Delete my account
        </button>
        <SaveStatus pending={pending} saved={null} error={blocked ?? state.error} />
      </div>
    </form>
  );
}

export function PasskeyRename({
  csrf,
  passkey,
}: {
  readonly csrf: string;
  readonly passkey: { readonly id: string; readonly name: string };
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    renamePasskeyAction,
    EMPTY_FORM_STATE,
  );
  const inputId = useId();
  return (
    <form action={action} className={styles.renameRow}>
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="passkey" value={passkey.id} />
      <label htmlFor={inputId} className="visually-hidden">
        Name of {passkey.name}
      </label>
      <input
        id={inputId}
        name="name"
        className={styles.input}
        defaultValue={passkey.name}
        maxLength={60}
        required
      />
      <button type="submit" className={styles.secondary} disabled={pending}>
        Rename
      </button>
      <SaveStatus pending={pending} saved={state.saved} error={state.error} />
    </form>
  );
}
