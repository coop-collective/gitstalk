/**
 * The Code tab's reads in the browser, as TanStack Query options: one folder's entries and one
 * file, each at a commit sha (`file-tree-answers.ts`), so an answer never changes and is read at
 * most once per tab. The file tree, Go to file and the folders and files opened in the browser
 * (`code-opener.tsx`) share them, so a folder expanded in the tree opens without a read.
 *
 * - A folder is `immutable`: kept and persisted for the tab (sessionStorage, this viewer).
 * - A file is `immutableBlob`: kept in memory only, as one file can fill sessionStorage.
 */
import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';

import type { RepoScope } from '../../src/changes/change-feed';
import type { CodeTarget } from '../../src/code/code-location';
import { fileTreePaths, isFileAnswer, isFolderAnswer } from '../../src/code/file-tree-answers';
import type { TreeEntry } from '../../src/code/tree';
import { readmeOf } from '../../src/code/tree';
import type { FileBlob } from '../../src/repo-pages/engine-reads';
import { fetchJson, isHttpStatus } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import { freshness } from '../../src/query/policy';

type ReadContext = { readonly signal: AbortSignal };

/** One folder's entries at `sha` ('' is the root). */
export function folderQuery(scope: RepoScope, sha: string, folder: string) {
  return queryOptions({
    queryKey: qk.repo(scope.uid, scope.owner, scope.repo).folder(sha, folder),
    queryFn: async ({ signal }: ReadContext): Promise<readonly TreeEntry[]> =>
      (await fetchJson(fileTreePaths(scope.base).folder(sha, folder), isFolderAnswer, { signal }))
        .entries,
    enabled: sha !== '',
    retry: retryUnlessMissing,
    ...freshness('immutable', { visibility: scope.visibility }),
  });
}

/** One file at `sha`. */
export function fileQuery(scope: RepoScope, sha: string, path: string) {
  return queryOptions({
    queryKey: qk.repo(scope.uid, scope.owner, scope.repo).file(sha, path),
    queryFn: async ({ signal }: ReadContext): Promise<FileBlob> =>
      (await fetchJson(fileTreePaths(scope.base).file(sha, path), isFileAnswer, { signal })).file,
    enabled: sha !== '' && path !== '',
    retry: retryUnlessMissing,
    ...freshness('immutableBlob'),
  });
}

/**
 * Reads what opening `target` will show, ahead of the click (a hover or a focus): a file, or a
 * folder and then its README. Each read is made once per tab; a failure is left for the open
 * itself to show.
 */
export async function prefetchTarget(
  client: QueryClient,
  at: { readonly scope: RepoScope; readonly sha: string },
  target: CodeTarget,
): Promise<void> {
  const { scope, sha } = at;
  if (target.view === 'blob') return client.prefetchQuery(fileQuery(scope, sha, target.path));
  await client.prefetchQuery(folderQuery(scope, sha, target.path));
  const entries = client.getQueryData(folderQuery(scope, sha, target.path).queryKey);
  const readme = entries === undefined ? null : readmeOf(entries);
  if (readme !== null) await client.prefetchQuery(fileQuery(scope, sha, readme.path));
}

/** One retry for a passing failure; none for a 404, which is an answer. */
function retryUnlessMissing(failures: number, error: unknown): boolean {
  return failures < 1 && !isHttpStatus(error, 404);
}
