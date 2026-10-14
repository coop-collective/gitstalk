'use client';

/**
 * A repository's Settings → Collaborators (owner only; the page checks, the gateway checks
 * again): invite by handle with a role, change a role, remove someone, cancel an invitation,
 * and the access log. Also the Leave button people use on the People page.
 */
import { useActionState } from 'react';

import type {
  AuditEvent,
  Collaborator,
  Invitation,
} from '../../src/repositories/collaborators-client';
import type { CollaboratorState } from '../../src/server/collaborator-actions';
import {
  cancelInvitationAction,
  inviteAction,
  removeCollaboratorAction,
  setRoleAction,
} from '../../src/server/collaborator-actions';
import { COLLABORATOR_ROLES, ROLE_SUMMARY } from './roles';
import styles from './repository.module.css';

type Access = { readonly repoId: string; readonly csrf: string; readonly path: string };

const DATE = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const IDLE: CollaboratorState = { kind: 'idle' };

export function CollaboratorsSettings(props: {
  readonly name: string;
  readonly collaborators: readonly Collaborator[];
  readonly invitations: readonly Invitation[];
  readonly audit: readonly AuditEvent[];
  readonly access: Access;
}) {
  const [state, invite, pending] = useActionState(inviteAction, IDLE);
  const members = props.collaborators.filter((person) => person.role !== 'owner');
  return (
    <section
      className={`${styles.panel} ${styles.settingsSection}`}
      aria-labelledby="people-title"
      id="collaborators"
    >
      <h2 id="people-title">Collaborators</h2>
      <p className={styles.sub}>
        Invite people by their Gitstalk handle. <b>read</b>: {ROLE_SUMMARY.read.toLowerCase()}{' '}
        <b>write</b>: {ROLE_SUMMARY.write.toLowerCase()} <b>maintain</b>:{' '}
        {ROLE_SUMMARY.maintain.toLowerCase()} Settings and deletion stay yours. Deploy tokens do not
        depend on collaborators.
      </p>
      <form action={invite} className={styles.deployForm}>
        <Hidden access={props.access} />
        <input
          name="handle"
          className={styles.input}
          placeholder="handle"
          aria-label="Invite by handle"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <select name="role" className={styles.input} defaultValue="write" aria-label="Role">
          {COLLABORATOR_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <button type="submit" className={styles.primary} disabled={pending}>
          {pending ? 'Inviting…' : 'Invite'}
        </button>
      </form>
      <Status state={state} />
      {members.length === 0 && props.invitations.length === 0 ? (
        <p className={styles.muted}>
          Only you, and the agent sessions you connect, can reach {props.name} today.
        </p>
      ) : (
        <ul className={styles.deployList} aria-label="People with access">
          {members.map((person) => (
            <MemberRow key={person.user_id} person={person} access={props.access} />
          ))}
          {props.invitations.map((invitation) => (
            <InvitationRow key={invitation.id} invitation={invitation} access={props.access} />
          ))}
        </ul>
      )}
      {props.audit.length === 0 ? null : (
        <details className={styles.auditLog}>
          <summary>Access log ({props.audit.length})</summary>
          <ul>
            {props.audit.map((event) => (
              <li key={`${event.at}-${event.action}-${event.target_handle ?? ''}`}>
                <time dateTime={event.at}>{DATE.format(new Date(event.at))}</time>{' '}
                {auditText(event)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function MemberRow(props: { readonly person: Collaborator; readonly access: Access }) {
  const [roleState, changeRole, changing] = useActionState(setRoleAction, IDLE);
  const [removeState, remove, removing] = useActionState(removeCollaboratorAction, IDLE);
  const { person } = props;
  if (removeState.kind === 'done') return null;
  return (
    <li>
      <div>
        <b>@{person.handle}</b>{' '}
        <span className={styles.muted}>since {DATE.format(new Date(person.since))}</span>
        <Status state={roleState.kind === 'idle' ? removeState : roleState} />
      </div>
      <div className={styles.inviteActions}>
        <form action={changeRole} className={styles.inviteActions}>
          <Hidden access={props.access} />
          <input type="hidden" name="user" value={person.user_id} />
          <select
            name="role"
            className={styles.input}
            defaultValue={person.role}
            aria-label={`Role of @${person.handle}`}
          >
            {COLLABORATOR_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <button type="submit" className={styles.secondary} disabled={changing}>
            Change role
          </button>
        </form>
        <form action={remove}>
          <Hidden access={props.access} />
          <input type="hidden" name="user" value={person.user_id} />
          <button type="submit" className={styles.danger} disabled={removing}>
            Remove
          </button>
        </form>
      </div>
    </li>
  );
}

function InvitationRow(props: { readonly invitation: Invitation; readonly access: Access }) {
  const [state, cancel, pending] = useActionState(cancelInvitationAction, IDLE);
  const { invitation } = props;
  if (state.kind === 'done') return null;
  return (
    <li>
      <div>
        <b>@{invitation.invitee_handle}</b> <span className={styles.pill}>invited</span>{' '}
        <span className={styles.muted}>
          as {invitation.role} · until {DATE.format(new Date(invitation.expires_at))}
        </span>
        <Status state={state} />
      </div>
      <form action={cancel}>
        <Hidden access={props.access} />
        <input type="hidden" name="invitation" value={invitation.id} />
        <button type="submit" className={styles.secondary} disabled={pending}>
          Cancel invitation
        </button>
      </form>
    </li>
  );
}

/** Leave a repository you collaborate on (then Home). */
export function LeaveRepository(props: {
  readonly fullName: string;
  readonly userId: string;
  readonly access: Access;
}) {
  const [state, leave, pending] = useActionState(removeCollaboratorAction, IDLE);
  return (
    <form action={leave} className={styles.inviteActions}>
      <Hidden access={props.access} />
      <input type="hidden" name="user" value={props.userId} />
      <input type="hidden" name="fullName" value={props.fullName} />
      <button type="submit" className={styles.danger} disabled={pending}>
        Leave {props.fullName}
      </button>
      <Status state={state} />
    </form>
  );
}

function Hidden({ access }: { readonly access: Access }) {
  return (
    <>
      <input type="hidden" name="csrf" value={access.csrf} />
      <input type="hidden" name="repo" value={access.repoId} />
      <input type="hidden" name="path" value={access.path} />
    </>
  );
}

function Status({ state }: { readonly state: CollaboratorState }) {
  if (state.kind === 'refused')
    return (
      <p className={styles.error} role="alert">
        {state.message}
      </p>
    );
  if (state.kind === 'done')
    return (
      <p className={styles.saved} role="status">
        {state.message}
      </p>
    );
  return null;
}

const AUDIT_VERBS: Readonly<Record<string, string>> = {
  'collaborator.invite': 'invited',
  'collaborator.invite_cancel': 'cancelled the invitation of',
  'collaborator.accept': 'accepted the invitation',
  'collaborator.decline': 'declined the invitation',
  'collaborator.role': 'changed the role of',
  'collaborator.remove': 'removed',
  'collaborator.leave': 'left',
  'repository.visibility': 'changed visibility',
  'repository.transfer': 'transferred the repository',
  'actions-secret-set': 'saved the Actions secret',
  'actions-secret-deleted': 'deleted the Actions secret',
  'actions-variable-set': 'saved the Actions variable',
  'actions-variable-deleted': 'deleted the Actions variable',
  'bean.approve': 'approved a held bean',
};

function auditText(event: AuditEvent): string {
  const verb = AUDIT_VERBS[event.action] ?? event.action;
  const self = event.target_handle === null || event.target_handle === event.actor_handle;
  const target = self ? '' : ` @${event.target_handle ?? ''}`;
  const detail = event.detail === '' ? '' : ` (${event.detail})`;
  return `@${event.actor_handle} ${verb}${target}${detail}`;
}
