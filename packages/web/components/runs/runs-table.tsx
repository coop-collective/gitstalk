import { IntentLink as Link } from '../shell/intent-link';

import type { RunListing } from '@gitstalk/shared-ask/forge/forge-source';
import { formatUsd } from '../../src/race/race-format';
import styles from './runs.module.css';
import { adminRunPath } from '../../src/admin/admin-paths';

const PHASE_LABEL: Readonly<Record<RunListing['phase'], string>> = {
  created: 'Not started',
  running: 'Racing',
  finishing: 'Final check',
  done: 'Finished',
};

/** Runs as a table (a list of cards on phones): what raced, how far it got, where to look. */
export function RunsTable(props: {
  readonly title: string;
  readonly runs: readonly RunListing[];
  readonly empty: string;
}) {
  const headingId = `runs-${props.title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {props.title}
      </h2>
      {props.runs.length === 0 ? (
        <p className={styles.empty}>{props.empty}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Agents</th>
              <th scope="col">On the stalk</th>
              <th scope="col">Agent spend</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.runs.map((run) => (
              <RunRow key={run.run} run={run} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RunRow({ run }: { readonly run: RunListing }) {
  const share = run.beans === 0 ? 0 : run.green / run.beans;
  return (
    <tr>
      <td data-label="Run">
        <span className={styles.runLabel}>{run.label}</span>
        <code className={styles.runId}>race-{run.run}</code>
      </td>
      <td data-label="Agents" className="tabular">
        {run.agents}
        {run.model === null ? '' : ` ${run.model}`}
      </td>
      <td data-label="On the stalk">
        <span className={styles.green}>
          <span className="tabular">
            {run.green}/{run.beans}
          </span>
          <span className={styles.meter} aria-hidden="true">
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
        </span>
      </td>
      <td data-label="Agent spend" className="tabular">
        {formatUsd(run.costUsd)}
      </td>
      <td data-label="Status">
        <span className={run.phase === 'running' ? styles.racing : styles.phase}>
          {PHASE_LABEL[run.phase]}
        </span>
        {run.source === 'recorded' ? <span className={styles.recorded}>recorded</span> : null}
      </td>
      <td className={styles.links}>
        <Link href={adminRunPath(run.run)}>Repository</Link>
        <Link href={`${adminRunPath(run.run)}/race`}>Engine</Link>
      </td>
    </tr>
  );
}
