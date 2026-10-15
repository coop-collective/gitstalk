import { describe, expect, it } from 'vitest';

import type { OpenLocation } from './code-location';
import { codeTitle, hrefOf, isSameLocation, locationAt, locationOfUrl } from './code-location';

const BASE = '/coop/greeter';
const SPROUT = { kind: 'sprout' } as const;

describe('a Code URL as a location', () => {
  it('reads the repository root, a folder and a file', () => {
    expect(locationOfUrl(BASE, '/coop/greeter', '')).toEqual({
      view: 'tree',
      path: '',
      ref: { kind: 'stalk' },
      plain: false,
    });
    expect(locationOfUrl(BASE, '/coop/greeter/tree/src/util', '?ref=sprout')).toEqual({
      view: 'tree',
      path: 'src/util',
      ref: SPROUT,
      plain: false,
    });
    expect(locationOfUrl(BASE, '/coop/greeter/blob/README.md', '?plain=1')).toEqual({
      view: 'blob',
      path: 'README.md',
      ref: { kind: 'stalk' },
      plain: true,
    });
  });

  it('decodes escaped segments, in the path and in the repository’s own address', () => {
    expect(locationOfUrl('/co%7Eop/greeter', '/co~op/greeter/blob/a%20b/c%23.ts', '')?.path).toBe(
      'a b/c#.ts',
    );
  });

  it('names nothing outside the Code tab of this repository', () => {
    expect(locationOfUrl(BASE, '/coop/other/blob/a.ts', '')).toBeNull();
    expect(locationOfUrl(BASE, '/coop/greeter/changes', '')).toBeNull();
    expect(locationOfUrl(BASE, '/coop/greeter/blob', '')).toBeNull();
    expect(locationOfUrl(BASE, '/coop/greeter/blob/%E0%A4%A', '')).toBeNull();
  });

  it('round-trips through the URL it writes', () => {
    const file: OpenLocation = { view: 'blob', path: 'docs/a b.md', ref: SPROUT, plain: true };
    const href = new URL(hrefOf(BASE, file), 'https://gitstalk.test');
    expect(href.pathname).toBe('/coop/greeter/blob/docs/a%20b.md');
    expect(locationOfUrl(BASE, href.pathname, href.search)).toEqual(file);
    const root = locationAt({ view: 'tree', path: '' }, { kind: 'stalk' });
    expect(hrefOf(BASE, root)).toBe(BASE);
  });
});

describe('comparing locations', () => {
  const file = locationAt({ view: 'blob', path: 'README.md' }, SPROUT);

  it('tells a Markdown file’s source from its rendering, but not a folder’s', () => {
    expect(isSameLocation(file, { ...file, plain: true })).toBe(false);
    const folder = locationAt({ view: 'tree', path: 'src' }, SPROUT);
    expect(isSameLocation(folder, { ...folder, plain: true })).toBe(true);
  });

  it('tells two refs apart', () => {
    expect(isSameLocation(file, { ...file, ref: { kind: 'stalk' } })).toBe(false);
    expect(isSameLocation(file, { ...file })).toBe(true);
  });
});

describe('the title of a location', () => {
  it('matches the pages’ own titles', () => {
    expect(codeTitle(locationAt({ view: 'tree', path: '' }, SPROUT), 'coop', 'greeter')).toBe(
      'coop/greeter · Gitstalk',
    );
    expect(
      codeTitle(locationAt({ view: 'blob', path: 'src/a.ts' }, SPROUT), 'coop', 'greeter'),
    ).toBe('src/a.ts, coop/greeter · Gitstalk');
  });
});
