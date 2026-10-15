'use client';

/**
 * The Code tab's file tree, beside the open file: folders open in place (their entries read
 * once per commit), the open file is highlighted and kept in view, and a green stalk runs down
 * the indent guides from the root to it. A WAI-ARIA tree view: the rows are a flat list with
 * `aria-level`, `aria-setsize` and `aria-posinset`, one row in the tab order (roving
 * `tabindex`), arrows to move and open or close, Home and End, Enter, `*` and type-ahead.
 *
 * Every row is a link, so without script a file opens and a folder opens its own page (which
 * the server renders with the tree open down to it). With script, a click on a folder opens
 * it in place and a click (or Enter) on a file opens it in the workspace without a page render
 * (`code-opener.tsx`): the tree stays as it was.
 */
import { useRouter } from 'next/navigation';
import type { KeyboardEvent, MouseEvent, RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { RepoScope } from '../../src/changes/change-feed';
import type { FolderListing, StalkMarks, TreeAction, TreeRow } from '../../src/code/file-tree';
import {
  expandAlong,
  keyAction,
  openFoldersFor,
  stalkGuides,
  toggleFolder,
  typeAhead,
  visibleRows,
} from '../../src/code/file-tree';
import type { CodeView, RefChoice } from '../../src/code/tree';
import { codeHref } from '../../src/code/tree';
import type { TreeMemory } from '../../src/code/tree-layout';
import { memoryKey, readMemory } from '../../src/code/tree-layout';
import { FileIcon } from '../home/marks';
import { LinkPending } from '../shell/link-pending';
import { CodeLink, useCodeOpener } from './code-opener';
import { cssVars } from './css-vars';
import styles from './file-tree.module.css';
import { readStored, writeStored } from './tree-storage';
import { useTreeFolders } from './use-tree-folders';

/** Where the Code tab is: the ref browsed, the commit it resolved to, and the open path. */
export type TreeAt = {
  readonly ref: RefChoice;
  readonly sha: string;
  readonly path: string;
  readonly view: CodeView;
};

/** Typed letters within this long of each other make one type-ahead word. */
const TYPE_AHEAD_MS = 700;

export function FileTree(props: {
  readonly scope: RepoScope;
  readonly at: TreeAt;
  /** The folders the server read with the page. */
  readonly folders: readonly FolderListing[];
  /** Opens Go to file. */
  readonly onFind: () => void;
}) {
  const { scope, at } = props;
  const state = useTreeState(at);
  const folders = useTreeFolders({
    scope,
    sha: at.sha,
    sent: props.folders,
    expanded: state.expanded,
  });
  const rows = visibleRows(folders.loaded, state.expanded, state.filter);
  const selected = at.path === '' ? null : at.path;
  const scrollRef = useRef<HTMLDivElement>(null);
  useTreeMemory({ scope, state, scrollRef });
  const onKeyDown = useTreeKeys({ rows, state, at, scope, selected });
  useRevealSelected({
    scrollRef,
    selected,
    shown: rows.some((row) => row.entry.path === selected),
  });
  const tabbable = tabbableRow(rows, state.focused, selected);
  const marks = selected === null ? null : stalkGuides(rows, selected);
  return (
    <div className={styles.treePane}>
      <TreeTools filter={state.filter} onFilter={state.setFilter} onFind={props.onFind} />
      <div className={styles.treeScroll} ref={scrollRef}>
        <ul role="tree" aria-label="Files" className={styles.tree} onKeyDown={onKeyDown}>
          {rows.map((row, index) => (
            <TreeItem
              key={row.entry.path}
              row={row}
              href={codeHref(
                scope.base,
                row.folder === null ? 'blob' : 'tree',
                row.entry.path,
                at.ref,
              )}
              selected={row.entry.path === selected}
              tabbable={row.entry.path === tabbable}
              failed={folders.failed.has(row.entry.path)}
              stalk={marks?.[index] ?? null}
              onToggle={() => state.toggle(row.entry.path)}
              onFocus={() => state.setFocused(row.entry.path)}
            />
          ))}
        </ul>
        <TreeNote filter={state.filter} rows={rows.length} />
      </div>
    </div>
  );
}

type TreeState = {
  readonly expanded: ReadonlySet<string>;
  readonly setExpanded: (update: (expanded: ReadonlySet<string>) => ReadonlySet<string>) => void;
  readonly toggle: (folder: string) => void;
  readonly focused: string | null;
  readonly setFocused: (path: string | null) => void;
  readonly filter: string;
  readonly setFilter: (filter: string) => void;
};

/** The tree's own state; a newly opened path opens the folders on the way to it. */
function useTreeState(at: TreeAt): TreeState {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(openFoldersFor(at.path, at.view)),
  );
  const [focused, setFocused] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const openKey = `${at.view}:${at.path}`;
  const [openedFor, setOpenedFor] = useState(openKey);
  if (openedFor !== openKey) {
    setOpenedFor(openKey);
    setExpanded((current) => expandAlong(current, at.path, at.view));
  }
  return {
    expanded,
    setExpanded,
    toggle: (folder) => setExpanded((current) => toggleFolder(current, folder)),
    focused,
    setFocused,
    filter,
    setFilter,
  };
}

