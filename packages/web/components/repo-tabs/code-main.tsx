'use client';

/**
 * The Code workspace's bar and main pane, drawn for the open location (`code-opener.tsx`): the
 * server's render while the URL is the page's own, and otherwise the folder or file opened in
 * the browser, read at the page's commit from the folder and file routes. Both draw with the
 * same components (`BlobView`, `FolderView`), so a file looks the same however it was opened.
 */
import { useQuery } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';

import { hrefOf, isSameLocation } from '../../src/code/code-location';
import { readmeOf } from '../../src/code/tree';
import type { CodeBody, CodeHead } from '../../src/repo-pages/code-data';
import { isHttpStatus } from '../../src/query/fetch-json';
import { BlobView } from './blob-view';
import type { CodeLocation } from './code-browser';
import { CodeBar, FolderView } from './code-browser';
import type { CodeOpener } from './code-opener';
import { useCodeOpener } from './code-opener';
import { fileQuery, folderQuery } from './code-queries';
import treeStyles from './file-tree.module.css';
import styles from './repo-tabs.module.css';

/** The bar for the open location: its path, and the Code button on a folder. */
export function OpenCodeBar(props: ComponentProps<typeof CodeBar>) {
  const open = useCodeOpener()?.open ?? null;
  const view = open?.view ?? props.view;
  return (
    <CodeBar
      {...props}
      at={{ ...props.at, path: open?.path ?? props.at.path }}
      view={view}
      menu={view === 'tree' ? (props.menu ?? null) : null}
    />
  );
}

/** What the page read for its own location, as the main pane shows it. */
export type RenderedCode = {
  readonly base: string;
  readonly body: CodeBody;
  /** What last happened on the browsed ref: the same for every folder and file of the page. */
  readonly head: CodeHead;
  readonly nowMs: number;
};

/** The main pane: the open folder (with `aside` beside it) or file. */
export function OpenCodeMain(props: RenderedCode & { readonly aside: ReactNode }) {
  const opener = useCodeOpener();
  if (opener === null) return null;
  const { open } = opener;
  const at: CodeLocation = { base: props.base, ref: open.ref, path: open.path, sha: opener.sha };
  const body = isSameLocation(open, opener.rendered) ? (
    <RenderedBody
      at={at}
      body={props.body}
      head={props.head}
      plain={open.plain}
      nowMs={props.nowMs}
    />
  ) : (
    <OpenedBody opener={opener} at={at} head={props.head} nowMs={props.nowMs} />
  );
  if (open.view === 'blob') return body;
  return (
    <div className={treeStyles.folderSplit}>
      <div>{body}</div>
      {props.aside}
    </div>
  );
}

/** The body the server read: a folder, a file, or why there is neither. */
export function RenderedBody(props: {
  readonly at: CodeLocation;
  readonly body: CodeBody;
  readonly head: CodeHead;
  readonly plain: boolean;
  readonly nowMs: number;
}) {
  const { body } = props;
  if (body.kind === 'missing') return <Missing what={body.what} />;
  if (body.kind === 'file') return <BlobView at={props.at} file={body.file} plain={props.plain} />;
  return (
    <FolderView
      at={props.at}
      entries={body.entries}
      head={props.head}
      nowMs={props.nowMs}
      readme={body.readme}
    />
  );
}

/** A folder or a file opened in the browser, read at the page's commit. */
function OpenedBody(props: {
  readonly opener: CodeOpener;
  readonly at: CodeLocation;
  readonly head: CodeHead;
  readonly nowMs: number;
}) {
  const { open } = props.opener;
  if (open.view === 'blob') return <OpenedFile {...props} />;
  return <OpenedFolder {...props} />;
}

function OpenedFile(props: { readonly opener: CodeOpener; readonly at: CodeLocation }) {
  const { scope, sha, open } = props.opener;
  const file = useQuery(fileQuery(scope, sha, open.path));
  if (file.data !== undefined)
    return <BlobView at={props.at} file={file.data} plain={open.plain} />;
  if (file.isError)
    return isHttpStatus(file.error, 404) ? (
      <Missing what={`There is no file ${open.path} here.`} />
    ) : (
      <Unread href={hrefOf(scope.base, open)} />
    );
  return <Opening path={open.path} />;
}

function OpenedFolder(props: {
  readonly opener: CodeOpener;
  readonly at: CodeLocation;
  readonly head: CodeHead;
  readonly nowMs: number;
}) {
  const { scope, sha, open } = props.opener;
  const entries = useQuery(folderQuery(scope, sha, open.path));
  const readme = entries.data === undefined ? null : readmeOf(entries.data);
  const readmeFile = useQuery({
    ...fileQuery(scope, sha, readme?.path ?? ''),
    enabled: readme !== null,
  });
  if (entries.data !== undefined) {
    const text = readmeFile.data?.content ?? null;
    return (
      <FolderView
        at={props.at}
        entries={entries.data}
        head={props.head}
        nowMs={props.nowMs}
        readme={readme === null || text === null ? null : { path: readme.path, text }}
      />
    );
  }
  if (entries.isError)
    return isHttpStatus(entries.error, 404) ? (
      <Missing what={`There is no folder ${open.path} here.`} />
    ) : (
      <Unread href={hrefOf(scope.base, open)} />
    );
  return <Opening path={open.path} />;
}

function Missing(props: { readonly what: string }) {
  return (
    <section className={styles.box}>
      <p className={styles.empty}>{props.what}</p>
    </section>
  );
}

/** A read that failed: the page itself (a server render) is one link away. */
function Unread(props: { readonly href: string }) {
  return (
    <section className={styles.box}>
      <p className={styles.empty}>
        This could not be read just now. <a href={props.href}>Open its page</a>.
      </p>
    </section>
  );
}

/** Shown only until the read arrives; a hover usually read it already. */
function Opening(props: { readonly path: string }) {
  return (
    <section className={styles.box} aria-busy="true" aria-label={props.path}>
      <p className={styles.empty}>{`Opening ${props.path === '' ? 'the root' : props.path}…`}</p>
    </section>
  );
}
