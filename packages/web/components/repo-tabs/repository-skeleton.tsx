'use client';

import { useParams } from 'next/navigation';

import { RepoHead } from '../home/repo-head';
import styles from './repo-tabs.module.css';

/**
 * What a repository route shows while its tab loads: the real header and tab bar at once (no
 * tab is marked, none is known yet) and grey blocks where the content goes, in the Code tab's
 * layout: a toolbar, the main pane and a side column.
 */
export function RepositorySkeleton() {
  const params = useParams<{ owner?: string; repo?: string }>();
  const owner = params.owner ?? '';
  const name = params.repo ?? '';
  return (
    <main aria-busy="true" aria-label="Loading repository">
      <RepoHead
        base={`/${owner}/${name}`}
        repository={{ owner: decodeURIComponent(owner), name: decodeURIComponent(name) }}
        current={null}
        kind="repository"
        ownerHref={`/${owner}`}
      />
      <div className={styles.page}>
        <div className={styles.split}>
          <div className={styles.skeleton}>
            <span className={`${styles.skelBlock} ${styles.skelToolbar}`} />
            <span className={`${styles.skelBlock} ${styles.skelPanel}`} />
          </div>
          <div className={styles.skeleton}>
            <span className={`${styles.skelBlock} ${styles.skelSide}`} />
            <span className={styles.skelBar} />
            <span className={styles.skelBar} />
          </div>
        </div>
      </div>
    </main>
  );
}
