import { env } from 'cloudflare:workers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import type { RunId } from '@gitstalk/shared-race/ids';
import { TaskId } from '@gitstalk/shared-race/ids';

import type { Answer } from '@gitstalk/shared-ask/ask/answer';
import type { ForgeSource } from '@gitstalk/shared-ask/forge/forge-source';
import { classifierFrom } from '@gitstalk/shared-ask/ask/classifier-from-env';
import { classifyByKeywords } from '@gitstalk/shared-ask/ask/classifier';
import { planAnswer } from '@gitstalk/shared-ask/ask/plan-answer';
import { isForgeError } from '@gitstalk/shared-ask/forge/forge-errors';
import { busiestMoment } from '@gitstalk/shared-ask/home/busiest-moment';
import { composeAnswer } from '@gitstalk/shared-ask/home/composition';
import { isFinished, suggestDecision, suggestions } from '@gitstalk/shared-ask/pick/lead';
import type { Picker } from '@gitstalk/shared-ask/pick/picker';
import { reduceRace } from '@gitstalk/shared-ask/race/reduce-race';
import { ExplorerAnswer, FinishedAnswer, workingOn } from './explorer-answer';
import type { HomeState } from './home-url';
import { readHomeState } from './home-url';
import { HomeWorkspace } from './home-workspace';
import type { RepoKind, RepoTab } from './repo-head';
import { RepoHead, TAB_QUESTIONS, tabOf } from './repo-head';
import { forgeForRun } from '../../src/forge/sources';
import type { Repository } from '../../src/people/repository';
import { isRecordedRun } from '../../src/recorded/recorded-runs';
import type { HomePageData } from '../../src/server/home-page-data';
import { featuredBean } from '../../src/server/featured-bean';
import { pagePicker } from '../../src/server/picker';

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** Where the home is shown: a race's repository, or a persistent one. */
export type HomeFrame = {
  /** The engine instance whose state the page reads (a race's run id, a repository's engine). */
  readonly run: RunId;
  /** `/runs/<run>` or `/<owner>/<repo>`. */
  readonly base: string;
  readonly repository: Repository;
  readonly kind: RepoKind;
  readonly visibility?: 'public' | 'private' | 'internal';
  readonly ownerHref?: string;
  /** A persistent repository its owner archived. */
  readonly archived?: boolean;
};

/**
 * The repository's home: the stalk and the generated explorer (`docs/claude-opus/14` §10),
 * for a race's run (`/runs/:run`) or a persistent repository (`/:owner/:repo`). `data` is the
 * engine's state, read once by the caller.
 */
export async function RepositoryHome(props: {
  readonly frame: HomeFrame;
  readonly data: HomePageData;
  readonly source: ForgeSource;
  readonly searchParams: SearchParams;
}) {
  const { run, base, repository } = props.frame;
  const { data, source } = props;
  const recorded = isRecordedRun(run);
  const url = readHomeState(props.searchParams);
  const picker = pagePicker();
  const visible =
    url.t === null ? data.events : data.events.filter((event) => event.t <= (url.t ?? 0));
  const state = reduceRace(visible, data.options);
  const now = url.t ?? state.endedAt ?? state.clock;
  const finished = isFinished(state, now);
  const subject = props.frame.kind === 'repository' ? 'repository' : 'race';
  const items = suggestions(state, now, subject);
  const [suggest, explorer] = await Promise.all([
    picker.decide(suggestDecision(items, !finished, subject)),
    explorerFor({ run, base, url, picker, data, finished, now, source }),
  ]);
  const ordered = suggest.chosen.flatMap((id) =>
    items.filter((item) => item.id === id).map((item) => item.question),
  );
  return (
    <main>
      <RepoHead
        base={base}
        repository={repository}
        current={currentTab(props.frame.kind, url)}
        kind={props.frame.kind}
        {...(props.frame.visibility === undefined ? {} : { visibility: props.frame.visibility })}
        {...(props.frame.ownerHref === undefined ? {} : { ownerHref: props.frame.ownerHref })}
        archived={props.frame.archived === true}
      />
      <HomeWorkspace
        run={run}
        base={base}
        owner={repository.owner}
        mode={recorded ? 'replay' : 'live'}
        events={data.events}
        options={data.options}
        titles={data.titles}
        files={data.files}
        sessions={data.sessions}
        pushers={data.pushers}
        subject={subject}
        url={url}
        relevant={explorer?.relevant ?? null}
        questions={[
          ...new Set([
            ...ordered,
            ...Object.values(TAB_QUESTIONS),
            "what's on sprout but not on stalk?",
          ]),
        ]}
        suggestReceipt={suggest}
        receipts={[suggest, ...(explorer?.receipts ?? [])]}
        pickerModel={picker.model}
      >
        {explorer?.node}
      </HomeWorkspace>
    </main>
  );
}

