/**
 * The Automations tab around its two kinds (`docs/claude-opus/25` §5): Actions (the
 * repository's `.github/workflows`) and Automations (`.gitstalk/automations`). On a
 * deployment answering from fixtures, every page says so.
 */
import { IntentLink as Link } from '../shell/intent-link';
import type { ReactNode } from 'react';

import type { ActionsMode } from '../../src/actions/actions-client';
import type { RepositoryPage } from '../../src/server/repository-page';
import styles from './actions.module.css';

export type AutomationsView = 'actions' | 'automations';

export function ActionsShell(props: {
  readonly page: RepositoryPage;
  readonly view: AutomationsView;
  readonly mode: ActionsMode | null;
  /** Workflows in the repository, counted on the Actions segment. */
  readonly workflowCount?: number | undefined;
  /** Automations in the repository, counted on the Automations segment. */
  readonly automationCount?: number | undefined;
  readonly children: ReactNode;
}) {
  const { base } = props.page;
  return (
    <main>
      <div className={styles.page}>
        <nav className={styles.subnav} aria-label="Automations">
          <div className={styles.segments}>
            <Link
              href={`${base}/actions`}
              aria-current={props.view === 'actions' ? 'page' : undefined}
            >
              Actions
              {props.workflowCount === undefined ? null : (
                <span className={styles.count}>{props.workflowCount}</span>
              )}
            </Link>
            <Link
              href={`${base}/automations`}
              aria-current={props.view === 'automations' ? 'page' : undefined}
            >
              Automations
              {props.automationCount === undefined ? null : (
                <span className={styles.count}>{props.automationCount}</span>
              )}
            </Link>
          </div>
          {props.mode === 'fixtures' ? (
            <span className={styles.fixtures} role="note">
              Staging: runs here are fixtures, not real jobs
            </span>
          ) : null}
        </nav>
        {props.children}
      </div>
    </main>
  );
}

/** What the tab shows when no control plane answers on this deployment. */
export function ActionsOff() {
  return (
    <section className={styles.box}>
      <div className={styles.empty}>
        <p>Actions are not running on this deployment yet.</p>
        <p className={styles.muted}>
          Workflows in <code>.github/workflows/</code> are kept and will run when they are.
        </p>
      </div>
    </section>
  );
}
