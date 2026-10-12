/**
 * A bean's diff on its page, streamed: the page's first byte does not wait for it (two engine
 * reads in a row, the bean's detail then the diff). Until it is read, `BeanDiffPending` holds
 * its place; then the diff is handed to the browser's query cache (`qk.repo(...).bean(name)`)
 * and `BeanDiff` follows it from there. Server-only.
 */
import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { Suspense } from 'react';

import type { RepoScope } from '../../src/changes/change-feed';
import { qk } from '../../src/query/keys';
import { makeQueryClient } from '../../src/query/make-query-client';
import type { EngineReads } from '../../src/repo-pages/engine-reads';
import { BeanDiff } from './bean-diff';
import styles from './repo-tabs.module.css';

export function StreamedBeanDiff(props: {
  readonly reads: EngineReads;
  readonly scope: RepoScope;
  readonly bean: string;
}) {
  return (
    <Suspense fallback={<BeanDiffPending />}>
      <SeededBeanDiff {...props} />
    </Suspense>
  );
}

async function SeededBeanDiff(props: {
  readonly reads: EngineReads;
  readonly scope: RepoScope;
  readonly bean: string;
}) {
  const { reads, scope, bean } = props;
  // A bean with no diff yet, or a diff the engine cannot produce, shows "No diff to show yet".
  const diff = await reads.beanDiff(bean).catch(() => null);
  // Its own client: the page's (events, pushed beans) was dehydrated with the shell already.
  const queryClient = makeQueryClient();
  queryClient.setQueryData(qk.repo(scope.uid, scope.owner, scope.repo).bean(bean), diff);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <BeanDiff scope={scope} engine={reads.engine} bean={bean} />
    </HydrationBoundary>
  );
}

/** The diff's heading and a grey block where its files go, while it is read. */
function BeanDiffPending() {
  return (
    <section className={styles.section} aria-label="Diff" aria-busy="true">
      <h3>Changes in this bean</h3>
      <span className={`${styles.skelBlock} ${styles.skelSide}`} />
    </section>
  );
}
