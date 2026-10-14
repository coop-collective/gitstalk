'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo } from 'react';

import type { Pushers, SessionDirectory } from '@gitstalk/shared-ask/home/sessions';
import { stalkRows } from '@gitstalk/shared-ask/home/stalk';
import type { PickReceipt } from '@gitstalk/shared-ask/pick/picker';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RaceOptions, RaceState } from '@gitstalk/shared-ask/race/race-state';
import { reduceRace } from '@gitstalk/shared-ask/race/reduce-race';
import { lastPushLine, sessionsActiveLine } from '../../src/people/contributor-line';
import { formatClock, plural } from '../../src/race/race-format';
import type { LiveStatus } from '../canvas/use-live-events';
import { useLiveEvents } from '../canvas/use-live-events';
import { useLiveNow } from '../canvas/use-live-now';
import type { ReplayClock } from '../canvas/use-replay-clock';
import { SPEEDS, useReplayClock } from '../canvas/use-replay-clock';
import { AskBox } from './ask-box';
import { HomeDefaults } from './home-defaults';
import { LiveStreamsProvider } from './live-streams';
import type { HomeState } from './home-url';
import { askHomeHref, beanHref } from './home-url';
import styles from './home.module.css';
import { PicksDrawer } from './receipts';
import { StalkList } from './stalk-list';

export type HomeWorkspaceProps = {
  readonly run: string;
  /** Where the repository lives: `/runs/<run>` for a race, `/<owner>/<repo>` for a repository. */
  readonly base: string;
  readonly owner: string;
  readonly mode: 'replay' | 'live';
  readonly events: readonly RaceEvent[];
  readonly options: RaceOptions;
  readonly titles: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly sessions: SessionDirectory;
  /** Who pushed each bean (a repository's); empty for races. */
  readonly pushers: Pushers;
  /** A race names agent sessions; a repository names the people who push. */
  readonly subject: 'race' | 'repository';
  readonly url: HomeState;
  /** Beans an answer is about (their leaves stay bright); null when nothing is asked. */
  readonly relevant: readonly string[] | null;
  /** Questions in the picker's order, for the Ask's completions and examples. */
  readonly questions: readonly string[];
  readonly suggestReceipt: PickReceipt | null;
  readonly receipts: readonly PickReceipt[];
  /** The model that orders the lists (`Clef Flash`); null when fixed rules do. */
  readonly pickerModel: string | null;
  /** The server-rendered explorer for a question or a bean; the defaults when absent. */
  readonly children?: ReactNode;
};

/**
 * The repository home: the compressed stalk at the playhead on the left, the generated
 * explorer on the right, the status line below. A recorded run replays; a live one follows
 * its events as they arrive.
 */
export function HomeWorkspace(props: HomeWorkspaceProps) {
  const live = useLiveEvents(props.run, props.events, props.mode === 'live');
  const events = props.mode === 'live' ? live.events : props.events;
  const end = raceEnd(events);
  const clock = useReplayClock({ end, initial: props.url.t ?? end, speed: 10 });
  const settled = useMemo(() => reduceRace(events, props.options), [events, props.options]);
  const liveNow = useLiveNow(settled.epochMs, settled.endedAt, settled.clock);
  const now = props.mode === 'replay' ? clock.now : liveNow;
  const count = props.mode === 'replay' ? countUpTo(events, now) : events.length;
  const visible = useMemo(() => events.slice(0, count), [events, count]);
  const state = useMemo(
    () => (count === events.length ? settled : reduceRace(visible, props.options)),
    [count, events.length, settled, visible, props.options],
  );
  const finished = state.endedAt !== null && now >= state.endedAt;
  const url = useMemo(
    (): HomeState => ({
      ...props.url,
      t: finished || props.mode === 'live' ? null : Math.round(now),
    }),
    [props.url, finished, props.mode, now],
  );
  const rows = useMemo(
    () => stalkRows({ state, events: visible, now, titles: props.titles }),
    [state, visible, now, props.titles],
  );
  const relevant = useMemo(
    () => (props.relevant === null ? null : new Set(props.relevant)),
    [props.relevant],
  );
  const hrefFor = useCallback((bean: string) => beanHref(props.base, url, bean), [props.base, url]);
  const askHref = useCallback((q: string) => askHomeHref(props.base, url, q), [props.base, url]);
  const validating = visible.some((event) => event.type === 'green.promote' && event.t > now - 6);
  useUrlTime(props.mode === 'replay' && !clock.playing && !finished ? now : null);
  return (
    <LiveStreamsProvider run={props.run} enabled={props.mode === 'live'}>
      <div className={styles.home}>
        <aside
          className={`${styles.stalkcol} ${relevant === null ? '' : styles.asking} ${validating ? styles.validating : ''}`}
          aria-label="The beanstalk"
        >
          <div className={styles.stalkhead}>
            <b>The beanstalk</b>
            <span>
              {state.line.commits.filter((commit) => commit.t <= now).length} landed,{' '}
              {rows.filter((row) => row.kind === 'bean').length} growing
            </span>
          </div>
          <div className={styles.stalkscroll}>
            <StalkList
              rows={rows}
              owner={props.owner}
              pushers={props.pushers}
              relevant={relevant}
              selected={props.url.bean}
              hrefFor={hrefFor}
            />
          </div>
          {props.mode === 'replay' ? <Scrubber clock={clock} /> : null}
        </aside>
        <section className={styles.explorer} aria-label="Explorer">
          <AskBox
            base={props.base}
            q={props.url.q}
            t={url.t}
            questions={props.questions.map((q) => ({ q, href: askHref(q) }))}
            receipt={props.suggestReceipt}
          />
          {props.children ?? (
            <HomeDefaults
              base={props.base}
              state={state}
              now={now}
              files={props.files}
              titles={props.titles}
              sessions={props.sessions}
              pushers={props.pushers}
              hrefFor={hrefFor}
              askHref={askHref}
            />
          )}
        </section>
      </div>
      <StatusLine
        state={state}
        now={now}
        sessions={props.sessions}
        pushers={props.pushers}
        subject={props.subject}
        mode={props.mode}
        liveStatus={live.status}
        receipts={props.receipts}
        pickerModel={props.pickerModel}
      />
    </LiveStreamsProvider>
  );
}

