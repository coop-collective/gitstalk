/**
 * A person's repository around its tab: the name once (owner / name and its visibility), the
 * tabs, then the tab's own page.
 */
import type { ReactNode } from 'react';

import type { RepoTab } from '../home/repo-head';
import { RepoHead } from '../home/repo-head';
import type { RepositoryPage } from '../../src/server/repository-page';
import styles from './repo-tabs.module.css';

export function RepositoryShell(props: {
  readonly page: RepositoryPage;
  readonly tab: RepoTab;
  /** Beans in check, red or waiting, counted on the Changes tab. */
  readonly openChanges: number;
  /** Use the width of the window (the Code tab's two panes), not the reading column. */
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  const { record, base, role } = props.page;
  return (
    <main>
      <RepoHead
        base={base}
        repository={{ owner: record.owner.handle, name: record.name }}
        current={props.tab}
        kind="repository"
        visibility={record.visibility}
        ownerHref={`/${record.owner.handle}`}
        openChanges={props.openChanges}
        canAdminister={role !== null}
        archived={record.archived_at !== null}
      />
      <div className={styles.page} data-wide={props.wide === true ? '' : undefined}>
        {props.children}
      </div>
    </main>
  );
}
