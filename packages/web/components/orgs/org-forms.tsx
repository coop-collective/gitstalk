'use client';

/**
 * Org forms: New organization, General, Repository defaults, the Danger zone, and the
 * repository Transfer form. Each posts a server action (`src/server/org-actions.ts`); the
 * identity library and the gateway decide who may.
 */
import { useActionState } from 'react';

import type { OrgState } from '../../src/server/org-actions';
import {
  createOrgAction,
  deleteOrgAction,
  transferRepositoryAction,
  updateOrgAction,
} from '../../src/server/org-actions';
import repo from '../repository/repository.module.css';
import { ConfirmSubmit } from '../settings/confirm-submit';
import { useSavedForm } from '../settings/use-saved-form';
import styles from './orgs.module.css';

const IDLE: OrgState = { kind: 'idle' };

export type OrgSettingsView = {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly description: string;
  readonly iconKey: string | null;
  readonly basePermission: 'none' | 'read' | 'write';
  readonly repoCreation: 'members' | 'admins';
  readonly defaultVisibility: 'public' | 'private';
};

type Access = { readonly csrf: string; readonly path: string };

export function NewOrgForm(props: { readonly csrf: string; readonly host: string }) {
  const [state, action, pending] = useActionState(createOrgAction, IDLE);
  return (
    <form action={action} className={repo.form} noValidate>
      <input type="hidden" name="csrf" value={props.csrf} />
      <Status state={state} />
      <div className={repo.field}>
        <label htmlFor="org-handle" className={repo.label}>
          Handle
        </label>
        <div className={repo.nameRow}>
          <span className={repo.owner}>{props.host} /</span>
          <input
            id="org-handle"
            name="handle"
            className={repo.input}
            required
            maxLength={39}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="org-handle-hint"
          />
        </div>
        <span id="org-handle-hint" className={repo.hint}>
          Its address and the first part of its repositories&rsquo; clone URLs. People and
          organizations share handles, so it cannot be someone&rsquo;s.
        </span>
      </div>
      <div className={repo.field}>
        <label htmlFor="org-name" className={repo.label}>
          Name
        </label>
        <input id="org-name" name="name" className={repo.input} required maxLength={80} />
      </div>
      <div className={repo.field}>
        <label htmlFor="org-description" className={repo.label}>
          Description <span className={repo.muted}>(optional)</span>
        </label>
        <input id="org-description" name="description" className={repo.input} maxLength={350} />
      </div>
      <div className={repo.actions}>
        <button type="submit" className={repo.primary} disabled={pending}>
          {pending ? 'Creating organization…' : 'Create organization'}
        </button>
        <span className={repo.hint}>You become its owner. Invite people from its Settings.</span>
      </div>
    </form>
  );
}

export function OrgGeneralSettings(props: {
  readonly org: OrgSettingsView;
  readonly access: Access;
}) {
  const { state, action, pending, saved } = useSavedForm(updateOrgAction, IDLE);
  const { org } = props;
  return (
    <form
      action={action}
      className={`${repo.panel} ${repo.settingsSection}`}
      aria-labelledby="org-general-title"
    >
      <h2 id="org-general-title">General</h2>
      <Hidden org={org} access={props.access} />
      <div className={repo.field}>
        <label htmlFor="org-settings-name" className={repo.label}>
          Name
        </label>
        <input
          id="org-settings-name"
          name="name"
          className={repo.input}
          defaultValue={saved('name', org.name)}
          maxLength={80}
          required
        />
        <span className={repo.hint}>
          The handle <code>{org.handle}</code> stays: it is in every clone URL.
        </span>
      </div>
      <div className={repo.field}>
        <label htmlFor="org-settings-description" className={repo.label}>
          Description
        </label>
        <input
          id="org-settings-description"
          name="description"
          className={repo.input}
          defaultValue={saved('description', org.description)}
          maxLength={350}
        />
      </div>
      <Status state={state} />
      <div className={repo.actions}>
        <button type="submit" className={repo.primary} disabled={pending}>
          Save
        </button>
      </div>
    </form>
  );
}

const BASE_CHOICES = [
  {
    value: 'none',
    title: 'None (default)',
    detail: 'Members see only repositories they are invited to, plus internal and public ones.',
  },
  { value: 'read', title: 'Read', detail: 'Members clone, fetch and view every repository.' },
  { value: 'write', title: 'Write', detail: 'Members also push beans to every repository.' },
] as const;

export function OrgRepositoryDefaults(props: {
  readonly org: OrgSettingsView;
  readonly access: Access;
}) {
  const { state, action, pending, saved } = useSavedForm(updateOrgAction, IDLE);
  const { org } = props;
  return (
    <form
      action={action}
      className={`${repo.panel} ${repo.settingsSection}`}
      aria-labelledby="org-defaults-title"
    >
      <h2 id="org-defaults-title">Repository defaults</h2>
      <Hidden org={org} access={props.access} />
      <fieldset className={repo.choices}>
        <legend>Base permission for members</legend>
        {BASE_CHOICES.map((choice) => (
          <label key={choice.value} className={repo.choice}>
            <input
              type="radio"
              name="basePermission"
              value={choice.value}
              defaultChecked={saved('basePermission', org.basePermission) === choice.value}
            />
            <span>
              <b>{choice.title}</b>
              <span>{choice.detail}</span>
            </span>
          </label>
        ))}
        <span className={repo.hint}>
          Owners and admins manage every repository. Viewers get at most read. Every member reads
          the internal repositories. A collaborator role on one repository adds to this; the
          stronger one counts.
        </span>
      </fieldset>
      <fieldset className={repo.choices}>
        <legend>Who creates repositories</legend>
        <label className={repo.choice}>
          <input
            type="radio"
            name="repoCreation"
            value="members"
            defaultChecked={saved('repoCreation', org.repoCreation) === 'members'}
          />
          <span>
            <b>Members, admins and owners</b>
            <span>Viewers never create repositories.</span>
          </span>
        </label>
        <label className={repo.choice}>
          <input
            type="radio"
            name="repoCreation"
            value="admins"
            defaultChecked={saved('repoCreation', org.repoCreation) === 'admins'}
          />
          <span>
            <b>Admins and owners only</b>
          </span>
        </label>
      </fieldset>
      <fieldset className={repo.choices}>
        <legend>New repositories start</legend>
        {(['private', 'public'] as const).map((visibility) => (
          <label key={visibility} className={repo.choice}>
            <input
              type="radio"
              name="defaultVisibility"
              value={visibility}
              defaultChecked={saved('defaultVisibility', org.defaultVisibility) === visibility}
            />
            <span>
              <b>{visibility === 'private' ? 'Private' : 'Public'}</b>
            </span>
          </label>
        ))}
      </fieldset>
      <Status state={state} />
      <div className={repo.actions}>
        <button type="submit" className={repo.primary} disabled={pending}>
          Save defaults
        </button>
      </div>
    </form>
  );
}

