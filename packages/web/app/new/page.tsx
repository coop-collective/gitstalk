import { env } from 'cloudflare:workers';

import { NewRepositoryForm } from '../../components/repository/new-repository-form';
import styles from '../../components/repository/repository.module.css';
import { creatableNamespaces } from '../../src/orgs/org-page';
import { signedInUser } from '../../src/server/signed-in';
import { webHost } from '../../src/site/web-host';

export const metadata = { title: 'New repository' };

type PageProps = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

/** New repository: owner, name, description, visibility, and how it starts. */
export default async function NewRepositoryPage({ searchParams }: PageProps) {
  const user = await signedInUser('/new');
  const [owners, query] = await Promise.all([creatableNamespaces(user), searchParams]);
  const asked = query['owner'];
  return (
    <main className={`${styles.page} ${styles.narrow}`}>
      <h1 className={styles.lead}>New repository</h1>
      <p className={styles.sub}>
        A repository holds the stalk, the line every bean lands on. Agents and people push beans to
        it; you decide what it means.
      </p>
      <NewRepositoryForm
        owners={owners}
        host={webHost(env.WEB_URL)}
        initialOwner={typeof asked === 'string' ? asked : user.handle}
      />
    </main>
  );
}
