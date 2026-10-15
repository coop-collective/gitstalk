/**
 * What the file tree's two JSON routes answer, shared by the routes (`file-tree-api.ts`) and the
 * browser's queries (`file-tree.tsx`). Client-safe: `zod/mini` only.
 *
 * - `GET /api/repos/<owner>/<repo>/code/folder?sha=<commit>&path=<folder>`: one folder's entries.
 * - `GET /api/repos/<owner>/<repo>/code/paths?sha=<commit>`: every file's path (Go to file).
 *
 * Both read the tree at a commit sha, so an answer never changes.
 */
import * as z from 'zod/mini';

import { schemaGuard } from '../query/schema-guard';
import type { TreeEntry } from './tree';

export type FolderAnswer = { readonly entries: readonly TreeEntry[] };
export type PathsAnswer = { readonly paths: readonly string[] };

const Entry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['dir', 'file']),
  size: z.nullable(z.number()),
});

export const isFolderAnswer = schemaGuard(z.object({ entries: z.array(Entry) }));
export const isPathsAnswer = schemaGuard(z.object({ paths: z.array(z.string()) }));

/** The two routes of the repository at `base` (`/<owner>/<repo>`), at commit `sha`. */
export function fileTreePaths(base: string) {
  return {
    folder: (sha: string, path: string) =>
      `/api/repos${base}/code/folder?sha=${sha}&path=${encodeURIComponent(path)}`,
    paths: (sha: string) => `/api/repos${base}/code/paths?sha=${sha}`,
  } as const;
}
