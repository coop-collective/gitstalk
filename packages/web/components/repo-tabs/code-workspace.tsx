'use client';

/**
 * The Code tab's two panes, as in an editor: the file tree on the left, the open file (or the
 * folder) on the right, with the bar (ref switcher, path, Code button) across both.
 *
 * - From 1024 px the tree is a sidebar: resizable by its handle (drag, or the arrow keys on
 *   it), collapsible by the Files button or Ctrl+B (Cmd+B on a Mac), its width and collapse
 *   remembered in localStorage.
 * - Below 1024 px it is a drawer the Files button opens; it closes on Escape, on the backdrop,
 *   or when a file opens. Without script, the Files link opens it as the page's `:target`.
 * - `t` opens Go to file anywhere on the page (not while typing).
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
  readonly at: TreeAt;
  readonly folders: readonly FolderListing[];
  /** The bar over both panes (ref switcher, path, Code button). */
  readonly bar: ReactNode;
  /** The open file or folder. */
  readonly children: ReactNode;
}) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [layout, setLayout] = useStoredLayout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const toggleButton = useRef<HTMLAnchorElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useDrawerFocus({ open: drawerOpen, sidebar, toggleButton });
  const toggle = useCallback(() => {
    if (window.matchMedia(WIDE_QUERY).matches)
      setLayout((current) => ({ ...current, collapsed: !current.collapsed }));
    else setDrawerOpen((open) => !open);
  }, [setLayout]);
  useShortcuts({ onToggle: toggle, onFind: () => setFinding(true) });
  useCloseDrawerOnNavigation(props.at, setDrawerOpen);
  const closeDrawer = () => setDrawerOpen(false);
  const expanded = wide ? !layout.collapsed : drawerOpen;
  return (
    <div
      className={styles.workspace}
      data-collapsed={layout.collapsed ? '' : undefined}
      data-drawer={drawerOpen ? 'open' : undefined}
      style={cssVars({ '--tree-width': `${layout.width}px` })}
    >
      <div className={styles.toolbar} inert={!wide && drawerOpen}>
        <FilesToggle ref={toggleButton} expanded={expanded} onToggle={toggle} />
        <div className={styles.barSlot}>{props.bar}</div>
      </div>
      <div className={styles.panes}>
        <aside
          ref={sidebar}
          id={PANEL_ID}
          className={styles.sidebar}
          aria-label="File tree"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !wide && drawerOpen) closeDrawer();
          }}
        >
          <a href="#" className={styles.drawerClose} onClick={drawerCloseClick(closeDrawer)}>
            Close
          </a>
          <FileTree
            scope={props.scope}
            at={props.at}
            folders={props.folders}
            onFind={() => setFinding(true)}
          />
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
        <div className={styles.main} inert={!wide && drawerOpen}>
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
  );
}

/**
 * Shows or hides the tree. A link to the sidebar, so without script it opens the drawer as the
 * page's `:target`; with script, a button.
 */
function FilesToggle(props: {
  readonly ref: Ref<HTMLAnchorElement>;
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
      title="Show or hide the file tree (Ctrl+B)"
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
      <span>Files</span>
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
 * An opened drawer takes focus to the tree's current row; a closed one gives it back to the
 * Files button. Both wait for the render, as the page behind an open drawer is `inert`.
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
      sidebar.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
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
