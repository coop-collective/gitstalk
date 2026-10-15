/**
 * The Code tab's default side pane: the beanstalk (beans growing at the tip, landings down the
 * line), as on the Ask view, read from the engine at request time. Streams in behind the stalk
 * last drawn (`CodeStalkFallback`), so neither the open folder or file nor a move between them
 * waits for it. Server-only.
 */
import { Suspense } from 'react';

import { stalkRows } from '@gitstalk/shared-ask/home/stalk';
import { reduceRace } from '@gitstalk/shared-ask/race/reduce-race';

import type { RepoScope } from '../../src/changes/change-feed';
import { askData } from '../../src/server/ask-page';
import type { RepositoryTab } from '../../src/server/repository-tab';
import { CodeStalkFallback, CodeStalkFrame, CodeStalkRows } from './code-stalk-rows';

export function CodeStalk(props: { readonly tab: RepositoryTab; readonly scope: RepoScope }) {
  return (
    <Suspense fallback={<CodeStalkFallback scope={props.scope} />}>
      <StalkOfEngine tab={props.tab} scope={props.scope} />
    </Suspense>
  );
}

async function StalkOfEngine(props: { readonly tab: RepositoryTab; readonly scope: RepoScope }) {
  const { record } = props.tab;
  const ask = await askData(record);
  if (ask === null) return <CodeStalkFrame note="Nothing on the stalk yet." />;
  const { events, options, titles, pushers } = ask.data;
  const state = reduceRace(events, options);
  const now = state.endedAt ?? state.clock;
  const rows = stalkRows({ state, events, now, titles });
  const landed = state.line.commits.length;
  const growing = rows.filter((row) => row.kind === 'bean').length;
  const view = {
    note: `${landed} landed, ${growing} growing`,
    rows,
    owner: record.owner.handle,
    pushers,
  };
  return <CodeStalkRows scope={props.scope} view={view} />;
}
