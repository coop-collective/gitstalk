import { env } from 'cloudflare:workers';
import { IntentLink as Link } from '../../../../components/shell/intent-link';
import { redirect } from 'next/navigation';

import type { KeyRequestView } from '@gitstalk/shared-identity/ssh-key-requests';
import { describeKeyRequest, normalUserCode } from '@gitstalk/shared-identity/ssh-key-requests';

import styles from '../../../../components/account/account.module.css';
import { currentSession } from '../../../../src/auth/user';

export const metadata = { title: 'Add an SSH key' };
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

type PageProps = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

/**
 * "Add this SSH key to your account", opened by the setup script (the code in the link) or
 * typed from another device. Styled as the agent consent screen (`/connect`): the signed-in
 * person checks the fingerprint against their terminal and approves, or declines.
 */
export default async function AddKeyPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const code = typeof query['code'] === 'string' ? query['code'].slice(0, 20) : '';
  const done = typeof query['done'] === 'string' ? query['done'] : '';
  const session = await currentSession();
  if (session === null)
    redirect(
      `/login?next=${encodeURIComponent(code === '' ? '/settings/keys/add' : `/settings/keys/add?code=${code}`)}`,
    );
  if (done === 'approved' || done === 'denied') return <Done approved={done === 'approved'} />;
  const view =
    code === '' ? null : await describeKeyRequest(env, { userCode: code, userId: session.user.id });
  if (view === null) return <EnterCode tried={code !== ''} />;
  return (
    <Consent
      view={view}
      code={normalUserCode(code)}
      csrf={session.csrfToken}
      handle={session.user.handle}
    />
  );
}

function Consent(props: {
  readonly view: KeyRequestView;
  readonly code: string;
  readonly csrf: string;
  readonly handle: string;
}) {
  const { view } = props;
  const shownCode = `${props.code.slice(0, 4)}-${props.code.slice(4)}`;
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="add-key-title">
        <p className={styles.eyebrow}>connect git</p>
        <h1 id="add-key-title" className={styles.title}>
          Add this SSH key to @{props.handle}?
        </h1>
        <div className={styles.client}>
          <span className={styles.clientMark} aria-hidden="true">
            ⌁
          </span>
          <div>
            <p className={styles.clientName}>{view.name}</p>
            <dl className={styles.facts}>
              <dt>Code</dt>
              <dd className={styles.mono}>{shownCode}</dd>
              <dt>Key</dt>
              <dd className={styles.mono}>{view.keyType}</dd>
              <dt>Fingerprint</dt>
              <dd className={styles.mono}>{view.fingerprint}</dd>
            </dl>
          </div>
        </div>
        <p className={styles.warning}>
          Continue only if you just ran setup on {view.name} and its terminal shows this code and
          fingerprint. A key added here can push to your repositories.
        </p>
        <form method="post" action="/settings/keys/add/decide" className={styles.form}>
          <input type="hidden" name="code" value={props.code} />
          <input type="hidden" name="csrf" value={props.csrf} />
          <p className={styles.hint}>
            It may read your repositories and push beans (never land on the stalk, never change
            settings).
            {view.wantsHttpsToken
              ? ` Until git over SSH is live, ${view.name} also gets an HTTPS token (read and write, 90 days), listed under Tokens.`
              : ''}{' '}
            Remove it any time in Settings, SSH keys.
          </p>
          <div className={styles.actions}>
            <button type="submit" name="decision" value="deny" className={styles.secondary}>
              Deny
            </button>
            <button type="submit" name="decision" value="approve" className={styles.primary}>
              Add key
            </button>
          </div>
        </form>
        <p className={styles.signedInAs}>
          Signed in as @{props.handle}. Not you? <Link href="/login">Switch account</Link>
        </p>
      </section>
    </main>
  );
}

function EnterCode({ tried }: { readonly tried: boolean }) {
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="code-title">
        <p className={styles.eyebrow}>connect git</p>
        <h1 id="code-title" className={styles.title}>
          Enter the code from your terminal
        </h1>
        {tried ? (
          <p className={styles.error} role="alert">
            That code is not waiting for approval: it expired (ten minutes), was already answered,
            or was mistyped. Run setup again for a new one.
          </p>
        ) : (
          <p className={styles.lede}>
            The setup script shows an eight-letter code, like BCDF-GHJK.
          </p>
        )}
        <form method="get" action="/settings/keys/add" className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="user-code" className={styles.label}>
              Code
            </label>
            <input
              id="user-code"
              name="code"
              className={`${styles.input} ${styles.mono}`}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              required
              maxLength={12}
              placeholder="BCDF-GHJK"
            />
          </div>
          <div className={styles.actions}>
            <button type="submit" className={styles.primary}>
              Continue
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function Done({ approved }: { readonly approved: boolean }) {
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="done-title">
        <p className={styles.eyebrow}>connect git</p>
        <h1 id="done-title" className={styles.title}>
          {approved ? 'Key added. Back to your terminal.' : 'Declined. Nothing was added.'}
        </h1>
        <p className={styles.lede}>
          {approved
            ? 'Setup finishes on its own in a few seconds. You can close this tab.'
            : 'If that was not you, nothing changed; the request is gone.'}
        </p>
        <p className={styles.hint}>
          <Link href="/settings/keys">Your SSH keys</Link>
        </p>
      </section>
    </main>
  );
}
