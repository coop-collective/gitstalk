/**
 * History's validation view (it folded the earlier Stalk tab, `docs/claude-opus/20` §6-7): the
 * two lines' heads, the last week's counts, the validations' verdicts and the beans taken off,
 * read from the repo-events index. The commits themselves stay the engine's (`history-tab.tsx`).
 */
import { IntentLink as Link } from '../shell/intent-link';

import type { IndexedBean, RepoDay, RepositoryStalk } from '../../src/repositories/index-client';
import { timeAgo } from '../../src/repositories/when';
import styles from './validation.module.css';

/** The stalk's head (validated) and the sprout's (landed), as the last events left them. */
export function ValidationLines(props: { readonly lines: RepositoryStalk['lines'] }) {
  const { lines } = props;
  return (
    <div className={styles.lines}>
      <LineHead
        label="Stalk"
        sha={lines?.stalk_sha ?? null}
        tone="stalk"
        note="validated: every check green"
      />
      <LineHead
        label="Sprout"
        sha={lines?.sprout_sha ?? null}
        tone="sprout"
        note="landed: green on the merged tree"
      />
    </div>
  );
}

const WEEK_COUNTS: readonly (readonly [keyof Omit<RepoDay, 'day'>, string])[] = [
  ['landed', 'landed'],
  ['promoted', 'stalk moves'],
  ['red_validations', 'red validations'],
  ['reverted', 'reverts'],
  ['reworks', 'reworks'],
  ['decisions', 'decisions'],
];

export function ValidationWeek({ days }: { readonly days: readonly RepoDay[] }) {
  const total = (key: keyof Omit<RepoDay, 'day'>) => days.reduce((sum, day) => sum + day[key], 0);
  return (
    <dl className={styles.week} aria-label="The last 7 days">
      {WEEK_COUNTS.map(([key, label]) => (
        <div key={key} className={styles.stat}>
          <dt>{label}</dt>
          <dd>{total(key)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Every validation that judged a commit: the stalk moving, a red validation, an audit, a revert. */
export function VerdictsPanel(props: {
  readonly verdicts: RepositoryStalk['verdicts'];
  readonly nowMs: number;
}) {
  return (
    <section className={styles.panel} aria-labelledby="verdicts-title">
      <PanelHead id="verdicts-title" title="Validation verdicts" count={props.verdicts.length} />
      {props.verdicts.length === 0 ? (
        <p className={styles.empty}>No validation has finished yet.</p>
      ) : (
        <ul className={styles.activity}>
          {props.verdicts.map((line, index) => (
            <li key={`${line.at}-${index}`} data-kind={line.kind}>
              <span>
                {line.text}
                <time dateTime={line.at}>{timeAgo(line.at, props.nowMs)}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Beans taken off the sprout after a red validation, dropped, or parked for a person. */
export function TakenOffPanel(props: {
  readonly beans: readonly IndexedBean[];
  readonly base: string;
  readonly nowMs: number;
}) {
  return (
    <section className={styles.panel} aria-labelledby="off-title">
      <PanelHead id="off-title" title="Taken off or waiting" count={props.beans.length} />
      {props.beans.length === 0 ? (
        <p className={styles.empty}>Nothing reverted, dropped or parked.</p>
      ) : (
        <ul className={styles.beans}>
          {props.beans.map((bean) => (
            <li key={bean.bean} className={styles.bean}>
              <Link
                href={`${props.base}/changes/${encodeURIComponent(bean.bean)}`}
                className={styles.beanName}
              >
                {bean.bean}
              </Link>
              <span className={styles.beanTitle}>
                {bean.title === '' ? null : <>{bean.title} </>}
                <span className={styles.muted}>{bean.actor === null ? '' : `@${bean.actor}`}</span>
                {bean.reason === '' ? null : (
                  <span className={styles.reason}>
                    {bean.state}: {bean.reason}
                  </span>
                )}
              </span>
              <span className={styles.beanMeta}>
                <time dateTime={bean.updated_at}>{timeAgo(bean.updated_at, props.nowMs)}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LineHead(props: {
  readonly label: string;
  readonly sha: string | null;
  readonly tone: 'stalk' | 'sprout';
  readonly note: string;
}) {
  return (
    <div className={styles.line} data-tone={props.tone}>
      <span className={styles.lineLabel}>{props.label}</span>
      <code className={styles.lineSha} title={props.sha ?? undefined}>
        {props.sha === null ? 'at its first commit' : props.sha.slice(0, 7)}
      </code>
      <span className={styles.muted}>{props.note}</span>
    </div>
  );
}

function PanelHead(props: { readonly id: string; readonly title: string; readonly count: number }) {
  return (
    <div className={styles.panelHead}>
      <h2 id={props.id}>{props.title}</h2>
      <span className={styles.muted}>{props.count === 0 ? '' : props.count}</span>
    </div>
  );
}
