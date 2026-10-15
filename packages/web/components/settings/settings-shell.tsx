/**
 * The settings layout for people, repositories and organizations: who or what is being set
 * up, a left nav with one link per section page (the current one marked), then the page's
 * sheets. Under 760 px the nav becomes a strip that scrolls sideways. `SettingsSection` is one
 * titled sheet; `danger` marks a destructive one.
 *
 * `SettingsShell` is the whole page. A layout that keeps the nav mounted across sections (a
 * repository's settings) draws `SettingsFrame` itself and each page draws `SettingsHead`; the
 * nav then marks the current section from the address.
 */
import type { ReactNode } from 'react';

import { SettingsNav } from './settings-client';
import styles from './settings-shell.module.css';

export type SettingsNavItem = {
  readonly href: string;
  readonly label: string;
  readonly isCurrent?: boolean;
  readonly isDanger?: boolean;
};

export type SettingsNavGroup = {
  readonly title: string;
  readonly items: readonly SettingsNavItem[];
};

export function SettingsShell({
  who,
  nav,
  title,
  lede,
  children,
}: {
  /** The avatar and name above the nav. */
  readonly who: ReactNode;
  readonly nav: readonly SettingsNavGroup[];
  readonly title: string;
  readonly lede?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SettingsFrame who={who} nav={nav}>
      <SettingsHead title={title} {...(lede === undefined ? {} : { lede })} />
      {children}
    </SettingsFrame>
  );
}

/** Who or what is being set up and the section nav, around a page's sheets. */
export function SettingsFrame(props: {
  readonly who: ReactNode;
  readonly nav: readonly SettingsNavGroup[];
  readonly children: ReactNode;
}) {
  return (
    <main className={styles.shell}>
      <aside className={styles.aside}>
        {props.who}
        <nav aria-label="Settings sections">
          <SettingsNav groups={props.nav} />
        </nav>
      </aside>
      <div className={styles.main}>{props.children}</div>
    </main>
  );
}

/** A settings page's title and the line under it. */
export function SettingsHead(props: { readonly title: string; readonly lede?: ReactNode }) {
  return (
    <header className={styles.head}>
      <h1 className={styles.title}>{props.title}</h1>
      {props.lede === undefined ? null : <p className={styles.lede}>{props.lede}</p>}
    </header>
  );
}

export function SettingsSection({
  id,
  title,
  lede,
  tone = 'plain',
  aside,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly lede?: ReactNode;
  readonly tone?: 'plain' | 'danger';
  /** Something at the end of the title line (a "coming soon" pill, a count). */
  readonly aside?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`${styles.section} ${tone === 'danger' ? styles.danger : ''}`}
      aria-labelledby={`${id}-title`}
    >
      <div className={styles.sectionHead}>
        <h2 id={`${id}-title`} className={styles.sectionTitle}>
          {title} {aside}
        </h2>
        {lede === undefined ? null : <p className={styles.sectionLede}>{lede}</p>}
      </div>
      {children}
    </section>
  );
}

/** "Coming soon" beside a title. */
export function SoonPill({ children = 'Coming soon' }: { readonly children?: ReactNode }) {
  return <span className={styles.soon}>{children}</span>;
}

/** The line under a form: saving, saved, or what went wrong (announced to screen readers). */
export function SaveStatus({
  pending,
  saved,
  error,
}: {
  readonly pending: boolean;
  readonly saved: string | null;
  readonly error: string | null;
}) {
  if (pending)
    return (
      <p className={styles.pending} role="status">
        Saving…
      </p>
    );
  if (error !== null)
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  if (saved !== null)
    return (
      <p className={styles.saved} role="status">
        {saved}
      </p>
    );
  return null;
}
