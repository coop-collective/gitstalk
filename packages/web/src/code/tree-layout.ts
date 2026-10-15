/**
 * What the Code tab remembers about its file tree, per viewer and browser: the sidebar's width
 * and whether it is collapsed (localStorage, every repository), and which folders were open and
 * how far the tree was scrolled (sessionStorage, per repository, so a page that mounts the tree
 * again, such as a folder after a file, shows it as it was). Stored values are read through
 * schemas and fall back to the defaults; storage that throws or is missing changes nothing.
 */
import * as z from 'zod/mini';

/** The sidebar's width in pixels, by default and at the extremes. */
export const TREE_WIDTH = { initial: 280, min: 180, max: 560 } as const;

/** The pixels one arrow key moves the resize handle, and with Shift held. */
export const RESIZE_STEP = { small: 16, large: 64 } as const;

export const LAYOUT_STORAGE_KEY = 'gitstalk-file-tree';

export type TreeLayout = { readonly width: number; readonly collapsed: boolean };

export const DEFAULT_LAYOUT: TreeLayout = { width: TREE_WIDTH.initial, collapsed: false };

/** What the tree remembers for one repository in this tab. */
export type TreeMemory = { readonly expanded: readonly string[]; readonly scrollTop: number };

const StoredLayout = z.object({ width: z.number(), collapsed: z.boolean() });
const StoredMemory = z.object({ expanded: z.array(z.string()), scrollTop: z.number() });

/** The stored layout, or the default when nothing (or nothing valid) is stored. */
export function readLayout(raw: string | null): TreeLayout {
  const parsed = parseJson(raw, StoredLayout);
  return parsed === null ? DEFAULT_LAYOUT : { ...parsed, width: clampWidth(parsed.width, null) };
}

/** The stored memory of a repository's tree, or null. */
export function readMemory(raw: string | null): TreeMemory | null {
  return parseJson(raw, StoredMemory);
}

/** The sessionStorage key of a repository's tree memory. */
export function memoryKey(owner: string, repo: string): string {
  return `${LAYOUT_STORAGE_KEY}:${owner}/${repo}`;
}

/**
 * A width kept between the minimum and the maximum, and at most half the viewport so the file
 * keeps room (`viewport` null: no viewport limit, as when reading a stored width).
 */
export function clampWidth(width: number, viewport: number | null): number {
  const max = viewport === null ? TREE_WIDTH.max : Math.min(TREE_WIDTH.max, viewport / 2);
  return Math.round(Math.min(Math.max(width, TREE_WIDTH.min), Math.max(max, TREE_WIDTH.min)));
}

/** The width a key on the resize handle asks for, or null for a key it ignores. */
export function resizeByKey(width: number, key: string, shift: boolean): number | null {
  const step = shift ? RESIZE_STEP.large : RESIZE_STEP.small;
  switch (key) {
    case 'ArrowLeft':
      return width - step;
    case 'ArrowRight':
      return width + step;
    case 'Home':
      return TREE_WIDTH.min;
    case 'End':
      return TREE_WIDTH.max;
    default:
      return null;
  }
}

/**
 * Whether a key press is the Go to file shortcut (`t`, as on GitHub): no modifier, and not
 * typed into a field.
 */
export function isFinderShortcut(event: ShortcutEvent): boolean {
  return event.key === 't' && !hasModifier(event) && !event.inField;
}

/** Whether a key press toggles the file tree (Ctrl+B, or Cmd+B on a Mac, as in VS Code). */
export function isToggleShortcut(event: ShortcutEvent): boolean {
  return (
    event.key.toLowerCase() === 'b' &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** The parts of a key press the shortcuts look at. */
export type ShortcutEvent = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** Whether focus is in a text field, a select or an editable region. */
  readonly inField: boolean;
};

function hasModifier(event: ShortcutEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

function parseJson<S extends z.ZodMiniType>(raw: string | null, schema: S): z.infer<S> | null {
  if (raw === null) return null;
  try {
    const parsed = z.safeParse(schema, JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Not JSON: something else wrote the key; the defaults stand.
    return null;
  }
}
