'use client';

/**
 * The repository's Code button (as on GitHub, beside the ref switcher): a disclosure whose
 * panel has three tabs, Clone (HTTPS, SSH, the clone and push commands), Agent (the
 * /signup/agent install selector, set up for this repository) and Submit intent (shown,
 * marked soon, disabled). It is a `<details>`, so without JavaScript the button still opens
 * the panel on the Clone tab. With it: Escape and a click outside close the panel and focus
 * returns to the button; the tabs follow the WAI-ARIA pattern; the last tab is remembered.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { CodeMenu, CodeMenuTab } from '../../src/repositories/code-menu';
import {
  CODE_MENU_STORAGE_KEY,
  CODE_MENU_TABS,
  codeMenuTabOf,
  nextTabIndex,
} from '../../src/repositories/code-menu';
import { AgentInstallTabs } from '../account/agent-install-tabs';
import { CopyButton } from './copy-button';
import styles from './repository.module.css';

export function CodeButton(props: { readonly menu: CodeMenu; readonly slug: string }) {
  const { menu } = props;
  const baseId = useId();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<CodeMenuTab, HTMLButtonElement>());
  const [isOpen, setOpen] = useState(false);
  const [tab, setTab] = useState<CodeMenuTab>('clone');

  useEffect(() => {
    const saved = codeMenuTabOf(readSaved());
    if (saved !== null) setTab(saved);
    // The native event: the toggle follows a click, Enter or Space on the summary.
    const details = detailsRef.current;
    const onToggle = (): void => setOpen(details?.open === true);
    details?.addEventListener('toggle', onToggle);
    return () => details?.removeEventListener('toggle', onToggle);
  }, []);
  // Opening moves focus to the selected tab (a click on a tab focuses it anyway).
  useEffect(() => {
    if (isOpen) tabRefs.current.get(tab)?.focus();
  }, [isOpen, tab]);
  useEffect(() => {
    if (!isOpen) return undefined;
    const close = (): void => {
      if (detailsRef.current !== null) detailsRef.current.open = false;
    };
    const onPointer = (event: PointerEvent): void => {
      if (isOutside(event.target, detailsRef.current)) close();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      close();
      summaryRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  const choose = (next: CodeMenuTab): void => {
    setTab(next);
    save(next);
  };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = CODE_MENU_TABS.findIndex((entry) => entry.id === tab);
    const index = nextTabIndex(event.key, current, CODE_MENU_TABS.length);
    const next = index === null ? undefined : CODE_MENU_TABS[index]?.id;
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <details ref={detailsRef} className={styles.codeMenu}>
      <summary ref={summaryRef} className={styles.codeButton}>
        <CodeGlyph />
        Code
      </summary>
      <div className={styles.codePanel} role="group" aria-label={`Clone or connect ${props.slug}`}>
        <div className={styles.codeTabs} role="tablist" aria-label="Code" onKeyDown={onTabKey}>
          {CODE_MENU_TABS.map((entry) => (
            <button
              key={entry.id}
              ref={(element) => {
                if (element === null) tabRefs.current.delete(entry.id);
                else tabRefs.current.set(entry.id, element);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${entry.id}`}
              aria-selected={entry.id === tab}
              aria-controls={`${baseId}-panel-${entry.id}`}
              tabIndex={entry.id === tab ? 0 : -1}
              className={styles.codeTab}
              onClick={() => choose(entry.id)}
            >
              {entry.label}
              {entry.soon ? <span className={styles.soonPill}>Soon</span> : null}
            </button>
          ))}
        </div>
        <TabPanel baseId={baseId} id="clone" selected={tab}>
          <ClonePanel menu={menu} />
        </TabPanel>
        <TabPanel baseId={baseId} id="agent" selected={tab}>
          <AgentPanel menu={menu} />
        </TabPanel>
        <TabPanel baseId={baseId} id="intent" selected={tab}>
          <IntentPanel baseId={baseId} />
        </TabPanel>
      </div>
    </details>
  );
}

function TabPanel(props: {
  readonly baseId: string;
  readonly id: CodeMenuTab;
  readonly selected: CodeMenuTab;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${props.baseId}-panel-${props.id}`}
      aria-labelledby={`${props.baseId}-tab-${props.id}`}
      hidden={props.id !== props.selected}
      className={styles.codeTabPanel}
    >
      {props.children}
    </div>
  );
}

function ClonePanel({ menu }: { readonly menu: CodeMenu }) {
  return (
    <>
      <CopyRow label="HTTPS" text={menu.httpsUrl} copyLabel="the HTTPS clone URL" />
      {menu.ssh.kind === 'live' ? (
        <>
          <CopyRow label="SSH" text={menu.ssh.url} copyLabel="the SSH clone URL" />
          {menu.ssh.hostKeyFingerprint === '' ? null : (
            <p className={styles.codeHint}>
              Host key on first connect: <code>{menu.ssh.hostKeyFingerprint}</code>
            </p>
          )}
        </>
      ) : (
        <div className={styles.codeRow} aria-disabled="true">
          <span className={styles.codeLabel}>SSH</span>
          <input readOnly disabled value="SSH: coming soon" aria-label="SSH clone URL" />
        </div>
      )}
      <CommandRow text={menu.cloneCommand} copyLabel="the git clone command" />
      <p className={styles.codeHint}>Push a change to a bean branch, and Gitstalk checks it:</p>
      <CommandRow text={menu.pushCommand} copyLabel="the push command" />
      <p className={styles.codeFoot}>
        When git asks for a password, paste a personal token from{' '}
        <a href={menu.tokensPath}>Settings › Tokens</a>; any user name works.
        {menu.deployTokensPath === null ? null : (
          <>
            {' '}
            For CI and scripts, a deploy token and the env vars git reads are in{' '}
            <a href={menu.deployTokensPath}>Settings › Deploy tokens</a>.
          </>
        )}
      </p>
    </>
  );
}

function AgentPanel({ menu }: { readonly menu: CodeMenu }) {
  return (
    <>
      <AgentInstallTabs installs={menu.agents} />
      <p className={styles.codeFoot}>
        <a href={menu.pluginUrl} target="_blank" rel="noreferrer">
          Install plugin
        </a>{' '}
        · <a href={menu.agentDocsUrl}>Connecting agents</a>
      </p>
    </>
  );
}

function IntentPanel({ baseId }: { readonly baseId: string }) {
  return (
    <>
      <p className={styles.codeHint}>
        Describe what you want; Gitstalk opens a bean with your intent for an agent to pick up.
      </p>
      <label className="visually-hidden" htmlFor={`${baseId}-intent`}>
        Your intent (coming soon)
      </label>
      <textarea
        id={`${baseId}-intent`}
        className={styles.codeIntent}
        rows={3}
        disabled
        placeholder="Add a dark mode toggle to the settings page"
      />
      <button type="button" className={styles.primary} disabled>
        Open a bean
      </button>
    </>
  );
}

function CopyRow(props: {
  readonly label: string;
  readonly text: string;
  readonly copyLabel: string;
}) {
  return (
    <div className={styles.codeRow}>
      <span className={styles.codeLabel}>{props.label}</span>
      <input
        readOnly
        value={props.text}
        aria-label={`${props.label} clone URL`}
        spellCheck={false}
      />
      <CopyButton text={props.text} label={props.copyLabel} />
    </div>
  );
}

function CommandRow(props: { readonly text: string; readonly copyLabel: string }) {
  return (
    <div className={styles.codeCommand}>
      <code tabIndex={0}>{props.text}</code>
      <CopyButton text={props.text} label={props.copyLabel} />
    </div>
  );
}

function CodeGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Whether a pointer landed outside the panel and the button (the sheet's backdrop counts). */
function isOutside(target: EventTarget | null, details: HTMLDetailsElement | null): boolean {
  if (!(target instanceof Node) || details === null) return false;
  return target === details || !details.contains(target);
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(CODE_MENU_STORAGE_KEY);
  } catch {
    // Storage unavailable: open on Clone.
    return null;
  }
}

function save(tab: CodeMenuTab): void {
  try {
    localStorage.setItem(CODE_MENU_STORAGE_KEY, tab);
  } catch {
    // Storage refused (private window, blocked site data): the tab still switches.
  }
}
