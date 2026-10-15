/**
 * The Code tab's file tree beside the open file, as pure data: which folders the server sends
 * with the page (the root and every folder on the way to the open path), which folders are
 * expanded, the rows the tree draws (with the WAI-ARIA tree view's level, position and set
 * size), the name filter, and what each key does. The component (`file-tree.tsx`) only renders
 * rows and applies actions, so this module carries the behaviour and its tests.
 */
import type { CodeView, TreeEntry } from './tree';
import { listing } from './tree';

/** One folder's entries ('' is the root). */
export type FolderListing = { readonly path: string; readonly entries: readonly TreeEntry[] };

/** The folders loaded so far, by path. */
export type LoadedFolders = ReadonlyMap<string, readonly TreeEntry[]>;

/** How a folder row is drawn: open with its entries, closed, or open while its entries load. */
export type FolderState = 'open' | 'closed' | 'loading';

/** One row of the tree, in the order drawn. */
export type TreeRow = {
  readonly entry: TreeEntry;
  /** 1 at the root (`aria-level`). */
  readonly level: number;
  /** 1-based position among the shown siblings (`aria-posinset`, `aria-setsize`). */
  readonly posInSet: number;
  readonly setSize: number;
  /** The folder the entry is in ('' at the root). */
  readonly parent: string;
  /** Null for a file. */
  readonly folder: FolderState | null;
};

/** What a key does to the tree; null when the tree ignores the key. */
export type TreeAction =
  | { readonly kind: 'focus'; readonly path: string }
  | { readonly kind: 'expand'; readonly paths: readonly string[] }
  | { readonly kind: 'collapse'; readonly path: string }
  | { readonly kind: 'toggle'; readonly path: string }
  | { readonly kind: 'open'; readonly path: string };

/** The folders that hold `path`, outermost first: `a/b/c.ts` is in `a` and `a/b`. */
export function ancestorsOf(path: string): readonly string[] {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** The folders shown open for a page: those on the way to a file, or to and including a folder. */
export function openFoldersFor(path: string, view: CodeView): readonly string[] {
  if (path === '') return [];
  return view === 'tree' ? [...ancestorsOf(path), path] : ancestorsOf(path);
}

/**
 * The listings a page sends with its tree: the root and each open folder, from the flat file
 * list the page read anyway (no extra request). A folder the tree lacks is left out.
 */
export function foldersAlong(
  files: readonly { readonly path: string; readonly size: number }[],
  path: string,
  view: CodeView,
): readonly FolderListing[] {
  return ['', ...openFoldersFor(path, view)].flatMap((folder) => {
    const entries = listing(files, folder);
    return entries === null ? [] : [{ path: folder, entries }];
  });
}

/** `expanded` with every folder on the way to `path` added (the tree reveals the open file). */
export function expandAlong(
  expanded: ReadonlySet<string>,
  path: string,
  view: CodeView,
): ReadonlySet<string> {
  const wanted = openFoldersFor(path, view);
  if (wanted.every((folder) => expanded.has(folder))) return expanded;
  return new Set([...expanded, ...wanted]);
}

/** `expanded` with `folder` opened or closed. */
export function toggleFolder(expanded: ReadonlySet<string>, folder: string): ReadonlySet<string> {
  const next = new Set(expanded);
  if (next.has(folder)) next.delete(folder);
  else next.add(folder);
  return next;
}

/**
 * The rows to draw. Without a filter: the root's entries, and the entries of every expanded
 * folder under an expanded parent. With one (a case-insensitive part of a name): every loaded
 * entry whose name contains it, with the folders that hold one shown open; closed folders that
 * were never loaded are not searched.
 */
export function visibleRows(
  folders: LoadedFolders,
  expanded: ReadonlySet<string>,
  filter = '',
): readonly TreeRow[] {
  const needle = filter.trim().toLowerCase();
  return rowsOf(needle === '' ? unfilteredWalk(folders, expanded) : filteredWalk(folders, needle));
}

/**
 * What `key` does with `focused` (a row's path; null when nothing is focused yet) under the
 * WAI-ARIA tree view pattern: arrows move and open or close, Home and End jump, Enter opens a
 * file or toggles a folder, `*` opens every folder beside the focused one.
 */
export function keyAction(
  rows: readonly TreeRow[],
  focused: string | null,
  key: string,
): TreeAction | null {
  if (rows.length === 0) return null;
  const index = rows.findIndex((row) => row.entry.path === focused);
  const row = rows[index];
  const focus = (target: TreeRow | undefined): TreeAction | null =>
    target === undefined ? null : { kind: 'focus', path: target.entry.path };
  switch (key) {
    case 'ArrowDown':
      return focus(index === -1 ? rows[0] : rows[index + 1]);
    case 'ArrowUp':
      return focus(index === -1 ? rows[0] : rows[index - 1]);
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows.at(-1));
    default:
      return row === undefined ? focus(rows[0]) : rowAction(rows, index, row, key);
  }
}

/**
 * Type-ahead: the next row after `focused` whose name starts with `typed` (case-insensitive),
 * wrapping round; null when none does.
 */
