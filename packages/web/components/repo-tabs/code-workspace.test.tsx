import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { RepoScope } from '../../src/changes/change-feed';
import { foldersAlong } from '../../src/code/file-tree';
import type { CodeView } from '../../src/code/tree';
import { CodeWorkspace } from './code-workspace';

// The app router and its links come from vinext at build time; a plain anchor stands in. The
// URL is not a Code URL, so the workspace shows the location it was rendered for.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: {
    readonly href: string;
    readonly prefetch?: unknown;
    readonly onNavigate?: unknown;
  }) => {
    const anchor: Record<string, unknown> = { ...props };
    delete anchor['prefetch'];
    delete anchor['onNavigate'];
    return <a {...anchor} />;
  },
}));
vi.mock('../shell/link-pending', () => ({ LinkPending: () => null }));
vi.mock('../shell/intent-link', () => ({
  IntentLink: (props: { readonly href: string; readonly children: ReactNode }) => (
    <a {...props} href={props.href} />
  ),
}));

const FILES = [
  { path: 'README.md', size: 900 },
  { path: 'package.json', size: 210 },
  { path: 'src/greet.ts', size: 340 },
  { path: 'src/util/slug.ts', size: 160 },
  { path: 'src/util/text/case.ts', size: 90 },
  { path: 'test/greet.test.ts', size: 410 },
];
const SHA = 'a'.repeat(40);
const SCOPE: RepoScope = {
  uid: null,
  owner: 'coop',
  repo: 'greeter',
  base: '/coop/greeter',
  visibility: 'public',
};

/** The workspace's HTML as the server renders it for a page, before any script runs. */
function render(path: string, view: CodeView): string {
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <CodeWorkspace
        scope={SCOPE}
        at={{ ref: { kind: 'sprout' }, sha: SHA, path, view }}
        plain={false}
        folders={foldersAlong(FILES, path, view)}
        bar={<nav aria-label="Path">bar</nav>}
        stalk={<p>the stalk</p>}
      >
        <section aria-label="The open file">file</section>
      </CodeWorkspace>
    </QueryClientProvider>,
  );
}

/** One tree row: its `<li>` attributes and the HTML inside it (rows are a flat list). */
type Item = { readonly attrs: ReadonlyMap<string, string>; readonly inner: string };

function treeItems(html: string): readonly Item[] {
  return html
    .split('<li ')
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf('>');
      return { attrs: attributes(chunk.slice(0, end)), inner: chunk.slice(end + 1) };
    })
    .filter((row) => row.attrs.get('role') === 'treeitem');
}

function attributes(text: string): ReadonlyMap<string, string> {
  return new Map(
    [...text.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1] ?? '', match[2] ?? '']),
  );
}

function item(html: string, path: string): Item {
  const found = treeItems(html).find((candidate) => candidate.attrs.get('data-path') === path);
  if (found === undefined) throw new Error(`no row for ${path}`);
  return found;
}

/** The first element with this opening-tag text, as its attributes. */
function tag(html: string, pattern: RegExp): ReadonlyMap<string, string> {
  const match = pattern.exec(html);
  if (match === null) throw new Error(`no element matches ${pattern}`);
  return attributes(match[0]);
}

const paths = (html: string) => treeItems(html).map((row) => row.attrs.get('data-path'));
const hrefOf = (row: Item) => attributes(/<a [^>]*>/.exec(row.inner)?.[0] ?? '').get('href');
const litGuides = (row: Item) => row.inner.split('<li')[0]?.match(/data-lit=""/g)?.length ?? 0;