/**
 * Remembers the open folders and the scroll per repository for this tab, so a page that
 * mounts the tree again (a folder's page after a file's) shows it as the reader left it.
 */
function useTreeMemory(input: {
  readonly scope: RepoScope;
  readonly state: TreeState;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
}): void {
  const key = memoryKey(input.scope.owner, input.scope.repo);
  const { expanded, setExpanded } = input.state;
  const scrollTop = useRef(0);
  const restoring = useRef<TreeMemory | null>(null);
  useLayoutEffect(() => {
    const memory = readMemory(readStored('session', key));
    if (memory === null) return;
    restoring.current = memory;
    setExpanded((current) => new Set([...current, ...memory.expanded]));
  }, [key, setExpanded]);
  useLayoutEffect(() => {
    // The scroll is restored once the remembered folders are open, before the browser paints.
    const scroller = input.scrollRef.current;
    const memory = restoring.current;
    if (scroller === null || memory === null) return;
    if (!memory.expanded.every((folder) => expanded.has(folder))) return;
    scroller.scrollTop = memory.scrollTop;
    scrollTop.current = scroller.scrollTop;
    restoring.current = null;
  }, [expanded, input.scrollRef]);
  useEffect(() => {
    const scroller = input.scrollRef.current;
    if (scroller === null) return undefined;
    const save = () => {
      scrollTop.current = scroller.scrollTop;
    };
    scroller.addEventListener('scroll', save, { passive: true });
    return () => scroller.removeEventListener('scroll', save);
  }, [input.scrollRef]);
  // A layout effect: its cleanup runs before the next page's tree reads the memory on mount.
  useLayoutEffect(() => {
    const remember = () =>
      writeStored(
        'session',
        key,
        JSON.stringify({ expanded: [...expanded], scrollTop: scrollTop.current }),
      );
    remember();
    return remember;
  }, [key, expanded]);
}

/** Keeps the open file in view inside the tree's own scroll, never scrolling the page. */
function useRevealSelected(input: {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly selected: string | null;
  readonly shown: boolean;
}): void {
  const { scrollRef, selected, shown } = input;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || selected === null || !shown) return;
    const item = itemElement(scroller, selected);
    if (item !== null) revealInside(scroller, item);
  }, [scrollRef, selected, shown]);
}

function useTreeKeys(input: {
  readonly rows: readonly TreeRow[];
  readonly state: TreeState;
  readonly at: TreeAt;
  readonly scope: RepoScope;
  readonly selected: string | null;
}): (event: KeyboardEvent<HTMLUListElement>) => void {
  const router = useRouter();
  const opener = useCodeOpener();
  const typed = useRef({ text: '', at: 0 });
  const moved = useFocusAfterMove();
  const { rows, state } = input;
  const open = (path: string) => {
    if (opener === null) router.push(codeHref(input.scope.base, 'blob', path, input.at.ref));
    else opener.go({ view: 'blob', path });
  };
  return (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = tabbableRow(rows, state.focused, input.selected);
    const action =
      keyAction(rows, current, event.key) ?? typeAheadAction(rows, current, typed, event.key);
    if (action === null) return;
    event.preventDefault();
    if (action.kind === 'focus') moved.current = action.path;
    applyAction(action, { state, open });
  };
}

/**
 * The row a key moved to, focused once it is rendered (a move into a folder that just opened
 * targets a row that is not on screen yet).
 */
function useFocusAfterMove(): RefObject<string | null> {
  const moved = useRef<string | null>(null);
  useEffect(() => {
    const target = moved.current;
    if (target === null) return;
    moved.current = null;
    const scroller = document.activeElement?.closest('[role="tree"]')?.parentElement ?? null;
    const item = scroller === null ? null : itemElement(scroller, target);
    item?.focus({ preventScroll: true });
    if (scroller instanceof HTMLElement && item !== null) revealInside(scroller, item);
  });
  return moved;
}

function applyAction(
  action: TreeAction,
  to: { readonly state: TreeState; readonly open: (path: string) => void },
): void {
  const { state } = to;
  switch (action.kind) {
    case 'focus':
      state.setFocused(action.path);
      return;
    case 'expand':
      state.setExpanded((current) => new Set([...current, ...action.paths]));
      return;
    case 'collapse':
      state.setExpanded((current) => {
        const next = new Set(current);
        next.delete(action.path);
        return next;
      });
      return;
    case 'toggle':
      state.toggle(action.path);
      return;
    case 'open':
      to.open(action.path);
      return;
    default:
      assertNever(action);
  }
}

/** A printable key as type-ahead: letters typed in quick succession make one word. */
function typeAheadAction(
  rows: readonly TreeRow[],
  current: string | null,
  typed: RefObject<{ text: string; at: number }>,
  key: string,
): TreeAction | null {
  if (key.length !== 1 || key === ' ') return null;
  const now = performance.now();
  const text = now - typed.current.at > TYPE_AHEAD_MS ? key : typed.current.text + key;
  typed.current = { text, at: now };
  const path = typeAhead(rows, current, text);
  return path === null ? null : { kind: 'focus', path };
}

