import { describe, expect, it } from 'vitest';

import type { LoadedFolders, TreeRow } from './file-tree';
import {
  ancestorsOf,
  expandAlong,
  foldersAlong,
  keyAction,
  openFoldersFor,
  stalkGuides,
  toggleFolder,
  typeAhead,
  visibleRows,
} from './file-tree';
import { listing } from './tree';

const FILES = [
  { path: 'README.md', size: 900 },
  { path: 'package.json', size: 210 },
  { path: 'src/greet.ts', size: 340 },
  { path: 'src/util/slug.ts', size: 160 },
  { path: 'src/util/text/case.ts', size: 90 },
  { path: 'test/greet.test.ts', size: 410 },
];

/** Every folder of FILES loaded, as after the reader opened them all. */
function loaded(...folders: readonly string[]): LoadedFolders {
  return new Map(folders.map((folder) => [folder, listing(FILES, folder) ?? []]));
}

const paths = (rows: readonly TreeRow[]) => rows.map((row) => row.entry.path);

describe('the folders on the way to the open path', () => {
  it('names the folders that hold a file, outermost first', () => {
    expect(ancestorsOf('src/util/text/case.ts')).toEqual(['src', 'src/util', 'src/util/text']);
    expect(ancestorsOf('README.md')).toEqual([]);
  });

  it('opens a folder itself on the folder view, not on the file view', () => {
    expect(openFoldersFor('src/util', 'tree')).toEqual(['src', 'src/util']);
    expect(openFoldersFor('src/util/slug.ts', 'blob')).toEqual(['src', 'src/util']);
    expect(openFoldersFor('', 'tree')).toEqual([]);
  });

  it('sends the root and each open folder with the page, from the list it read', () => {
    const folders = foldersAlong(FILES, 'src/util/slug.ts', 'blob');
    expect(folders.map((folder) => folder.path)).toEqual(['', 'src', 'src/util']);
    expect(folders[2]?.entries.map((entry) => entry.name)).toEqual(['text', 'slug.ts']);
  });

  it('leaves out a folder the tree does not have', () => {
    expect(foldersAlong(FILES, 'gone/away.ts', 'blob').map((folder) => folder.path)).toEqual(['']);
  });

  it('adds the open path to what the reader expanded, keeping the same set when nothing is new', () => {
    const expanded = new Set(['test']);
    const along = expandAlong(expanded, 'src/util/slug.ts', 'blob');
    expect([...along].toSorted()).toEqual(['src', 'src/util', 'test']);
    expect(expandAlong(along, 'src/greet.ts', 'blob')).toBe(along);
  });

  it('toggles one folder without touching the set it was given', () => {
    const expanded = new Set(['src']);
    expect([...toggleFolder(expanded, 'test')].toSorted()).toEqual(['src', 'test']);
    expect([...toggleFolder(expanded, 'src')]).toEqual([]);
    expect([...expanded]).toEqual(['src']);
  });
});

describe('the rows the tree draws', () => {
  it('shows the root, and the entries of each expanded folder under it, with ARIA positions', () => {
    const rows = visibleRows(loaded('', 'src'), new Set(['src']));
    expect(paths(rows)).toEqual([
      'src',
      'src/util',
      'src/greet.ts',
      'test',
      'package.json',
      'README.md',
    ]);
    expect(rows[1]).toMatchObject({ level: 2, posInSet: 1, setSize: 2, parent: 'src' });
    expect(rows[0]?.folder).toBe('open');
    expect(rows[1]?.folder).toBe('closed');
    expect(rows[2]?.folder).toBeNull();
  });

  it('marks an expanded folder whose entries are not loaded yet as loading', () => {
    const rows = visibleRows(loaded(''), new Set(['src']));
    expect(rows[0]).toMatchObject({ folder: 'loading' });
    expect(paths(rows)).not.toContain('src/greet.ts');
  });

  it('hides the entries of a loaded folder under a closed parent', () => {
    const rows = visibleRows(loaded('', 'src', 'src/util'), new Set(['src/util']));
    expect(paths(rows)).not.toContain('src/util/slug.ts');
  });

  it('filters loaded entries by name, showing the folders that hold a match open', () => {
    const rows = visibleRows(loaded('', 'src', 'src/util', 'test'), new Set(), 'GREET');
    expect(paths(rows)).toEqual(['src', 'src/greet.ts', 'test', 'test/greet.test.ts']);
    expect(rows[0]?.folder).toBe('open');
    expect(rows[1]).toMatchObject({ level: 2, posInSet: 1, setSize: 1 });
  });

  it('does not search a folder that was never loaded', () => {
    const rows = visibleRows(loaded('', 'src'), new Set(), 'case');
    expect(rows).toEqual([]);
  });

  it('shows a folder whose own name matches, closed unless it holds a match', () => {
    const rows = visibleRows(loaded('', 'src', 'src/util'), new Set(), 'util');
    expect(paths(rows)).toEqual(['src', 'src/util']);
    expect(rows[1]?.folder).toBe('closed');
  });
});

