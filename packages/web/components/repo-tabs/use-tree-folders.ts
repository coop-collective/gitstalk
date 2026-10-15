'use client';

/**
 * The file tree's folders: those the page sent (the root and the way to the open path), and
 * each folder the reader expands, read once through TanStack Query by (commit sha, folder).
 * A tree at a sha never changes, so each folder is fetched at most once and never refetched
 * (`freshness('immutable')`); a repository's folders, public or private, are also persisted
 * for the tab (sessionStorage, this viewer only).
 */
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { RepoScope } from '../../src/changes/change-feed';
import type { FolderListing, LoadedFolders } from '../../src/code/file-tree';
import { ancestorsOf } from '../../src/code/file-tree';
import { fileTreePaths, isFolderAnswer } from '../../src/code/file-tree-answers';
import type { TreeEntry } from '../../src/code/tree';
import { fetchJson, isHttpStatus } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import { freshness } from '../../src/query/policy';

export type TreeFolders = {
  readonly loaded: LoadedFolders;
  /** Folders whose read failed (gone at this commit, or the gateway refused). */
  readonly failed: ReadonlySet<string>;
};

export function useTreeFolders(input: {
  readonly scope: RepoScope;
  readonly sha: string;
  readonly sent: readonly FolderListing[];
  readonly expanded: ReadonlySet<string>;
}): TreeFolders {
  const { scope, sha } = input;
  const keys = qk.repo(scope.uid, scope.owner, scope.repo);
  const sent = useMemo(
    () => new Map(input.sent.map((folder) => [folder.path, folder.entries])),
    [input.sent],
  );
  const wanted = shownFolders(input.expanded);
  const results = useQueries({
    queries: wanted.map((folder) => {
      const initial = sent.get(folder);
      return {
        queryKey: keys.folder(sha, folder),
        queryFn: ({ signal }: { readonly signal: AbortSignal }) =>
          readFolder(scope, sha, folder, signal),
        enabled: sha !== '',
        retry: (failures: number, error: unknown) => failures < 1 && !isHttpStatus(error, 404),
        ...(initial === undefined ? {} : { initialData: initial }),
        ...freshness('immutable', { visibility: scope.visibility }),
      };
    }),
  });
  const client = useQueryClient();
  const loaded = new Map(sent);
  // Folders read before and since closed stay searchable by the filter.
  for (const [key, entries] of client.getQueriesData<readonly TreeEntry[]>({
    queryKey: [...keys.all, 'folder', sha],
  }))
    if (entries !== undefined) loaded.set(String(key.at(-1)), entries);
  const failed = new Set<string>();
  results.forEach((result, index) => {
    const folder = wanted[index] ?? '';
    if (result.data !== undefined) loaded.set(folder, result.data);
    else if (result.isError) failed.add(folder);
  });
  return { loaded, failed };
}

/** The root and every expanded folder whose parents are expanded too (the ones on screen). */
function shownFolders(expanded: ReadonlySet<string>): readonly string[] {
  const shown = [...expanded].filter((folder) =>
    ancestorsOf(folder).every((parent) => expanded.has(parent)),
  );
  return ['', ...shown.toSorted()];
}

async function readFolder(
  scope: RepoScope,
  sha: string,
  folder: string,
  signal: AbortSignal,
): Promise<readonly TreeEntry[]> {
  const path = fileTreePaths(scope.base).folder(sha, folder);
  return (await fetchJson(path, isFolderAnswer, { signal })).entries;
}
