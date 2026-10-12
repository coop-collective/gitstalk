'use client';

/**
 * A run's buttons for maintainers: Cancel while it can still change, Re-run once it has
 * finished (the workflow dispatched again on the stalk with the same inputs). The page shows
 * them only to maintainers and the owner; the server action and the control plane check again.
 * A press tells the run's status to change at once (`onIntent`); a refusal rolls it back.
 */
import type { QueryKey } from '@tanstack/react-query';

import type { RunIntent } from '../../src/actions/run-view';
import { useActionWithInvalidation } from '../../src/query/use-action-with-invalidation';
import type { ActionsAccess } from '../../src/server/actions-page';
import type { WorkflowFormState } from '../../src/server/workflow-actions';
import { cancelRunAction, rerunRunAction } from '../../src/server/workflow-actions';
import { AccessFields } from './access-fields';
import styles from './actions.module.css';

const IDLE: WorkflowFormState = { kind: 'idle' };

export function RunControls(props: {
  readonly runId: string;
  readonly live: boolean;
  readonly canRerun: boolean;
  readonly access: ActionsAccess;
  /** The run's query: refetched once a cancel went through. */
  readonly runKey: QueryKey;
  /** Shows the intent's result before the control plane answers; reverts when the request ends. */
  readonly onIntent: (intent: RunIntent) => void;
}) {
  const [cancelState, cancel, cancelling] = useActionWithInvalidation(cancelRunAction, IDLE, {
    isSuccess: (state) => state.kind === 'done',
    invalidate: [props.runKey],
  });
  const [rerunState, rerun, rerunning] = useActionWithInvalidation(rerunRunAction, IDLE, {
    isSuccess: (state) => state.kind === 'done',
    invalidate: [props.runKey],
  });
  const message = [cancelState, rerunState].find((state) => state.kind !== 'idle');
  return (
    <div className={styles.runControls}>
      {props.live ? (
        <form
          action={(form) => {
            props.onIntent('cancel');
            cancel(form);
          }}
        >
          <AccessFields access={props.access} />
          <input type="hidden" name="run" value={props.runId} />
          <button
            type="submit"
            className={styles.danger}
            disabled={cancelling || cancelState.kind === 'done'}
          >
            {cancelling ? 'Cancelling…' : 'Cancel run'}
          </button>
        </form>
      ) : null}
      {!props.live && props.canRerun ? (
        <form
          action={(form) => {
            props.onIntent('rerun');
            rerun(form);
          }}
        >
          <AccessFields access={props.access} />
          <input type="hidden" name="run" value={props.runId} />
          <button type="submit" className={styles.button} disabled={rerunning}>
            {rerunning ? 'Starting…' : 'Re-run'}
          </button>
        </form>
      ) : null}
      {message === undefined ? null : (
        <p className={message.kind === 'refused' ? styles.alert : styles.status} role="status">
          {message.message}
        </p>
      )}
    </div>
  );
}
