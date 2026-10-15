import { answerFolder } from '../../../../../../../src/code/file-tree-api';
import type { TreeRouteContext } from '../../../../../../../src/code/viewer-tree-access';
import { viewerTreeAccess } from '../../../../../../../src/code/viewer-tree-access';

/**
 * `GET /api/repos/:owner/:repo/code/folder?sha=&path=`: one folder's entries at a commit, for
 * the Code tab's file tree when a folder is expanded; a 404 for anyone who may not read it.
 */
export async function GET(request: Request, context: TreeRouteContext): Promise<Response> {
  return answerFolder(request, await viewerTreeAccess(context));
}
