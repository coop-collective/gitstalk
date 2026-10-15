import { IntentLink as Link } from '../shell/intent-link';

import type { Answer, RailBlock } from '@gitstalk/shared-ask/ask/answer';
import type { BeanDetail, DecisionRecord } from '@gitstalk/shared-ask/forge/forge-source';
import type { ComponentId, Composition } from '@gitstalk/shared-ask/home/composition';
import { COMPONENT_LABELS } from '@gitstalk/shared-ask/home/composition';
import { fileRows } from '@gitstalk/shared-ask/home/file-rows';
import { journeyOf } from '@gitstalk/shared-ask/home/journey';
import type { Credit, Pushers, SessionDirectory } from '@gitstalk/shared-ask/home/sessions';
import { creditOf } from '@gitstalk/shared-ask/home/sessions';
import { isInFlight } from '@gitstalk/shared-ask/race/race-counters';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { Bean, RaceState } from '@gitstalk/shared-ask/race/race-state';
import type { FileDiff } from '@gitstalk/shared-ask/repo/repo-types';
import { formatClock, formatSpan, plural } from '../../src/race/race-format';
import type { JourneyItem } from './bean-journey';
import { BeanJourney } from './bean-journey';
import type { HomeState } from './home-url';
import { beanHref, homeHref } from './home-url';
import styles from './home.module.css';
import { BaseChip, BeanChip, FileIcon, HunkLines, InFlightChip } from './marks';
import { InfoReceipt } from './receipts';

export type ExplorerContext = {
  readonly base: string;
  readonly url: HomeState;
  readonly answer: Answer;
  readonly composition: Composition;
  /** The run at the answer's moment. */
  readonly state: RaceState;
  readonly events: readonly RaceEvent[];
  readonly now: number;
  readonly titles: Readonly<Record<string, string>>;
  readonly sessions: SessionDirectory;
  /** Who pushed each bean (a repository's); empty for races. */
  readonly pushers: Pushers;
  /** A bean the answer features (the newest one it is about), with its change. */
  readonly featured: { readonly bean: BeanDetail; readonly files: readonly FileDiff[] } | null;
};

/** The generated explorer for a question or a bean: a headline, then the chosen components. */
export function ExplorerAnswer(ctx: ExplorerContext) {
  const asked = ctx.url.q !== '';
  return (
    <>
      {asked ? (
        <>
          <div className={styles.answer}>{ctx.answer.headline}</div>
          <div className={styles.sub}>
            You asked “{ctx.url.q}”.
            <Link
              href={homeHref(ctx.base, ctx.url, { q: '', removed: [], bean: null, step: null })}
            >
              Clear the question
            </Link>
          </div>
        </>
      ) : null}
      <ComposeLine composition={ctx.composition} />
      {ctx.composition.components.map((component) => (
        <div key={component} className={styles.comp}>
          <Component id={component} ctx={ctx} />
        </div>
      ))}
    </>
  );
}

/** When the run has finished, "who is working now?" has an honest answer. */
export function FinishedAnswer(props: {
  readonly base: string;
  readonly url: HomeState;
  readonly finishedAt: number;
  readonly busiest: number | null;
}) {
  return (
    <>
      <div className={styles.answer}>
        Nobody, the run finished at {formatClock(props.finishedAt)}.
      </div>
      <div className={styles.sub}>
        You asked “{props.url.q}”.
        <Link
          href={homeHref(props.base, props.url, { q: '', removed: [], bean: null, step: null })}
        >
          Clear the question
        </Link>
      </div>
      {props.busiest === null ? null : (
        <div className={styles.acts} style={{ marginTop: 12 }}>
          <Link href={homeHref(props.base, props.url, { t: props.busiest })}>
            Show the busiest moment ({formatClock(props.busiest)})
          </Link>
        </div>
      )}
    </>
  );
}

function ComposeLine({ composition }: { readonly composition: Composition }) {
  return (
    <div className={styles.compose}>
      This view:
      {composition.components.map((component, index) => (
        <span key={component} className={styles.c}>
          <b>{index + 1}</b>
          {COMPONENT_LABELS[component]}
        </span>
      ))}
      {composition.receipt === null ? null : <InfoReceipt receipt={composition.receipt} />}
    </div>
  );
}

