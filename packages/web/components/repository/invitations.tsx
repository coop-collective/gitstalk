'use client';

/**
 * Invitations waiting on Home: who invited you to which repository, with which role, and
 * Accept (opens the repository) or Decline. The gateway checks the invitation is yours. An
 * answered row leaves the list at once (`useOptimistic`) and comes back, with the reason, if
 * the answer fails.
 */
import { useActionState, useOptimistic } from 'react';

import type { Invitation } from '../../src/repositories/collaborators-client';
import type { CollaboratorState } from '../../src/server/collaborator-actions';
import { answerInvitationAction } from '../../src/server/collaborator-actions';
import { ROLE_SUMMARY } from './roles';
import styles from './repository.module.css';

/** `hidden` loses to the list's `display: flex`, and a row must stay mounted to show a refusal. */
const HIDDEN = { display: 'none' } as const;

export function Invitations(props: {
  readonly invitations: readonly Invitation[];
  readonly csrf: string;
}) {
  const [answered, markAnswered] = useOptimistic<ReadonlySet<string>, string>(
    new Set(),
    (ids, id) => new Set(ids).add(id),
  );
  const waiting = props.invitations.filter((invitation) => !answered.has(invitation.id));
  if (props.invitations.length === 0) return null;
  return (
    <section
      className={`${styles.panel} ${styles.invitations}`}
      aria-labelledby="invites-title"
      style={waiting.length === 0 ? HIDDEN : undefined}
    >
      <div className={styles.panelHead}>
        <h2 id="invites-title">
          {waiting.length === 1
            ? 'An invitation is waiting'
            : `${waiting.length} invitations are waiting`}
        </h2>
      </div>
      <ul className={styles.inviteList}>
        {props.invitations.map((invitation) => (
          <InvitationRow
            key={invitation.id}
            invitation={invitation}
            csrf={props.csrf}
            hidden={answered.has(invitation.id)}
            onAnswer={markAnswered}
          />
        ))}
      </ul>
    </section>
  );
}

function InvitationRow(props: {
  readonly invitation: Invitation;
  readonly csrf: string;
  /** Answered, and the answer not confirmed yet: kept mounted so a refusal can show. */
  readonly hidden: boolean;
  readonly onAnswer: (invitationId: string) => void;
}) {
  const [state, action, pending] = useActionState<CollaboratorState, FormData>(
    answerInvitationAction,
    { kind: 'idle' },
  );
  const { invitation } = props;
  const answer = (form: FormData) => {
    props.onAnswer(invitation.id);
    action(form);
  };
  const fullName = `${invitation.owner_handle}/${invitation.repo_name}`;
  return (
    <li style={props.hidden ? HIDDEN : undefined}>
      <div>
        <b>@{invitation.invited_by_handle}</b> invited you to{' '}
        <span className={styles.mono}>{fullName}</span> as <b>{invitation.role}</b>
        <br />
        <span className={styles.muted}>{ROLE_SUMMARY[invitation.role]}</span>
        {state.kind === 'refused' ? (
          <p className={styles.error} role="alert">
            {state.message}
          </p>
        ) : null}
        {state.kind === 'done' ? (
          <p className={styles.muted} role="status">
            {state.message}
          </p>
        ) : null}
      </div>
      {state.kind === 'done' ? null : (
        <form action={answer} className={styles.inviteActions}>
          <input type="hidden" name="csrf" value={props.csrf} />
          <input type="hidden" name="invitation" value={invitation.id} />
          <button
            type="submit"
            name="answer"
            value="accept"
            className={styles.primary}
            disabled={pending}
          >
            Accept
          </button>
          <button
            type="submit"
            name="answer"
            value="decline"
            className={styles.secondary}
            disabled={pending}
          >
            Decline
          </button>
        </form>
      )}
    </li>
  );
}
