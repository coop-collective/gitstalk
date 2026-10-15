'use client';

/**
 * Go to file (`t`, as on GitHub): a modal finder over every path at the browsed commit. The
 * paths are read once per commit (`code/paths`, the tree read the page made, from the edge
 * cache for a public repository) and only when the finder first opens. The field is a
 * combobox over a listbox: arrows move, Enter opens the file (in place, `code-opener.tsx`),
 * Escape closes.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { RepoScope } from '../../src/changes/change-feed';
import type { PathMatch } from '../../src/code/find-file';
import { findFiles } from '../../src/code/find-file';
import { fileTreePaths, isPathsAnswer } from '../../src/code/file-tree-answers';
import type { RefChoice } from '../../src/code/tree';
import { codeHref } from '../../src/code/tree';
import { fetchJson } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import { freshness } from '../../src/query/policy';
import { useCodeOpener } from './code-opener';
import styles from './file-tree.module.css';

/** Matches shown at once; typing narrows them. */
const SHOWN = 50;

export function GoToFile(props: {
  readonly scope: RepoScope;
  readonly ref: RefChoice;
  readonly sha: string;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (props.open && !element.open) element.showModal();
    if (!props.open && element.open) element.close();
  }, [props.open]);
  return (
    <dialog
      ref={dialog}
      className={styles.finder}
      aria-label="Go to file"
      onClose={props.onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      {props.open ? <Finder {...props} /> : null}
    </dialog>
  );
}

function Finder(props: {
  readonly scope: RepoScope;
  readonly ref: RefChoice;
  readonly sha: string;
  readonly onClose: () => void;
}) {
  const { scope, sha } = props;
  const router = useRouter();
  const opener = useCodeOpener();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const paths = useQuery({
    queryKey: qk.repo(scope.uid, scope.owner, scope.repo).paths(sha),
    queryFn: async ({ signal }) =>
      (await fetchJson(fileTreePaths(scope.base).paths(sha), isPathsAnswer, { signal })).paths,
    enabled: sha !== '',
    ...freshness('immutable', { visibility: scope.visibility }),
  });
  const matches = findFiles(paths.data ?? [], query, SHOWN);
  const open = (path: string) => {
    props.onClose();
    if (opener === null) router.push(codeHref(scope.base, 'blob', path, props.ref));
    else opener.go({ view: 'blob', path });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const next = moveActive(event.key, active, matches.length);
    if (next !== null) {
      event.preventDefault();
      setActive(next);
      return;
    }
    const chosen = matches[active];
    if (event.key === 'Enter' && chosen !== undefined) {
      event.preventDefault();
      open(chosen.path);
    }
  };
  const optionId = (index: number) => `${listId}-${index}`;
  return (
    <div className={styles.finderBody}>
      <input
        className={styles.finderField}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={matches.length === 0 ? undefined : optionId(active)}
        aria-label="Go to file"
        placeholder="Go to file"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" aria-label="Files" className={styles.finderList}>
        {matches.map((match, index) => (
          <li
            key={match.path}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            className={styles.finderOption}
            onPointerMove={() => setActive(index)}
            onClick={() => open(match.path)}
          >
            <MarkedPath match={match} />
          </li>
        ))}
      </ul>
      <p className={styles.finderStatus} role="status">
        {finderStatus(paths.status, matches.length, {
          total: paths.data?.length ?? 0,
          typed: query.trim() !== '',
        })}
      </p>
    </div>
  );
}

/** A path with the matched letters marked, the file's name stronger than its folders. */
function MarkedPath(props: { readonly match: PathMatch }) {
  const { path, marks } = props.match;
  const marked = new Set(marks);
  const nameStart = path.lastIndexOf('/') + 1;
  return (
    <span className={styles.finderPath}>
      <span className={styles.finderDir}>{spans(path.slice(0, nameStart), 0, marked)}</span>
      <span className={styles.finderName}>{spans(path.slice(nameStart), nameStart, marked)}</span>
    </span>
  );
}

/** `text` (starting at `offset` in the path) in runs, the matched ones marked. */
function spans(text: string, offset: number, marked: ReadonlySet<number>) {
  const runs: { text: string; marked: boolean }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const isMarked = marked.has(offset + index);
    const last = runs.at(-1);
    if (last !== undefined && last.marked === isMarked) last.text += text.slice(index, index + 1);
    else runs.push({ text: text.slice(index, index + 1), marked: isMarked });
  }
  return runs.map((run, index) => (run.marked ? <mark key={index}>{run.text}</mark> : run.text));
}

function moveActive(key: string, active: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return (active + 1) % count;
  if (key === 'ArrowUp') return (active - 1 + count) % count;
  return null;
}

function finderStatus(
  status: 'pending' | 'error' | 'success',
  shown: number,
  counts: { readonly total: number; readonly typed: boolean },
) {
  if (status === 'pending') return 'Reading the file list…';
  if (status === 'error') return 'The file list could not be read. Close this and try again.';
  if (shown === 0) return 'No file matches.';
  if (!counts.typed) return `${counts.total} files. Type part of a name to find one.`;
  if (shown === SHOWN) return `The best ${SHOWN} matches. Keep typing to narrow them.`;
  return `${shown} ${shown === 1 ? 'match' : 'matches'} of ${counts.total} files`;
}
