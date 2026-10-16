'use client';

/**
 * The Code tab's two panes, as in an editor: the side pane on the left, the open file (or the
 * folder) on the right, with the bar (ref switcher, path, Code button) across both.
 *
 * - The side pane has two tabs: the beanstalk, shown on a folder, and the file tree, shown on
 *   a file. Either can be picked; opening a file or a folder picks its own again.
 * - From 1024 px the tree is a sidebar: resizable by its handle (drag, or the arrow keys on
 *   it), collapsible by the Files button or Ctrl+B (Cmd+B on a Mac), its width and collapse
 *   remembered in localStorage.
 * - Below 1024 px it is a drawer the Files button opens; it closes on Escape, on the backdrop,
 *   or when a file opens. Without script, the Files link opens it as the page's `:target`.
 * - `t` opens Go to file anywhere on the page (not while typing).
 * - Folders and files open in place (`code-opener.tsx`): the URL changes, the page is not
 *   rendered again, and the bar, the main pane and the tree follow the URL.
 */
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode, Ref, RefObject } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { RepoScope } from '../../src/changes/change-feed';
import type { FolderListing } from '../../src/code/file-tree';
import type { TreeLayout } from '../../src/code/tree-layout';
import {
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  TREE_WIDTH,
  clampWidth,
  isFinderShortcut,
  isToggleShortcut,
  readLayout,
  resizeByKey,
} from '../../src/code/tree-layout';
import { CodeOpenerProvider, useCodeOpenerState } from './code-opener';
import type { TreeAt } from './file-tree';
import { FileTree } from './file-tree';
import { cssVars } from './css-vars';
import styles from './file-tree.module.css';
import { GoToFile } from './go-to-file';
import { readStored, writeStored } from './tree-storage';

/** The sidebar's id, for the Files button's `aria-controls` and the no-script `:target`. */
const PANEL_ID = 'code-files';
const WIDE_QUERY = '(min-width: 1024px)';

export function CodeWorkspace(props: {
  readonly scope: RepoScope;
  /** What the server rendered; the open location is the URL's (`code-opener.tsx`). */
  readonly at: TreeAt;
  /** Whether the server rendered a Markdown file as its source (`?plain=1`). */
  readonly plain: boolean;
  readonly folders: readonly FolderListing[];
  /** The bar over both panes (ref switcher, path, Code button). */
  readonly bar: ReactNode;
  /** The beanstalk, the side pane's tab on a folder. */
  readonly stalk: ReactNode;
  /** The open file or folder (`OpenCodeMain`). */
  readonly children: ReactNode;
}) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [layout, setLayout] = useStoredLayout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const toggleButton = useRef<HTMLAnchorElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const opener = useCodeOpenerState({
    scope: props.scope,
    rendered: { ...props.at, plain: props.plain },
    onOpen: () => revealTop(main.current),
  });
  const at: TreeAt = { ...props.at, view: opener.open.view, path: opener.open.path };
  const [pane, setPane] = usePaneOfView(at.view);
  useDrawerFocus({ open: drawerOpen, sidebar, toggleButton });
  const toggle = useCallback(() => {
    if (window.matchMedia(WIDE_QUERY).matches)
      setLayout((current) => ({ ...current, collapsed: !current.collapsed }));
    else setDrawerOpen((open) => !open);
  }, [setLayout]);
  useShortcuts({ onToggle: toggle, onFind: () => setFinding(true) });
  useCloseDrawerOnNavigation(at, setDrawerOpen);
  const closeDrawer = () => setDrawerOpen(false);
  const expanded = wide ? !layout.collapsed : drawerOpen;
  return (
    <CodeOpenerProvider opener={opener}>
      <div
        className={styles.workspace}
        data-collapsed={layout.collapsed ? '' : undefined}
        data-drawer={drawerOpen ? 'open' : undefined}
        style={cssVars({ '--tree-width': `${layout.width}px` })}
      >
        <div className={styles.toolbar} inert={!wide && drawerOpen}>
          <FilesToggle ref={toggleButton} pane={pane} expanded={expanded} onToggle={toggle} />
          <div className={styles.barSlot}>{props.bar}</div>
        </div>
        <div className={styles.panes}>
          <aside
            ref={sidebar}
            id={PANEL_ID}
            className={styles.sidebar}
            aria-label="Stalk and files"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !wide && drawerOpen) closeDrawer();
            }}
          >
            <a href="#" className={styles.drawerClose} onClick={drawerCloseClick(closeDrawer)}>
              Close
            </a>
            <PaneTabs pane={pane} onPick={setPane} />
            <div
              id={`${PANEL_ID}-stalk`}
              role="tabpanel"
              aria-labelledby={`${PANEL_ID}-stalk-tab`}
              className={styles.panePanel}
              hidden={pane !== 'stalk'}
            >
              {props.stalk}
            </div>
            <div
              id={`${PANEL_ID}-files`}
              role="tabpanel"
              aria-labelledby={`${PANEL_ID}-files-tab`}
              className={styles.panePanel}
              hidden={pane !== 'files'}
            >
              <FileTree
                scope={props.scope}
                at={at}
                folders={props.folders}
                onFind={() => setFinding(true)}
              />
            </div>
            <ResizeHandle
              width={layout.width}
              onResize={(width) => setLayout((current) => ({ ...current, width }))}
            />
          </aside>
          <button
            type="button"
            className={styles.backdrop}
            tabIndex={-1}
            aria-label="Close the file tree"
            onClick={closeDrawer}
          />
          <div ref={main} className={styles.main} inert={!wide && drawerOpen}>
            {props.children}
          </div>
        </div>
        <GoToFile
          scope={props.scope}
          ref={props.at.ref}
          sha={props.at.sha}
          open={finding}
          onClose={() => setFinding(false)}
        />
      </div>
    </CodeOpenerProvider>
  );
}

