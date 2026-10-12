'use client';

/**
 * One bean, kept live in the browser: where it stands and who brought it, its journey (each
 * push, check and verdict, with the failing tests and the landed beans it collided with, then
 * landing, validation and any decision), its diff, and the engine's last word to the pusher.
 * Derived from the same queries as the Changes list (`useChangesFeed`); the feed stays open
 * until the bean is settled (validated, parked or fallen off).
 */
import type { QueryKey } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RepoScope } from '../../src/changes/change-feed';
import { changesBeanDiff } from '../../src/changes/change-feed';
import type { Change } from '../../src/changes/changes';
import {
  authorText,
  changesOf,
  isSettledState,
  latestActivityMs,
  stateText,
} from '../../src/changes/changes';
import { qk } from '../../src/query/keys';
import { timeAgo } from '../../src/repositories/when';
import { BeanDiff } from './bean-diff';
import { ChangeGlyph } from './change-glyph';
import { LiveBadge } from './live-badge';
import styles from './repo-tabs.module.css';
import { useChangesFeed } from './use-changes-feed';

const at = (ms: number): string => new Date(ms).toISOString();

export function ChangeView(props: {
  readonly scope: RepoScope;
  readonly engine: string;
  readonly bean: string;
  /** Where its files are browsed (computed by the server, which has the ref helpers). */
  readonly filesHref: string;
  /** Whether the bean was settled when the server rendered (its feed then never opens). */
  readonly settled: boolean;
  readonly nowMs: number;
}) {
  const { scope, bean } = props;
  const [settled, setSettled] = useState(props.settled);
  const staleAfter = useCallback(
    (fresh: readonly RaceEvent[]): readonly QueryKey[] =>
      changesBeanDiff(fresh, bean) ? [qk.repo(scope.uid, scope.owner, scope.repo).bean(bean)] : [],
    [scope.uid, scope.owner, scope.repo, bean],
  );
  const feed = useChangesFeed(scope, { live: !settled, staleAfter });
  const changes = useMemo(() => changesOf(feed.events, feed.pushed), [feed.events, feed.pushed]);
  const change = changes.find((candidate) => candidate.bean === bean);
  // Derived state, adjusted while rendering: the feed closes once the bean settles.
  const isSettled = change !== undefined && isSettledState(change.state);
  if (isSettled !== settled) setSettled(isSettled);
  if (change === undefined) return <p className={styles.empty}>No bean named {bean} here.</p>;
  const verdict = feed.pushed.find((pushed) => pushed.bean === bean)?.verdict ?? [];
  const nowMs = latestActivityMs([change], props.nowMs);
  return (
    <>
      <div className={styles.bar}>
        <Link href={`${scope.base}/changes?show=${change.group}`} className={styles.back}>
          All changes
        </Link>
        <LiveBadge status={feed.status} enabled={!settled} />
      </div>
      <ChangeHeader change={change} filesHref={props.filesHref} />
      <div className={styles.split}>
        <div>
          <Journey change={change} base={scope.base} nowMs={nowMs} />
          <BeanDiff scope={scope} engine={props.engine} bean={bean} />
        </div>
        <aside className={styles.aside} aria-label="What the push was told">
          <section>
            <h2>What the push was told</h2>
            {verdict.length === 0 ? (
              <p>{change.reason === '' ? 'No verdict yet.' : change.reason}</p>
            ) : (
              <div className={styles.box}>
                <pre className={styles.verdict}>{verdict.join('\n')}</pre>
              </div>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function ChangeHeader(props: { readonly change: Change; readonly filesHref: string }) {
  const { change } = props;
  return (
    <header className={styles.changeHead}>
      <h2>{change.title}</h2>
      <p>
        <ChangeGlyph state={change.state} />
        <span className={styles.state} data-state={change.state}>
          {stateText(change.state)}
        </span>
        <span className={styles.beanName}>bean/{change.bean}</span>
        <span>
          by <span className={styles.person}>{authorText(change.author)}</span>
        </span>
        {change.head === null ? null : <Link href={props.filesHref}>Browse its files</Link>}
      </p>
    </header>
  );
}

function Journey(props: {
  readonly change: Change;
  readonly base: string;
  readonly nowMs: number;
}) {
  const { change } = props;
  return (
    <section className={styles.box} aria-label="Journey">
      <div className={styles.boxHead}>
        <span className={styles.headTitle}>Journey</span>
        <span className={styles.headMeta}>
          {change.pushes} {change.pushes === 1 ? 'push' : 'pushes'}
        </span>
      </div>
      {change.journey.length === 0 ? (
        <p className={styles.empty}>Nothing has happened to this bean yet.</p>
      ) : (
        <ol className={styles.journey}>
          {change.journey.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <span className={styles.dot} data-tone={entry.tone} aria-hidden="true" />
              <div className={styles.stepText}>
                {entry.text}
                <time dateTime={at(entry.at)}>{timeAgo(at(entry.at), props.nowMs)}</time>
                {entry.lines.length === 0 ? null : (
                  <ul className={styles.stepLines}>
                    {entry.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                {entry.beans.length === 0 ? null : (
                  <div className={styles.stepBeans}>
                    {entry.beans.map((other) => (
                      <Link key={other} href={`${props.base}/changes/${encodeURIComponent(other)}`}>
                        bean/{other}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
