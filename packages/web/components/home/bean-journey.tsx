'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { BeanStreamView } from '@gitstalk/shared-ask/forge/bean-stream';

import type { FileDiff } from '@gitstalk/shared-ask/repo/repo-types';
import type { JourneyTone } from '@gitstalk/shared-ask/home/journey';
import { beanDiffPath, isRepoDiff } from '../../src/changes/change-feed';
import { fetchJson, isHttpStatus } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import { formatClock, formatSpan, plural } from '../../src/race/race-format';
import styles from './home.module.css';
import { useBeanStream, useStreamRun } from './live-streams';
import { DiffFiles } from './marks';
import { StreamingDiff } from './streaming-diff';

/** One step of a bean's journey as the card lists it. */
export type JourneyItem = {
  readonly id: string;
  readonly t: number;
  readonly tone: JourneyTone | 'all';
  readonly text: string;
  /** The step's facts (files, failing tests, a reason). */
  readonly detail: string;
  /** The step is happening now: a spinner instead of a dot. */
  readonly live: boolean;
  /** Its detail shows the bean's change. */
  readonly showsChange: boolean;
  /** The agent's own report, for the steps it wrote. */
  readonly report: string | null;
};

export type JourneyBean = {
  readonly id: string;
  readonly title: string;
  readonly intent: string;
  readonly status: { readonly word: string; readonly tone: string };
  readonly session: string;
  readonly landedIdx: number | null;
  readonly reworks: number;
};

/**
 * A bean's journey: its steps on the left ("All changes" first and selected), the selected
 * step's details or files on the right. A step in progress spins.
 */
export function BeanJourney(props: {
  readonly bean: JourneyBean;
  readonly steps: readonly JourneyItem[];
  readonly files: readonly FileDiff[];
  readonly now: number;
  readonly initialStep: string | null;
}) {
  const [selected, setSelected] = useState(
    props.steps.some((step) => step.id === props.initialStep)
      ? (props.initialStep ?? 'all')
      : 'all',
  );
  const choose = (id: string) => {
    setSelected(id);
    const url = new URL(window.location.href);
    if (id === 'all') url.searchParams.delete('step');
    else url.searchParams.set('step', id);
    window.history.replaceState(window.history.state, '', url);
  };
  const step = props.steps.find((item) => item.id === selected);
  const { bean } = props;
  const { stream, files } = useStreamUntilCommitted(bean.id, props.files);
  return (
    <div className={styles.box}>
      <div className={styles.beanhead}>
        <h3>{bean.title}</h3>
        <div className={styles.meta}>
          <span className={styles.chip} data-tone={bean.status.tone}>
            {bean.status.word}
          </span>
          <span>{bean.id}</span>
          <span>{bean.session}</span>
          {bean.landedIdx === null ? null : <span>#{bean.landedIdx}</span>}
          {bean.reworks > 0 ? (
            <span className={styles.chip} data-tone="red">
              {plural(bean.reworks, 'rework')}
            </span>
          ) : null}
        </div>
        <p>{withCode(bean.intent.split('\n\n')[0] ?? '')}</p>
      </div>
      <div className={styles.jgrid}>
        <ol className={styles.journey} role="listbox" aria-label="Its journey">
          {props.steps.map((item) => (
            <li
              key={item.id}
              role="option"
              aria-selected={item.id === selected}
              data-tone={item.tone}
              data-live={item.live ? '' : undefined}
              tabIndex={0}
              onClick={() => choose(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  choose(item.id);
                }
              }}
            >
              {item.tone === 'all' ? null : (
                <span className={styles.jt}>{formatClock(item.t)}</span>
              )}
              {item.text}
              {item.live ? <span className={styles.livetag}>live</span> : null}
            </li>
          ))}
        </ol>
        <div className={styles.jdetail}>
          <StepDetail
            step={step}
            files={files}
            now={props.now}
            landed={bean.landedIdx !== null}
            stream={stream}
          />
        </div>
      </div>
    </div>
  );
}

function StepDetail(props: {
  readonly step: JourneyItem | undefined;
  readonly files: readonly FileDiff[];
  readonly now: number;
  readonly landed: boolean;
  readonly stream: LiveChange | null;
}) {
  const { step, files, stream } = props;
  const onAll = step === undefined || step.tone === 'all';
  if (stream !== null && (onAll || (stream.kind === 'stream' && step.live))) {
    return <LiveChangeView change={stream} files={files} landed={props.landed} />;
  }
  if (step === undefined || step.tone === 'all') {
    if (files.length === 0) return <div className={styles.empty}>No change yet.</div>;
    return (
      <>
        <div className={styles.jnote}>
          {plural(files.length, 'file')}, its whole change{' '}
          {props.landed ? 'as it landed' : 'so far'}
        </div>
        <DiffFiles files={files} />
      </>
    );
  }
  return (
    <>
      <div className={styles.cardbody}>
        <p className={styles.stephead}>
          <span className={styles.jt}>{formatClock(step.t)}</span>
          {step.text}
        </p>
        {step.live && step.tone === 'plan' ? (
          <>
            <p>
              Running for {formatSpan(props.now - step.t)}: the change is merged onto the
              sprout&apos;s current head and the whole suite runs on that exact tree. Checks here
              take about 70 s.
            </p>
            <div className={styles.progress}>
              <i style={{ width: `${Math.min(96, ((props.now - step.t) / 70) * 100)}%` }} />
            </div>
          </>
        ) : null}
        {step.detail === '' ? null : <p>{step.detail}</p>}
        {step.report === null ? null : (
          <blockquote className={styles.report}>{step.report}</blockquote>
        )}
      </div>
      {step.showsChange && files.length > 0 ? (
        <DiffFiles files={files} open={1} lines={24} />
      ) : null}
    </>
  );
}

