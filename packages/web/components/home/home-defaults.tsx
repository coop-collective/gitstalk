'use client';

import { IntentLink as Link } from '../shell/intent-link';

import type { BeanStreamSummary } from '@gitstalk/shared-ask/forge/bean-stream';
import { dirListing } from '@gitstalk/shared-ask/home/file-rows';
import type { Pushers, SessionDirectory } from '@gitstalk/shared-ask/home/sessions';
import { creditOf } from '@gitstalk/shared-ask/home/sessions';
import { isInFlight } from '@gitstalk/shared-ask/race/race-counters';
import type { RaceState } from '@gitstalk/shared-ask/race/race-state';
import { formatClock, formatSpan, plural } from '../../src/race/race-format';
import styles from './home.module.css';
import { useStreamSummaries } from './live-streams';
import { BaseChip, BeanChip, FileIcon, InFlightChip } from './marks';

export type DefaultsProps = {
  readonly base: string;
  readonly state: RaceState;
  readonly now: number;
  readonly files: readonly string[];
  readonly titles: Readonly<Record<string, string>>;
  readonly sessions: SessionDirectory;
  readonly pushers: Pushers;
  readonly hrefFor: (bean: string) => string;
  readonly askHref: (q: string) => string;
};

/** The explorer when nothing is asked: Growing now (while beans fly), What happened, Files. */
export function HomeDefaults(props: DefaultsProps) {
  const streams = useStreamSummaries();
  const flying = Object.values(props.state.beans).filter(
    (bean) => isInFlight(bean.phase) && bean.startedAt !== null,
  );
  return (
    <>
      {flying.length > 0 ? (
        <div className={styles.comp}>
          <div className={styles.box}>
            <div className={styles.boxhead}>
              <b>Growing now</b>
              <span className={styles.muted}>
                {plural(flying.length, 'bean')} in flight at {formatClock(props.now)}
              </span>
            </div>
            <ul className={styles.list}>
              {flying.map((bean) => {
                const credit = creditOf(bean, props.sessions, props.pushers);
                return (
                  <li key={bean.id}>
                    <span
                      className={styles.a}
                      title={credit.detail === '' ? undefined : credit.detail}
                    >
                      {credit.who}
                    </span>
                    <Link className={styles.t} href={props.hrefFor(bean.id)}>
                      {props.titles[bean.id] ?? bean.id}
                    </Link>
                    <span className={styles.s}>
                      <PhaseMark phase={bean.phase} />
                      {phaseWord(bean.phase)} {formatSpan(props.now - bean.since)}
                      <StreamStat summary={streams.get(bean.id)} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
      <div className={styles.comp}>
        <WhatHappened {...props} />
      </div>
      <div className={styles.comp}>
        <FilesTable {...props} />
      </div>
    </>
  );
}

/** While its agent writes (`stream_diffs`): the files and lines so far. */
function StreamStat({ summary }: { readonly summary: BeanStreamSummary | undefined }) {
  if (summary === undefined) return null;
  return (
    <span className={styles.writing}>
      <i className={styles.cur} /> {plural(summary.files.length, 'file')} +{summary.additions} −
      {summary.deletions}
    </span>
  );
}

function WhatHappened(props: DefaultsProps) {
  const { state } = props;
  const card = state.cards.find((item) => item.status === 'open') ?? state.cards[0];
  const red = state.ci.find((run) => run.purpose === 'validate' && run.green === false);
  const greenAgain =
    red === undefined
      ? undefined
      : state.ci.find(
          (run) =>
            run.purpose === 'validate' && run.green === true && run.startedAt > red.startedAt,
        );
  const culprit = state.tickets.find((ticket) => ticket.culprit !== null)?.culprit ?? null;
  const dropped = Object.values(state.beans).filter((bean) => bean.phase === 'dropped');
  const stories = [
    card === undefined ? null : (
      <div key="decision" className={styles.story}>
        <span className={styles.storyIcon} data-tone="decide">
          ◆
        </span>
        <div>
          <b>{card.card}: two specs clashed</b>
          <p>
            “{card.specs[card.against[0] ?? ''] ?? ''}”{' '}
            {card.status === 'decided' ? 'was kept over' : 'against'} “
            {card.specs[card.task] ?? card.task}”.{' '}
            <Link href={props.hrefFor(card.task)}>Follow {card.task}</Link>
          </p>
        </div>
      </div>
    ),
    red === undefined ? null : (
      <div key="red" className={styles.story}>
        <span className={styles.storyIcon} data-tone="red">
          ✕
        </span>
        <div>
          <b>The sprout went red{red.trunkIdx === null ? '' : ` at #${red.trunkIdx}`}</b>
          <p>
            <code>{red.failingFiles[0]?.split('/').at(-1) ?? 'a test'}</code> failed.
            {culprit === null
              ? ''
              : ` Bisecting the beans whose read sets covered it named ${culprit}.`}{' '}
            {greenAgain?.endedAt === undefined || greenAgain.endedAt === null
              ? 'Still red.'
              : `Green again at ${formatClock(greenAgain.endedAt)}.`}{' '}
            <Link href={props.askHref('why did the sprout go red?')}>What broke</Link>
          </p>
        </div>
      </div>
    ),
    dropped.length === 0 ? null : (
      <div key="fell" className={styles.story}>
        <span className={styles.storyIcon} data-tone="fell">
          ●
        </span>
        <div>
          <b>{plural(dropped.length, 'bean')} fell off</b>
          <p>
            {dropped.map((bean, index) => (
              <span key={bean.id}>
                {index > 0 ? ', ' : ''}
                <Link href={props.hrefFor(bean.id)}>{bean.id}</Link> (
                {dropWord(bean.dropReason ?? '')})
              </span>
            ))}
          </p>
        </div>
      </div>
    ),
  ].filter((story) => story !== null);
  return (
    <div className={styles.box}>
      <div className={styles.boxhead}>
        <b>What happened</b>
      </div>
      {stories.length > 0 ? (
        stories
      ) : (
        <div className={styles.empty}>No decisions, red validations or dropped beans so far.</div>
      )}
    </div>
  );
}

function FilesTable(props: DefaultsProps) {
  const listing = dirListing({
    paths: props.files,
    state: props.state,
    now: props.now,
    dir: 'src',
    changedOnly: true,
  });
  const stalkIdx = props.state.line.stalkIdx;
  const sproutIdx = props.state.line.commits.filter((commit) => commit.t <= props.now).length - 1;
  return (
    <div className={styles.box}>
      <div className={styles.boxhead}>
        <b>Files</b>
        <span className={styles.muted}>src</span>
        <span className={styles.right}>
          sprout #{sproutIdx}, stalk #{stalkIdx}
          {sproutIdx > stalkIdx ? `, ${sproutIdx - stalkIdx} behind` : ', caught up'}
          <Link href={`${props.base}/files`}>Browse all files</Link>
        </span>
      </div>
      <table className={styles.ftable}>
        <tbody>
          {listing.rows.map((row) => (
            <tr key={row.path}>
              <td className={styles.fname}>
                <FileIcon dir={row.dir} />
                <Link
                  href={
                    row.dir
                      ? `${props.base}/files`
                      : `${props.base}/files?file=${encodeURIComponent(row.path)}`
                  }
                >
                  {row.name}
                </Link>
              </td>
              <td className={styles.fmsg}>
                {row.last === null ? (
                  <BaseChip />
                ) : (
                  <BeanChip task={row.last.task} idx={row.last.idx} status={row.last.status} />
                )}{' '}
                {row.last === null || row.last.task === null ? (
                  <span>unchanged this run</span>
                ) : (
                  <Link href={props.hrefFor(row.last.task)}>
                    {props.titles[row.last.task] ?? row.last.task}
                  </Link>
                )}{' '}
                {row.flying.length > 0 ? (
                  <InFlightChip
                    count={row.flying.length}
                    title={row.flying
                      .map((bean) => `${bean.slot ?? ''} ${props.titles[bean.task] ?? bean.task}`)
                      .join('\n')}
                  />
                ) : null}
              </td>
              <td className={styles.fwhen}>{row.last === null ? '' : formatClock(row.last.t)}</td>
            </tr>
          ))}
          {listing.unchanged > 0 ? (
            <tr className={styles.unchanged}>
              <td colSpan={3}>and {plural(listing.unchanged, 'file')} unchanged this run</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function PhaseMark({ phase }: { readonly phase: string }) {
  if (phase === 'rework') return <i className={styles.reddot} />;
  if (phase === 'working') return <i className={styles.purple} />;
  return <i className={styles.ring} />;
}

export function phaseWord(phase: string): string {
  if (phase === 'working') return 'writing';
  if (phase === 'rework') return 'reworking';
  if (phase === 'deciding') return 'waiting on a decision';
  return phase;
}

function dropWord(reason: string): string {
  if (/conflict/.test(reason)) return 'conflict';
  if (/decision|declined/.test(reason)) return 'declined';
  if (/red/.test(reason)) return 'still red';
  return 'dropped';
}
