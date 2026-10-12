import { env } from 'cloudflare:workers';

import { listPasskeys } from '@gitstalk/shared-identity/passkeys';

import { AccountSettings } from '../../../components/account/account-settings';
import { PasskeyRename } from '../../../components/account/account-forms';
import styles from '../../../components/account/account.module.css';
import { AddPasskey } from '../../../components/account/passkey-buttons';
import { formatDate } from '../../../components/account/scope-chips';
import { SettingsSection } from '../../../components/settings/settings-shell';
import { accountPage, queryValue } from '../../../src/server/account-page';

export const metadata = { title: 'Passkeys' };
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

type PageProps = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

const NOTES: Readonly<Record<string, string>> = {
  added: 'Passkey added.',
  removed: 'Passkey removed.',
  last_sign_in_method: 'That is your only way to sign in, so it stays. Add another passkey first.',
  not_found: 'That passkey was already gone.',
};

/** Settings → Passkeys: list, name, add another, remove (never the last one). */
export default async function PasskeySettingsPage({ searchParams }: PageProps) {
  const { session, profile } = await accountPage('/settings/passkeys');
  const passkeys = await listPasskeys(env, profile.id);
  const note = NOTES[queryValue(await searchParams, 'passkey') ?? ''];
  const isLast = passkeys.length === 1 && session.user.email === null;
  return (
    <AccountSettings
      current="passkeys"
      profile={profile}
      title="Passkeys"
      lede="A key kept by your device or password manager: nothing to type, nothing to phish. You can also sign in with a code sent to your verified email."
    >
      <SettingsSection
        id="list"
        title={passkeys.length === 1 ? 'Your passkey' : `Your ${passkeys.length} passkeys`}
        lede={
          isLast
            ? 'It is your only way in: add a second passkey, or an email address in Settings → Emails, before you can remove it.'
            : 'Name them after where they live, so you know which to remove when a device goes.'
        }
      >
        {note === undefined ? null : (
          <p className={styles.note} role="status">
            {note}
          </p>
        )}
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Added</th>
              <th scope="col">Last used</th>
              <th scope="col">
                <span className="visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {passkeys.map((passkey) => (
              <tr key={passkey.id}>
                <td>
                  <PasskeyRename csrf={session.csrfToken} passkey={passkey} />
                </td>
                <td className={styles.muted}>{formatDate(passkey.createdAt)}</td>
                <td className={styles.muted}>{formatDate(passkey.lastUsedAt)}</td>
                <td>
                  <form method="post" action="/settings/passkeys/remove">
                    <input type="hidden" name="csrf" value={session.csrfToken} />
                    <input type="hidden" name="passkey" value={passkey.id} />
                    <button
                      type="submit"
                      className={styles.danger}
                      aria-label={`Remove ${passkey.name}`}
                      disabled={isLast}
                      title={
                        isLast
                          ? 'Your only way in: add another passkey or an email first'
                          : undefined
                      }
                    >
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsSection>
      <SettingsSection
        id="add"
        title="Add a passkey"
        lede="Your browser asks where to keep it: this device, a phone, or a password manager such as 1Password."
      >
        <AddPasskey csrf={session.csrfToken} />
      </SettingsSection>
    </AccountSettings>
  );
}
