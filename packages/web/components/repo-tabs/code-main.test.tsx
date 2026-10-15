import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { RepoScope } from '../../src/changes/change-feed';
import { foldersAlong } from '../../src/code/file-tree';
import { listing } from '../../src/code/tree';
import type { FileBlob } from '../../src/repo-pages/engine-reads';
import { OpenCodeBar, OpenCodeMain } from './code-main';
import type { CodeOpener } from './code-opener';
import { useCodeOpener } from './code-opener';
import { fileQuery, folderQuery } from './code-queries';
import { CodeWorkspace } from './code-workspace';

/** The URL the workspace reads, as `usePathname` and `useSearchParams` give it. */
const url = vi.hoisted(() => ({ current: new URL('https://gitstalk.test/') }));

// The app router and its links come from vinext at build time; plain anchors stand in.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => url.current.pathname,
  useSearchParams: () => url.current.searchParams,
}));
vi.mock('next/link', () => ({
  default: (props: { readonly prefetch?: unknown; readonly onNavigate?: unknown }) => {
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
  { path: 'README.md', size: 30 },
  { path: 'package.json', size: 20 },
  { path: 'src/greet.ts', size: 40 },
  { path: 'src/util/slug.ts', size: 50 },
];
const SHA = 'a'.repeat(40);
const SPROUT = { kind: 'sprout' } as const;
const SCOPE: RepoScope = {
  uid: null,
  owner: 'coop',
  repo: 'greeter',
  base: '/coop/greeter',
  visibility: 'public',
};

function blob(path: string, content: string): FileBlob {
  return { path, size: content.length, binary: false, content, truncated: false };
}

/** The page for `src/greet.ts` at the sprout, as the server renders it with the URL at `href`. */
function render(href: string, client = new QueryClient(), probe: ReactNode = null): string {
  url.current = new URL(href, 'https://gitstalk.test');
  const at = { base: SCOPE.base, ref: SPROUT, path: 'src/greet.ts', sha: SHA };
  return renderToString(
    <QueryClientProvider client={client}>
      <CodeWorkspace
        scope={SCOPE}
        at={{ ref: SPROUT, sha: SHA, path: at.path, view: 'blob' }}
        plain={false}
        folders={foldersAlong(FILES, at.path, 'blob')}
        bar={<OpenCodeBar at={at} view="blob" repoName="greeter" beans={[]} menu={null} />}
        stalk={<p>the stalk</p>}
      >
        <OpenCodeMain
          base={SCOPE.base}
          body={{ kind: 'file', file: blob('src/greet.ts', 'export const greet = 1;\n') }}
          head={null}
          nowMs={0}
          aside={<aside aria-label="About this repository">About</aside>}
        />
        {probe}
      </CodeWorkspace>
    </QueryClientProvider>,
  );
}

/** A query client holding what the browser has read of the repository at `SHA`. */
function readBefore(reads: {
  readonly files?: readonly FileBlob[];
  readonly folders?: readonly string[];
}): QueryClient {
  const client = new QueryClient();
  for (const file of reads.files ?? [])
    client.setQueryData(fileQuery(SCOPE, SHA, file.path).queryKey, file);
  for (const folder of reads.folders ?? [])
    client.setQueryData(folderQuery(SCOPE, SHA, folder).queryKey, listing(FILES, folder) ?? []);
  return client;
}

const selectedRows = (html: string) =>
  [...html.matchAll(/<li [^>]*aria-selected="true"[^>]*data-path="([^"]*)"/g)].map(
    (match) => match[1],
  );
const crumb = (html: string) => /<nav [^>]*aria-label="Path"[^>]*>.*?<\/nav>/s.exec(html)?.[0];

describe('the Code workspace’s main pane', () => {
  it('shows what the server read while the URL is the page’s own', () => {
    const html = render('/coop/greeter/blob/src/greet.ts?ref=sprout');
    expect(html).toContain('greet');
    expect(html).toContain('aria-label="src/greet.ts"');
    expect(html).not.toContain('Opening');
    expect(selectedRows(html)).toEqual(['src/greet.ts']);
  });

  it('draws a file opened in the browser from what was read at the page’s commit', () => {
    const client = readBefore({
      files: [blob('src/util/slug.ts', 'export const slug = 2;\n')],
      folders: ['src/util'],
    });
    const html = render('/coop/greeter/blob/src/util/slug.ts?ref=sprout', client);
    expect(html).toContain('aria-label="src/util/slug.ts"');
    expect(html).toContain('slug');
    expect(html).not.toContain('aria-label="src/greet.ts"');
    expect(selectedRows(html)).toEqual(['src/util/slug.ts']);
    expect(crumb(html)).toContain('<strong>slug.ts</strong>');
    expect(crumb(html)).toContain('href="/coop/greeter/tree/src/util?ref=sprout"');
  });

  it('shows a folder opened in the browser with its README and the side column', () => {
    const client = readBefore({
      folders: [''],
      files: [blob('README.md', '# Greeter\n\nSays hello.\n')],
    });
    const html = render('/coop/greeter?ref=sprout', client);
    expect(html).toContain('href="/coop/greeter/blob/package.json?ref=sprout"');
    expect(html).toContain('href="/coop/greeter/tree/src?ref=sprout"');
    expect(html).toContain('<h1>Greeter</h1>');
    expect(html).toContain('aria-label="About this repository"');
    expect(selectedRows(html)).toEqual([]);
  });

  it('says it is opening a file it has not read yet', () => {
    const html = render('/coop/greeter/blob/src/util/slug.ts?ref=sprout');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Opening src/util/slug.ts…');
  });

  it('keeps the server’s render for a URL at another ref, which is a page of its own', () => {
    const client = readBefore({ files: [blob('src/util/slug.ts', 'export const slug = 2;\n')] });
    const html = render('/coop/greeter/blob/src/util/slug.ts', client);
    expect(html).toContain('aria-label="src/greet.ts"');
    expect(selectedRows(html)).toEqual(['src/greet.ts']);
  });

  it('opens a Markdown file’s source by its own URL', () => {
    const client = readBefore({ files: [blob('README.md', '# Greeter\n')] });
    const rendered = render('/coop/greeter/blob/README.md?ref=sprout', client);
    expect(rendered).toContain('href="/coop/greeter/blob/README.md?ref=sprout&amp;plain=1"');
    expect(rendered).toContain('<h1>Greeter</h1>');
    const source = render('/coop/greeter/blob/README.md?ref=sprout&plain=1', client);
    expect(source).not.toContain('<h1>Greeter</h1>');
    expect(source).toContain('>Rendered</a>');
  });
});

/** The workspace's opener, as a component inside it sees it. */
function openerAt(href: string): CodeOpener {
  const seen: { opener: CodeOpener | null } = { opener: null };
  function Probe() {
    seen.opener = useCodeOpener();
    return null;
  }
  render(href, new QueryClient(), <Probe />);
  if (seen.opener === null) throw new Error('no opener in the workspace');
  return seen.opener;
}

describe('opening a folder or a file in the workspace', () => {
  it('writes the URL of the folder or file to the history at the browsed ref, without a render', () => {
    const pushState = vi.fn();
    vi.stubGlobal('window', { history: { pushState } });
    try {
      const opener = openerAt('/coop/greeter/blob/src/greet.ts?ref=sprout');
      opener.go({ view: 'blob', path: 'src/util/slug.ts' });
      opener.go({ view: 'tree', path: 'src' });
      opener.go({ view: 'blob', path: 'README.md', plain: true });
      expect(pushState.mock.calls.map((call) => call[2])).toEqual([
        '/coop/greeter/blob/src/util/slug.ts?ref=sprout',
        '/coop/greeter/tree/src?ref=sprout',
        '/coop/greeter/blob/README.md?ref=sprout&plain=1',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('adds no history entry for the location already open', () => {
    const pushState = vi.fn();
    vi.stubGlobal('window', { history: { pushState } });
    try {
      openerAt('/coop/greeter/blob/src/greet.ts?ref=sprout').go({
        view: 'blob',
        path: 'src/greet.ts',
      });
      expect(pushState).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
