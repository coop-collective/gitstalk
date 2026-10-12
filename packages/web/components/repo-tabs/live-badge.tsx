/** Where the engine's live feed stands, as the Changes tab's bar shows it. */
import type { LiveFeedStatus } from '../../src/query/use-live-feed';
import styles from './repo-tabs.module.css';

export function LiveBadge(props: { readonly status: LiveFeedStatus; readonly enabled: boolean }) {
  if (!props.enabled || props.status === 'ended') return null;
  return (
    <span className={styles.live} data-status={props.status} role="status">
      <i aria-hidden="true" />
      {props.status === 'live' ? 'Live' : 'Connecting…'}
    </span>
  );
}
