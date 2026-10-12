import { env } from 'cloudflare:workers';

import { RepoHead } from '../../../../../components/home/repo-head';
import { PeoplePanels } from '../../../../../components/repository/people';
import styles from '../../../../../components/repository/repository.module.css';
import { currentSession } from '../../../../../src/auth/user';
import { collaboratorsClient } from '../../../../../src/repositories/collaborators-client';
import type { RepositoryParams } from '../../../../../src/server/repository-page';
import { repositoryPage } from '../../../../../src/server/repository-page';

type PageProps = { readonly params: RepositoryParams };

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `People, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

/** Who has access, and which sessions and tokens acted for whom. Members only see the list. */
export default async function RepositoryPeoplePage({ params }: PageProps) {
  const page = await repositoryPage(params);
  const { record, base, role, user } = page;
  const [people, session] = await Promise.all([
    role === null
      ? Promise.resolve(null)
      : collaboratorsClient(env.GATEWAY).people(record.id, user?.id ?? null),
    role === null || role === 'owner' ? Promise.resolve(null) : currentSession(),
  ]);
  const fullName = `${record.owner.handle}/${record.name}`;
  const canManage = role === 'owner' || role === 'maintain';
  return (
    <main>
      <RepoHead
        base={base}
        repository={{ owner: record.owner.handle, name: record.name }}
        current="people"
        kind="repository"
        visibility={record.visibility}
        ownerHref={`/${record.owner.handle}`}
        archived={record.archived_at !== null}
        canAdminister={role !== null}
      />
      <div className={`${styles.page} ${styles.narrow}`}>
        <div className={styles.settings}>
          <PeoplePanels
            fullName={fullName}
            ownerHandle={record.owner.handle}
            people={people?.ok === true ? people.value : null}
            settingsHref={canManage ? `${base}/settings/collaborators` : null}
            leave={
              session === null
                ? null
                : {
                    userId: session.user.id,
                    csrf: session.csrfToken,
                    repoId: record.id,
                    path: `${base}/people`,
                  }
            }
            nowMs={Date.now()}
          />
        </div>
      </div>
    </main>
  );
}
