'use client';

/**
 * The start page's "Connect git" step: three tabs, Plugin (the default: one line installs the
 * Claude Code plugin and runs /gitstalk:setup), HTTPS (a token at git's password prompt) and
 * Env vars (a deploy token for CI, with the block pre-filled for this repository). The chosen
 * tab is remembered per viewer in this browser.
 */
import { useActionState, useEffect, useId, useState } from 'react';

import type { StartGuide } from '../../src/repositories/paths';
import { envVarsBlock } from '../../src/repositories/paths';
import type { DeployTokenState } from '../../src/server/deploy-token-actions';
import { createDeployTokenAction } from '../../src/server/deploy-token-actions';
import { CopyButton } from './copy-button';
import styles from './repository.module.css';

const TABS = [
  { id: 'plugin', label: 'Plugin' },
  { id: 'https', label: 'HTTPS' },
  { id: 'env', label: 'Env vars' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const STORAGE_KEY = 'beanstalk.connect-tab';

/** Who may make deploy tokens here (the owner), with what they need to. */
export type DeployTokenAccess = {
  readonly repoId: string;
  readonly csrf: string;
  readonly path: string;
} | null;

export function ConnectTabs(props: {
  readonly guide: StartGuide;
  readonly deploy: DeployTokenAccess;
}) {
  const [tab, setTab] = useState<TabId>('plugin');
  const baseId = useId();
  useEffect(() => {
    const saved = readSaved();
    if (saved !== null) setTab(saved);
  }, []);
  const choose = (next: TabId): void => {
    setTab(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage refused (private window, blocked site data): the tab still switches.
    }
  };
  return (
    <section className={styles.step} aria-labelledby={`${baseId}-title`}>
      <h2 id={`${baseId}-title`}>Connect git</h2>
      <div role="tablist" aria-label="How to connect git" className={styles.connectTabs}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`${baseId}-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`${baseId}-${entry.id}-panel`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={styles.connectTab}
            onClick={() => choose(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-${tab}-panel`}
        aria-labelledby={`${baseId}-${tab}`}
        className={styles.connectPanel}
      >
        {tab === 'plugin' ? <PluginPanel guide={props.guide} /> : null}
        {tab === 'https' ? <HttpsPanel guide={props.guide} /> : null}
        {tab === 'env' ? <EnvPanel guide={props.guide} deploy={props.deploy} /> : null}
      </div>
    </section>
  );
}

function PluginPanel({ guide }: { readonly guide: StartGuide }) {
  return (
    <>
      <p>
        One line: it installs the Gitstalk plugin for Claude Code and starts setup. Claude finds
        your SSH keys (1Password, ssh-agent, <code>~/.ssh</code>) or makes one, asks which to use,
        and opens Gitstalk once for you to approve it. After that git never asks for a password.
      </p>
      <Line label="Claude Code" text={guide.plugin.claude} />
      <Line label="Codex" text={guide.plugin.codex} />
      <div className={styles.say}>
        <q>{guide.plugin.codexPrompt}</q>
        <CopyButton text={guide.plugin.codexPrompt} label="what to ask Codex" />
      </div>
    </>
  );
}

function HttpsPanel({ guide }: { readonly guide: StartGuide }) {
  return (
    <>
      <p>
        Clone over HTTPS. When git asks for a password, paste a personal token with write access
        from <a href={guide.https.tokensPath}>Settings, Tokens</a>; any user name works, and your OS
        keychain remembers it.
      </p>
      <Line label="Clone" text={`git clone ${guide.cloneUrl}`} />
      <p className={styles.connectWarning}>
        Last resort: the token in the URL, <code>{guide.https.urlWithToken}</code>. It is saved in
        plain text in <code>.git/config</code> and in your shell history, so prefer the prompt.
      </p>
    </>
  );
}

function EnvPanel(props: { readonly guide: StartGuide; readonly deploy: DeployTokenAccess }) {
  const [state, action, pending] = useActionState<DeployTokenState, FormData>(
    createDeployTokenAction,
    { kind: 'idle' },
  );
  const token = state.kind === 'created' ? state.token : null;
  return (
    <>
      <p>
        For CI and scripts: a deploy token opens this repository only, read or read and write, and
        expires. git reads it from <code>GITSTALK_TOKEN</code> and never prompts (git 2.31 or
        newer).
      </p>
      {props.deploy === null ? (
        <p className={styles.muted}>Only the repository&rsquo;s owner makes deploy tokens.</p>
      ) : (
        <form action={action} className={styles.deployForm}>
          <input type="hidden" name="csrf" value={props.deploy.csrf} />
          <input type="hidden" name="repo" value={props.deploy.repoId} />
          <input type="hidden" name="path" value={props.deploy.path} />
          <input
            name="name"
            className={styles.input}
            defaultValue="CI"
            maxLength={60}
            aria-label="Token name"
            required
          />
          <select name="access" className={styles.input} defaultValue="write" aria-label="Access">
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
      )}
      {state.kind === 'refused' ? (
        <p className={styles.connectWarning} role="alert">
          {state.message}
        </p>
      ) : null}
      {token === null ? null : (
        <p className={styles.connectNote} role="status">
          The token is filled in below. Copy it now: it is shown once. Store it as a CI secret, not
          in the repository.
        </p>
      )}
      <EnvVarsBlocks gitOrigin={props.guide.gitOrigin} token={token} />
    </>
  );
}

/** How git reads a deploy token from the environment: a credential helper, or a header. */
export function EnvVarsBlocks(props: {
  readonly gitOrigin: string;
  readonly token: string | null;
}) {
  const block = envVarsBlock(props.gitOrigin, props.token);
  return (
    <>
      <Block label="Credential helper" text={block.helper} />
      <Block label="Or as a Bearer header" text={block.header} />
    </>
  );
}

function Line({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className={styles.harness}>
      <b>{label}</b>
      <code>{text}</code>
      <CopyButton text={text} label={`the ${label} line`} />
    </div>
  );
}

function Block({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div>
      <div className={styles.terminalBar}>
        <span>{label}</span>
        <CopyButton text={text} label={label} />
      </div>
      <div className={styles.terminal}>
        {text.split('\n').map((line) => (
          <code key={line}>{line}</code>
        ))}
      </div>
    </div>
  );
}

function readSaved(): TabId | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return TABS.find((entry) => entry.id === saved)?.id ?? null;
  } catch {
    // Storage unavailable: start on the default tab.
    return null;
  }
}
