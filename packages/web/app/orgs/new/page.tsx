import { env } from 'cloudflare:workers';
import { notFound } from 'next/navigation';

import { NewOrgForm } from '../../../components/orgs/org-forms';
import styles from '../../../components/repository/repository.module.css';
import { currentSession } from '../../../src/auth/user';
import { signedInUser } from '../../../src/server/signed-in';
import { webHost } from '../../../src/site/web-host';

export const metadata = { title: 'New organization' };

/** New organization: a handle, a name, a description. The creator becomes its owner. */
export default async function NewOrgPage() {
  await signedInUser('/orgs/new');
  const session = await currentSession();
  if (session === null) notFound();
  return (
    <main className={`${styles.page} ${styles.narrow}`}>
      <h1 className={styles.lead}>New organization</h1>
      <p className={styles.sub}>
        An organization owns repositories together. Its members get a role, and its owners decide
        what members may do with every repository.
      </p>
      <NewOrgForm csrf={session.csrfToken} host={webHost(env.WEB_URL)} />
    </main>
  );
}
