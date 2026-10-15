'use client';

/**
 * Opens folders and files in the Code workspace without rendering the page again.
 *
 * The page the server rendered names one location (a folder or a file at a commit). A plain
 * click on a folder or a file of the same ref writes its URL to the history
 * (`history.pushState`); vinext treats that as Next.js does since 14.1 (shallow routing):
 * `usePathname` and `useSearchParams` follow it, no request is made, and back and forward
 * between such entries only move the URL. The main pane, the bar and the tree read the open
 * location from the URL, so the rendered location shows the server's render and any other is
 * drawn here from the folder and file routes (`code-queries.ts`), read at the page's commit.
 *
 * What stays a page render: a modified click (a new tab), a link without script, another ref
 * (the ref switcher), another tab, and `router.refresh()` when the line moves (the head watcher),
 * which renders the URL now open at the new commit.
 */
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, use, useEffect } from 'react';

import type { RepoScope } from '../../src/changes/change-feed';
import type { CodeTarget, OpenLocation } from '../../src/code/code-location';
import {
  codeTitle,
  hrefOf,
  isSameLocation,
  locationAt,
  locationOfUrl,
} from '../../src/code/code-location';
import type { CodeView, RefChoice } from '../../src/code/tree';
import { refLabel } from '../../src/code/tree';
import { IntentLink } from '../shell/intent-link';
import { prefetchTarget } from './code-queries';

export type CodeOpener = {
  readonly scope: RepoScope;
  /** The commit the page was read at; every folder and file opened here is read at it too. */
  readonly sha: string;
  /** The location the server rendered. */
  readonly rendered: OpenLocation;
  /** The location the URL names: what the main pane, the bar and the tree show. */
  readonly open: OpenLocation;
  /** Opens a folder or a file at the browsed ref. */
  readonly go: (target: CodeTarget) => void;
  /** Reads what opening `target` shows, ahead of the click. */
  readonly prefetch: (target: CodeTarget) => void;
};

const CodeOpenerContext = createContext<CodeOpener | null>(null);

/** The workspace's opener, or null outside one (a page with nothing to browse). */
export function useCodeOpener(): CodeOpener | null {
  return use(CodeOpenerContext);
}

export function CodeOpenerProvider(props: {
  readonly opener: CodeOpener;
  readonly children: ReactNode;
}) {
  return <CodeOpenerContext value={props.opener}>{props.children}</CodeOpenerContext>;
}

/** The workspace's opener for the page the server rendered. */
export function useCodeOpenerState(input: {
  readonly scope: RepoScope;
  readonly rendered: {
    readonly ref: RefChoice;
    readonly sha: string;
    readonly view: CodeView;
    readonly path: string;
    readonly plain: boolean;
  };
  /** Runs after a folder or a file is opened (the workspace scrolls the pane into view). */
  readonly onOpen: () => void;
}): CodeOpener {
  const { scope } = input;
  const { ref, sha } = input.rendered;
  const rendered = locationAt(input.rendered, ref);
  const open = useUrlLocation(scope.base, ref) ?? rendered;
  const client = useQueryClient();
  useDocumentTitle(open, scope);
  return {
    scope,
    sha,
    rendered,
    open,
    go: (target) => {
      const next = locationAt(target, ref);
      if (isSameLocation(next, open)) return;
      window.history.pushState(null, '', hrefOf(scope.base, next));
      input.onOpen();
    },
    prefetch: (target) => {
      void prefetchTarget(client, { scope, sha }, target);
    },
  };
}

/**
 * A link to a folder or a file of the workspace. Inside one, a plain click opens it there and a
 * hover or a focus reads it ahead (a JSON read at a sha, never a page prefetch); a modified
 * click and a page without script follow the link. Outside a workspace, an intent link.
 */
export function CodeLink(props: ComponentProps<typeof IntentLink> & { readonly to: CodeTarget }) {
  const { to, ...link } = props;
  const { onMouseEnter, onFocus, ...rest } = link;
  const opener = useCodeOpener();
  if (opener === null) return <IntentLink {...link} />;
  return (
    <Link
      {...rest}
      prefetch={false}
      onNavigate={(event) => {
        event.preventDefault();
        opener.go(to);
      }}
      onMouseEnter={(event) => {
        opener.prefetch(to);
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        opener.prefetch(to);
        onFocus?.(event);
      }}
    />
  );
}

/** The URL's location, when it is a Code URL of this repository at the ref the page browses. */
function useUrlLocation(base: string, ref: RefChoice): OpenLocation | null {
  const pathname = usePathname();
  const search = useSearchParams();
  const location = locationOfUrl(base, pathname, search.toString());
  return location !== null && refLabel(location.ref) === refLabel(ref) ? location : null;
}

/** Names the open folder or file in the tab's title, as its own page's metadata would. */
function useDocumentTitle(open: OpenLocation, scope: RepoScope): void {
  const title = codeTitle(open, scope.owner, scope.repo);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
