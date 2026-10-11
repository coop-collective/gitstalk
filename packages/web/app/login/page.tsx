import Link from 'next/link';

import styles from '../../components/account/account.module.css';
import { ForgetClientCache } from '../../components/account/forget-client-cache';
import { TurnstileField } from '../../components/account/turnstile';
import { PasskeySignin } from '../../components/account/passkey-buttons';
import { NextPath } from '../../src/auth/http';
import { emailSignIn } from '../../src/auth/services';
import { turnstileSiteKey } from '../../src/auth/turnstile';
import { currentUser } from '../../src/auth/user';

export const metadata = { title: 'Sign in' };
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

type Query = Readonly<Record<string, string | string[] | undefined>>;
type PageProps = { readonly searchParams: Promise<Query> };

/** Sign in with a passkey (and by email once a sender domain is configured). */
export default async function LoginPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const next = NextPath.parse(typeof query['next'] === 'string' ? query['next'] : '/');
  const user = await currentUser();
  const email = emailSignIn() !== null;
  const siteKey = turnstileSiteKey();
  return (
    <main className={styles.page}>
      <div className={styles.stack}>
        <section className={styles.panel} aria-labelledby="login-title">
          {next.startsWith('/connect') ? (
            <p className={styles.eyebrow}>connect an agent · sign in</p>
          ) : null}
          <h1 id="login-title" className={styles.title}>
            Sign in to Gitstalk
          </h1>
          {user === null ? (
            <>
              <SignedOutNotice query={query} />
              <PasskeySignin next={next} turnstileSiteKey={siteKey} />
              {email ? <EmailSignin query={query} siteKey={siteKey} /> : null}
              <p className={styles.note}>
                New here?{' '}
                <Link href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link>
              </p>
            </>
          ) : (
            <p className={styles.success}>
              Signed in as <strong>@{user.handle}</strong>. <Link href={next}>Continue</Link> or
              open <Link href="/settings">Settings</Link>.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

/** What brought someone here signed out: signing out, or deleting their account. */
function SignedOutNotice({ query }: { readonly query: Query }) {
  const text = signedOutText(query);
  return text === null ? null : (
    <p className={styles.success} role="status">
      <ForgetClientCache />
      {text}
    </p>
  );
}

function signedOutText(query: Query): string | null {
  if (query['account'] === 'deleted') return 'Your account was deleted.';
  return query['signed_out'] === undefined ? null : 'You are signed out.';
}

function EmailSignin({
  query,
  siteKey,
}: {
  readonly query: Query;
  readonly siteKey: string | null;
}) {
  if (query['email_sent'] !== undefined)
    return (
      <p className={styles.success}>
        Check your email: the link works once, for 15 minutes, in this browser.
      </p>
    );
  return (
    <>
      <p className={styles.divider}>or</p>
      <form method="post" action="/api/auth/email" className={styles.form}>
        <label htmlFor="login-email" className={styles.label}>
          Email
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={styles.input}
        />
        <TurnstileField siteKey={siteKey} action="signin" />
        <button type="submit" className={styles.secondary}>
          Email me a sign-in link
        </button>
        {query['email_error'] === undefined ? null : (
          <p className={styles.error} role="alert">
            That link did not work, or too many tries. Ask for a new one.
          </p>
        )}
      </form>
    </>
  );
}