describe('the Code tab’s workspace, server-rendered', () => {
  it('draws the tree open down to the open file, with the file selected and in the tab order', () => {
    const html = render('src/util/slug.ts', 'blob');
    expect(html).toContain('role="tree" aria-label="Files"');
    expect(paths(html)).toEqual([
      'src',
      'src/util',
      'src/util/text',
      'src/util/slug.ts',
      'src/greet.ts',
      'test',
      'package.json',
      'README.md',
    ]);
    const rows = treeItems(html);
    expect(
      rows
        .filter((row) => row.attrs.get('aria-selected') === 'true')
        .map((row) => row.attrs.get('data-path')),
    ).toEqual(['src/util/slug.ts']);
    expect(
      rows
        .filter((row) => row.attrs.get('tabindex') === '0')
        .map((row) => row.attrs.get('data-path')),
    ).toEqual(['src/util/slug.ts']);
  });

  it('gives every row its ARIA level, position and set size, and folders their state', () => {
    const html = render('src/util/slug.ts', 'blob');
    const util = item(html, 'src/util').attrs;
    expect([util.get('aria-level'), util.get('aria-posinset'), util.get('aria-setsize')]).toEqual([
      '2',
      '1',
      '2',
    ]);
    expect(util.get('aria-expanded')).toBe('true');
    expect(item(html, 'test').attrs.get('aria-expanded')).toBe('false');
    expect(item(html, 'README.md').attrs.has('aria-expanded')).toBe(false);
  });

  it('links every row to its page at the browsed ref, so it works without script', () => {
    const html = render('src/util/slug.ts', 'blob');
    expect(hrefOf(item(html, 'src/greet.ts'))).toBe('/coop/greeter/blob/src/greet.ts?ref=sprout');
    expect(hrefOf(item(html, 'test'))).toBe('/coop/greeter/tree/test?ref=sprout');
    expect(item(html, 'src/util/slug.ts').inner).toContain('aria-current="page"');
  });

  it('lights the stalk down the guides to the open file', () => {
    const html = render('src/util/slug.ts', 'blob');
    expect(litGuides(item(html, 'src/util'))).toBe(1);
    expect(litGuides(item(html, 'src/util/slug.ts'))).toBe(1);
    expect(litGuides(item(html, 'src/greet.ts'))).toBe(0);
  });

  it('opens a folder’s own page with the folder itself open and selected', () => {
    const html = render('src/util', 'tree');
    expect(item(html, 'src/util').attrs.get('aria-selected')).toBe('true');
    expect(paths(html)).toContain('src/util/slug.ts');
  });

  it('labels the sidebar, the Files button and the keyboard-resizable handle', () => {
    const html = render('README.md', 'blob');
    const toggle = tag(html, /<a [^>]*role="button"[^>]*>/);
    expect(toggle.get('aria-controls')).toBe('code-files');
    expect(toggle.get('aria-expanded')).toBe('true');
    expect(toggle.get('href')).toBe('#code-files');
    expect(tag(html, /<aside [^>]*>/).get('aria-label')).toBe('Stalk and files');
    const handle = tag(html, /<div [^>]*role="separator"[^>]*>/);
    expect(handle.get('aria-label')).toBe('Resize the file tree');
    expect(handle.get('aria-valuenow')).toBe('280');
    expect(handle.get('tabindex')).toBe('0');
  });

  it('shows the stalk on a folder and the file tree on a file, each a tab away', () => {
    const tabs = (html: string) =>
      [...html.matchAll(/<button [^>]*role="tab"[^>]*>(\w+)<\/button>/g)].map((match) => ({
        label: match[1],
        selected: tag(match[0], /<button [^>]*>/).get('aria-selected'),
      }));
    const panel = (html: string, pane: string) =>
      tag(html, new RegExp(`<div [^>]*id="code-files-${pane}"[^>]*>`));
    const folder = render('', 'tree');
    const toggleLabel = (html: string) =>
      /<a [^>]*role="button"[^>]*>.*?<span>(\w+)<\/span><\/a>/s.exec(html)?.[1];
    expect(toggleLabel(folder)).toBe('Stalk');
    expect(toggleLabel(render('README.md', 'blob'))).toBe('Files');
    expect(tabs(folder)).toEqual([
      { label: 'Stalk', selected: 'true' },
      { label: 'Files', selected: 'false' },
    ]);
    expect(panel(folder, 'stalk').has('hidden')).toBe(false);
    expect(panel(folder, 'files').has('hidden')).toBe(true);
    expect(folder).toContain('<p>the stalk</p>');
    const file = render('README.md', 'blob');
    expect(tabs(file)).toEqual([
      { label: 'Stalk', selected: 'false' },
      { label: 'Files', selected: 'true' },
    ]);
    expect(panel(file, 'stalk').has('hidden')).toBe(true);
    expect(panel(file, 'files').has('hidden')).toBe(false);
  });

  it('keeps the bar and the open file in the page', () => {
    const html = render('README.md', 'blob');
    expect(html).toContain('<nav aria-label="Path">bar</nav>');
    expect(html).toContain('<section aria-label="The open file">file</section>');
  });
});
