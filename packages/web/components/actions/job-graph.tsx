/**
 * A run's jobs as a graph (`needs:` is the edges): a column per depth, stems from each job to
 * the jobs that wait for it. A stem glows and flows only into a job running now; finished
 * stems are the stalk's green. Each job opens its steps and log below (`?job=`). Wide graphs
 * scroll inside their box, never the page.
 */
import { IntentLink as Link } from '../shell/intent-link';

import type { Job } from '../../src/actions/actions-contract';
import type { RunState } from '../../src/actions/run-view';
import {
  elapsedMs,
  formatDuration,
  jobColumns,
  stateOf,
  STATE_WORDS,
} from '../../src/actions/run-view';
import styles from './actions.module.css';
import { StateMark } from './state-mark';

const NODE_W = 196;
const NODE_H = 54;
const COLUMN_GAP = 56;
const ROW_GAP = 14;

type Placed = { readonly job: Job; readonly x: number; readonly y: number };

export function JobGraph(props: {
  readonly jobs: readonly Job[];
  readonly selected: string | null;
  readonly runPath: string;
  readonly nowMs: number;
}) {
  const columns = jobColumns(props.jobs);
  const placed = new Map<string, Placed>(
    columns.flatMap((column, x) =>
      column.map(
        (job, y) =>
          [job.id, { job, x: x * (NODE_W + COLUMN_GAP), y: y * (NODE_H + ROW_GAP) }] as const,
      ),
    ),
  );
  const rows = Math.max(1, ...columns.map((column) => column.length));
  const width = columns.length * (NODE_W + COLUMN_GAP) - COLUMN_GAP;
  const height = rows * (NODE_H + ROW_GAP) - ROW_GAP;
  return (
    <div className={styles.graphScroll}>
      <div className={styles.graph} style={{ width, height }}>
        <svg className={styles.stems} width={width} height={height} aria-hidden="true">
          {[...placed.values()].flatMap((to) =>
            to.job.needs.flatMap((id) => {
              const from = placed.get(id);
              if (from === undefined) return [];
              return [
                <path
                  key={`${id}-${to.job.id}`}
                  className={styles.stem}
                  data-state={stemState(stateOf(from.job), stateOf(to.job))}
                  d={stemPath(from, to)}
                />,
              ];
            }),
          )}
        </svg>
        {[...placed.values()].map(({ job, x, y }) => {
          const state = stateOf(job);
          return (
            <Link
              key={job.id}
              href={`${props.runPath}?job=${encodeURIComponent(job.id)}`}
              scroll={false}
              className={styles.node}
              data-state={state}
              aria-current={props.selected === job.id ? 'true' : undefined}
              style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
              title={`${job.name}: ${STATE_WORDS[state]}`}
            >
              <StateMark state={state} />
              <span className={styles.nodeName}>{job.name}</span>
              <span className={styles.nodeTime}>
                {formatDuration(elapsedMs(job, props.nowMs)) || STATE_WORDS[state]}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function stemState(from: RunState, to: RunState): string {
  if (to === 'running') return 'running';
  if (from === 'success' && to !== 'skipped' && to !== 'queued') return 'success';
  return 'waiting';
}

function stemPath(from: Placed, to: Placed): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const bend = (x2 - x1) / 2;
  return `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
