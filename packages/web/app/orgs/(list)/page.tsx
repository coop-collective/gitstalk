import { env } from 'cloudflare:workers';
import { IntentLink as Link } from '../../../components/shell/intent-link';

import { orgsOf } from '@gitstalk/shared-identity/orgs';

import { OrgMark } from '../../../components/orgs/org-mark';
import orgStyles from '../../../components/orgs/orgs.module.css';
import styles from '../../../components/repository/repository.module.css';
import { signedInUser } from '../../../src/server/signed-in';

export const metadata = { title: 'Your organizations' };
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

/** The organizations the signed-in person belongs to, with their role and Settings. */
export default async function YourOrgsPage() {
  const user = await signedInUser('/orgs');
  const memberships = await orgsOf(env, user.id);
  return (
    <main className={`${styles.page} ${styles.narrow}`}>
      <div className={styles.panelHead}>
        <h1 className={styles.lead}>Your organizations</h1>
        <Link href="/orgs/new" className={styles.secondary}>
          New organization
        </Link>
      </div>
      <section className={styles.panel} aria-label="Organizations">
        {memberships.length === 0 ? (
          <p className={styles.empty}>
            You belong to no organization yet. Create one, or accept an invitation on Home.
          </p>
        ) : (
          <ul className={orgStyles.orgList}>
            {memberships.map(({ org, role }) => (
              <li key={org.id}>
                <OrgMark handle={org.handle} iconKey={org.iconKey} size={26} />
                <Link href={`/${org.handle}`}>{org.name}</Link>
                <span className={styles.muted}>{org.handle}</span>
                <span className={styles.pill}>{role}</span>
                <Link href={`/orgs/${org.handle}/settings`} className={styles.muted}>
                  Settings
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
