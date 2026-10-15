/**
 * What the Code tab's JSON routes answer, shared by the routes (`file-tree-api.ts`) and the
 * browser's queries (`use-tree-folders.ts`, `go-to-file.tsx`, `code-opener.tsx`). Client-safe:
 * `zod/mini` only.
 *
 * - `GET /api/repos/<owner>/<repo>/code/folder?sha=<commit>&path=<folder>`: one folder's entries.
 * - `GET /api/repos/<owner>/<repo>/code/paths?sha=<commit>`: every file's path (Go to file).
 * - `GET /api/repos/<owner>/<repo>/code/file?sha=<commit>&path=<file>`: one file, as the Code
 *   tab shows it (a folder or a file opened in the browser, `code-opener.tsx`).
 *
 * Each reads at a commit sha, so an answer never changes.
 */
import * as z from 'zod/mini';

import { schemaGuard } from '../query/schema-guard';
import type { FileBlob } from '../repo-pages/engine-reads';
import type { TreeEntry } from './tree';

export type FolderAnswer = { readonly entries: readonly TreeEntry[] };
export type PathsAnswer = { readonly paths: readonly string[] };
export type FileAnswer = { readonly file: FileBlob };

const Entry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['dir', 'file']),
  size: z.nullable(z.number()),
});

export const isFolderAnswer = schemaGuard(z.object({ entries: z.array(Entry) }));
export const isPathsAnswer = schemaGuard(z.object({ paths: z.array(z.string()) }));
export const isFileAnswer = schemaGuard(
  z.object({
    file: z.object({
      path: z.string(),
      size: z.number(),
      binary: z.boolean(),
      content: z.nullable(z.string()),
      truncated: z.boolean(),
    }),
  }),
);

/** The routes of the repository at `base` (`/<owner>/<repo>`), at commit `sha`. */
export function fileTreePaths(base: string) {
  return {
    folder: (sha: string, path: string) =>
      `/api/repos${base}/code/folder?sha=${sha}&path=${encodeURIComponent(path)}`,
    paths: (sha: string) => `/api/repos${base}/code/paths?sha=${sha}`,
    file: (sha: string, path: string) =>
      `/api/repos${base}/code/file?sha=${sha}&path=${encodeURIComponent(path)}`,
  } as const;
}
