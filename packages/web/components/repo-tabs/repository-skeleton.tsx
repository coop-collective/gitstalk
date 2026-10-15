/**
 * What a repository route shows while its tab loads, under the header the repository layout
 * keeps mounted (`RepositoryFrame`): grey blocks where the content goes, in the Code tab's
 * layout: a toolbar, the main pane and a side column.
 */
import styles from './repo-tabs.module.css';

export function RepositorySkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading repository">
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
