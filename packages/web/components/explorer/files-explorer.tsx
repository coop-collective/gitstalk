import { env } from 'cloudflare:workers';
import { notFound } from 'next/navigation';

import { TaskId } from '@gitstalk/shared-race/ids';

import { AnswerPanel } from './answer-panel';
import type { Suggestion } from './ask-bar';
import { AskBar } from './ask-bar';
import styles from './explorer.module.css';
import { readExplorerState } from './explorer-url';
import { FileTree } from './file-tree';
import { MainPane } from './main-pane';
import { RailBlocks } from './rail-blocks';
import { RepoHead } from '../home/repo-head';
import type { HomeFrame, SearchParams } from '../home/repository-home';
import { classifierFrom } from '@gitstalk/shared-ask/ask/classifier-from-env';
import { planAnswer } from '@gitstalk/shared-ask/ask/plan-answer';
import type { Pushers } from '@gitstalk/shared-ask/home/sessions';
import { CATALOG } from '@gitstalk/shared-ask/ask/view-spec';
import { isForgeError } from '@gitstalk/shared-ask/forge/forge-errors';
import { forgeForRun } from '../../src/forge/sources';
import { REPOSITORY_SUGGESTIONS } from '../../src/repositories/questions';
import { pushersOf } from '../../src/repositories/pushers';
import { raceMoments } from '../../src/race/race-moments';
import { reduceRace } from '@gitstalk/shared-ask/race/reduce-race';
import { recordedRun } from '../../src/recorded/recorded-runs';

/** The demo questions for the recorded v2 run (`docs/claude-opus/13` §3, `12` beat 3). */
const V2_SUGGESTIONS: readonly Suggestion[] = [
  { q: 'what changed recently on coupons?' },
  { q: 'who changed tax rounding and why?' },
  { q: 'why did the sprout go red?' },
  { q: 'what did we decide about money formatting?' },
  { q: "what's being worked on in billing right now?", at: 600 },
  { q: "what's on sprout but not on stalk?", at: 600 },
  { q: 'what tests cover checkout?' },
  { q: 'show bean t032' },
];

/**
 * The Files explorer of a race's repository or a persistent one: Ask, the tree, the main
 * view and the context rail, read from the engine `frame.run`.
 */
export async function FilesExplorer(props: {
  readonly frame: HomeFrame;
  readonly searchParams: SearchParams;
}) {
  const { run, base, repository } = props.frame;
  const state = readExplorerState(props.searchParams);
  const recorded = recordedRun(run);
  const source = forgeForRun(env.GATEWAY, run, state.at === null ? {} : { asOf: state.at });
  const pushers: Promise<Pushers> =
    props.frame.kind === 'repository' ? pushersOf(env.GATEWAY, run) : Promise.resolve({});
  const answer = await planAnswer({
    source,
    run,
    question: state.q,
    classifier: classifierFrom({
      name: env.ASK_CLASSIFIER,
      model: env.ASK_AI_MODEL,
      ai: Reflect.get(env, 'AI'),
    }),
    removed: state.removed,
    ref: state.ref,
    selection: {
      file: state.file,
      bean: TaskId.safeParse(state.bean).data ?? null,
      view: state.view,
    },
  }).catch((error: unknown) => {
    if (isForgeError(error, 'not_found')) notFound();
    throw error;
  });
  const events = recorded?.events ?? [];
  const race = reduceRace(events);
  const suggestions = suggestionsFor(props.frame, recorded?.label);
  const resolvedPushers = await pushers;
  return (
    <main className={styles.page}>
      {/* A repository's header is its layout's (RepositoryFrame), kept across tabs. */}
      {props.frame.kind === 'repository' ? null : (
        <RepoHead
          base={base}
          repository={repository}
          current="files"
          kind={props.frame.kind}
          {...(props.frame.visibility === undefined ? {} : { visibility: props.frame.visibility })}
          {...(props.frame.ownerHref === undefined ? {} : { ownerHref: props.frame.ownerHref })}
          archived={props.frame.archived === true}
        />
      )}
      <AskBar
        base={base}
        state={state}
        policy={answer.policy}
        moments={recorded === undefined ? null : raceMoments(events)}
        endedAt={race.endedAt}
        suggestions={suggestions}
      />
      <AnswerPanel base={base} state={state} answer={answer} />
      <div className={styles.panes}>
        <nav className={`${styles.pane} ${styles.treePane}`} aria-label="Repository files">
          <div className={styles.paneHead}>
            <span className={styles.paneTitle}>
              {answer.tree.mode === 'filtered' ? 'In this answer' : 'Files'}
            </span>
            <span className={styles.paneSub} title={`${answer.ref.name} at ${answer.ref.sha}`}>
              {answer.tree.files.length} at {answer.ref.name} {answer.ref.sha.slice(0, 7)}
            </span>
          </div>
          <div className={styles.paneBody}>
            <FileTree base={base} state={state} tree={answer.tree} selected={state.file} />
          </div>
        </nav>
        <section className={styles.pane} aria-label="Main view">
          <MainPane
            base={base}
            state={state}
            main={answer.main}
            railBean={answer.rail.find((block) => block.kind === 'checks')?.bean ?? null}
            pushers={resolvedPushers}
          />
        </section>
        <aside className={styles.railPane} aria-label="Context">
          <RailBlocks
            base={base}
            state={state}
            blocks={answer.rail}
            subject={props.frame.kind === 'repository' ? 'repository' : 'race'}
            pushers={resolvedPushers}
          />
        </aside>
      </div>
    </main>
  );
}

/**
 * The Ask's examples: the recorded v2 demo's, a repository's (questions that need no slot,
 * bean id or demo area to make sense), or the catalog's for any other race.
 */
function suggestionsFor(
  frame: HomeFrame,
  recordedLabel: string | undefined,
): readonly Suggestion[] {
  if (recordedLabel === 'Gitstalk v2') return V2_SUGGESTIONS;
  if (frame.kind === 'repository') return REPOSITORY_SUGGESTIONS.map((q) => ({ q }));
  return Object.values(CATALOG).map((entry) => ({ q: entry.example }));
}
