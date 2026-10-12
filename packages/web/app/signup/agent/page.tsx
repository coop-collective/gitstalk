import { env } from 'cloudflare:workers';
import { IntentLink as Link } from '../../../components/shell/intent-link';

import styles from '../../../components/account/account.module.css';
import { CopyButton } from '../../../components/repository/copy-button';
import { currentUser } from '../../../src/auth/user';
import { agentInstalls } from '../../../src/setup/agent-installs';
import { publicPageMetadata } from '../../../src/site/page-metadata';

export const metadata = publicPageMetadata({
  path: '/signup/agent',
  title: 'Connect an agent',
  description:
    'Sign up through your coding agent: one line for Claude Code, Codex, Cursor, Gemini CLI or any MCP client adds Gitstalk to your agent and opens your browser to sign in with a passkey or an email code, pick a handle if you are new, and approve the session.',
});
/** The heading depends on who is signed in. */
export const dynamic = 'force-dynamic';

/**
 * Sign up through your agent (`docs/claude-opus/16` §2.2, item 1.4): one command per harness
 * that installs the plugin (or adds the MCP server) and runs the client's own OAuth sign-in,
 * which opens `/connect`; signed out, that page sends you through sign-in (a passkey or an email
 * code; a new address picks a handle) first. Signed in, the same page connects another agent.
 */
export default async function AgentSignupPage() {
  const user = await currentUser();
  const installs = agentInstalls(env.MCP_URL);
  return (
    <main className={styles.page}>
      <section className={`${styles.panel} ${styles.wide}`} aria-labelledby="agent-title">
        <p className={styles.eyebrow}>
          {user === null ? 'sign up --as agent' : `@${user.handle} · connect an agent`}
        </p>
        <h1 id="agent-title" className={styles.title}>
          {user === null ? 'Paste one line into your agent' : 'Connect another agent'}
        </h1>
        <p className={styles.lede}>
          {user === null
            ? 'That is the whole sign-up: the command adds Gitstalk to your agent and opens your browser, where you sign in with a passkey or an email code (new here: pick a handle) and approve the session.'
            : 'The command adds Gitstalk to your agent and opens your browser; approve the session and it shows up on Home within seconds.'}
        </p>
        {user === null ? (
          <p className={styles.hint}>
            No agent handy? <Link href="/signup">Create an account in the browser</Link>.
          </p>
        ) : null}
        <ul className={styles.installs}>
          {installs.map((install) => (
            <li key={install.id} className={styles.install}>
              <div className={styles.installHead}>
                <h2 className={styles.sectionTitle}>{install.name}</h2>
                <span className={styles.hint}>{install.where}</span>
              </div>
              <div className={styles.installCode}>
                <code>{install.code}</code>
                <CopyButton text={install.code} label={`Copy the ${install.name} command`} />
              </div>
              <p className={styles.hint}>
                {install.after}
                {install.verified ? null : ' (Follows the client’s documented MCP sign-in.)'}
              </p>
            </li>
          ))}
        </ul>
        <p className={styles.note}>
          {user === null ? (
            <>
              Rather use the browser? <Link href="/signup">Create an account</Link> and connect an
              agent afterwards.
            </>
          ) : (
            <>
              Connected agents are listed on <Link href="/">Home</Link> and in{' '}
              <Link href="/settings">Settings</Link>, where you can disconnect them.
            </>
          )}
        </p>
      </section>
    </main>
  );
}
