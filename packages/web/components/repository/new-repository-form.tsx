'use client';

import { useActionState, useState } from 'react';

import type { CreateState } from '../../src/repositories/flows';
import { EMPTY_CREATE_STATE } from '../../src/repositories/flows';
import { createRepository } from '../../src/server/repository-actions';
import styles from './repository.module.css';

const STARTS = [
  {
    value: 'template:typescript-starter',
    title: 'TypeScript starter',
    detail: 'A small library with tests and a check, so the first bean is checked for real.',
  },
  { value: 'empty', title: 'Empty', detail: 'A README and nothing else.' },
  {
    value: 'import',
    title: 'Import a public git repository',
    detail: 'Its default branch becomes the stalk.',
  },
] as const;

/** A namespace the person may create in: themself, or an org that lets them. */
export type OwnerChoice = {
  readonly handle: string;
  readonly kind: 'user' | 'org';
  readonly name: string;
  readonly defaultVisibility: 'public' | 'private' | 'internal';
};

/**
 * New repository: owner (you or one of your organizations), name, description, visibility,
 * and how it starts.
 */
export function NewRepositoryForm(props: {
  readonly owners: readonly OwnerChoice[];
  /** This deployment's host, shown before the owner (`gitstalk.dev /`). */
  readonly host: string;
  readonly initialOwner: string;
}) {
  const initial = props.owners.find((owner) => owner.handle === props.initialOwner);
  const [state, action, pending] = useActionState<CreateState, FormData>(createRepository, {
    ...EMPTY_CREATE_STATE,
    values: {
      ...EMPTY_CREATE_STATE.values,
      owner: initial?.handle ?? '',
      visibility: initial?.defaultVisibility ?? EMPTY_CREATE_STATE.values.visibility,
    },
  });
  const [start, setStart] = useState<string>(state.values.start);
  const [ownerHandle, setOwnerHandle] = useState<string>(state.values.owner);
  const [visibility, setVisibility] = useState<string>(state.values.visibility);
  const { errors, values } = state;
  const [me] = props.owners;
  const owner = props.owners.find((choice) => choice.handle === ownerHandle) ?? me;
  const isOrg = owner?.kind === 'org';
  const choose = (handle: string): void => {
    setOwnerHandle(handle);
    // Only an organization's repository can be internal; for yourself it becomes private.
    const next = props.owners.find((choice) => choice.handle === handle);
    if (next?.kind !== 'org' && visibility === 'internal') setVisibility('private');
  };
  return (
    <form action={action} className={styles.form} noValidate>
      {errors.form === undefined ? null : (
        <p className={styles.notice} role="alert">
          {errors.form}
        </p>
      )}
      <div className={styles.field}>
        <label htmlFor="repo-name" className={styles.label}>
          Name
        </label>
        <div className={styles.nameRow}>
          <span className={styles.owner}>{props.host} /</span>
          {props.owners.length > 1 ? (
            <select
              name="owner"
              className={styles.input}
              value={owner?.handle}
              onChange={(event) => choose(event.target.value)}
              aria-label="Owner"
            >
              {props.owners.map((choice) => (
                <option key={choice.handle} value={choice.handle}>
                  {choice.kind === 'user' ? `${choice.handle} (you)` : choice.handle}
                </option>
              ))}
            </select>
          ) : (
            <input type="hidden" name="owner" value={owner?.handle ?? ''} />
          )}
          <span className={styles.owner}>
            {props.owners.length > 1 ? '/' : `${owner?.handle ?? ''} /`}
          </span>
          <input
            id="repo-name"
            name="name"
            className={styles.input}
            defaultValue={values.name}
            required
            maxLength={63}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.name === undefined ? undefined : true}
            aria-describedby="repo-name-hint"
          />
        </div>
        <span
          id="repo-name-hint"
          className={errors.name === undefined ? styles.hint : styles.error}
        >
          {errors.name ??
            'Letters, digits, ".", "-" and "_", starting with a letter or digit. It is part of the clone URL.'}
        </span>
      </div>
      <div className={styles.field}>
        <label htmlFor="repo-description" className={styles.label}>
          Description <span className={styles.muted}>(optional)</span>
        </label>
        <input
          id="repo-description"
          name="description"
          className={styles.input}
          defaultValue={values.description}
          maxLength={350}
        />
        {errors.description === undefined ? null : (
          <span className={styles.error}>{errors.description}</span>
        )}
      </div>
      <fieldset className={styles.choices}>
        <legend>Visibility</legend>
        <label className={styles.choice}>
          <input
            type="radio"
            name="visibility"
            value="private"
            checked={visibility === 'private' || (visibility === 'internal' && !isOrg)}
            onChange={() => setVisibility('private')}
          />
          <span>
            <b>Private</b>
            <span>
              {isOrg
                ? 'The people you invite, and the organization’s owners and admins.'
                : 'Only you can see it.'}
            </span>
          </span>
        </label>
        {isOrg ? (
          <label className={styles.choice}>
            <input
              type="radio"
              name="visibility"
              value="internal"
              checked={visibility === 'internal'}
              onChange={() => setVisibility('internal')}
            />
            <span>
              <b>Internal</b>
              <span>
                Every member of {owner?.handle} can read and clone it; everyone else gets not found.
                Pushing needs a role.
              </span>
            </span>
          </label>
        ) : null}
        <label className={styles.choice}>
          <input
            type="radio"
            name="visibility"
            value="public"
            checked={visibility === 'public'}
            onChange={() => setVisibility('public')}
          />
          <span>
            <b>Public</b>
            <span>
              {owner?.kind === 'org'
                ? 'Anyone with the link can read it. Only people with a write role change it.'
                : 'Anyone with the link can read it. Only you and your agents change it.'}
            </span>
          </span>
        </label>
      </fieldset>
      <fieldset className={styles.choices}>
        <legend>Start with</legend>
        {STARTS.map((choice) => (
          <label key={choice.value} className={styles.choice}>
            <input
              type="radio"
              name="start"
              value={choice.value}
              checked={start === choice.value}
              onChange={() => setStart(choice.value)}
            />
            <span>
              <b>{choice.title}</b>
              <span>{choice.detail}</span>
              {choice.value === 'import' && start === 'import' ? (
                <span className={styles.importUrl}>
                  <input
                    name="importUrl"
                    className={styles.input}
                    defaultValue={values.importUrl}
                    placeholder="https://github.com/owner/repo.git"
                    aria-label="Public git URL"
                    aria-invalid={errors.importUrl === undefined ? undefined : true}
                    spellCheck={false}
                  />
                  {errors.importUrl === undefined ? null : (
                    <span className={styles.error}>{errors.importUrl}</span>
                  )}
                </span>
              ) : null}
            </span>
          </label>
        ))}
        {errors.start === undefined ? null : <span className={styles.error}>{errors.start}</span>}
      </fieldset>
      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={pending}>
          {pending ? 'Creating repository…' : 'Create repository'}
        </button>
        <span className={styles.hint}>An import can take a minute for a large repository.</span>
      </div>
    </form>
  );
}
