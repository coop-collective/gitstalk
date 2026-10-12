import { IntentLink as Link } from '../shell/intent-link';

import type { RailBlock } from '@gitstalk/shared-ask/ask/answer';
import type {
  BeanRecord,
  DecisionRecord,
  TestRecord,
} from '@gitstalk/shared-ask/forge/forge-source';
import type { Pushers } from '@gitstalk/shared-ask/home/sessions';
import type { Lane } from '@gitstalk/shared-ask/race/race-state';
import { formatClock, formatSpan, plural } from '../../src/race/race-format';
import { StatusPill, beadClass, statusLabel } from './bean-status';
import { BeanSteps } from './bean-view';
import styles from './explorer.module.css';
import type { ExplorerState } from './explorer-url';
import { explorerHref } from './explorer-url';

type Context = {
  readonly base: string;
  readonly state: ExplorerState;
  /** A persistent repository names people (`@coop`) where a race names agent slots. */
  readonly subject: 'race' | 'repository';
  /** Who pushed each bean, for a repository. */
  readonly pushers: Pushers;
};

/** The context rail, in the catalog's order for the question's class. */
export function RailBlocks(props: {
  readonly base: string;
  readonly state: ExplorerState;
  readonly blocks: readonly RailBlock[];
  readonly subject?: 'race' | 'repository';
  readonly pushers?: Pushers;
}) {
  const context: Context = {
    base: props.base,
    state: props.state,
    subject: props.subject ?? 'race',
    pushers: props.pushers ?? {},
  };
  return (
    <>
      {props.blocks.map((block, index) => (
        <RailBlockView key={`${block.kind}-${index}`} block={block} context={context} />
      ))}
    </>
  );
}

function RailBlockView({
  block,
  context,
}: {
  readonly block: RailBlock;
  readonly context: Context;
}) {
  switch (block.kind) {
    case 'beans':
      return (
        <Block title={block.title} count={block.beans.length} empty="No bean touched these files.">
          {block.beans.length === 0 ? null : <BeanTimeline beans={block.beans} context={context} />}
        </Block>
      );
    case 'decisions':
      return (
        <Block
          title="Decisions"
          count={block.cards.length}
          empty="No decision card about these files."
        >
          {block.cards.map((card) => (
            <DecisionCardView key={card.card} card={card} context={context} />
          ))}
        </Block>
      );
    case 'tests':
      return (
        <Block title="Tests" count={block.tests.length} empty="No test covers these files.">
          {block.tests.map((test) => (
            <TestRow key={test.path} test={test} context={context} />
          ))}
        </Block>
      );
    case 'agents':
      return (
        <Block
          title={
            context.subject === 'repository' ? 'People and sessions on it now' : 'Agents on it now'
          }
          count={block.lanes.length}
          empty={
            context.subject === 'repository'
              ? 'Nobody has a bean on these files right now.'
              : 'No agent holds a bean on these files right now.'
          }
        >
          {block.lanes.map((lane) => (
            <LaneRow key={lane.slot} lane={lane} now={block.now} context={context} />
          ))}
        </Block>
      );
    case 'red':
      return <RedBlock block={block} context={context} />;
    case 'promotion':
      return <PromotionBlock block={block} context={context} />;
    case 'checks':
      return (
        <Block
          title={`What happened to ${block.bean}`}
          count={block.steps.length}
          empty="Nothing yet."
        >
          <BeanSteps steps={block.steps} />
        </Block>
      );
    default:
      return null;
  }
}

function Block(props: {
  readonly title: string;
  readonly count: number;
  readonly empty: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <section className={styles.block} aria-label={props.title}>
      <h2 className={styles.blockHead}>
        {props.title}
        <span className={styles.blockCount}>{props.count}</span>
      </h2>
      {props.count === 0 ? <p className={styles.blockEmpty}>{props.empty}</p> : props.children}
    </section>
  );
}

function beanHref(context: Context, bean: string): string {
  return explorerHref(context.base, context.state, { bean, file: null, view: null });
}

