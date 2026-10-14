/**
 * The History tab: the stalk's commits, newest first, each with its bean, the person who
 * pushed it and when; above them, the sprout's commits that are not validated yet, marked as
 * such, since they are landed but not yet on the stalk. Beside them (from the repo-events
 * index, when it answers) the lines' heads, each validation's verdict, and the beans taken
 * off: one tab for landed versus validated (it folded the earlier Stalk tab).
 */
import { IntentLink as Link } from '../shell/intent-link';

import { groupCounts } from '../../src/changes/changes';
import type { Change } from '../../src/changes/changes';
import type { History, HistoryRow, Verdict } from '../../src/history/history';
import { verdictsOf } from '../../src/history/history';
import type { LineHeads } from '../../src/query/invalidation';
import type { RepositoryStalk } from '../../src/repositories/index-client';
import type { RepositoryTab } from '../../src/server/repository-tab';
import { timeAgo } from '../../src/repositories/when';
import type { GlyphKind } from './glyph';
import { Glyph } from './glyph';
import {
  TakenOffPanel,
  ValidationLines,
  ValidationWeek,
  VerdictsPanel,
} from './history-validation';
import styles from './repo-tabs.module.css';
import { repoScopeOf } from './changes-tab';
import { RepositoryShell } from './repository-shell';
import { HeadWatcher } from './use-head-watcher';

export function HistoryTab(props: {
  readonly tab: RepositoryTab;
  readonly history: History;
  readonly changes: readonly Change[];
  /** The index's validation view; null when it did not answer (commits only). */
  readonly validation: RepositoryStalk | null;
  /** Each line's newest commit as rendered ('' for a line with none), and the newest event. */
  readonly rendered: { readonly heads: LineHeads; readonly seq: number };
  readonly nowMs: number;
}) {
  const { tab, validation } = props;
  return (
    <RepositoryShell page={tab} tab="history" openChanges={groupCounts(props.changes).open}>
      <HeadWatcher
        scope={repoScopeOf(tab)}
        heads={props.rendered.heads}
        seq={props.rendered.seq}
        activity
      />
      {validation === null ? null : (
        <>
          <ValidationLines lines={validation.lines} />
          <ValidationWeek days={validation.days} />
        </>
      )}
      <div className={validation === null ? styles.single : styles.split}>
        <div>
          <CommitLines
            history={props.history}
            verdicts={verdictsOf(validation?.verdicts ?? [])}
            base={tab.base}
            nowMs={props.nowMs}
          />
        </div>
        {validation === null ? null : (
          <aside className={styles.validationColumn}>
            <VerdictsPanel verdicts={validation.verdicts} nowMs={props.nowMs} />
            <TakenOffPanel beans={validation.off} base={tab.base} nowMs={props.nowMs} />
          </aside>
        )}
      </div>
    </RepositoryShell>
  );
}

/** The sprout's commits not validated yet (marked so), then the stalk's. */
function CommitLines(props: {
  readonly history: History;
  readonly verdicts: ReadonlyMap<string, Verdict>;
  readonly base: string;
  readonly nowMs: number;
}) {
  const { history } = props;
  const rows = { verdicts: props.verdicts, base: props.base, nowMs: props.nowMs };
  return (
    <>
      {history.pending.length === 0 ? null : (
        <section className={`${styles.box} ${styles.pendingBox}`} aria-labelledby="pending-title">
          <div className={styles.boxHead}>
            <Glyph kind="sprout" />
            <h2 id="pending-title" className={styles.headTitle}>
              On the sprout, not validated yet
            </h2>
            <span className={styles.headMeta}>
              {history.pending.length} {history.pending.length === 1 ? 'commit' : 'commits'}
            </span>
          </div>
          <Commits rows={history.pending} glyph="sprout" line="sprout" {...rows} />
        </section>
      )}
      <section className={styles.box} aria-labelledby="stalk-title">
        <div className={styles.boxHead}>
          <Glyph kind="stalk" />
          <h2 id="stalk-title" className={styles.headTitle}>
            The stalk
          </h2>
          <span className={styles.headMeta}>
            {history.stalk.length} {history.stalk.length === 1 ? 'commit' : 'commits'}
          </span>
        </div>
        {history.stalk.length === 0 ? (
          <p className={styles.empty}>Nothing is on the stalk yet.</p>
        ) : (
          <Commits rows={history.stalk} glyph="stalk" line="stalk" {...rows} />
        )}
      </section>
    </>
  );
}

/** What a commit's row says about its validation: the index's verdict, else its line's state. */
function VerdictPill(props: {
  readonly line: 'sprout' | 'stalk';
  readonly verdict: Verdict | undefined;
  readonly nowMs: number;
}) {
  const { verdict } = props;
  if (verdict === undefined)
    return props.line === 'sprout' ? (
      <span className={styles.state} data-state="landed">
        landed, not validated yet
      </span>
    ) : null;
  const word = {
    validated: ['validated', 'validated'],
    red: ['red', 'validation red'],
    demoted: ['validated', 'stalk went back here'],
    reverted: ['red', 'reverted'],
  }[verdict.kind];
  return (
    <span className={styles.state} data-state={word[0]} title={verdict.text}>
      {word[1]} {timeAgo(verdict.at, props.nowMs)}
    </span>
  );
}

function Commits(props: {
  readonly rows: readonly HistoryRow[];
  readonly glyph: GlyphKind;
  readonly line: 'sprout' | 'stalk';
  readonly verdicts: ReadonlyMap<string, Verdict>;
  readonly base: string;
  readonly nowMs: number;
}) {
  return (
    <ol className={styles.commits}>
      {props.rows.map((row) => (
        <li key={row.sha}>
          <Glyph kind={row.root ? 'seed' : props.glyph} />
          <span className={styles.commitTitle}>
            {row.bean === null ? (
              row.title
            ) : (
              <Link href={`${props.base}/changes/${encodeURIComponent(row.bean)}`}>
                {row.title}
              </Link>
            )}
          </span>
          <Link
            href={`${props.base}/tree?ref=${encodeURIComponent(row.sha)}`}
            className={styles.sha}
            title="Browse the files at this commit"
          >
            {row.sha.slice(0, 7)}
          </Link>
          <span className={styles.commitMeta}>
            {row.root ? (
              <span>
                Fertilized by{' '}
                {row.by.kind === 'person' ? `@${row.by.name}` : props.base.split('/')[1]}
              </span>
            ) : (
              <span className={styles.person}>
                {row.by.kind === 'person' ? `@${row.by.name}` : row.by.name}
              </span>
            )}
            {row.bean === null ? null : <span className={styles.beanName}>bean/{row.bean}</span>}
            <VerdictPill
              line={props.line}
              verdict={props.verdicts.get(row.sha)}
              nowMs={props.nowMs}
            />
            {row.at === null ? null : (
              <time dateTime={new Date(row.at).toISOString()}>
                {timeAgo(new Date(row.at).toISOString(), props.nowMs)}
              </time>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
