/**
 * The Code tab: a folder of the stalk (or the sprout, or a bean's branch) with what last
 * changed it, its README rendered below, and beside it what the repository is and what is
 * growing. Cloning and connecting an agent live behind the bar's Code button.
 */
import { IntentLink as Link } from '../shell/intent-link';
import type { ReactNode } from 'react';

import { FileIcon } from '../home/marks';
import { CodeButton } from '../repository/code-button';
import type { Change } from '../../src/changes/changes';
import { authorText } from '../../src/changes/changes';
import type { CodeView, RefChoice, TreeEntry } from '../../src/code/tree';
import { codeHref, crumbs, readmeHref, sizeText } from '../../src/code/tree';
import type { CodeHead } from '../../src/repo-pages/code-data';
import type { CodeMenu } from '../../src/repositories/code-menu';
import { timeAgo } from '../../src/repositories/when';
import { Glyph } from './glyph';
import { MarkdownView } from './markdown-view';
import { RefSwitcher, glyphOfState } from './ref-switcher';
import styles from './repo-tabs.module.css';

export type CodeLocation = {
  readonly base: string;
  readonly ref: RefChoice;
  readonly path: string;
  /** The commit the tree was read at. */
  readonly sha: string;
};

/** The bar over a folder or a file: the ref switcher, the path, and on a folder the Code button. */
export function CodeBar(props: {
  readonly at: CodeLocation;
  readonly view: CodeView;
  readonly repoName: string;
  readonly beans: readonly Change[];
  /** What the Code button offers; null where it is not shown (a file). */
  readonly menu?: { readonly menu: CodeMenu; readonly slug: string } | null;
}) {
  const { at } = props;
  const parts = crumbs(at.path);
  return (
    <div className={styles.bar}>
      <RefSwitcher
        base={at.base}
        view={props.view}
        path={at.path}
        current={at.ref}
        beans={props.beans}
      />
      <nav className={styles.crumbs} aria-label="Path">
        {parts.length === 0 ? (
          <strong>{props.repoName}</strong>
        ) : (
          <Link href={codeHref(at.base, 'tree', '', at.ref)}>{props.repoName}</Link>
        )}
        {parts.map((crumb, index) => (
          <span key={crumb.path} style={{ display: 'contents' }}>
            <span>/</span>
            {index === parts.length - 1 ? (
              <strong>{crumb.name}</strong>
            ) : (
              <Link href={codeHref(at.base, 'tree', crumb.path, at.ref)}>{crumb.name}</Link>
            )}
          </span>
        ))}
      </nav>
      {props.menu === undefined || props.menu === null ? null : (
        <CodeButton menu={props.menu.menu} slug={props.menu.slug} />
      )}
    </div>
  );
}