export function typeAhead(
  rows: readonly TreeRow[],
  focused: string | null,
  typed: string,
): string | null {
  const prefix = typed.toLowerCase();
  if (prefix === '') return null;
  const start = rows.findIndex((row) => row.entry.path === focused);
  // A repeated single letter cycles through the names starting with it, as in a file manager.
  const from = prefix.length === 1 ? start + 1 : Math.max(start, 0);
  for (let step = 0; step < rows.length; step += 1) {
    const row = rows[(from + step) % rows.length];
    if (row !== undefined && row.entry.name.toLowerCase().startsWith(prefix)) return row.entry.path;
  }
  return null;
}

/** Which indent guides of a row draw the stalk, by column (0 is the guide under the root's folders). */
export type StalkMarks = {
  readonly lit: readonly number[];
  /** The column where the stalk reaches this row (the open path's next step), or null. */
  readonly end: number | null;
};

/**
 * The stalk: the indent guides from each folder on the way to `selected` down to the next step
 * on that way, so one line grows from the root to the open file. One entry per row.
 */
export function stalkGuides(rows: readonly TreeRow[], selected: string): readonly StalkMarks[] {
  const chain = [...ancestorsOf(selected), selected];
  const indexOf = new Map(rows.map((row, index) => [row.entry.path, index]));
  const steps = chain.slice(0, -1).flatMap((folder, column) => {
    const reach = indexOf.get(chain[column + 1] ?? '');
    return reach === undefined ? [] : [{ column, inside: `${folder}/`, reach }];
  });
  return rows.map((row, index) => {
    const lit: number[] = [];
    let end: number | null = null;
    for (const step of steps) {
      if (!row.entry.path.startsWith(step.inside) || index > step.reach) continue;
      lit.push(step.column);
      if (index === step.reach) end = step.column;
    }
    return { lit, end };
  });
}

/** The folder that holds `path` ('' for an entry at the root). */
export function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

function rowAction(
  rows: readonly TreeRow[],
  index: number,
  row: TreeRow,
  key: string,
): TreeAction | null {
  const path = row.entry.path;
  switch (key) {
    case 'ArrowRight':
      if (row.folder === 'closed') return { kind: 'expand', paths: [path] };
      if (row.folder === 'open' && rows[index + 1]?.parent === path)
        return { kind: 'focus', path: rows[index + 1]?.entry.path ?? path };
      return null;
    case 'ArrowLeft':
      if (row.folder === 'open' || row.folder === 'loading') return { kind: 'collapse', path };
      return row.parent === '' ? null : { kind: 'focus', path: row.parent };
    case 'Enter':
      return row.folder === null ? { kind: 'open', path } : { kind: 'toggle', path };
    case '*':
      return expandSiblings(rows, row);
    default:
      return null;
  }
}

function expandSiblings(rows: readonly TreeRow[], row: TreeRow): TreeAction | null {
  const closed = rows
    .filter((other) => other.parent === row.parent && other.folder === 'closed')
    .map((other) => other.entry.path);
  return closed.length === 0 ? null : { kind: 'expand', paths: closed };
}

/** How rows are drawn: the entries shown in a folder, and the state a folder is drawn in. */
type Walk = {
  readonly entriesOf: (folder: string) => readonly TreeEntry[];
  readonly stateOf: (entry: TreeEntry) => FolderState | null;
};

function rowsOf(walk: Walk): readonly TreeRow[] {
  const rows: TreeRow[] = [];
  addRows(walk, '', 1, rows);
  return rows;
}

function addRows(walk: Walk, folder: string, level: number, rows: TreeRow[]): void {
  const entries = walk.entriesOf(folder);
  entries.forEach((entry, index) => {
    const state = walk.stateOf(entry);
    rows.push({
      entry,
      level,
      posInSet: index + 1,
      setSize: entries.length,
      parent: folder,
      folder: state,
    });
    if (state === 'open') addRows(walk, entry.path, level + 1, rows);
  });
}

/** The rows without a filter: each expanded folder's entries under an expanded parent. */
function unfilteredWalk(folders: LoadedFolders, expanded: ReadonlySet<string>): Walk {
  return {
    entriesOf: (folder) => folders.get(folder) ?? [],
    stateOf: (entry) => {
      if (entry.kind === 'file') return null;
      if (!expanded.has(entry.path)) return 'closed';
      return folders.has(entry.path) ? 'open' : 'loading';
    },
  };
}

/** The rows under a filter: matching entries, and the folders holding one, open. */
function filteredWalk(folders: LoadedFolders, needle: string): Walk {
  const holding = foldersHoldingMatches(folders, needle);
  return {
    entriesOf: (folder) =>
      (folders.get(folder) ?? []).filter(
        (entry) => matches(entry, needle) || holding.has(entry.path),
      ),
    stateOf: (entry) => {
      if (entry.kind === 'file') return null;
      return holding.has(entry.path) ? 'open' : 'closed';
    },
  };
}

function foldersHoldingMatches(folders: LoadedFolders, needle: string): ReadonlySet<string> {
  const holding = new Set<string>();
  for (const entries of folders.values())
    for (const entry of entries)
      if (matches(entry, needle)) for (const folder of ancestorsOf(entry.path)) holding.add(folder);
  return holding;
}

function matches(entry: TreeEntry, needle: string): boolean {
  return entry.name.toLowerCase().includes(needle);
}
