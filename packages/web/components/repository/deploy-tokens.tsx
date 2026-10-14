'use client';

/**
 * A repository's Settings → Deploy tokens: make one (shown once), see when and from where each
 * was last used, revoke. Owner only (the page checks; the gateway checks again).
 */
import { useActionState } from 'react';

import type { DeployTokenSummary } from '@gitstalk/shared-race/deploy-tokens';

import type { DeployTokenState } from '../../src/server/deploy-token-actions';
import {
  createDeployTokenAction,
  revokeDeployTokenAction,
} from '../../src/server/deploy-token-actions';
import { EnvVarsBlocks } from './connect-tabs';
import { CopyButton } from './copy-button';
import styles from './repository.module.css';

const DATE = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

type Access = { readonly repoId: string; readonly csrf: string; readonly path: string };

export function DeployTokens(props: {
  readonly tokens: readonly DeployTokenSummary[];
  readonly access: Access;
  /** Where git is served, for the env vars blocks. */
  readonly gitOrigin: string;
}) {
  const [state, action, pending] = useActionState<DeployTokenState, FormData>(
    createDeployTokenAction,
    { kind: 'idle' },
  );
  const { access } = props;
  return (
    <section className={`${styles.panel} ${styles.settingsSection}`} aria-labelledby="deploy-title">
      <h2 id="deploy-title">Deploy tokens</h2>
      <p className={styles.sub}>
        For CI and other machines: one token opens this repository only, read or read and write,
        until it expires. Pushes with it are pushed by you. Below the list: the env vars git reads
        it from, so it never prompts (git 2.31 or newer).
      </p>
      <form action={action} className={styles.deployForm}>
        <Hidden access={access} />
        <input
          name="name"
          className={styles.input}
          placeholder="CI"
          maxLength={60}
          aria-label="Token name"
          required
        />
        <select name="access" className={styles.input} defaultValue="read" aria-label="Access">
          <option value="read">read</option>
          <option value="write">read and write</option>
        </select>
        <select name="days" className={styles.input} defaultValue="90" aria-label="Expires after">
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
        </select>
        <button type="submit" className={styles.primary} disabled={pending}>
          {pending ? 'Creating…' : 'Create deploy token'}
        </button>
      </form>
      {state.kind === 'refused' ? (
        <p className={styles.connectWarning} role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'created' ? (
        <div className={styles.connectNote} role="status">
          <p>
            &ldquo;{state.name}&rdquo; ({state.access === 'write' ? 'read and write' : 'read'}) is
            ready. Copy it now: it is shown once.
          </p>
          <div className={styles.cloneRow}>
            <input readOnly value={state.token} aria-label="New deploy token" spellCheck={false} />
            <CopyButton text={state.token} label="the token" />
          </div>
        </div>
      ) : null}
      {props.tokens.length === 0 ? (
        <p className={styles.muted}>No deploy tokens yet.</p>
      ) : (
        <ul className={styles.deployList}>
          {props.tokens.map((token) => (
            <TokenRow key={token.id} token={token} access={access} />
          ))}
        </ul>
      )}
      <EnvVarsBlocks
        gitOrigin={props.gitOrigin}
        token={state.kind === 'created' ? state.token : null}
      />
    </section>
  );
}

function TokenRow({
  token,
  access,
}: {
  readonly token: DeployTokenSummary;
  readonly access: Access;
}) {
  const [state, revoke, pending] = useActionState<DeployTokenState, FormData>(
    revokeDeployTokenAction,
    { kind: 'idle' },
  );
  const revoked = token.revokedAt !== null || state.kind === 'revoked';
  const used =
    token.lastUsedAt === null
      ? 'never used'
      : `last used ${DATE.format(new Date(token.lastUsedAt))}${token.lastUsedFrom === null ? '' : ` from ${token.lastUsedFrom}`}`;
  return (
    <li>
      <div>
        <b>{token.name}</b> <span className={styles.mono}>{token.hint}</span>
        <br />
        <span className={styles.muted}>
          {token.access === 'write' ? 'read and write' : 'read'} · expires{' '}
          {DATE.format(new Date(token.expiresAt))} · {used}
        </span>
      </div>
      {revoked ? (
        <span className={styles.muted} role="status">
          Revoked
        </span>
      ) : (
        <form action={revoke}>
          <Hidden access={access} />
          <input type="hidden" name="token" value={token.id} />
          <button
            type="submit"
            className={styles.danger}
            disabled={pending}
            aria-label={`Revoke ${token.name}`}
          >
            Revoke
          </button>
          {state.kind === 'refused' ? (
            <span className={styles.connectWarning} role="alert">
              {state.message}
            </span>
          ) : null}
        </form>
      )}
    </li>
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