function TreeTools(props: {
  readonly filter: string;
  readonly onFilter: (filter: string) => void;
  readonly onFind: () => void;
}) {
  return (
    <div className={styles.treeTools}>
      <input
        type="search"
        className={styles.filter}
        placeholder="Filter open folders"
        aria-label="Filter the open folders by name"
        value={props.filter}
        onChange={(event) => props.onFilter(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && props.filter !== '') {
            event.preventDefault();
            props.onFilter('');
          }
          if (event.key === 'ArrowDown') {
            const first = event.currentTarget
              .closest(`.${styles.treePane}`)
              ?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
            if (first !== null && first !== undefined) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      />
      <button
        type="button"
        className={styles.findButton}
        onClick={props.onFind}
        aria-keyshortcuts="t"
        title="Go to file (t)"
      >
        Go to file <kbd>t</kbd>
      </button>
    </div>
  );
}

function TreeNote(props: { readonly filter: string; readonly rows: number }) {
  if (props.filter.trim() === '' || props.rows > 0) return null;
  return (
    <p className={styles.treeNote} role="status">
      Nothing in the open folders is named like “{props.filter.trim()}”. Go to file searches every
      file.
    </p>
  );
}

function TreeItem(props: {
  readonly row: TreeRow;
  readonly href: string;
  readonly selected: boolean;
  readonly tabbable: boolean;
  readonly failed: boolean;
  readonly stalk: StalkMarks | null;
  readonly onToggle: () => void;
  readonly onFocus: () => void;
}) {
  const { row } = props;
  const isFolder = row.folder !== null;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    props.onFocus();
    if (!isFolder || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    // A folder opens in place; its own page stays a modified click (or no script) away.
    event.preventDefault();
    props.onToggle();
  };
  return (
    <li
      role="treeitem"
      aria-level={row.level}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={isFolder ? row.folder !== 'closed' : undefined}
      aria-selected={props.selected ? true : undefined}
      aria-busy={row.folder === 'loading' && !props.failed ? true : undefined}
      tabIndex={props.tabbable ? 0 : -1}
      data-path={row.entry.path}
      className={styles.item}
      onFocus={(event) => {
        if (event.target === event.currentTarget) props.onFocus();
      }}
    >
      <CodeLink
        href={props.href}
        to={{ view: isFolder ? 'tree' : 'blob', path: row.entry.path }}
        tabIndex={-1}
        className={styles.row}
        style={cssVars({ '--level': row.level })}
        aria-current={props.selected ? 'page' : undefined}
        onClick={onClick}
      >
        <Guides level={row.level} stalk={props.stalk} />
        <span className={styles.twisty} data-state={row.folder ?? 'file'} aria-hidden="true" />
        <span className={styles.icon} data-dir={isFolder ? '' : undefined}>
          <FileIcon dir={isFolder} />
        </span>
        <span className={styles.name}>{row.entry.name}</span>
        <RowNote state={row.folder} failed={props.failed} />
        <LinkPending />
      </CodeLink>
    </li>
  );
}

/** The indent guides of a row: one per folder above it, lit where the stalk runs. */
function Guides(props: { readonly level: number; readonly stalk: StalkMarks | null }) {
  if (props.level <= 1) return null;
  return (
    <span className={styles.guides} aria-hidden="true">
      {Array.from({ length: props.level - 1 }, (_, column) => (
        <i
          key={column}
          style={cssVars({ '--column': column })}
          data-lit={props.stalk?.lit.includes(column) === true ? '' : undefined}
          data-end={props.stalk?.end === column ? '' : undefined}
        />
      ))}
    </span>
  );
}

function RowNote(props: { readonly state: TreeRow['folder']; readonly failed: boolean }) {
  if (props.state !== 'loading') return null;
  return <span className={styles.rowNote}>{props.failed ? 'could not load' : 'loading'}</span>;
}

/** The row in the tab order: the focused one, else the open file, else the first. */
function tabbableRow(
  rows: readonly TreeRow[],
  focused: string | null,
  selected: string | null,
): string | null {
  const has = (path: string | null) => path !== null && rows.some((row) => row.entry.path === path);
  if (has(focused)) return focused;
  if (has(selected)) return selected;
  return rows[0]?.entry.path ?? null;
}

function itemElement(scroller: Element, path: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[role="treeitem"][data-path="${CSS.escape(path)}"]`);
}

/** Scrolls `scroller` the least needed to show `item`'s row; the page itself does not move. */
function revealInside(scroller: HTMLElement, item: HTMLElement): void {
  const row = item.firstElementChild ?? item;
  const box = scroller.getBoundingClientRect();
  const target = row.getBoundingClientRect();
  if (target.top < box.top) scroller.scrollTop -= box.top - target.top;
  else if (target.bottom > box.bottom) scroller.scrollTop += target.bottom - box.bottom;
}

function assertNever(value: never): never {
  throw new Error(`unknown tree action ${JSON.stringify(value)}`);
}
