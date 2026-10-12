'use client';

import { useParams } from 'next/navigation';

import { RepoHead } from '../home/repo-head';
import styles from './repo-tabs.module.css';

/**
 * What a repository route shows while its tab loads: the header and tab bar at once, as plain
 * text (no tab is marked, none is known yet, and no link is drawn: during a client navigation
 * `useParams` is empty here, so an address built from it would be `//` or `///changes`), and
 * grey blocks where the content goes, in the Code tab's layout: a toolbar, the main pane and a
 * side column.
 */
export function RepositorySkeleton() {
  const params = useParams<{ owner?: string; repo?: string }>();
  return (
    <main aria-busy="true" aria-label="Loading repository">
      <RepoHead
        base=""
        repository={{
          owner: decodeURIComponent(params.owner ?? ''),
          name: decodeURIComponent(params.repo ?? ''),
        }}
        current={null}
        kind="repository"
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
