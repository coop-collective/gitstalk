import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DOCS_PAGES, SITE_ROOT_PAGES, sitePagePaths } from './pages';

/** The `.html` pages in a directory of the site's public files, without their extension. */
function htmlPages(directory: string): string[] {
  const dir = fileURLToPath(new URL(`../../../site/public/${directory}`, import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.html') && !name.startsWith('_'))
    .map((name) => name.slice(0, -'.html'.length))
    .toSorted();
}

describe('the public pages the sitemap lists', () => {
  it('lists every docs page in packages/site/public/docs', () => {
    expect([...DOCS_PAGES, 'index'].toSorted()).toEqual(htmlPages('docs'));
  });

  it('lists every top-level site page but the landing and the 404 page', () => {
    const pages = htmlPages('').filter((name) => name !== '404' && name !== 'index');
    expect([...SITE_ROOT_PAGES].toSorted()).toEqual(pages);
  });

  it('gives each page its pretty path: the landing, then pages, then the docs', () => {
    const paths = sitePagePaths();
    expect(paths.slice(0, 3)).toEqual(['/', '/about', '/agent']);
    expect(paths).toContain('/docs/');
    expect(paths).toContain('/docs/self-hosting');
    expect(paths.some((path) => path.endsWith('.html'))).toBe(false);
  });
});
