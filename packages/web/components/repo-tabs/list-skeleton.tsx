import page from '../repository/repository.module.css';
import styles from './repo-tabs.module.css';

/**
 * A person's, an org's or the organizations list's loading state: a title bar and rows of
 * repositories, in the narrow page width those pages use.
 */
export function ListSkeleton(props: { readonly heading: string }) {
  return (
    <main className={`${page.page} ${page.narrow}`} aria-busy="true" aria-label={props.heading}>
      <div className={styles.skeleton}>
        <span className={`${styles.skelBar} ${styles.skelTitle}`} />
        {[0, 1, 2, 3].map((row) => (
          <span key={row} className={styles.skelBlock} />
        ))}
      </div>
    </main>
  );
}
