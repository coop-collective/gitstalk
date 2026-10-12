'use client';

/**
 * A run's head and job graph, kept current while the run can still change: the page's server
 * render seeds a query, which polls the run route every few seconds while the run is live
 * (TanStack Query pauses it in a hidden tab). Cancel and Re-run show their result at once and
 * roll back if the control plane refuses. When the run finishes, the page is rendered once
 * more so what only the server reads (annotations, summary, the job's stored log) catches up.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IntentLink as Link } from '../shell/intent-link';
import { useRouter } from 'next/navigation';
import { useEffect, useOptimistic, useRef } from 'react';

import type { RunDetail } from '../../src/actions/actions-contract';
import type { RunIntent } from '../../src/actions/run-view';
import {
  actorLabel,
  elapsedMs,
  eventWord,
  formatDuration,
  isLive,
  isRunDetail,
  optimisticRun,
  runTitle,
  sectionOf,
  stateOf,
  STATE_WORDS,
} from '../../src/actions/run-view';
import { fetchJson } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import { timeAgo } from '../../src/repositories/when';
import type { ActionsAccess } from '../../src/server/actions-page';
import styles from './actions.module.css';
import { JobGraph } from './job-graph';
import { RunControls } from './run-controls';
import { StateMark } from './state-mark';

const POLL_MS = 4000;

export function RunStatus(props: {
  /** The viewer's id, or null: part of the query key. */
  readonly uid: string | null;
  readonly owner: string;
  readonly repo: string;
  readonly base: string;
  readonly apiBase: string;
  /** The run as the server rendered it, at `nowMs`. */
  readonly initial: RunDetail;
  readonly nowMs: number;
  readonly jobId: string | null;
  readonly access: ActionsAccess | null;
}) {
  const { initial, nowMs, base } = props;
  const queryClient = useQueryClient();
  const router = useRouter();
  const queryKey = qk.repo(props.uid, props.owner, props.repo).run(initial.id);
  const { data: run, dataUpdatedAt } = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      fetchJson(`${props.apiBase}/runs/${encodeURIComponent(initial.id)}`, isRunDetail, { signal }),
    initialData: initial,
    initialDataUpdatedAt: nowMs,
    refetchInterval: (query) => (isLive(stateOf(query.state.data ?? initial)) ? POLL_MS : false),
  });
  // A newer server render (navigation, or the refresh below) is fresher than what is cached.
  useEffect(() => {
    queryClient.setQueryData(queryKey, initial, { updatedAt: nowMs });
    // queryKey is a new array each render; its parts are the dependencies.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [queryClient, initial, nowMs]);

  const wasLive = useRef(isLive(stateOf(run)));
  const live = isLive(stateOf(run));
  useEffect(() => {
    if (wasLive.current && !live) router.refresh();
    wasLive.current = live;
  }, [live, router]);

  const [shown, setIntent] = useOptimistic<RunDetail, RunIntent>(run, optimisticRun);
  const state = stateOf(shown);
  const section = sectionOf(shown.workflowPath);
  const runPath = `${base}/${section}/runs/${encodeURIComponent(shown.id)}`;
  const now = Math.max(nowMs, dataUpdatedAt);
  return (
    <>
      <header className={styles.runHead}>
        <StateMark state={state} size={20} />
        <h1>{runTitle(shown)}</h1>
        <p className={styles.runFacts}>
          <b>
            {shown.workflowName} #{shown.number}
          </b>
          <span>{eventWord(shown.event)}</span>
          <Link
            prefetch={false}
            className={styles.sha}
            href={`${base}/tree?ref=${encodeURIComponent(shown.sha)}`}
          >
            {shown.sha.slice(0, 7)}
          </Link>
          {shown.bean === null ? null : (
            <Link
              prefetch={false}
              className={styles.bean}
              href={`${base}/changes/${encodeURIComponent(shown.bean)}`}
            >
              bean/{shown.bean}
            </Link>
          )}
          <span>{actorLabel(shown.actor)}</span>
          <time dateTime={shown.createdAt}>{timeAgo(shown.createdAt, now)}</time>
        </p>
        {props.access === null ? null : (
          <RunControls
            runId={run.id}
            live={live}
            canRerun={run.canRerun}
            access={props.access}
            runKey={queryKey}
            onIntent={setIntent}
          />
        )}
      </header>
      {shown.reason === null ? null : (
        <p className={styles.reason} role="note">
          {shown.reason}
        </p>
      )}
      <section className={styles.box} aria-label="Run">
        <dl className={styles.facts}>
          <div>
            <dt>Status</dt>
            <dd>{STATE_WORDS[state]}</dd>
          </div>
          <div>
            <dt>Wall time</dt>
            <dd>{formatDuration(elapsedMs(shown, now)) || 'waiting'}</dd>
          </div>
          <div>
            <dt>Minutes billed</dt>
            <dd>{shown.billedMinutes}</dd>
          </div>
          <div>
            <dt>Line</dt>
            <dd>{shown.branch}</dd>
          </div>
          {Object.entries(shown.inputs).map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div>
            <dt>Workflow</dt>
            <dd>
              <Link
                prefetch={false}
                href={`${base}/blob/${shown.workflowPath.split('/').map(encodeURIComponent).join('/')}`}
              >
                {shown.workflowPath.split('/').at(-1)}
              </Link>
            </dd>
          </div>
        </dl>
        <div className={styles.boxHead}>
          <h2>Jobs</h2>
          <span className={styles.muted}>
            {shown.jobs.length} {shown.jobs.length === 1 ? 'job' : 'jobs'}
            {(shown.jobs[0]?.runsOn ?? '') === '' ? '' : ` · runs-on ${shown.jobs[0]?.runsOn}`}
          </span>
        </div>
        {shown.jobs.length === 0 ? (
          <p className={styles.empty}>This run has no jobs.</p>
        ) : (
          <JobGraph jobs={shown.jobs} selected={props.jobId} runPath={runPath} nowMs={now} />
        )}
      </section>
    </>
  );
}
