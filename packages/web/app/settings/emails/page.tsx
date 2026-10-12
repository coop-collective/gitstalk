import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import Link from 'next/link';

import { EMAIL_TICKET_COOKIE, readCookie } from '@gitstalk/shared-identity/cookies';
import { emailForTicket } from '@gitstalk/shared-identity/email-codes';

import { AccountSettings } from '../../../components/account/account-settings';
import styles from '../../../components/account/account.module.css';
import { CodeForm, EmailField, StepNotice } from '../../../components/account/email-forms';
import { SettingsSection, SoonPill } from '../../../components/settings/settings-shell';
import { emailSignIn } from '../../../src/auth/services';
import { stepFromQuery } from '../../../src/auth/sign-in-steps';
import { accountPage, queryValue } from '../../../src/server/account-page';

export const metadata = { title: 'Emails' };
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

type PageProps = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

/**
 * Settings → Emails: the verified address that signs this account in by email. Adding or
 * changing it sends a six-digit code to the new address (src/auth/email-routes.ts `add`,
 * `confirm`); it is saved only once the code is entered.
 */
export default async function EmailSettingsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const { session, profile } = await accountPage('/settings/emails');
  const { step, error } = stepFromQuery(query);
  const isMailOn = emailSignIn() !== null;
  const email = session.user.email;
  const pendingAddress = isMailOn && step === 'code' ? await addressWaitingForCode() : null;
  return (
    <AccountSettings current="emails" profile={profile} title="Emails">
      <SettingsSection
        id="addresses"
        title="Address"
        aside={isMailOn ? undefined : <SoonPill />}
        lede="Where sign-in codes go. With an address you can sign in by email on any device, as well as with a passkey."
      >
        {queryValue(query, 'email') === 'added' ? (
          <p className={styles.success} role="status">
            Address verified. You can now sign in with it.
          </p>
        ) : null}
        {email === null ? (
          <p className={styles.empty}>
            No address yet. You signed up with a passkey; add an address so a lost device does not
            lock you out.
          </p>
        ) : (
          <table className={styles.table}>
            <tbody>
              <tr>
                <td className={styles.mono}>{email}</td>
                <td>
                  <span className={styles.current}>verified · signs you in</span>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </SettingsSection>
      {isMailOn ? (
        <SettingsSection id="add" title={addTitle(pendingAddress, email)}>
          {pendingAddress === null ? (
            <form method="post" action="/api/auth/email/add" className={styles.tokenForm}>
              <input type="hidden" name="csrf" value={session.csrfToken} />
              <EmailField
                id="settings-email"
                autoComplete="email"
                label={email === null ? 'Email' : 'New email'}
              />
              <span className={styles.hint}>
                We send a six-digit code there; the address is saved once you enter it.
              </span>
              <button type="submit" className={styles.secondary}>
                Send code
              </button>
              <StepNotice error={error} attemptsLeft={null} />
            </form>
          ) : (
            <>
              <p className={styles.lede}>
                We sent a six-digit code to <strong>{pendingAddress}</strong>. It works for 10
                minutes.
              </p>
              <StepNotice error={error} attemptsLeft={null} />
              <CodeForm
                action="/api/auth/email/confirm"
                hidden={{ csrf: session.csrfToken }}
                submitLabel="Verify address"
              />
              <p className={styles.note}>
                <Link href="/settings/emails">Use another address</Link>
              </p>
            </>
          )}
        </SettingsSection>
      ) : (
        <p className={styles.hint}>
          This deployment does not send email
          {env.EMAIL_SENDER_DOMAIN === '' ? ' (no sender domain is set up)' : ''}, so addresses
          cannot be added here yet.
        </p>
      )}
    </AccountSettings>
  );
}

function addTitle(pendingAddress: string | null, email: string | null): string {
  if (pendingAddress !== null) return 'Enter the code';
  return email === null ? 'Add an address' : 'Change address';
}

/** The address this browser's Settings code went to, while that code is live. */
async function addressWaitingForCode(): Promise<string | null> {
  const ticket = readCookie((await headers()).get('cookie'), EMAIL_TICKET_COOKIE);
  if (ticket === null) return null;
  return emailForTicket(env, { ticket, purpose: 'add_email', now: Date.now() });
}
