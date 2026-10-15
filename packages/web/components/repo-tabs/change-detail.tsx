/**
 * One bean's page: the repository shell rendered here, the bean itself (`ChangeView`: its
 * journey, its diff, the engine's last word to the pusher) following the engine's feed in the
 * browser from what the server read. The diff comes in as a slot the server streams.
 */
import type { ReactNode } from 'react';

import type { ApproveAccess } from '../../src/changes/approval-client';
import type { RepoScope } from '../../src/changes/change-feed';
import type { Change } from '../../src/changes/changes';
import { isSettledState } from '../../src/changes/changes';
import { codeHref } from '../../src/code/tree';
import type { RepositoryTab } from '../../src/server/repository-tab';
import { ChangeView } from './change-view';
import { RepositoryShell } from './repository-shell';

export function ChangeDetail(props: {
  readonly tab: RepositoryTab;
  readonly scope: RepoScope;
  /** The bean as the server derived it, when it rendered. */
  readonly change: Change;
  /** Open beans when the page rendered, for the tab's count. */
  readonly openChanges: number;
  /** The bean's diff (`StreamedBeanDiff`), in its place under the journey. */
  readonly diff: ReactNode;
  /** Whether the viewer may approve the bean if the approval rules hold it. */
  readonly approveAccess: ApproveAccess;
  readonly nowMs: number;
}) {
  const { tab, change } = props;
  return (
    <RepositoryShell page={tab} tab="changes" openChanges={props.openChanges}>
      <ChangeView
        scope={props.scope}
        diff={props.diff}
        bean={change.bean}
        filesHref={codeHref(tab.base, 'tree', '', { kind: 'bean', name: change.bean })}
        settled={isSettledState(change.state)}
        approveAccess={props.approveAccess}
        nowMs={props.nowMs}
      />
    </RepositoryShell>
  );
}