export function FolderView(props: {
  readonly at: CodeLocation;
  readonly entries: readonly TreeEntry[];
  readonly head: CodeHead;
  readonly nowMs: number;
  readonly readme: { readonly path: string; readonly text: string } | null;
}) {
  const { at } = props;
  return (
    <>
      <section className={styles.box} aria-label="Files">
        <HeadRow head={props.head} base={at.base} sha={at.sha} nowMs={props.nowMs} />
        {props.entries.length === 0 ? (
          <p className={styles.empty}>
            Nothing here yet. The first bean that adds a file grows it.
          </p>
        ) : (
          <ul className={styles.files}>
            {at.path === '' ? null : (
              <li>
                <Link
                  href={codeHref(at.base, 'tree', parentOf(at.path), at.ref)}
                  aria-label="Up one folder"
                >
                  <span />
                  <span className={styles.fileName}>..</span>
                  <span />
                </Link>
              </li>
            )}
            {props.entries.map((entry) => (
              <li key={entry.path}>
                <Link
                  href={codeHref(
                    at.base,
                    entry.kind === 'dir' ? 'tree' : 'blob',
                    entry.path,
                    at.ref,
                  )}
                >
                  <span className={styles.icon} data-dir={entry.kind === 'dir' ? '' : undefined}>
                    <FileIcon dir={entry.kind === 'dir'} />
                  </span>
                  <span className={styles.fileName}>{entry.name}</span>
                  <span className={styles.size}>
                    {entry.size === null || entry.size === 0 ? '' : sizeText(entry.size)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {props.readme === null ? null : (
        <section className={`${styles.box} ${styles.readme}`} aria-label={props.readme.path}>
          <div className={styles.boxHead}>
            <FileIcon dir={false} />
            <span className={styles.mono}>{props.readme.path.split('/').at(-1)}</span>
          </div>
          <MarkdownView text={props.readme.text} resolve={(href) => readmeHref(at, href)} />
        </section>
      )}
    </>
  );
}

/** The line above the files: the newest commit (and its bean and person), or the bean shown. */
export function HeadRow(props: {
  readonly head: CodeHead;
  readonly base: string;
  readonly sha: string;
  readonly nowMs: number;
}) {
  const { head, base } = props;
  if (head === null)
    return (
      <div className={styles.boxHead}>
        <span className={`${styles.headTitle} ${styles.mono}`}>{props.sha.slice(0, 7)}</span>
      </div>
    );
  if (head.kind === 'bean') {
    const { change } = head;
    return (
      <div className={styles.boxHead}>
        <Glyph kind={glyphOfState(change.state)} />
        <span className={styles.headTitle}>
          <Link href={`${base}/changes/${encodeURIComponent(change.bean)}`}>{change.title}</Link>
        </span>
        <span className={styles.headMeta}>
          <span className={styles.person}>{authorText(change.author)}</span>
          <span>{change.state}</span>
          <span className={styles.mono}>{props.sha.slice(0, 7)}</span>
        </span>
      </div>
    );
  }
  const { row } = head;
  return (
    <div className={styles.boxHead}>
      <Glyph kind={row.root ? 'seed' : head.line} />
      <span className={styles.headTitle}>
        {row.bean === null ? (
          row.title
        ) : (
          <Link href={`${base}/changes/${encodeURIComponent(row.bean)}`}>{row.title}</Link>
        )}
      </span>
      <span className={styles.headMeta}>
        <span className={styles.person}>
          {row.by.kind === 'person' ? `@${row.by.name}` : row.by.name}
        </span>
        {row.at === null ? null : (
          <time dateTime={new Date(row.at).toISOString()}>
            {timeAgo(new Date(row.at).toISOString(), props.nowMs)}
          </time>
        )}
        <Link
          href={`${base}/history${head.line === 'sprout' ? '?line=sprout' : ''}`}
          className={styles.mono}
        >
          {row.sha.slice(0, 7)}
        </Link>
      </span>
    </div>
  );
}

/** The side column: what the repository is and what is growing. */
export function CodeAside(props: {
  readonly base: string;
  readonly description: string;
  readonly changes: readonly Change[];
  readonly onStalk: number;
}) {
  const open = props.changes.filter((change) => change.group === 'open');
  const red = open.filter((change) => change.state === 'red' || change.state === 'conflict');
  const growing = open.length - red.length;
  return (
    <aside className={styles.aside} aria-label="About this repository">
      <section>
        <h2>About</h2>
        <p>{props.description === '' ? 'No description yet.' : props.description}</p>
        <ul className={styles.facts}>
          <Fact glyph="stalk">
            <Link href={`${props.base}/history`}>
              {props.onStalk} {props.onStalk === 1 ? 'bean' : 'beans'} on the stalk
            </Link>
          </Fact>
          <Fact glyph="bean">
            <Link href={`${props.base}/changes`}>
              {growing === 0 ? 'Nothing in check' : `${growing} in check or waiting`}
            </Link>
          </Fact>
          {red.length === 0 ? null : (
            <Fact glyph="red">
              <Link href={`${props.base}/changes`}>{red.length} red, waiting for a push</Link>
            </Fact>
          )}
        </ul>
      </section>
    </aside>
  );
}

function Fact(props: { readonly glyph: 'stalk' | 'bean' | 'red'; readonly children: ReactNode }) {
  return (
    <li>
      <Glyph kind={props.glyph} />
      {props.children}
    </li>
  );
}

function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}