describe('the keyboard', () => {
  const rows = visibleRows(loaded('', 'src', 'src/util'), new Set(['src', 'src/util']));

  it('moves with the up and down arrows, and jumps with Home and End', () => {
    expect(keyAction(rows, 'src', 'ArrowDown')).toEqual({ kind: 'focus', path: 'src/util' });
    expect(keyAction(rows, 'src/util', 'ArrowUp')).toEqual({ kind: 'focus', path: 'src' });
    expect(keyAction(rows, 'src', 'ArrowUp')).toBeNull();
    expect(keyAction(rows, 'src', 'End')).toEqual({ kind: 'focus', path: 'README.md' });
    expect(keyAction(rows, 'README.md', 'Home')).toEqual({ kind: 'focus', path: 'src' });
    expect(keyAction(rows, 'README.md', 'ArrowDown')).toBeNull();
  });

  it('starts on the first row when nothing is focused', () => {
    expect(keyAction(rows, null, 'ArrowDown')).toEqual({ kind: 'focus', path: 'src' });
    expect(keyAction(rows, null, 'Enter')).toEqual({ kind: 'focus', path: 'src' });
  });

  it('opens a closed folder on the right arrow, then moves into it', () => {
    expect(keyAction(rows, 'src/util/text', 'ArrowRight')).toEqual({
      kind: 'expand',
      paths: ['src/util/text'],
    });
    expect(keyAction(rows, 'src', 'ArrowRight')).toEqual({ kind: 'focus', path: 'src/util' });
    expect(keyAction(rows, 'src/greet.ts', 'ArrowRight')).toBeNull();
  });

  it('closes an open folder on the left arrow, else moves to the folder that holds the row', () => {
    expect(keyAction(rows, 'src/util', 'ArrowLeft')).toEqual({
      kind: 'collapse',
      path: 'src/util',
    });
    expect(keyAction(rows, 'src/util/slug.ts', 'ArrowLeft')).toEqual({
      kind: 'focus',
      path: 'src/util',
    });
    expect(keyAction(rows, 'README.md', 'ArrowLeft')).toBeNull();
  });

  it('opens a file and toggles a folder on Enter', () => {
    expect(keyAction(rows, 'src/greet.ts', 'Enter')).toEqual({
      kind: 'open',
      path: 'src/greet.ts',
    });
    expect(keyAction(rows, 'test', 'Enter')).toEqual({ kind: 'toggle', path: 'test' });
  });

  it('opens every closed folder beside the focused row on *', () => {
    expect(keyAction(rows, 'package.json', '*')).toEqual({ kind: 'expand', paths: ['test'] });
    expect(keyAction(rows, 'src/util/slug.ts', '*')).toEqual({
      kind: 'expand',
      paths: ['src/util/text'],
    });
  });

  it('ignores other keys', () => {
    expect(keyAction(rows, 'src', 'x')).toBeNull();
    expect(keyAction([], null, 'ArrowDown')).toBeNull();
  });
});

describe('type-ahead', () => {
  const rows = visibleRows(loaded('', 'src'), new Set(['src']));

  it('moves to the next name starting with a letter, wrapping round', () => {
    expect(typeAhead(rows, 'src', 't')).toBe('test');
    expect(typeAhead(rows, 'README.md', 's')).toBe('src');
  });

  it('cycles through names sharing a first letter', () => {
    const deeper = visibleRows(loaded('', 'src', 'src/util'), new Set(['src', 'src/util']));
    expect(typeAhead(deeper, 'src/util/text', 't')).toBe('test');
    expect(typeAhead(deeper, 'test', 't')).toBe('src/util/text');
  });

  it('matches a longer prefix from the focused row, and answers null when nothing matches', () => {
    expect(typeAhead(rows, 'src', 'src')).toBe('src');
    expect(typeAhead(rows, 'src', 'pa')).toBe('package.json');
    expect(typeAhead(rows, 'src', 'zz')).toBeNull();
  });
});

describe('the stalk to the open file', () => {
  it('lights each folder’s guide from the folder down to the next step on the way', () => {
    const rows = visibleRows(loaded('', 'src', 'src/util'), new Set(['src', 'src/util']));
    const marks = stalkGuides(rows, 'src/util/slug.ts');
    const byPath = new Map(rows.map((row, index) => [row.entry.path, marks[index]]));
    expect(byPath.get('src')).toEqual({ lit: [], end: null });
    expect(byPath.get('src/util')).toEqual({ lit: [0], end: 0 });
    // The root folder's guide stops at `src/util`; from there the next one carries on.
    expect(byPath.get('src/util/text')).toEqual({ lit: [1], end: null });
    expect(byPath.get('src/util/slug.ts')).toEqual({ lit: [1], end: 1 });
    expect(byPath.get('src/greet.ts')).toEqual({ lit: [], end: null });
  });

  it('draws nothing for a file at the root or nothing open', () => {
    const rows = visibleRows(loaded(''), new Set());
    expect(stalkGuides(rows, 'README.md').every((mark) => mark.lit.length === 0)).toBe(true);
    expect(stalkGuides(rows, '').every((mark) => mark.end === null)).toBe(true);
  });
});
