'use client';

/**
 * /signup/agent's install commands as tabs, one per harness, Claude Code first (WAI-ARIA tabs
 * with automatic activation); the repository's Code button reuses it with lines for that
 * repository and what to ask the agent after. The choice is remembered in this browser under the same key the
 * marketing site's selector uses (packages/site/public/site.js), so a harness picked on one is
 * picked on the other, and another open tab that changes it is followed here.
 */
import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { AgentInstall } from '../../src/setup/agent-installs';
import { CopyButton } from '../repository/copy-button';
import styles from './account.module.css';

type HarnessId = AgentInstall['id'];
const STORAGE_KEY = 'gitstalk-agent';

export function AgentInstallTabs(props: { readonly installs: readonly AgentInstall[] }) {
  const { installs } = props;
  const baseId = useId();
  const tabRefs = useRef(new Map<HarnessId, HTMLButtonElement>());
  const [selected, setSelected] = useState<HarnessId | undefined>(installs[0]?.id);
  useEffect(() => {
    const follow = (id: string | null): void => {
      const found = installs.find((install) => install.id === id);
      if (found !== undefined) setSelected(found.id);
    };
    follow(readSaved());
    const onStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY) follow(event.newValue);
    };
    addEventListener('storage', onStorage);
    return () => removeEventListener('storage', onStorage);
  }, [installs]);

  const choose = (id: HarnessId): void => {
    setSelected(id);
    save(id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = keyTarget(installs, selected, event.key);
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <div className={styles.installTabs}>
      <div
        role="tablist"
        aria-label="Choose your agent"
        className={styles.harnessTabs}
        onKeyDown={onKeyDown}
      >
        {installs.map((install) => (
          <button
            key={install.id}
            ref={(element) => {
              if (element === null) tabRefs.current.delete(install.id);
              else tabRefs.current.set(install.id, element);
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${install.id}`}
            aria-selected={install.id === selected}
            aria-controls={`${baseId}-panel-${install.id}`}
            tabIndex={install.id === selected ? 0 : -1}
            className={styles.harnessTab}
            onClick={() => choose(install.id)}
          >
            {install.name}
          </button>
        ))}
      </div>
      {installs.map((install) => (
        <div
          key={install.id}
          role="tabpanel"
          id={`${baseId}-panel-${install.id}`}
          aria-labelledby={`${baseId}-tab-${install.id}`}
          hidden={install.id !== selected}
          className={styles.install}
        >
          <span className={styles.hint}>
            {install.name}: {install.where}
          </span>
          <div className={styles.installCode}>
            <code tabIndex={0}>{install.code}</code>
            <CopyButton text={install.code} label={`the ${install.name} command`} />
          </div>
          <p className={styles.hint}>
            {install.after}
            {install.verified ? null : ' (Follows the client’s documented MCP sign-in.)'}
          </p>
          {install.prompt === undefined ? null : (
            <>
              <span className={styles.hint}>Then ask it</span>
              <div className={styles.installCode}>
                <q className={styles.installPrompt}>{install.prompt}</q>
                <CopyButton text={install.prompt} label={`what to ask ${install.name}`} />
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** The harness an arrow, Home or End key moves to, wrapping at either end. */
function keyTarget(
  installs: readonly AgentInstall[],
  selected: HarnessId | undefined,
  key: string,
): HarnessId | undefined {
  const current = installs.findIndex((install) => install.id === selected);
  const last = installs.length - 1;
  const moves: Readonly<Record<string, number>> = {
    ArrowRight: current + 1,
    ArrowLeft: current - 1,
    Home: 0,
    End: last,
  };
  const next = moves[key];
  if (next === undefined) return undefined;
  return installs[(next + installs.length) % installs.length]?.id;
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: start on Claude Code.
    return null;
  }
}

function save(id: HarnessId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage refused (private window, blocked site data): the tab still switches.
  }
}