/**
 * `stream`: the bean's streamed change, while its agent writes and after, until the page has
 * the commit. `committed`: the commit that replaced the stream while the reader watched, drawn
 * by the same view so the swap moves nothing.
 */
type LiveChange =
  | { readonly kind: 'stream'; readonly view: BeanStreamView; readonly writing: boolean }
  | { readonly kind: 'committed'; readonly view: BeanStreamView };

function LiveChangeView(props: {
  readonly change: LiveChange;
  readonly files: readonly FileDiff[];
  readonly landed: boolean;
}) {
  const { change } = props;
  const { summary } = change.view;
  const writing = change.kind === 'stream' && change.writing;
  const files = change.kind === 'stream' ? change.view.files : props.files;
  return (
    <>
      {change.kind === 'stream' ? (
        <div className={styles.jnote} data-stream-seq={summary.seq}>
          <span className={styles.chip} data-tone="fly">
            <i className={styles.mdot} />
            {writing ? 'streaming' : 'finished writing'}
          </span>{' '}
          {plural(files.length, 'file')} so far, +{summary.additions} −{summary.deletions}
          {summary.truncated ? ', cut to fit' : ''}
          {writing ? '' : '; its commit is on the way'}
        </div>
      ) : (
        <div className={`${styles.jnote} ${styles.settle}`}>
          {plural(files.length, 'file')}, its whole change{' '}
          {props.landed ? 'as it landed' : 'so far'}
        </div>
      )}
      <StreamingDiff
        files={files}
        snapshot={{
          key: change.kind === 'stream' ? `${summary.inv}:${summary.seq}` : 'commit',
          inv: summary.inv,
          mode: change.kind === 'stream' ? 'stream' : 'commit',
        }}
        writer={writing ? summary.agent : null}
      />
    </>
  );
}

/**
 * The bean's streamed change while its agent writes; after the stream ends, the last
 * snapshot until the bean's committed files are read again (`useCommittedFiles`), then the
 * commit in the same view.
 */
function useStreamUntilCommitted(
  bean: string,
  serverFiles: readonly FileDiff[],
): { readonly stream: LiveChange | null; readonly files: readonly FileDiff[] } {
  const { view, writing } = useBeanStream(bean);
  const ended = !writing && view !== null;
  const files = useCommittedFiles(bean, serverFiles, ended);
  const [endedWith, setEndedWith] = useState<readonly unknown[] | null>(null);
  useEffect(() => {
    if (!ended) {
      setEndedWith(null);
      return;
    }
    setEndedWith((current) => current ?? files);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- capture the files once, when the stream ends
  }, [ended]);
  return { stream: liveChangeOf({ bean, view, writing, endedWith, files }), files };
}

function liveChangeOf(input: {
  readonly bean: string;
  readonly view: BeanStreamView | null;
  readonly writing: boolean;
  readonly endedWith: readonly unknown[] | null;
  readonly files: readonly FileDiff[];
}): LiveChange | null {
  const { view, writing, endedWith, files } = input;
  if (view === null || view.summary.task !== input.bean) return null;
  if (writing) return { kind: 'stream', view, writing };
  if (endedWith === null || endedWith === files) return { kind: 'stream', view, writing };
  return files.length === 0 ? null : { kind: 'committed', view };
}

/**
 * The bean's files: the server's until a stream of it ends, then its committed change read
 * again through the engine's diff route (each later stream's end invalidates the query).
 *
 * The home knows the engine run but not the viewer, so the key's viewer segment is the
 * anonymous one: the data is the run's own (the route answers whoever may read the run), it
 * is dropped as soon as the card unmounts (`gcTime: 0`), and `QueryProvider` clears the
 * cache whenever the viewer changes.
 */
function useCommittedFiles(
  bean: string,
  serverFiles: readonly FileDiff[],
  ended: boolean,
): readonly FileDiff[] {
  const run = useStreamRun();
  const queryClient = useQueryClient();
  const queryKey = qk.repo(null, 'runs', run).bean(bean);
  const committed = useQuery({
    queryKey,
    queryFn: ({ signal }) => readBeanFiles(beanDiffPath(run, bean), signal),
    enabled: ended && run !== '',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  useEffect(() => {
    // The first end enables the query (it fetches); a later end reads the newer commit.
    if (ended && queryClient.getQueryData(queryKey) !== undefined)
      void queryClient.invalidateQueries({ queryKey, exact: true });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- queryKey is rebuilt every render; run and bean stand for it
  }, [ended, queryClient, run, bean]);
  return committed.data ?? serverFiles;
}

/** The committed files, or null while the bean has no change (the route's 404). */
async function readBeanFiles(
  path: string,
  signal: AbortSignal,
): Promise<readonly FileDiff[] | null> {
  try {
    return (await fetchJson(path, isRepoDiff, { signal })).files;
  } catch (error: unknown) {
    if (isHttpStatus(error, 404)) return null;
    throw error;
  }
}

function withCode(text: string) {
  return text
    .split(/(`[^`]+`)/)
    .map((part, index) =>
      part.startsWith('`') && part.endsWith('`') ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}