/** A folder or a file opened below the pane's top goes back to the page's top, as a page would. */
function revealTop(element: HTMLElement | null): void {
  if (element !== null && element.getBoundingClientRect().top < 0) window.scrollTo({ top: 0 });
}

type Pane = 'stalk' | 'files';

const PANES: readonly { readonly pane: Pane; readonly label: string }[] = [
  { pane: 'stalk', label: 'Stalk' },
  { pane: 'files', label: 'Files' },
];

/** The side pane's tabs: arrows move between them (WAI-ARIA tabs, automatic activation). */
function PaneTabs(props: { readonly pane: Pane; readonly onPick: (pane: Pane) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = props.pane === 'stalk' ? 'files' : 'stalk';
    props.onPick(next);
    event.currentTarget.querySelector<HTMLElement>(`#${PANEL_ID}-${next}-tab`)?.focus();
  };
  return (
    <div role="tablist" aria-label="Side pane" className={styles.paneTabs} onKeyDown={onKeyDown}>
      {PANES.map(({ pane, label }) => (
        <button
          key={pane}
          id={`${PANEL_ID}-${pane}-tab`}
          type="button"
          role="tab"
          aria-selected={props.pane === pane}
          aria-controls={`${PANEL_ID}-${pane}`}
          tabIndex={props.pane === pane ? 0 : -1}
          className={styles.paneTab}
          onClick={() => props.onPick(pane)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** The pane the view opens with (the tree on a file, the stalk on a folder), until one is picked. */
function usePaneOfView(view: TreeAt['view']): readonly [Pane, (pane: Pane) => void] {
  const own: Pane = view === 'blob' ? 'files' : 'stalk';
  const [seen, setSeen] = useState(view);
  const [pane, setPane] = useState<Pane>(own);
  if (seen !== view) {
    setSeen(view);
    setPane(own);
  }
  return [pane, setPane];
}

/**
 * Shows or hides the side pane, named for the tab it shows (the stalk on a folder, the files on a
 * file), as below 1024 px it is the only way to the pane. A link to the sidebar, so without script it opens the drawer as the
 * page's `:target`; with script, a button.
 */
function FilesToggle(props: {
  readonly ref: Ref<HTMLAnchorElement>;
  readonly pane: Pane;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <a
      ref={props.ref}
      href={`#${PANEL_ID}`}
      role="button"
      className={styles.filesToggle}
      aria-controls={PANEL_ID}
      aria-expanded={props.expanded}
      aria-keyshortcuts="Control+B Meta+B"
      title="Show or hide the stalk and the file tree (Ctrl+B)"
      onClick={(event) => {
        event.preventDefault();
        props.onToggle();
      }}
      onKeyDown={(event) => {
        if (event.key !== ' ') return;
        event.preventDefault();
        props.onToggle();
      }}
    >
      <PanelIcon />
      <span>{props.pane === 'stalk' ? 'Stalk' : 'Files'}</span>
    </a>
  );
}

/** The handle between the panes: drag it, or focus it and use the arrows, Home and End. */
function ResizeHandle(props: {
  readonly width: number;
  readonly onResize: (width: number) => void;
}) {
  const drag = useRef<{ readonly x: number; readonly width: number } | null>(null);
  const resize = (width: number) => props.onResize(clampWidth(width, window.innerWidth));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file tree"
      aria-controls={PANEL_ID}
      aria-valuemin={TREE_WIDTH.min}
      aria-valuemax={TREE_WIDTH.max}
      aria-valuenow={props.width}
      tabIndex={0}
      className={styles.handle}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const next = resizeByKey(props.width, event.key, event.shiftKey);
        if (next === null) return;
        event.preventDefault();
        resize(next);
      }}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: props.width };
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        if (drag.current === null) return;
        resize(drag.current.width + event.clientX - drag.current.x);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={() => resize(TREE_WIDTH.initial)}
    />
  );
}

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
      <path d="M6 2.5v11" stroke="currentColor" />
      <path d="M3 5h1.5M3 7h1.5M3 9h1.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** The layout in localStorage: the default on the server and on the first paint, then the stored one. */
function useStoredLayout(): readonly [
  TreeLayout,
  (update: (current: TreeLayout) => TreeLayout) => void,
] {
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  useLayoutEffect(() => {
    setLayout(readLayout(readStored('local', LAYOUT_STORAGE_KEY)));
  }, []);
  const update = useCallback((change: (current: TreeLayout) => TreeLayout) => {
    setLayout((current) => {
      const next = change(current);
      writeStored('local', LAYOUT_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [layout, update];
}

function useShortcuts(handlers: { readonly onToggle: () => void; readonly onFind: () => void }) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const pressed = { ...pick(event), inField: isTyping(event.target) };
      if (isToggleShortcut(pressed)) {
        event.preventDefault();
        latest.current.onToggle();
      } else if (isFinderShortcut(pressed)) {
        event.preventDefault();
        latest.current.onFind();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * An opened drawer takes focus to the tree's current row (or the open tab, on the stalk); a
 * closed one gives it back to the Files button. Both wait for the render, as the page behind an open drawer is `inert`.
 */
function useDrawerFocus(input: {
  readonly open: boolean;
  readonly sidebar: RefObject<HTMLElement | null>;
  readonly toggleButton: RefObject<HTMLAnchorElement | null>;
}): void {
  const { open, sidebar, toggleButton } = input;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open)
      sidebar.current
        ?.querySelector<HTMLElement>(
          '[role="treeitem"][tabindex="0"], [role="tab"][aria-selected="true"]',
        )
        ?.focus();
    else if (wasOpen.current) toggleButton.current?.focus();
    wasOpen.current = open;
  }, [open, sidebar, toggleButton]);
}

/** A file opened from the drawer closes it. */
function useCloseDrawerOnNavigation(at: TreeAt, setDrawerOpen: (open: boolean) => void): void {
  const where = `${at.view}:${at.path}:${at.sha}`;
  const [seen, setSeen] = useState(where);
  if (seen !== where) {
    setSeen(where);
    setDrawerOpen(false);
  }
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    // The server draws the wide layout; CSS shows the drawer's layout below 1024 px anyway.
    () => true,
  );
}

function drawerCloseClick(close: () => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    close();
  };
}

function pick(event: globalThis.KeyboardEvent) {
  return {
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
