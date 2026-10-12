/**
 * Org secrets or variables a repository inherits, read-only, each with its source: changed in
 * the org's settings, never here. An org entry the repository overrides is listed and says so.
 */
import { IntentLink as Link } from '../shell/intent-link';

import type { InheritableSecret, InheritableVariable } from '../../src/actions/actions-contract';
import { timeAgo } from '../../src/repositories/when';
import styles from './actions.module.css';

type Props =
  | {
      readonly kind: 'secret';
      readonly entries: readonly InheritableSecret[];
      readonly nowMs: number;
    }
  | {
      readonly kind: 'variable';
      readonly entries: readonly InheritableVariable[];
      readonly nowMs: number;
    };

export function InheritedEntries(props: Props) {
  const first = props.entries[0];
  if (first === undefined || first.source.kind !== 'organization') return null;
  const org = first.source.orgHandle;
  const noun = props.kind === 'secret' ? 'secrets' : 'variables';
  return (
    <>
      <h4 className={styles.inheritedTitle}>
        Org {noun} from{' '}
        <Link href={`/orgs/${encodeURIComponent(org)}/settings/secrets`}>@{org}</Link>
      </h4>
      <ul className={styles.secrets} aria-label={`Org ${noun}`}>
        {props.kind === 'secret'
          ? props.entries.map((entry) => (
              <li key={entry.name} data-overridden={entry.overridden}>
                <div>
                  <span className={styles.secretName}>{entry.name}</span>{' '}
                  <span className={styles.sourceTag}>org</span>
                  <br />
                  <span className={styles.secretMeta}>
                    {metaOf(entry, props.nowMs)}
                    {entry.availableToPreland ? ' · available to pre-land checks' : ''}
                  </span>
                </div>
              </li>
            ))
          : props.entries.map((entry) => (
              <li key={entry.name} data-overridden={entry.overridden}>
                <div>
                  <span className={styles.secretName}>{entry.name}</span>{' '}
                  <span className={styles.sourceTag}>org</span>{' '}
                  <code className={styles.variableValue}>{entry.value}</code>
                  <br />
                  <span className={styles.secretMeta}>{metaOf(entry, props.nowMs)}</span>
                </div>
              </li>
            ))}
      </ul>
    </>
  );
}

function metaOf(
  entry: { readonly overridden: boolean; readonly updatedAt: string; readonly updatedBy: string },
  nowMs: number,
): string {
  const updated = `Updated ${timeAgo(entry.updatedAt, nowMs)} by @${entry.updatedBy}`;
  return entry.overridden ? `Overridden by this repository's own · ${updated}` : updated;
}
