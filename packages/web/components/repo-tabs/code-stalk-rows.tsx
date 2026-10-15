'use client';

/**
 * The Code tab's stalk pane on the client: its frame, its rows (each bean linking to its page
 * in Changes), and what it shows while a page's own stalk streams in. Every page of the tab
 * draws the pane anew, so the rows last drawn are kept in the query cache and the next page
 * shows them at once instead of an empty pane.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

import type { Pushers } from '@gitstalk/shared-ask/home/sessions';
import type { StalkRow } from '@gitstalk/shared-ask/home/stalk';
import type { RepoScope } from '../../src/changes/change-feed';
import { qk } from '../../src/query/keys';
import homeStyles from '../home/home.module.css';
import { StalkList } from '../home/stalk-list';

/** One drawing of the stalk: its rows and the line above them. */
export type StalkView = {
  readonly note: string;
  readonly rows: readonly StalkRow[];
  readonly owner: string;
  readonly pushers: Pushers;
};

export function CodeStalkRows(props: { readonly scope: RepoScope; readonly view: StalkView }) {
  const queryClient = useQueryClient();
  const { scope, view } = props;
  useEffect(() => {
    queryClient.setQueryData(stalkKey(scope), view);
  }, [queryClient, scope, view]);
  return <StalkPane base={scope.base} view={view} />;
}

/** While a page's stalk streams in: the one last drawn, or the frame alone on a first visit. */
export function CodeStalkFallback(props: { readonly scope: RepoScope }) {
  const queryClient = useQueryClient();
  const view = queryClient.getQueryData<StalkView>(stalkKey(props.scope));
  if (view === undefined) return <CodeStalkFrame note="Reading…" />;
  return <StalkPane base={props.scope.base} view={view} />;
}

/** The pane's head and scrolling body. */
export function CodeStalkFrame(props: { readonly note: string; readonly children?: ReactNode }) {
  return (
    <div className={homeStyles.stalkPane}>
      <div className={homeStyles.stalkhead}>
        <b>The beanstalk</b>
        <span>{props.note}</span>
      </div>
      <div className={homeStyles.stalkscroll}>{props.children}</div>
    </div>
  );
}

function StalkPane(props: { readonly base: string; readonly view: StalkView }) {
  const { view } = props;
  return (
    <CodeStalkFrame note={view.note}>
      <StalkList
        rows={view.rows}
        owner={view.owner}
        pushers={view.pushers}
        relevant={null}
        selected={null}
        hrefFor={(bean) => `${props.base}/changes/${encodeURIComponent(bean)}`}
      />
    </CodeStalkFrame>
  );
}

function stalkKey(scope: RepoScope) {
  return qk.repo(scope.uid, scope.owner, scope.repo).stalk();
}
