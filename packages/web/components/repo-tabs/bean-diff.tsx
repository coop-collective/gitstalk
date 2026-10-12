'use client';

/**
 * A bean's own change on its page: its landing, or its newest head against its base. The
 * server prefetches it under `qk.repo(...).bean(name)`; a new push or the landing invalidates
 * that key (`ChangeView`) and it is read again through the engine's diff route.
 */
import { useQuery } from '@tanstack/react-query';

import type { RepoDiff } from '@gitstalk/shared-ask/repo/repo-types';
import { DiffView } from '../explorer/diff-view';
import type { RepoScope } from '../../src/changes/change-feed';
import { beanDiffPath, isRepoDiff } from '../../src/changes/change-feed';
import { fetchJson, isHttpStatus } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import styles from './repo-tabs.module.css';

export function BeanDiff(props: {
  readonly scope: RepoScope;
  readonly engine: string;
  readonly bean: string;
}) {
  const { scope, engine, bean } = props;
  const diff = useQuery({
    queryKey: qk.repo(scope.uid, scope.owner, scope.repo).bean(bean),
    queryFn: ({ signal }) => readBeanDiff(beanDiffPath(engine, bean), signal),
  });
  const files = diff.data?.files ?? [];
  return (
    <section className={styles.section} aria-label="Diff">
      <h3>Changes in this bean</h3>
      {files.length === 0 ? (
        <div className={styles.box}>
          <p className={styles.empty}>No diff to show yet.</p>
        </div>
      ) : (
        <DiffView files={files} />
      )}
    </section>
  );
}

/** The diff, or null while the bean has none (the route's 404). */
async function readBeanDiff(path: string, signal: AbortSignal): Promise<RepoDiff | null> {
  try {
    return await fetchJson(path, isRepoDiff, { signal });
  } catch (error: unknown) {
    if (isHttpStatus(error, 404)) return null;
    throw error;
  }
}
