'use client';

/**
 * A bean's own change on its page: its landing, or its newest head against its base. The
 * server prefetches it under `qk.repo(...).bean(name)`; a new push or the landing invalidates
 * that key (`ChangeView`) and it is read again through the engine's diff route.
 *
 * Once the bean has landed its diff is the landing's commit pair, so the query is immutable
 * (never refetched on focus; persisted for a public repository). A later landing after a
 * requeue still invalidates it through the feed. Until then it is mutable (30 s).
 */
import { useQuery } from '@tanstack/react-query';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RepoDiff } from '@gitstalk/shared-ask/repo/repo-types';
import { DiffView } from '../explorer/diff-view';
import type { RepoScope } from '../../src/changes/change-feed';
import { beanDiffPath, isRepoDiff } from '../../src/changes/change-feed';
import { fetchJson, isHttpStatus } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import { freshness } from '../../src/query/policy';
import styles from './repo-tabs.module.css';

export function BeanDiff(props: {
  readonly scope: RepoScope;
  readonly engine: string;
  readonly bean: string;
}) {
  const { scope, engine, bean } = props;
  const keys = qk.repo(scope.uid, scope.owner, scope.repo);
  // Whether it landed, from the events the page's feed keeps (no fetch of its own).
  const { data: landed = false } = useQuery<readonly RaceEvent[], Error, boolean>({
    queryKey: keys.events(),
    enabled: false,
    select: (events) => hasLanded(events, bean),
  });
  const diff = useQuery({
    queryKey: keys.bean(bean),
    queryFn: ({ signal }) => readBeanDiff(beanDiffPath(engine, bean), signal),
    ...freshness(landed ? 'immutable' : 'mutable', { visibility: scope.visibility }),
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

/** Whether the events hold the bean's landing. */
function hasLanded(events: readonly RaceEvent[], bean: string): boolean {
  return events.some((event) => event.type === 'land' && event.task === bean);
}

/** The diff, or null while the bean has none (the route's 404). */
async function readBeanDiff(path: string, signal: AbortSignal): Promise<RepoDiff | null> {
  try {
    return await fetchJson(path, isRepoDiff, { signal, httpCache: 'revalidate' });
  } catch (error: unknown) {
    if (isHttpStatus(error, 404)) return null;
    throw error;
  }
}
