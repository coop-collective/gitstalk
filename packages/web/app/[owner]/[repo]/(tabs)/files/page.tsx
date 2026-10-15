import { env } from 'cloudflare:workers';
import { IntentLink as Link } from '../../../../../components/shell/intent-link';

import { RunId } from '@gitstalk/shared-race/ids';

import { FilesExplorer } from '../../../../../components/explorer/files-explorer';
import type { SearchParams } from '../../../../../components/home/repository-home';
import styles from '../../../../../components/repository/repository.module.css';
import { forgeForRun } from '../../../../../src/forge/sources';
import { hasGrown } from '../../../../../src/repositories/flows';
import { registryClient } from '../../../../../src/repositories/registry-client';
import { homePageData } from '../../../../../src/server/home-page-data';
import type { RepositoryParams } from '../../../../../src/server/repository-page';
import { repositoryPage } from '../../../../../src/server/repository-page';

type PageProps = {
  readonly params: RepositoryParams;
  readonly searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `Files, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

/** A repository's files: the explorer once the engine has grown something, the stalk's list before. */
export default async function RepositoryFilesPage({ params, searchParams }: PageProps) {
  const page = await repositoryPage(params);
  const { record, base } = page;
  const frame = {
    base,
    repository: { owner: record.owner.handle, name: record.name },
    kind: 'repository' as const,
    visibility: record.visibility,
    ownerHref: `/${record.owner.handle}`,
    archived: record.archived_at !== null,
  };
  const engine = RunId.safeParse(record.engine_id);
  if (engine.success) {
    const data = await homePageData(forgeForRun(env.GATEWAY, engine.data), engine.data).catch(
      () => null,
    );
    if (data !== null && hasGrown(data.events))
      return (
        <FilesExplorer frame={{ ...frame, run: engine.data }} searchParams={await searchParams} />
      );
  }
  const files = await registryClient(env.GATEWAY).files(record.id, page.user?.id ?? null);
  return (
    <main>
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="stalk-files">
          <div className={styles.panelHead}>
            <h2 id="stalk-files">Files on the stalk</h2>
            <span className={`${styles.muted} ${styles.mono}`}>
              {files.ok && files.value.sha !== null ? files.value.sha.slice(0, 7) : ''}
            </span>
          </div>
          {files.ok && files.value.files.length > 0 ? (
            <ul className={styles.fileList}>
              {files.value.files.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>Nothing to list yet.</p>
          )}
          <p className={styles.empty}>
            Ask and the explorer open here once the first bean starts.{' '}
            <Link href={base}>How to start</Link>
          </p>
        </section>
      </div>
    </main>
  );
}