function Scrubber({ clock }: { readonly clock: ReplayClock }) {
  return (
    <div className={styles.scrub}>
      <button
        type="button"
        className={styles.play}
        onClick={clock.toggle}
        aria-label={clock.playing ? 'Pause' : 'Play the run'}
      >
        {clock.playing ? '❚❚' : '▶'}
      </button>
      <span>
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            className={styles.speed}
            aria-pressed={clock.speed === speed}
            onClick={() => clock.setSpeed(speed)}
          >
            {speed}×
          </button>
        ))}
      </span>
      <input
        type="range"
        aria-label="Moment of the run"
        min={0}
        max={Math.round(clock.end)}
        value={Math.round(clock.now)}
        onChange={(event) => clock.seek(Number(event.target.value))}
      />
      <output className={styles.clock}>
        {formatClock(clock.now)} of {formatClock(clock.end)}
      </output>
    </div>
  );
}

/** The editor-style status line: the lines, the sprout's health, who is at work, the picks. */
function StatusLine(props: {
  readonly state: RaceState;
  readonly now: number;
  readonly sessions: SessionDirectory;
  readonly pushers: Pushers;
  readonly subject: 'race' | 'repository';
  readonly mode: 'replay' | 'live';
  readonly liveStatus: LiveStatus;
  readonly receipts: readonly PickReceipt[];
  /** The model that orders the lists (`Clef Flash`); null when fixed rules do. */
  readonly pickerModel: string | null;
}) {
  const { state } = props;
  const sprout = state.line.commits.filter((commit) => commit.t <= props.now).length - 1;
  const validations = state.ci.filter((run) => run.purpose === 'validate' && run.green !== null);
  const red = validations.at(-1)?.green === false;
  const growing = Object.values(state.beans).filter(
    (bean) =>
      bean.startedAt !== null && !['pending', 'landed', 'green', 'dropped'].includes(bean.phase),
  ).length;
  return (
    <footer className={styles.statusline} aria-label="Status">
      <span className={styles.sl}>
        <i className={styles.sldot} style={{ background: 'var(--sprout)' }} />
        sprout #{sprout}
      </span>
      <span className={styles.sl}>
        <i
          className={styles.sldot}
          style={{ background: 'var(--good-fill)', boxShadow: '0 0 6px var(--glow)' }}
        />
        stalk #{state.line.stalkIdx}
      </span>
      <span className={styles.sl} data-red={red ? '' : undefined}>
        {red ? 'sprout red' : 'sprout green'}
      </span>
      <span className={styles.sl}>
        <i className={styles.sldot} style={{ background: 'var(--human-fill)' }} />
        {plural(growing, 'bean')} growing
      </span>
      <span className={styles.sl}>
        {props.subject === 'race'
          ? sessionsActiveLine(state, props.sessions)
          : lastPushLine(state, props.pushers)}
      </span>
      <span className={styles.slsp} />
      <PicksDrawer receipts={props.receipts} pickerModel={props.pickerModel} />
      <span className={styles.sl} style={{ borderLeft: '1px solid var(--rule)' }}>
        {props.mode === 'live' ? props.liveStatus : 'replay'}
      </span>
      <span className={styles.sl} style={{ color: 'var(--ink)' }}>
        {formatClock(props.now)}
      </span>
    </footer>
  );
}

function raceEnd(events: readonly RaceEvent[]): number {
  const ended = events.findLast((event) => event.type === 'race.end');
  return ended?.t ?? events.at(-1)?.t ?? 0;
}

/** How many events happened by race second `t` (events are in time order). */
function countUpTo(events: readonly RaceEvent[], t: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((events[middle]?.t ?? Number.POSITIVE_INFINITY) <= t) low = middle + 1;
    else high = middle;
  }
  return low;
}

function useUrlTime(t: number | null): void {
  useEffect(() => {
    if (t === null) return undefined;
    const timer = window.setTimeout(() => {
      const next = new URL(window.location.href);
      next.searchParams.set('t', String(Math.round(t)));
      window.history.replaceState(window.history.state, '', next);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [t]);
}
