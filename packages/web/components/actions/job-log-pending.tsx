/**
 * The chosen job's log box while its stored log is still being read (a finished job's log
 * streams in after the page): the same head (state, name, time, search, download) and the
 * job's steps folded, so nothing moves when the lines arrive, with "reading the log…" where
 * the line count goes.
 */
import type { Job } from '../../src/actions/actions-contract';
import { elapsedMs, formatDuration, stateOf, STATE_WORDS } from '../../src/actions/run-view';
import styles from './actions.module.css';
import { StateMark } from './state-mark';

export function JobLogPending(props: {
  readonly job: Job;
  /** The log route for this job (`…/jobs/<job>/log`). */
  readonly logPath: string;
  readonly nowMs: number;
}) {
  const { job } = props;
  const state = stateOf(job);
  return (
    <section className={styles.box} aria-labelledby="job-title" aria-busy="true">
      <div className={styles.jobHead}>
        <StateMark state={state} />
        <h2 id="job-title">
          {job.name}{' '}
          <span className={styles.muted}>
            {STATE_WORDS[state]} {formatDuration(elapsedMs(job, props.nowMs))}
          </span>
        </h2>
        <form className={styles.search} role="search">
          <label htmlFor="log-search" className="visually-hidden">
            Search this job&rsquo;s log
          </label>
          <input id="log-search" type="search" placeholder="Search log" disabled />
        </form>
        <a className={styles.iconButton} href={`${props.logPath}?download=1`} download>
          Download log
        </a>
      </div>
      <div className={styles.logBox} aria-label="Job log">
        {job.steps.map((step) => (
          <details key={step.number} className={styles.step} data-state={stateOf(step)}>
            <summary>
              <StateMark state={stateOf(step)} size={14} />
              <span className={styles.stepName}>{step.name}</span>
              <span className={styles.stepTime}>
                {formatDuration(elapsedMs(step, props.nowMs))}
              </span>
            </summary>
          </details>
        ))}
      </div>
      <div className={styles.tail}>
        <span role="status">reading the log…</span>
      </div>
    </section>
  );
}