function Component({ id, ctx }: { readonly id: ComponentId; readonly ctx: ExplorerContext }) {
  switch (id) {
    case 'files':
      return <FilesAnswer ctx={ctx} />;
    case 'journey':
      if (ctx.answer.main.kind === 'bean')
        return (
          <Journey
            ctx={ctx}
            bean={ctx.answer.main.bean}
            files={ctx.answer.main.diff?.files ?? []}
          />
        );
      return ctx.featured === null ? null : (
        <Journey ctx={ctx} bean={ctx.featured.bean} files={ctx.featured.files} />
      );
    case 'decision':
      return <DecisionCards ctx={ctx} />;
    case 'red':
      return <RedCard ctx={ctx} />;
    case 'overlaps':
      return <Overlaps ctx={ctx} />;
    default:
      return assertNever(id);
  }
}

function FilesAnswer({ ctx }: { readonly ctx: ExplorerContext }) {
  const diffs = new Map(
    (ctx.answer.main.kind === 'diff' ? ctx.answer.main.diff.files : []).map((file) => [
      file.path,
      file,
    ]),
  );
  const paths = [...ctx.composition.files].toSorted(
    (a, b) => Number(isTest(a)) - Number(isTest(b)),
  );
  const rows = fileRows(paths, ctx.state, ctx.now);
  if (rows.length === 0) {
    return (
      <div className={styles.box}>
        <div className={styles.boxhead}>
          <b>Files</b>
        </div>
        <div className={styles.empty}>No files for this answer.</div>
      </div>
    );
  }
  return (
    <div className={`${styles.box} ${styles.diff}`}>
      <div className={styles.boxhead}>
        <b>Files</b>
        <span className={styles.muted}>
          {plural(rows.length, 'file')}
          {diffs.size > 0 ? ', changes in this answer' : ''}
        </span>
      </div>
      {rows.map((row, index) => {
        const diff = diffs.get(row.path);
        const summary = (
          <summary>
            <span className={styles.p}>
              <FileIcon dir={false} />
              <code>{row.path.replace(/^src\//, '')}</code>
            </span>
            <span>
              {row.last === null ? (
                <BaseChip />
              ) : (
                <BeanChip
                  task={row.last.task}
                  idx={row.last.idx}
                  status={row.last.status}
                  title={row.last.task === null ? undefined : ctx.titles[row.last.task]}
                />
              )}{' '}
              {row.flying.length > 0 ? (
                <InFlightChip
                  count={row.flying.length}
                  title={row.flying
                    .map((bean) => `${bean.slot ?? ''} ${ctx.titles[bean.task] ?? bean.task}`)
                    .join('\n')}
                />
              ) : null}
            </span>
            <span>{diff === undefined ? null : <DiffStat file={diff} />}</span>
          </summary>
        );
        return diff === undefined ? (
          <details key={row.path}>{summary}</details>
        ) : (
          <details key={row.path} open={index === 0}>
            {summary}
            <HunkLines file={diff} lines={30} />
          </details>
        );
      })}
    </div>
  );
}

function DiffStat({ file }: { readonly file: FileDiff }) {
  return (
    <>
      <span className={styles.add}>+{file.additions}</span>{' '}
      <span className={styles.del}>−{file.deletions}</span>
    </>
  );
}

function Journey({
  ctx,
  bean,
  files,
}: {
  readonly ctx: ExplorerContext;
  readonly bean: BeanDetail;
  readonly files: readonly FileDiff[];
}) {
  const credit = creditOf(bean, ctx.sessions, ctx.pushers);
  return (
    <BeanJourney
      bean={{
        id: bean.id,
        title: bean.title,
        intent: bean.intent,
        status: statusOf(bean),
        session: journeySession(credit, bean.agent),
        landedIdx: bean.landedIdx,
        reworks: bean.reworks,
      }}
      steps={journeyItems(bean, ctx.state)}
      files={files}
      now={ctx.now}
      initialStep={ctx.url.step}
    />
  );
}

/** The card's steps: "All changes" first, the bean's timeline, then what is happening now. */
function journeyItems(bean: BeanDetail, state: RaceState): readonly JourneyItem[] {
  const sentences = journeyOf(bean.steps);
  const lastAgentStep = bean.steps.findLastIndex((step) => step.kind === 'committed');
  const items: JourneyItem[] = [
    {
      id: 'all',
      t: 0,
      tone: 'all',
      text: 'All changes',
      detail: '',
      live: false,
      showsChange: true,
      report: null,
    },
    ...bean.steps.map((step, index): JourneyItem => ({
      id: String(index),
      t: step.t,
      tone: sentences[index]?.tone ?? 'plan',
      text: sentences[index]?.text ?? step.kind,
      detail:
        step.kind === 'committed' || step.kind === 'landed' || step.kind === 'green'
          ? ''
          : step.detail,
      live: false,
      showsChange: step.kind === 'committed' || step.kind === 'landed',
      report: index === lastAgentStep && bean.lastMessage !== '' ? bean.lastMessage : null,
    })),
  ];
  const now = state.beans[bean.id];
  const live = now === undefined ? null : liveItem(now);
  return live === null ? items : [...items, live];
}

function liveItem(bean: Bean): JourneyItem | null {
  if (!isInFlight(bean.phase) || bean.startedAt === null) return null;
  const base = {
    id: 'live',
    t: bean.since,
    detail: '',
    live: true,
    showsChange: false,
    report: null,
  };
  switch (bean.phase) {
    case 'working':
      return { ...base, tone: 'agent', text: 'Writing the change', showsChange: true };
    case 'checking':
      return { ...base, tone: 'plan', text: 'Pre-land check running on the merged tree' };
    case 'rework':
      return { ...base, tone: 'rework', text: 'Reworking the change' };
    case 'deciding':
      return { ...base, tone: 'decide', text: 'Waiting for a decision' };
    case 'queued':
    case 'testing':
      return { ...base, tone: 'plan', text: 'In the merge queue' };
    case 'parked':
      return { ...base, tone: 'decide', text: 'Parked: needs a person' };
    case 'held':
      return { ...base, tone: 'held', text: "Waiting for a person's approval" };
    case 'pending':
    case 'landed':
    case 'green':
    case 'dropped':
      return null;
    default:
      return assertNever(bean.phase);
  }
}

function verdict(winner: string | null, task: string): string {
  if (winner === null) return '';
  return winner === task ? ', kept' : ', declined';
}

function statusOf(bean: BeanDetail): { readonly word: string; readonly tone: string } {
  if (bean.phase === 'held') return { word: 'held for approval', tone: 'held' };
  switch (bean.status) {
    case 'green':
      return { word: 'on the stalk', tone: 'stalk' };
    case 'landed':
      return { word: 'on the sprout', tone: 'sprout' };
    case 'dropped':
      return { word: 'fell off', tone: 'red' };
    case 'parked':
      return { word: 'needs a person', tone: 'amber' };
    case 'reverted':
      return { word: 'reverted', tone: 'red' };
    case 'in-flight':
      return { word: 'growing', tone: 'fly' };
    case 'pending':
      return { word: 'not started', tone: 'base' };
    default:
      return assertNever(bean.status);
  }
}

function DecisionCards({ ctx }: { readonly ctx: ExplorerContext }) {
  const fromRail = ctx.answer.rail.flatMap((block) =>
    block.kind === 'decisions' ? block.cards : [],
  );
  const selected = ctx.answer.main.kind === 'bean' ? ctx.answer.main.bean.card : null;
  const cards: readonly DecisionRecord[] =
    selected === null ? fromRail : fromRail.filter((card) => card.card === selected);
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => {
        const against = card.against[0];
        const side = (task: string) => (
          <div data-win={card.winner === task ? '' : undefined}>
            <small>
              {task}
              {verdict(card.winner, task)}
            </small>
            {card.specs[task] ?? task}
          </div>
        );
        return (
          <div key={card.card} className={styles.box}>
            <div className={styles.boxhead}>
              <b>◆ Decision {card.card}: two specs could not both hold</b>
              <span className={styles.right}>
                {card.status === 'decided' && card.decidedAt !== null
                  ? `decided at ${formatClock(card.decidedAt)}`
                  : 'waiting for a person'}
              </span>
            </div>
            <div className={styles.cardbody}>
              <div className={styles.vs}>
                {against === undefined ? null : side(against)}
                {side(card.task)}
              </div>
              <p>
                {plural(card.failing.length, 'test')} failed whichever way the agent tried (
                {plural(card.attempts, 'attempt')}), so the forge asked instead of guessing.
                {card.oracle === null ? '' : ` Decided by ${card.oracle}.`}
              </p>
              <div className={styles.acts}>
                <Link href={beanHref(ctx.base, ctx.url, card.task)}>Follow {card.task}</Link>
                {against === undefined ? null : (
                  <Link href={beanHref(ctx.base, ctx.url, against)}>Follow {against}</Link>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

function RedCard({ ctx }: { readonly ctx: ExplorerContext }) {
  const block = ctx.answer.rail.find(
    (item): item is Extract<RailBlock, { kind: 'red' }> => item.kind === 'red',
  );
  const ticket = block?.tickets[0] ?? null;
  const first = ctx.state.ci.find((run) => run.purpose === 'validate' && run.green === false);
  if (first === undefined) return null;
  const greenAgain = ctx.state.ci.find(
    (run) => run.purpose === 'validate' && run.green === true && run.startedAt > first.startedAt,
  );
  const greenAt = greenAgain?.endedAt ?? null;
  const redAt = first.endedAt ?? first.startedAt;
  const inherited = ctx.events.filter(
    (event) =>
      event.type === 'rework.start' &&
      event.reason === 'preland-red' &&
      event.t >= redAt &&
      (greenAt === null || event.t <= greenAt),
  ).length;
  const culprit = ticket?.culprit ?? null;
  return (
    <div className={styles.box}>
      <div className={styles.boxhead}>
        <b>
          ✕ Red validation{ticket === null ? '' : ` ${ticket.ticket}`}
          {first.trunkIdx === null ? '' : ` at #${first.trunkIdx}`}
        </b>
        <span className={styles.right}>
          {greenAt === null ? 'still red' : `green again at ${formatClock(greenAt)}`}
        </span>
      </div>
      <div className={styles.cardbody}>
        <p>
          <code>{first.failingFiles[0]?.split('/').at(-1) ?? 'a test'}</code> failed when the sprout
          was validated. The forge recorded what every bean read, so only the beans whose read sets
          covered that test were suspects; bisecting them{' '}
          {culprit === null ? (
            'is under way'
          ) : (
            <>
              named <b>{culprit}</b>
            </>
          )}
          .
        </p>
        <div className={styles.steps}>
          <div>
            <b>{formatClock(redAt)}</b>went red
          </div>
          <div>
            <b>{plural(inherited, 'check')}</b>inherited the red
          </div>
          <div>
            <b>{culprit ?? 'bisecting'}</b>
            {culprit === null ? 'in progress' : 'named the culprit'}
          </div>
          <div>
            <b>{greenAt === null ? 'not yet' : formatClock(greenAt)}</b>
            {greenAt === null ? 'green again' : `green again, ${formatSpan(greenAt - redAt)} later`}
          </div>
        </div>
        {culprit === null ? null : (
          <div className={styles.acts}>
            <Link href={beanHref(ctx.base, ctx.url, culprit)}>Open {culprit}&apos;s journey</Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** Beans in flight on what a swarm question is about: its feature (an area or a word), or anywhere. */
export function workingOn(state: RaceState, feature: string | null): readonly Bean[] {
  const inScope = (file: string): boolean =>
    feature === null ? true : file.toLowerCase().includes(feature.toLowerCase());
  return Object.values(state.beans).filter(
    (bean) => isInFlight(bean.phase) && bean.startedAt !== null && bean.files.some(inScope),
  );
}

function Overlaps({ ctx }: { readonly ctx: ExplorerContext }) {
  const agent = ctx.answer.spec.entities.agent;
  if (agent !== null) return <AgentActivity ctx={ctx} agent={agent} />;
  const feature = ctx.answer.spec.entities.feature;
  const inScope = (file: string): boolean =>
    feature === null ? true : file.toLowerCase().includes(feature.toLowerCase());
  const scope = new Set(ctx.composition.files);
  const here = Object.values(ctx.state.beans).filter(
    (bean) =>
      isInFlight(bean.phase) &&
      bean.startedAt !== null &&
      (bean.files.some(inScope) || bean.files.some((file) => scope.has(file))),
  );
  const owners = new Map<string, Bean[]>();
  for (const bean of here)
    for (const file of bean.files) owners.set(file, [...(owners.get(file) ?? []), bean]);
  const hot = [...owners]
    .filter(([, beans]) => beans.length > 1)
    .toSorted((a, b) => b[1].length - a[1].length);
  const conflicts = ctx.events.filter(
    (event) =>
      event.type === 'merge.conflict' && event.t > ctx.now - 240 && event.files.some(inScope),
  );
  return (
    <div className={styles.two}>
      <div className={styles.box}>
        <div className={styles.boxhead}>
          <b>Who is working here now</b>
          <span className={styles.muted}>{formatClock(ctx.now)}</span>
        </div>
        {here.length === 0 ? (
          <div className={styles.empty}>Nobody right now.</div>
        ) : (
          <table className={styles.agents}>
            <tbody>
              {here.map((bean) => {
                const credit = creditOf(bean, ctx.sessions, ctx.pushers);
                return (
                  <tr key={bean.id}>
                    <td className={styles.who}>
                      {credit.who === '' ? '?' : credit.who}
                      <small>{whoNote(bean, ctx)}</small>
                    </td>
                    <td>
                      <Link href={beanHref(ctx.base, ctx.url, bean.id)}>
                        {ctx.titles[bean.id] ?? bean.id}
                      </Link>
                      <div className={styles.files}>
                        {bean.files.map((file) => file.split('/').at(-1)).join(', ') ||
                          'no files written yet'}
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <span className={styles.chip} data-tone={phaseTone(bean.phase)}>
                        {bean.phase === 'working' ? 'writing' : bean.phase}
                      </span>
                      <div className={styles.files}>for {formatSpan(ctx.now - bean.since)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className={styles.box}>
        <div className={styles.boxhead}>
          <b>Collision hot spots</b>
          <span className={styles.muted}>files two beans in flight both change</span>
        </div>
        {hot.length === 0 ? (
          <div className={styles.empty}>No two beans in flight change the same file.</div>
        ) : null}
        {hot.map(([file, beans]) => (
          <div key={file} className={styles.hot}>
            <span>
              <FileIcon dir={false} />
              <code>{file.replace(/^src\//, '')}</code>
            </span>
            <span>
              {beans.map((bean) => (
                <span
                  key={bean.id}
                  className={styles.chip}
                  data-tone="fly"
                  style={{ marginLeft: 4 }}
                >
                  {creditOf(bean, ctx.sessions, ctx.pushers).who}
                </span>
              ))}
            </span>
          </div>
        ))}
        {conflicts.length > 0 ? (
          <div className={styles.callout}>
            {plural(conflicts.length, 'merge conflict')} here in the last 4 minutes:{' '}
            {[
              ...new Set(
                conflicts.flatMap((event) =>
                  event.type === 'merge.conflict' && event.task !== null ? [event.task] : [],
                ),
              ),
            ].join(', ')}{' '}
            went back to their authors.
          </div>
        ) : null}
        <div className={styles.callout}>
          Each bean is checked on the merged tree before it lands, so these never collide on the
          sprout; the later one is re-checked or reworked.
        </div>
      </div>
    </div>
  );
}

function AgentActivity({ ctx, agent }: { readonly ctx: ExplorerContext; readonly agent: string }) {
  const beans = Object.values(ctx.state.beans).filter((bean) => bean.agent === agent);
  const session = ctx.sessions[agent];
  // A repository's beans were pushed by people: name them, not the engine slot that held them.
  const people = [
    ...new Set(
      beans.flatMap((bean) => (ctx.pushers[bean.id] === undefined ? [] : [ctx.pushers[bean.id]])),
    ),
  ];
  return (
    <div className={styles.box}>
      <div className={styles.boxhead}>
        <b>
          {people.length > 0
            ? `Pushed by ${people.map((who) => `@${who}`).join(', ')}`
            : `Session ${agent}`}
        </b>
        <span className={styles.muted}>
          {people.length > 0 || session === undefined ? '' : `${session.harness}, ${session.owner}`}
        </span>
      </div>
      <table className={styles.agents}>
        <tbody>
          {beans.map((bean) => (
            <tr key={bean.id}>
              <td className={styles.who}>{bean.id}</td>
              <td>
                <Link href={beanHref(ctx.base, ctx.url, bean.id)}>
                  {ctx.titles[bean.id] ?? bean.id}
                </Link>
              </td>
              <td style={{ textAlign: 'right' }}>
                <span className={styles.chip} data-tone={phaseTone(bean.phase)}>
                  {bean.phase}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The journey's "who": the pusher, or the slot and its session (`a0, Claude Code session of coop`). */
function journeySession(credit: Credit, agent: string | null): string {
  if (credit.kind === 'pusher') return credit.detail;
  if (credit.kind === 'session') return `${credit.who}, ${credit.detail}`;
  return agent ?? 'no session';
}

/** The small print under a race's slot: its owner and harness; nothing under a pusher. */
function whoNote(bean: Bean, ctx: ExplorerContext): string {
  if (ctx.pushers[bean.id] !== undefined) return '';
  const session = bean.agent === null ? undefined : ctx.sessions[bean.agent];
  return session === undefined ? '' : `${session.owner}, ${session.harness}`;
}

function phaseTone(phase: string): string {
  if (phase === 'green') return 'stalk';
  if (phase === 'landed') return 'sprout';
  if (phase === 'held') return 'held';
  if (phase === 'rework' || phase === 'dropped') return 'red';
  if (phase === 'checking' || phase === 'queued' || phase === 'testing') return 'amber';
  return 'fly';
}

function isTest(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path);
}

function assertNever(value: never): never {
  throw new Error(`unexpected value ${JSON.stringify(value)}`);
}