/** Beans as beads on a stem, newest activity first, each with its agent. */
function BeanTimeline({
  beans,
  context,
}: {
  readonly beans: readonly BeanRecord[];
  readonly context: Context;
}) {
  return (
    <ol className={styles.timeline}>
      {beans.map((bean) => (
        <li key={bean.id} className={styles.timelineItem}>
          <span className={beadClass(bean.status)} aria-hidden="true" />
          <div className={styles.timelineTop}>
            <Link href={beanHref(context, bean.id)}>{bean.id}</Link>
            <span>{statusLabel(bean.status)}</span>
            <span className={styles.timelineTime}>{beanTime(bean)}</span>
          </div>
          <div className={styles.timelineSub}>
            {bean.title}
            {carrier(bean.id, bean.agent, context)}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** ", by @coop" for a pushed bean, ", by a3" for a race's agent, nothing for neither. */
function carrier(bean: string, agent: string | null, context: Context): string {
  const pusher = context.pushers[bean];
  if (pusher !== undefined) return `, by @${pusher}`;
  if (context.subject === 'repository') return '';
  return agent === null ? '' : `, by ${agent}`;
}

function beanTime(bean: BeanRecord): string {
  const t = bean.greenAt ?? bean.landedAt ?? bean.startedAt;
  return t === null ? '' : formatClock(t);
}

function DecisionCardView({
  card,
  context,
}: {
  readonly card: DecisionRecord;
  readonly context: Context;
}) {
  const sides = [card.task, ...card.against];
  return (
    <div className={styles.card}>
      <div className={styles.timelineTop}>
        <strong>{card.card}</strong>
        <span
          className={`${styles.pill} ${card.status === 'open' ? styles.pillHuman : styles.pillLanded}`}
        >
          {card.status === 'open'
            ? 'waiting for a person'
            : `decided by ${card.oracle ?? 'a person'}`}
        </span>
        <span className={styles.timelineTime}>{formatClock(card.openedAt)}</span>
      </div>
      <div className={styles.cardSpecs}>
        {sides.map((bean) => (
          <div
            key={bean}
            className={`${styles.spec2} ${card.winner === bean ? styles.specWon : ''}`}
          >
            <Link className={styles.specBean} href={beanHref(context, bean)}>
              {bean}
            </Link>
            {card.specs[bean] ?? ''}
            {card.winner === bean ? <strong> (kept)</strong> : null}
          </div>
        ))}
      </div>
      {card.failing.length === 0 ? null : (
        <p className={styles.timelineSub}>
          {plural(card.failing.length, 'test')} disagreed, after{' '}
          {plural(card.attempts, 'informed rework')}.
        </p>
      )}
    </div>
  );
}

function TestRow({ test, context }: { readonly test: TestRecord; readonly context: Context }) {
  return (
    <div className={styles.testRow}>
      <Link
        className={styles.testPath}
        href={explorerHref(context.base, context.state, {
          file: test.path,
          bean: null,
          view: null,
        })}
      >
        {test.path}
      </Link>
      <span className={`${styles.pill} ${testPill(test.state)}`}>{testLabel(test.state)}</span>
      {test.history.length === 0 ? null : (
        <span className={styles.history} aria-label={historyLabel(test)}>
          {test.history.map((run, index) => (
            <span
              key={`${run.t}-${index}`}
              className={`${styles.run} ${runClass(run)}`}
              title={`${run.green ? 'passed' : 'failed'} ${run.kind} ${run.subject} at ${formatClock(run.t)}`}
            />
          ))}
        </span>
      )}
    </div>
  );
}

function runClass(run: TestRecord['history'][number]): string {
  if (run.green) return '';
  return (run.kind === 'preland' ? styles.runPreland : styles.runRed) ?? '';
}

function testPill(state: TestRecord['state']): string {
  if (state === 'pass') return styles.pillGreen ?? '';
  if (state === 'fail') return styles.pillRed ?? '';
  return styles.pillPending ?? '';
}

function testLabel(state: TestRecord['state']): string {
  if (state === 'pass') return 'passes';
  if (state === 'fail') return 'fails';
  return 'not run yet';
}

function historyLabel(test: TestRecord): string {
  const failed = test.history.filter((run) => !run.green).length;
  return `${plural(test.history.length, 'run')}, ${failed} failed`;
}

function LaneRow({
  lane,
  now,
  context,
}: {
  readonly lane: Lane;
  readonly now: number;
  readonly context: Context;
}) {
  return (
    <div className={styles.laneRow}>
      <span className={styles.slot}>
        {lane.bean !== null && context.pushers[lane.bean] !== undefined
          ? `@${context.pushers[lane.bean]}`
          : lane.slot}
      </span>
      <span>
        {lane.bean === null ? 'idle' : <Link href={beanHref(context, lane.bean)}>{lane.bean}</Link>}{' '}
        {laneDoing(lane)}
      </span>
      <span className={styles.timelineTime}>{formatSpan(now - lane.since)}</span>
    </div>
  );
}

function laneDoing(lane: Lane): string {
  if (lane.invocation !== null)
    return lane.invocation.kind === 'initial' ? 'writing it' : 'reworking it';
  return lane.bean === null ? '' : 'waiting for its check';
}

function RedBlock({
  block,
  context,
}: {
  readonly block: Extract<RailBlock, { kind: 'red' }>;
  readonly context: Context;
}) {
  const count = block.runs.length + block.tickets.length + block.culprits.length;
  return (
    <Block title="Red, and what was done" count={count} empty="Nothing went red in this range.">
      {block.tickets.map((ticket) => (
        <div key={ticket.ticket} className={styles.card}>
          <div className={styles.timelineTop}>
            <strong>Repair {ticket.ticket}</strong>
            <span>sprout #{ticket.redIdx} red</span>
            <span className={styles.timelineTime}>{ticket.status}</span>
          </div>
          <p className={styles.timelineSub}>
            {ticket.culprit === null ? (
              'Culprit not found.'
            ) : (
              <>
                Culprit <Link href={beanHref(context, ticket.culprit)}>{ticket.culprit}</Link>;
                revert-first, never fix forward.
              </>
            )}
          </p>
          <p className={`${styles.timelineSub} ${styles.mono}`}>{ticket.failing.join(', ')}</p>
        </div>
      ))}
      {block.culprits.length === 0 ? null : (
        <div className={styles.card}>
          <strong>Bisected culprits</strong>
          <p className={styles.timelineSub}>
            {block.culprits.map((culprit, index) => (
              <span key={`${culprit.batch}-${index}`}>
                {index === 0 ? '' : ', '}
                <Link href={beanHref(context, culprit.culprit)}>{culprit.culprit}</Link> (
                {culprit.batch})
              </span>
            ))}
          </p>
        </div>
      )}
      {block.runs.length === 0 ? null : (
        <ol className={styles.timeline}>
          {block.runs.map((run) => (
            <li key={run.ci} className={styles.timelineItem}>
              <span className={`${styles.bead} ${styles.beadRed}`} aria-hidden="true" />
              <div className={styles.timelineTop}>
                <strong>{run.subject}</strong>
                <span>{run.purpose === 'validate' ? 'validation red' : `${run.purpose} red`}</span>
                <span className={styles.timelineTime}>{formatClock(run.t)}</span>
              </div>
              <div className={`${styles.timelineSub} ${styles.mono}`}>
                {run.failingFiles.join(', ')}
              </div>
            </li>
          ))}
        </ol>
      )}
      {block.checks.length === 0 ? null : (
        <p className={styles.note}>
          {plural(block.checks.length, 'pre-land check')} also came back red; each sent its bean
          back to its author before it could land.
        </p>
      )}
    </Block>
  );
}

function PromotionBlock({
  block,
  context,
}: {
  readonly block: Extract<RailBlock, { kind: 'promotion' }>;
  readonly context: Context;
}) {
  const eta =
    block.validating === null ? null : block.validating.startedAt + block.ciSeconds - block.now;
  return (
    <Block
      title="Waiting for the stalk"
      count={block.beans.length}
      empty="Every landed bean is on the stalk."
    >
      {block.validating === null ? null : (
        <p className={styles.note}>
          Validating sprout #{block.validating.idx ?? '?'}
          {eta === null || eta <= 0 ? '' : `, about ${formatSpan(eta)} left`}.
        </p>
      )}
      <ol className={styles.timeline}>
        {block.beans.map((bean) => (
          <li key={bean.id} className={styles.timelineItem}>
            <span className={beadClass(bean.status)} aria-hidden="true" />
            <div className={styles.timelineTop}>
              <Link href={beanHref(context, bean.id)}>{bean.id}</Link>
              <StatusPill status={bean.status} />
              <span className={styles.timelineTime}>#{bean.landedIdx ?? '?'}</span>
            </div>
            <div className={styles.timelineSub}>{bean.title}</div>
          </li>
        ))}
      </ol>
    </Block>
  );
}
