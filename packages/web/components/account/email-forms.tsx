/**
 * The email sign-in forms: an address, a six-digit code, a handle. Plain HTML forms posting
 * to `/api/auth/email/<step>` (they work without JavaScript); `mode` and `next` ride along
 * as hidden fields. Settings → Emails reuses the address and code forms with its CSRF token.
 */
import type { SignInMode, StepError } from '../../src/auth/sign-in-steps';
import styles from './account.module.css';
import { TurnstileField } from './turnstile';

const MESSAGES: Readonly<Record<Exclude<StepError, null>, string>> = {
  address: 'That does not look like an email address.',
  rate: 'Too many tries. Wait a minute and try again.',
  too_many_codes: 'That address has had five codes this hour. Use the newest, or try later.',
  check: 'Complete the check, then try again.',
  send: 'The email could not be sent. Check the address and try again.',
  wrong_code: 'That code is not right.',
  expired: 'That code expired or was used up. Ask for a new one.',
  handle: 'Use 2–39 lowercase letters, digits or single hyphens (some words are reserved).',
  handle_taken: 'That handle is taken. Pick another.',
  email_taken: 'Another account already uses that address.',
};

/** The message for a step's error, with the tries left after a wrong code. */
export function StepNotice({
  error,
  attemptsLeft,
}: {
  readonly error: StepError;
  readonly attemptsLeft: number | null;
}) {
  if (error === null) return null;
  const left =
    error === 'wrong_code' && attemptsLeft !== null
      ? ` ${attemptsLeft === 0 ? 'No tries left: ask for a new code.' : `${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.`}`
      : '';
  return (
    <p className={styles.error} role="alert">
      {MESSAGES[error]}
      {left}
    </p>
  );
}

/** Step one of email sign-in: the address (and the Turnstile check when it is on). */
export function EmailStartForm({
  mode,
  next,
  siteKey,
  error,
}: {
  readonly mode: SignInMode;
  readonly next: string;
  readonly siteKey: string | null;
  readonly error: StepError;
}) {
  return (
    <form method="post" action="/api/auth/email/start" className={styles.form}>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="next" value={next} />
      <EmailField id="signin-email" autoComplete="email webauthn" />
      <TurnstileField siteKey={siteKey} action={mode} />
      <button type="submit" className={styles.secondary}>
        Continue with email
      </button>
      <StepNotice error={error} attemptsLeft={null} />
    </form>
  );
}

/** An address field: labelled, `type=email`, autocomplete as given. */
export function EmailField({
  id,
  autoComplete,
  label = 'Email',
}: {
  readonly id: string;
  readonly autoComplete: string;
  readonly label?: string;
}) {
  return (
    <>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        id={id}
        name="email"
        type="email"
        inputMode="email"
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        required
        maxLength={254}
        className={styles.input}
      />
    </>
  );
}

/** The six-digit code: numeric keyboard, one-time-code autofill (SMS-style suggestions). */
export function CodeForm({
  action,
  hidden,
  submitLabel,
}: {
  readonly action: string;
  readonly hidden: Readonly<Record<string, string>>;
  readonly submitLabel: string;
}) {
  return (
    <form method="post" action={action} className={styles.form}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label htmlFor="email-code" className={styles.label}>
        Six-digit code
      </label>
      <input
        id="email-code"
        name="code"
        className={`${styles.input} ${styles.code}`}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\s*\d{3}[\s-]?\d{3}\s*"
        maxLength={9}
        required
        autoFocus
        aria-describedby="email-code-hint"
      />
      <span id="email-code-hint" className={styles.hint}>
        From the email we just sent. Five tries.
      </span>
      <button type="submit" className={styles.primary}>
        {submitLabel}
      </button>
    </form>
  );
}

/** A new address's handle: the same rules as every handle (reserved and retired refused). */
export function HandleForm({ mode, next }: { readonly mode: SignInMode; readonly next: string }) {
  return (
    <form method="post" action="/api/auth/email/handle" className={styles.form}>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="next" value={next} />
      <label htmlFor="new-account-handle" className={styles.label}>
        Handle
      </label>
      <div className={styles.handleField}>
        <span aria-hidden="true">@</span>
        <input
          id="new-account-handle"
          name="handle"
          required
          minLength={2}
          maxLength={39}
          pattern="[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){1,38}"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          aria-describedby="new-account-handle-hint"
        />
      </div>
      <span id="new-account-handle-hint" className={styles.hint}>
        2–39 lowercase letters, digits or single hyphens. You can change it later in Settings.
      </span>
      <button type="submit" className={styles.primary}>
        Create account
      </button>
    </form>
  );
}
