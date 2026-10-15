/**
 * The Code tab's JSON routes, without bindings: `answerFolder` (one folder's entries, when the
 * reader expands or opens it), `answerPaths` (every path, for Go to file) and `answerFile` (one
 * file, when the reader opens it in the browser). Each reads at a commit sha through the
 * request's engine reads, which go through the edge object cache (`cached-reads.ts`: the shared
 * layers for a public repository, the private KV namespace for a private one), so expanding
 * folders and opening files cost no gateway call once cached. The access check is the pages'
 * own (`viewer-tree-access.ts`): a repository the viewer may not read is a 404, the same as a
 * missing one.
 *
 * Content addressed by a sha never changes: a public repository's answers are `immutable` for
 * this browser; a private or internal one's are never kept by the HTTP cache (the query cache
 * holds them for the tab, docs/claude-opus/35-caching.md).
 */
import { Sha } from '@gitstalk/shared-race/ids';

import type { CacheRule } from '../edge/http-cache';
import { IMMUTABLE, NO_STORE, byVisibility, jsonAnswer, problem } from '../edge/http-cache';
import { log } from '../log';
import type { Visibility } from '../query/policy';
import type { EngineReads } from '../repo-pages/engine-reads';
import type { FileAnswer, FolderAnswer, PathsAnswer } from './file-tree-answers';
import { listing } from './tree';

/** The engine reads these routes make. */
export type TreeReads = Pick<EngineReads, 'engine' | 'tree' | 'file'>;

/** What the viewer may read of the repository they asked for. */
export type TreeAccess =
  | { readonly kind: 'not-found' }
  /** `reads` is null when the record's engine id is unusable. */
  | { readonly kind: 'found'; readonly visibility: Visibility; readonly reads: TreeReads | null };

/** `GET …/code/folder?sha=&path=`: the entries directly under one folder at a commit. */
export function answerFolder(request: Request, access: TreeAccess): Promise<Response> {
  const path = new URL(request.url).searchParams.get('path') ?? '';
  return answer(request, access, (files) => {
    const entries = listing(files, path);
    if (entries === null) return null;
    const body: FolderAnswer = { entries };
    return body;
  });
}

/** `GET …/code/paths?sha=`: every file's path at a commit. */
export function answerPaths(request: Request, access: TreeAccess): Promise<Response> {
  return answer(request, access, (files) => {
    const body: PathsAnswer = { paths: files.map((file) => file.path) };
    return body;
  });
}

/**
 * `GET …/code/file?sha=&path=`: one file at a commit. A file the engine cannot read is a 404
 * (`EngineReads.file` logs the failure and reads it as missing, as the file's page does); a 404
 * is never kept, so a passing failure is not remembered.
 */
export async function answerFile(request: Request, access: TreeAccess): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const sha = Sha.safeParse(query.get('sha'));
  const path = query.get('path') ?? '';
  if (!sha.success) return problem(400, 'sha must be a 40-character commit id');
  if (path === '') return problem(400, 'path must name a file');
  if (access.kind === 'not-found') return problem(404, 'no such repository');
  if (access.reads === null) return problem(503, 'the engine is not reachable');
  const file = await access.reads.file(sha.data, path);
  if (file === null) return problem(404, 'no such file');
  const body: FileAnswer = { file };
  return jsonAnswer(request, body, { rule: ruleFor(access.visibility) });
}

type TreeFiles = readonly { readonly path: string; readonly size: number }[];

async function answer(
  request: Request,
  access: TreeAccess,
  shape: (files: TreeFiles) => FolderAnswer | PathsAnswer | null,
): Promise<Response> {
  const sha = Sha.safeParse(new URL(request.url).searchParams.get('sha'));
  if (!sha.success) return problem(400, 'sha must be a 40-character commit id');
  if (access.kind === 'not-found') return problem(404, 'no such repository');
  if (access.reads === null) return problem(503, 'the engine is not reachable');
  let files: TreeFiles;
  try {
    files = (await access.reads.tree(sha.data)).files;
  } catch (error: unknown) {
    log.error('file tree read failed', { engine: access.reads.engine, sha: sha.data, error });
    return problem(502, 'the gateway could not read the tree');
  }
  const body = shape(files);
  if (body === null) return problem(404, 'no such folder');
  return jsonAnswer(request, body, { rule: ruleFor(access.visibility) });
}

/** Content at a sha: kept for good by a public repository's browser, never by another's. */
function ruleFor(visibility: Visibility): CacheRule {
  return byVisibility(visibility, { public: IMMUTABLE, restricted: NO_STORE });
}
