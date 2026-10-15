/**
 * A repository tab's page under the header the repository layout keeps mounted
 * (`RepositoryFrame`): the tab's own content, and its count of open beans for the header's
 * Changes tab.
 */
import type { ReactNode } from 'react';

import type { RepoTab } from '../home/repo-head';
import { OpenChangesCount } from './repository-frame';
import styles from './repo-tabs.module.css';

export function RepositoryShell(props: {
  readonly tab: RepoTab;
  /** Beans in check, red or waiting, counted on the Changes tab. */
  readonly openChanges: number;
  /** Use the width of the window (the Code tab's two panes), not the reading column. */
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <main data-tab={props.tab}>
      <OpenChangesCount count={props.openChanges} />
      <div className={styles.page} data-wide={props.wide === true ? '' : undefined}>
        {props.children}
      </div>
    </main>
  );
}
