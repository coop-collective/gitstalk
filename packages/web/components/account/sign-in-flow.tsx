/**
 * The one sign-in flow behind `/login` and `/signup` (src/auth/sign-in-steps.ts names the
 * steps): continue with a passkey, or with an email address and a six-digit code; a new
 * address then chooses a handle and is offered a passkey. `/signup` differs in wording, and its
 * passkey way in creates an account (a handle and a new passkey, no email needed).
 *
 * Email steps are plain form posts to `/api/auth/email/<step>` (src/auth/email-routes.ts);
 * which step a page may show is decided here from its cookies, so a stale `?step=` falls
 * back to the start with a note.
 */
import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import { IntentLink as Link } from '../shell/intent-link';
import type { ReactNode } from 'react';

import {
  EMAIL_TICKET_COOKIE,
  PENDING_SIGNUP_COOKIE,
  readCookie,
} from '@gitstalk/shared-identity/cookies';
import { emailForTicket } from '@gitstalk/shared-identity/email-codes';
import { readPendingSignup } from '@gitstalk/shared-identity/email-sign-in';

import { emailSignIn } from '../../src/auth/services';
import type { SignInMode, SignInStep, StepError } from '../../src/auth/sign-in-steps';
import { stepPath } from '../../src/auth/sign-in-steps';
import { turnstileSiteKey } from '../../src/auth/turnstile';
import { currentSession } from '../../src/auth/user';
import styles from './account.module.css';
import { CodeForm, EmailStartForm, HandleForm, StepNotice } from './email-forms';
import { ForgetClientCache } from './forget-client-cache';
import { AddPasskey, PasskeySignin, PasskeySignup } from './passkey-buttons';

export type SignInFlowProps = {
  readonly mode: SignInMode;
  readonly step: SignInStep;
  readonly next: string;
  readonly error: StepError;
  readonly attemptsLeft: number | null;
  /** Why a signed-out browser is here (signed out, account deleted), or null. */
  readonly signedOutNote: string | null;
};

const TITLES: Readonly<Record<SignInMode, string>> = {
  signin: 'Sign in to Gitstalk',
  signup: 'Create your account',
};

export async function SignInFlow(props: SignInFlowProps) {
  const session = await currentSession();
  const content =
    session === null
      ? await signedOutStep(props)
      : signedInStep(props, { handle: session.user.handle, csrf: session.csrfToken });
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="signin-title">
        {props.next.startsWith('/connect') ? (
          <p className={styles.eyebrow}>
            connect an agent · {props.mode === 'signup' ? 'create your account' : 'sign in'}
          </p>
        ) : null}
        {content}
      </section>
    </main>
  );
}

function signedInStep(
  props: SignInFlowProps,
  person: { readonly handle: string; readonly csrf: string },
): ReactNode {
  if (props.step === 'passkey')
    return (
      <>
        <Title>Add a passkey for faster sign-in</Title>
        <p className={styles.success} role="status">
          Welcome, <strong>@{person.handle}</strong>. Your account is ready.
        </p>
        <p className={styles.lede}>
          A passkey signs you in with your fingerprint, face or device PIN, with no code to wait
          for. You can add one later in Settings.
        </p>
        <AddPasskey csrf={person.csrf} next={props.next} label="Add a passkey" />
        <Link href={props.next} className={styles.quiet}>
          Skip for now
        </Link>
      </>
    );
  return (
    <>
      <Title>{TITLES[props.mode]}</Title>
      <p className={styles.success}>
        Signed in as <strong>@{person.handle}</strong>. <Link href={props.next}>Continue</Link> or
        open <Link href="/settings">Settings</Link>.
      </p>
    </>
  );
}

async function signedOutStep(props: SignInFlowProps): Promise<ReactNode> {
  const config = emailSignIn();
  const cookies = (await headers()).get('cookie');
  const now = Date.now();
  if (config !== null && props.step === 'code') {
    const ticket = readCookie(cookies, EMAIL_TICKET_COOKIE);
    const email =
      ticket === null ? null : await emailForTicket(env, { ticket, purpose: 'signin', now });
    if (email !== null) return codeStep(props, email);
  }
  if (config !== null && props.step === 'handle') {
    const email = await readPendingSignup(
      config.key,
      readCookie(cookies, PENDING_SIGNUP_COOKIE),
      now,
    );
    if (email !== null) return handleStep(props, email);
  }
  const isStale = props.step === 'code' || props.step === 'handle' || props.step === 'passkey';
  return startStep(props, {
    hasEmail: config !== null,
    error: isStale && props.error === null ? 'expired' : props.error,
  });
}

function startStep(
  props: SignInFlowProps,
  options: { readonly hasEmail: boolean; readonly error: StepError },
): ReactNode {
  const siteKey = turnstileSiteKey();
  const isSignup = props.mode === 'signup';
  const other: SignInMode = isSignup ? 'signin' : 'signup';
  return (
    <>
      <Title>{TITLES[props.mode]}</Title>
      {props.signedOutNote === null ? null : (
        <p className={styles.success} role="status">
          <ForgetClientCache />
          {props.signedOutNote}
        </p>
      )}
      <p className={styles.lede}>
        {isSignup
          ? 'No password. Pick a handle and save a passkey on this device, or continue with your email and get a six-digit code.'
          : 'No password. Use a passkey, or get a six-digit code by email. New here? The same steps create your account.'}
      </p>
      {isSignup ? (
        <PasskeySignup next={props.next} turnstileSiteKey={siteKey} />
      ) : (
        <PasskeySignin next={props.next} turnstileSiteKey={siteKey} />
      )}
      {options.hasEmail ? (
        <>
          <p className={styles.divider}>or</p>
          <EmailStartForm
            mode={props.mode}
            next={props.next}
            siteKey={siteKey}
            error={options.error}
          />
        </>
      ) : null}
      <p className={styles.note}>
        {isSignup ? 'Already have an account? ' : 'New here? '}
        <Link href={stepPath(other, 'start', { next: props.next })}>
          {isSignup ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </>
  );
}

function codeStep(props: SignInFlowProps, email: string): ReactNode {
  return (
    <>
      <Title>Check your email</Title>
      <p className={styles.lede}>
        We sent a six-digit code to <strong>{email}</strong>. It works for 10 minutes, in this
        browser.
      </p>
      <StepNotice error={props.error} attemptsLeft={props.attemptsLeft} />
      <CodeForm
        action="/api/auth/email/verify"
        hidden={{ mode: props.mode, next: props.next }}
        submitLabel="Continue"
      />
      <p className={styles.note}>
        Wrong address or no mail?{' '}
        <Link href={stepPath(props.mode, 'start', { next: props.next })}>Start again</Link>
      </p>
    </>
  );
}

function handleStep(props: SignInFlowProps, email: string): ReactNode {
  return (
    <>
      <Title>Choose your handle</Title>
      <p className={styles.lede}>
        <strong>{email}</strong> is verified and has no account yet. Pick the handle that names you
        on beans, decisions and git.
      </p>
      <StepNotice error={props.error} attemptsLeft={null} />
      <HandleForm mode={props.mode} next={props.next} />
      <p className={styles.note}>
        Meant to use another address?{' '}
        <Link href={stepPath(props.mode, 'start', { next: props.next })}>Start again</Link>
      </p>
    </>
  );
}

function Title({ children }: { readonly children: ReactNode }) {
  return (
    <h1 id="signin-title" className={styles.title}>
      {children}
    </h1>
  );
}