type Explorer = {
  readonly node: ReactNode;
  readonly relevant: readonly string[];
  readonly receipts: Answer['picks'];
};

/** The explorer for a question or a bean; null for the defaults (nothing asked). */
async function explorerFor(input: {
  readonly run: RunId;
  readonly base: string;
  readonly url: HomeState;
  readonly picker: Picker;
  readonly data: HomePageData;
  readonly finished: boolean;
  readonly now: number;
  /** The request's source, as of now. */
  readonly source: ForgeSource;
}): Promise<Explorer | null> {
  const { run, url, data } = input;
  if (url.q === '' && url.bean === null) return null;
  if (
    url.bean === null &&
    input.finished &&
    classifyByKeywords(url.q, 'sprout').class === 'in-flight'
  ) {
    return {
      node: (
        <FinishedAnswer
          base={input.base}
          url={url}
          finishedAt={input.now}
          busiest={busiestMoment(data.events)}
        />
      ),
      relevant: [],
      receipts: [],
    };
  }
  const bean = TaskId.safeParse(url.bean).data ?? null;
  const source = url.t === null ? input.source : forgeForRun(env.GATEWAY, run, { asOf: url.t });
  const answer = await planAnswer({
    source,
    run,
    question: url.q,
    classifier: classifierFrom({
      name: env.ASK_CLASSIFIER,
      model: env.ASK_AI_MODEL,
      ai: Reflect.get(env, 'AI'),
    }),
    removed: url.removed,
    ref: null,
    selection: { file: null, bean, view: null },
    picker: input.picker,
  }).catch(notFoundOr);
  const featured = await featuredBean(source, run, answer, bean);
  const base = composeAnswer(answer, bean);
  const composition =
    featured === null ? base : { ...base, components: [...base.components, 'journey' as const] };
  const visible =
    url.t === null ? data.events : data.events.filter((event) => event.t <= (url.t ?? 0));
  const state = reduceRace(visible, data.options);
  const working =
    answer.spec.class === 'in-flight' ? workingOn(state, answer.spec.entities.feature) : [];
  const swarm = working.map((busy) => busy.id);
  const feature = answer.spec.entities.feature?.toLowerCase() ?? '';
  const swarmFiles = working.flatMap((busy) =>
    busy.files.filter((file) => feature === '' || file.toLowerCase().includes(feature)),
  );
  const shown =
    swarmFiles.length === 0
      ? composition
      : { ...composition, files: [...new Set([...composition.files, ...swarmFiles])].toSorted() };
  return {
    node: (
      <ExplorerAnswer
        base={input.base}
        url={url}
        answer={answer}
        composition={shown}
        state={state}
        events={visible}
        now={input.now}
        titles={data.titles}
        sessions={data.sessions}
        pushers={data.pushers}
        featured={featured}
      />
    ),
    relevant: [...composition.relevant, ...swarm],
    receipts: answer.picks,
  };
}

/** A repository's explorer is its Ask tab; a race's follows the question's tab. */
function currentTab(kind: RepoKind, url: HomeState): RepoTab {
  if (kind === 'repository') return 'ask';
  return url.bean === null ? tabOf(url.q) : 'code';
}

export function notFoundOr(error: unknown): never {
  if (isForgeError(error, 'not_found')) notFound();
  throw error;
}