export function OrgDangerZone(props: {
  readonly org: OrgSettingsView;
  readonly access: Access;
  readonly repositories: number;
}) {
  const [state, action, pending] = useActionState(deleteOrgAction, IDLE);
  const { org } = props;
  return (
    <form
      action={action}
      className={`${repo.panel} ${repo.settingsSection} ${repo.dangerZone}`}
      aria-labelledby="org-danger-title"
    >
      <h2 id="org-danger-title">Delete this organization</h2>
      <p className={repo.sub}>
        {props.repositories === 0
          ? 'Its members lose their roles and the handle becomes free. The audit log is kept.'
          : `It owns ${props.repositories} ${props.repositories === 1 ? 'repository' : 'repositories'}. Transfer or delete them first.`}
      </p>
      <Hidden org={org} access={props.access} />
      <input type="hidden" name="orgHandle" value={org.handle} />
      <div className={repo.field}>
        <label htmlFor="org-confirm-delete" className={repo.label}>
          Type <code>{org.handle}</code> to confirm
        </label>
        <input
          id="org-confirm-delete"
          name="confirm"
          className={repo.input}
          autoComplete="off"
          spellCheck={false}
          disabled={props.repositories > 0}
        />
      </div>
      <Status state={state} />
      <div className={repo.actions}>
        <button type="submit" className={repo.danger} disabled={pending || props.repositories > 0}>
          Delete {org.handle}
        </button>
      </div>
    </form>
  );
}

/** Settings → Transfer: to yourself or an org you administer. */
export function TransferRepository(props: {
  readonly repoId: string;
  readonly fullName: string;
  readonly targets: readonly { readonly handle: string; readonly label: string }[];
  readonly csrf: string;
  /** Internal now: moved to a person it becomes private (only organizations have internal). */
  readonly isInternal: boolean;
}) {
  const [state, action, pending] = useActionState(transferRepositoryAction, IDLE);
  return (
    <form
      action={action}
      className={`${repo.panel} ${repo.settingsSection}`}
      aria-labelledby="transfer-title"
    >
      <h2 id="transfer-title">Transfer</h2>
      <p className={repo.sub}>
        Move {props.fullName} to you or to an organization where you are an owner or admin. Its
        history, beans, collaborators and deploy tokens move with it. The old address keeps working:
        pages redirect, and git (HTTPS and SSH) and agents still clone, fetch and push there, until
        someone creates a repository with that name at the old owner.
      </p>
      {props.isInternal ? (
        <p className={repo.hint}>
          It is internal. Moved to a person it becomes private, because only organizations have
          internal repositories; moved to another organization it stays internal to that one.
        </p>
      ) : null}
      <input type="hidden" name="csrf" value={props.csrf} />
      <input type="hidden" name="repo" value={props.repoId} />
      {props.targets.length === 0 ? (
        <p className={repo.muted}>
          There is nowhere to move it: you administer no other organization.
        </p>
      ) : (
        <div className={styles.ownerRow}>
          <select name="to" className={repo.input} aria-label="New owner" defaultValue="">
            <option value="" disabled>
              Choose the new owner
            </option>
            {props.targets.map((target) => (
              <option key={target.handle} value={target.handle}>
                {target.label}
              </option>
            ))}
          </select>
          <ConfirmSubmit
            label="Transfer"
            title={`Transfer ${props.fullName}?`}
            confirmLabel="Transfer it"
            tone="danger"
            buttonClassName={repo.secondary}
            confirmClassName={repo.danger}
            disabled={pending}
          >
            <p>
              It moves to the owner you chose, with its history, beans, collaborators and deploy
              tokens. You keep access only through your role there.
              {props.isInternal ? ' Moved to a person it becomes private.' : ''}
            </p>
          </ConfirmSubmit>
        </div>
      )}
      <Status state={state} />
    </form>
  );
}

function Hidden(props: { readonly org: OrgSettingsView; readonly access: Access }) {
  return (
    <>
      <input type="hidden" name="csrf" value={props.access.csrf} />
      <input type="hidden" name="org" value={props.org.id} />
      <input type="hidden" name="path" value={props.access.path} />
    </>
  );
}

export function Status({ state }: { readonly state: OrgState }) {
  if (state.kind === 'refused')
    return (
      <p className={repo.error} role="alert">
        {state.message}
      </p>
    );
  if (state.kind === 'done')
    return (
      <p className={repo.saved} role="status">
        {state.message}
      </p>
    );
  return null;
}
