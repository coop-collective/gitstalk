'use client';

/**
 * The Changes tab's lists, derived in the browser from the engine's events and the pushed
 * beans (`useChangesFeed`): the group filters with their counts (and Held, the open beans
 * waiting for a person's approval, while there are any), the live badge, and the rows of the
 * group shown. A new batch from the engine re-derives the rows; nothing reloads.
 */
import { IntentLink as Link } from '../shell/intent-link';
import { useMemo } from 'react';

import type { RepoScope } from '../../src/changes/change-feed';
import type { Change, ChangeFilter } from '../../src/changes/changes';
import {
  authorText,
  changesOf,
  groupCounts,
  inGroup,
  latestActivityMs,
  shownGroup,
  stateText,
} from '../../src/changes/changes';
import { timeAgo } from '../../src/repositories/when';
import { ChangeGlyph } from './change-glyph';
import { LiveBadge } from './live-badge';
import styles from './repo-tabs.module.css';
import { useChangesFeed } from './use-changes-feed';

const GROUPS: readonly {
  readonly group: ChangeFilter;
  readonly name: string;
  readonly empty: string;
}[] = [
  {
    group: 'open',
    name: 'Open',
    empty: 'Nothing is growing. Push a bean/<name> branch, or ask your agent for a change.',
  },
  { group: 'held', name: 'Held', empty: 'No bean is waiting for an approval.' },
  { group: 'landed', name: 'Landed', empty: 'No bean has landed yet.' },
  { group: 'parked', name: 'Parked', empty: 'No bean is parked or fell off.' },
];

export function ChangesList(props: {
  readonly scope: RepoScope;
  /** The page's `?show=`, as given. */
  readonly show: string | null;
  /** The server's clock when it rendered the page. */
  readonly nowMs: number;
}) {
  const { scope } = props;
  const feed = useChangesFeed(scope);
  const changes = useMemo(() => changesOf(feed.events, feed.pushed), [feed.events, feed.pushed]);
  const show = shownGroup(props.show, changes);
  const counts = groupCounts(changes);
  const shown = inGroup(changes, show);
  const nowMs = latestActivityMs(changes, props.nowMs);
  const empty = GROUPS.find((entry) => entry.group === show)?.empty ?? '';
  return (
    <>
      <div className={styles.bar}>
        <nav className={styles.filters} aria-label="Which beans">
          {GROUPS.filter(
            (entry) => entry.group !== 'held' || counts.held > 0 || show === 'held',
          ).map((entry) => (
            <Link
              key={entry.group}
              href={`${scope.base}/changes?show=${entry.group}`}
              className={styles.filter}
              data-filter={entry.group}
              aria-current={show === entry.group ? 'page' : undefined}
            >
              {entry.name}
              <span className={styles.count}>{counts[entry.group]}</span>
            </Link>
          ))}
        </nav>
        <LiveBadge status={feed.status} enabled />
      </div>
      <section className={styles.box} aria-label={`${show} beans`}>
        {shown.length === 0 ? (
          <p className={styles.empty}>{empty}</p>
        ) : (
          <ul className={styles.changes}>
            {shown.map((change) => (
              <li key={change.bean}>
                <ChangeRow base={scope.base} change={change} nowMs={nowMs} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ChangeRow(props: {
  readonly base: string;
  readonly change: Change;
  readonly nowMs: number;
}) {
  const { change } = props;
  const href = `${props.base}/changes/${encodeURIComponent(change.bean)}`;
  return (
    <div className={styles.change}>
      <ChangeGlyph state={change.state} />
      <Link href={href} className={styles.changeTitle}>
        {change.title}
      </Link>
      <span className={styles.state} data-state={change.state}>
        {stateText(change.state)}
      </span>
      <div className={styles.changeMeta}>
        <span className={styles.beanName}>bean/{change.bean}</span>
        <span>
          by <span className={styles.person}>{authorText(change.author)}</span>
        </span>
        {change.pushes > 1 ? <span>{change.pushes} pushes</span> : null}
        {change.updatedAt === null ? null : (
          <time dateTime={new Date(change.updatedAt).toISOString()}>
            {timeAgo(new Date(change.updatedAt).toISOString(), props.nowMs)}
          </time>
        )}
      </div>
      {change.state === 'held' && change.hold !== null ? (
        <p className={styles.heldLine}>
          Waits for an owner or maintainer to approve{' '}
          <span className={styles.mono}>{change.hold.revision.slice(0, 7)}</span>
          {change.hold.class === null ? '' : ` (rule ${change.hold.class})`}
        </p>
      ) : null}
      {change.state === 'held' ||
      (change.failing.length === 0 && change.collided.length === 0) ? null : (
        <ul className={styles.failing} aria-label="Why it is red">
          {change.failing.slice(0, 3).map((test) => (
            <li key={test}>✗ {test}</li>
          ))}
          {change.failing.length > 3 ? <li>and {change.failing.length - 3} more</li> : null}
          {change.collided.length === 0 ? null : (
            <li>collided with {change.collided.join(', ')}</li>
          )}
        </ul>
      )}
    </div>
  );
}
