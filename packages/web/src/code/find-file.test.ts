import { describe, expect, it } from 'vitest';

import { findFiles, matchPath } from './find-file';

const PATHS = [
  'README.md',
  'package.json',
  'src/greet.ts',
  'src/util/slug.ts',
  'src/util/text/case.ts',
  'test/greet.test.ts',
  'docs/guides/getting-started.md',
];

describe('go to file', () => {
  it('finds paths holding the letters in order, ignoring case and spaces', () => {
    expect(findFiles(PATHS, 'SLUG', 10).map((match) => match.path)).toEqual(['src/util/slug.ts']);
    expect(findFiles(PATHS, 'u s', 10).map((match) => match.path)).toContain('src/util/slug.ts');
    expect(findFiles(PATHS, 'zzz', 10)).toEqual([]);
  });

  it('ranks a match in the file name above one spread over folders', () => {
    const found = findFiles(PATHS, 'greet', 10).map((match) => match.path);
    expect(found[0]).toBe('src/greet.ts');
    expect(found[1]).toBe('test/greet.test.ts');
  });

  it('prefers letters that start words', () => {
    expect(findFiles(PATHS, 'gs', 10)[0]?.path).toBe('docs/guides/getting-started.md');
  });

  it('marks the characters that matched, for highlighting', () => {
    expect(matchPath('src/greet.ts', 'gt')?.marks).toEqual([4, 8]);
    expect(matchPath('src/greet.ts', 'sg')?.marks).toEqual([0, 4]);
  });

  it('lists the first paths for an empty query, and keeps to the limit', () => {
    expect(findFiles(PATHS, '', 2).map((match) => match.path)).toEqual([
      'README.md',
      'package.json',
    ]);
    expect(findFiles(PATHS, 't', 3)).toHaveLength(3);
  });
});
