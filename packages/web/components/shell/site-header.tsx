import { env } from 'cloudflare:workers';

import { Avatar } from '../account/avatar';

import { currentSession } from '../../src/auth/user';
import { configuredPlatformAdmins } from '../../src/admin/admin-gate';
import { isPlatformAdmin } from '../../src/admin/platform-admins';
import { viewerTheme } from '../../src/server/viewer';
import { NEW_MENU, primaryLinks, userMenu } from '../../src/shell/header-entries';
import { IntentLink as Link } from './intent-link';
import { HeaderMenu } from './header-menu';
import styles from './header.module.css';
import { ThemeToggle } from './theme-toggle';
import { VineMark } from './vine-mark';

/**
 * The app header on every page. Left: the mark (Home) and the primary links. Right, signed in:
 * the New menu and the person's menu (profile, repositories, organizations, settings, the admin
 * area for platform admins, connect an agent, docs, day or night, sign out). Signed out: the theme pair, Sign in and Sign up.
 */
export async function SiteHeader() {
  // The header's name and picture come with the session (one D1 read for both).
  const [resolvedTheme, session] = await Promise.all([viewerTheme(), currentSession()]);
  const user = session?.user ?? null;
  const links = primaryLinks(user?.handle ?? null);
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="gitstalk home">
        <VineMark />
        <span className={styles.wordmark}>gitstalk</span>
      </Link>
      {links.length === 0 ? null : (
        <nav aria-label="Primary" className={styles.nav}>
          <ul className={styles.navList}>
            {links.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={styles.navLink}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div className={styles.tools}>
        {session === null || user === null ? (
          <>
            <ThemeToggle initial={resolvedTheme} />
            <Link href="/login" className={styles.signIn}>
              Sign in
            </Link>
            <Link href="/signup" className={styles.signUp}>
              Sign up
            </Link>
          </>
        ) : (
          <>
            <HeaderMenu
              label="Create new"
              variant="accent"
              button={
                <>
                  <span aria-hidden="true" className={styles.plus}>
                    +
                  </span>
                  <span className={styles.newText}>New</span>
                  <span aria-hidden="true" className={styles.caret} />
                </>
              }
              entries={NEW_MENU}
            />
            <HeaderMenu
              label={`Account menu for @${user.handle}`}
              button={
                <>
                  <Avatar
                    seed={user.id}
                    label={
                      session.profile.displayName === '' ? user.handle : session.profile.displayName
                    }
                    imageKey={session.profile.avatarKey}
                    size={26}
                  />
                  <span aria-hidden="true" className={styles.caret} />
                </>
              }
              entries={userMenu({
                handle: user.handle,
                csrf: session.csrfToken,
                theme: resolvedTheme,
                docsUrl: env.DOCS_URL,
                isPlatformAdmin: isPlatformAdmin(user, configuredPlatformAdmins()),
              })}
            />
          </>
        )}
      </div>
    </header>
  );
}
