'use client';

/**
 * A menu button for the header (the WAI-ARIA menu button pattern): the button opens a
 * `role=menu` list; arrow keys, Home and End move between items, Escape closes and returns
 * focus to the button, Tab and a click outside close it. Entries are data so the server
 * header can describe them; the theme entry is the day/night pair as radio items.
 */
import { IntentLink as Link } from './intent-link';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import { assertNever } from '../../src/actions/run-view';
import styles from './header.module.css';
import { nextMenuIndex } from '../../src/shell/menu-keys';
import type { ThemeChoice } from './theme';
import { useTheme } from './theme-toggle';

export type MenuEntry =
  | {
      readonly kind: 'link';
      readonly href: string;
      readonly label: string;
      readonly external?: boolean;
    }
  /** A line that is not an item: "Signed in as" above the handle. */
  | { readonly kind: 'note'; readonly label: string; readonly detail: string }
  | { readonly kind: 'separator' }
  | { readonly kind: 'theme'; readonly initial: ThemeChoice }
  | {
      readonly kind: 'post';
      readonly action: string;
      readonly label: string;
      readonly fields: Readonly<Record<string, string>>;
    };

const ITEM = '[role="menuitem"], [role="menuitemradio"]';

export function HeaderMenu(props: {
  /** What the button shows (an avatar, "+ New"). */
  readonly button: ReactNode;
  /** The button's accessible name. */
  readonly label: string;
  readonly entries: readonly MenuEntry[];
  readonly variant?: 'plain' | 'accent';
}) {
  const [isOpen, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<'first' | 'last' | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!isOpen) return undefined;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target !== null) focusItem(menuRef.current, target);
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true)
        setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [isOpen]);

  const open = (focus: 'first' | 'last') => {
    pendingFocus.current = focus;
    setOpen(true);
  };
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  };
  const onMenuKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const handled = moveFocus(menuRef.current, event.key);
    if (handled) event.preventDefault();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
    if (event.key === 'Tab') close(false);
  };

  return (
    <div className={styles.menuRoot} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.menuButton} ${props.variant === 'accent' ? styles.menuButtonAccent : ''}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        aria-label={props.label}
        onClick={() => (isOpen ? close(false) : open('first'))}
        onKeyDown={onButtonKey}
      >
        {props.button}
      </button>
      <ul
        id={menuId}
        ref={menuRef}
        role="menu"
        aria-label={props.label}
        className={styles.menu}
        hidden={!isOpen}
        onKeyDown={onMenuKey}
      >
        {props.entries.map((entry, index) => (
          <Entry key={index} entry={entry} onDone={() => close(false)} />
        ))}
      </ul>
    </div>
  );
}

function Entry({ entry, onDone }: { readonly entry: MenuEntry; readonly onDone: () => void }) {
  switch (entry.kind) {
    case 'separator':
      return <li role="separator" className={styles.separator} />;
    case 'note':
      return (
        <li role="none" className={styles.note}>
          <span>{entry.label}</span> <b>{entry.detail}</b>
        </li>
      );
    case 'link':
      return (
        <li role="none">
          {entry.external === true ? (
            <a
              role="menuitem"
              tabIndex={-1}
              href={entry.href}
              className={styles.item}
              onClick={onDone}
            >
              {entry.label}
            </a>
          ) : (
            <Link
              role="menuitem"
              tabIndex={-1}
              href={entry.href}
              className={styles.item}
              onClick={onDone}
            >
              {entry.label}
            </Link>
          )}
        </li>
      );
    case 'post':
      return (
        <li role="none">
          <form method="post" action={entry.action}>
            {Object.entries(entry.fields).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <button type="submit" role="menuitem" tabIndex={-1} className={styles.item}>
              {entry.label}
            </button>
          </form>
        </li>
      );
    case 'theme':
      return <ThemeEntries initial={entry.initial} />;
    default:
      return assertNever(entry);
  }
}

/** Day and night as two radio items in a group. */
function ThemeEntries({ initial }: { readonly initial: ThemeChoice }) {
  const { isDark, pick } = useTheme(initial);
  const choices = [
    { value: 'light', label: 'Day', glyph: '☀', checked: !isDark },
    { value: 'dark', label: 'Night', glyph: '☾', checked: isDark },
  ] as const;
  return (
    <li role="none">
      <ul role="group" aria-label="Theme" className={styles.themeRow}>
        <li role="none" className={styles.themeLabel} aria-hidden="true">
          Theme
        </li>
        {choices.map((choice) => (
          <li role="none" key={choice.value}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={choice.checked}
              tabIndex={-1}
              className={styles.themeChoice}
              onClick={() => pick(choice.value)}
            >
              <span aria-hidden="true">{choice.glyph}</span> {choice.label}
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

function itemsOf(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM));
}

function focusItem(menu: HTMLElement | null, which: 'first' | 'last'): void {
  const items = itemsOf(menu);
  (which === 'first' ? items[0] : items.at(-1))?.focus();
}

/** Arrow keys, Home and End inside the open menu; answers whether the key was handled. */
function moveFocus(menu: HTMLElement | null, key: string): boolean {
  const items = itemsOf(menu);
  const current = items.findIndex((item) => item === document.activeElement);
  const next = nextMenuIndex(key, current, items.length);
  if (next === null) return false;
  items[next]?.focus();
  return true;
}
