import { IntentLink as Link } from '../../components/shell/intent-link';
import { redirect } from 'next/navigation';

import type { ConsentView as ConsentViewType } from '@gitstalk/shared-identity/agent-sessions';
import { ConsentView } from '@gitstalk/shared-identity/agent-sessions';

import styles from '../../components/account/account.module.css';
import { agentSessionsRpc } from '../../src/auth/services';
import { currentSession } from '../../src/auth/user';

export const metadata = { title: 'Connect an agent' };
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

type PageProps = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

const SCOPE_TEXT: Readonly<Record<string, string>> = {
  read: 'Read repositories, runs and workflow logs, and see secret names (never values)',
  collaborate: 'Post on beans, answer requests and read its inbox',
  write:
    'Push code to its own beans (never the stalk, never settings); where you maintain, run, re-run and cancel workflows',
  secrets:
    'Where you maintain: set and delete Actions secrets and variables, such as deploy tokens',
};

/** Scopes the person must tick themselves, whatever the agent asked for. */
const OPT_IN: ReadonlySet<string> = new Set(['secrets']);

/**
 * The OAuth consent screen. An agent (Claude Code, Codex…) started at the MCP Worker's
 * /authorize, which validated the request and sent the browser here; the signed-in person
 * approves the client and its scopes, or declines.
 */
export default async function ConnectPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const id = typeof query['request'] === 'string' ? query['request'] : '';
  const session = await currentSession();
  if (session === null && id !== '')
    redirect(`/login?next=${encodeURIComponent(`/connect?request=${id}`)}`);
  const view = session === null || id === '' ? null : await describe(id, session.user);
  if (session === null || view === null) return <Expired />;
  const hidden = { request: id, csrf: session.csrfToken };
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="connect-title">
        <p className={styles.eyebrow}>connect an agent</p>
        <h1 id="connect-title" className={styles.title}>
          Allow {view.clientName} to use your account?
        </h1>
        <div className={styles.client}>
          <span className={styles.clientMark} aria-hidden="true">
            {view.clientName.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <p className={styles.clientName}>{view.clientName}</p>
            <p className={styles.note}>
              {view.clientDomain === null
                ? 'This app registered itself, so its name is not verified.'
                : `Published by ${view.clientDomain}.`}
            </p>
            <dl className={styles.facts}>
              <dt>Sends access to</dt>
              <dd>{view.redirectHost}</dd>
              <dt>Acts as</dt>
              <dd>@{session.user.handle}</dd>
            </dl>
          </div>
        </div>
        {view.redirectIsLoopback ? (
          <p className={styles.warning}>
            This sends access to an app on your computer. Continue only if you just started
            connecting from it.
          </p>
        ) : null}
        <form method="post" action="/connect/decide" className={styles.form}>
          <input type="hidden" name="request" value={hidden.request} />
          <input type="hidden" name="csrf" value={hidden.csrf} />
          <fieldset className={styles.scopes}>
            <legend className={styles.label}>It may</legend>
            {view.grantableScopes.map((scope) => (
              <ScopeOption key={scope} scope={scope} view={view} />
            ))}
          </fieldset>
          <p className={styles.hint}>
            Disconnect it any time in Settings. Landing on the stalk is never an agent’s to do.
          </p>
          <div className={styles.actions}>
            <button type="submit" name="decision" value="deny" className={styles.secondary}>
              Deny
            </button>
            <button type="submit" name="decision" value="approve" className={styles.primary}>
              Allow
            </button>
          </div>
        </form>
        <p className={styles.signedInAs}>
          Signed in as @{session.user.handle}. Not you? <Link href="/login">Switch account</Link>
        </p>
      </section>
    </main>
  );
}

function ScopeOption({ scope, view }: { readonly scope: string; readonly view: ConsentViewType }) {
  const required = scope === 'read';
  const isOptIn = OPT_IN.has(scope);
  const isRequested = view.requestedScopes.some((requested) => requested === scope);
  return (
    <label className={styles.scope}>
      <input
        type="checkbox"
        name="scope"
        value={scope}
        defaultChecked={required || (isRequested && !isOptIn)}
        disabled={required}
      />
      <span className={styles.scopeName}>{scope}</span>
      <span className={styles.scopeDetail}>
        {SCOPE_TEXT[scope] ?? scope}
        {required ? ' (always)' : ''}
        {isOptIn ? (
          <span className={styles.scopeWarning}>
            {' '}
            Only if you will hand this agent secret values: each one passes through the agent and
            its model provider. You can always add secrets yourself in a repository’s Settings
            instead.
          </span>
        ) : null}
      </span>
      {required ? <input type="hidden" name="scope" value="read" /> : null}
    </label>
  );
}

async function describe(
  id: string,
  user: { readonly id: string; readonly handle: string },
): Promise<ConsentViewType | null> {
  const answer = ConsentView.nullable().safeParse(
    await agentSessionsRpc().consentRequest(id, { id: user.id, handle: user.handle }),
  );
  return answer.success ? answer.data : null;
}

function Expired() {
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="expired-title">
        <h1 id="expired-title" className={styles.title}>
          This connection request is gone
        </h1>
        <p className={styles.lede}>
          It expired, was already answered, or was opened by another account. Start connecting again
          from your agent (for Claude Code: <code>/mcp</code>, then authenticate Gitstalk).
        </p>
      </section>
    </main>
  );
}
