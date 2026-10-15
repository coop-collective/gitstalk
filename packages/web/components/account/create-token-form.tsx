'use client';

/** Settings → Tokens: name, scopes and expiry; the new token is shown once, with a copy button. */
import { useActionState, useId, useState } from 'react';

import type { CreateTokenState } from '../../src/server/token-actions';
import { createTokenAction } from '../../src/server/token-actions';
import styles from './account.module.css';

const SCOPES = [
  { value: 'read', label: 'read', detail: 'clone and fetch; MCP read tools' },
  { value: 'collaborate', label: 'collaborate', detail: 'post on beans, answer requests' },
  { value: 'write', label: 'write', detail: 'push to your own beans; run workflows (maintainers)' },
  {
    value: 'secrets',
    label: 'secrets',
    detail: 'set Actions secrets and variables (maintainers); the token can write deploy keys',
  },
  {
    value: 'create',
    label: 'create',
    detail: 'create repositories (POST /api/repos, or with write a push to a new address)',
  },
] as const;

const EXPIRY = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
] as const;

export function CreateTokenForm({ csrf }: { readonly csrf: string }) {
  const [state, action, pending] = useActionState<CreateTokenState, FormData>(createTokenAction, {
    kind: 'idle',
  });
  const nameId = useId();
  const daysId = useId();
  return (
    <div className={styles.stack}>
      <form action={action} className={styles.tokenForm}>
        <input type="hidden" name="csrf" value={csrf} />
        <div className={styles.field}>
          <label htmlFor={nameId} className={styles.label}>
            Name
          </label>
          <input
            id={nameId}
            name="name"
            className={styles.input}
            placeholder="laptop git"
            required
            maxLength={60}
          />
        </div>
        <fieldset className={styles.scopes}>
          <legend className={styles.label}>Scopes</legend>
          {SCOPES.map((scope) => (
            <label key={scope.value} className={styles.scope}>
              <input
                type="checkbox"
                name="scope"
                value={scope.value}
                defaultChecked={scope.value === 'read'}
              />
              <span className={styles.scopeName}>{scope.label}</span>
              <span className={styles.scopeDetail}>{scope.detail}</span>
            </label>
          ))}
        </fieldset>
        <div className={styles.field}>
          <label htmlFor={daysId} className={styles.label}>
            Expires after
          </label>
          <select id={daysId} name="days" className={styles.input} defaultValue="30">
            {EXPIRY.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={styles.primary} disabled={pending}>
          {pending ? 'Creating…' : 'Create token'}
        </button>
        {state.kind === 'refused' ? (
          <p className={styles.error} role="alert">
            {state.message}
          </p>
        ) : null}
      </form>
      {state.kind === 'created' ? <NewToken token={state.token} name={state.name} /> : null}
    </div>
  );
}

function NewToken({ token, name }: { readonly token: string; readonly name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className={styles.reveal} aria-labelledby="new-token">
      <h3 id="new-token" className={styles.revealTitle}>
        “{name}” is ready. Copy it now: it is shown once.
      </h3>
      <div className={styles.secretRow}>
        <code className={styles.secret}>{token}</code>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            void navigator.clipboard.writeText(token).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className={styles.hint}>
        Use it as the git password with any user name, or as <code>Authorization: Bearer</code>.
        Gitstalk stores only its hash.
      </p>
    </section>
  );
}
